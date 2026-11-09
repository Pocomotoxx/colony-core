/**
 * The Deputy's watch: mechanical checks over the ledger and the audit log.
 *
 * The agent-system design gives the Deputy three jobs: notice goal drift, notice loops, and notice
 * decisions of the Chief that nobody reviewed. Here each is a COUNT OR A COMPARISON over records,
 * not a judgement, so the same records always give the same findings.
 *
 * What this cannot do, said plainly:
 * - It does not know the user's original request (the colony does not store it). "Goal drift" is
 *   measured only for split tasks, by whether a part's title shares any word with the root task;
 *   that is a weak, lexical signal and is reported at the lowest severity.
 * - It sees what the commands recorded. If the same model drives the Chief and the Deputy, it will
 *   not catch what both believe; its independence comes from the records, not from a second opinion.
 * - A hold is an escalation to the user. The colony cannot tell whether a person released it.
 *
 * All thresholds are heuristic and can be overridden.
 */

import type { AuditEntry } from '../audit-log.js';
import type { ColonyTask } from '../types.js';

export type FindingKind =
  | 'audit_integrity'
  | 'unreviewed_override'
  | 'self_released_hold'
  | 'repeated_failure'
  | 'claim_cycle'
  | 'duplicate_task_loop'
  | 'stalled_task'
  | 'goal_drift'
  | 'hold_open';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Finding {
  kind: FindingKind;
  severity: FindingSeverity;
  subject: string;
  detail: string;
  /** Task ids the finding rests on. */
  taskIds: string[];
  /** Audit sequence numbers it rests on, when it comes from the log. */
  auditSeqs: number[];
}

export interface WatchThresholds {
  /** Failed tasks with the same title. */
  repeatedFailures: number;
  /** Steals plus accepted handoffs on one task. */
  claimCycles: number;
  /** The same title created this many times with none completed. */
  duplicateTitles: number;
  /** Minutes an open task may go without any record. */
  stalledMinutes: number;
}

export const DEFAULT_WATCH_THRESHOLDS: Readonly<WatchThresholds> = { repeatedFailures: 3, claimCycles: 3, duplicateTitles: 3, stalledMinutes: 120 };

export interface WatchInput {
  tasks: readonly ColonyTask[];
  audit: readonly AuditEntry[];
  /** Result of verifying the audit chain, and whether the log still holds the boot anchor (null: no anchor). */
  chainOk: boolean;
  anchorHeld: boolean | null;
  now: number;
  thresholds?: Partial<WatchThresholds>;
  /** Keep only findings about this task. */
  focusTaskId?: string;
}

export interface WatchReport {
  heuristic: true;
  at: number;
  findings: Finding[];
  checked: { tasks: number; auditEntries: number };
  limits: string[];
}

const OPEN: ReadonlySet<string> = new Set(['assigned', 'in_progress', 'review', 'consensus']);
const MINUTE = 60_000;
const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const LIMITS = [
  'Thresholds are heuristic.',
  'Goal drift is measured only for split tasks and only by shared title words: a weak lexical signal.',
  'The colony does not store the original user request, so drift against it cannot be checked.',
  'A hold is an escalation to the user; the colony cannot tell whether a person released it.',
  'Independence comes from the records, not from a second opinion: a Deputy driven by the same model as the Chief can share its blind spots.',
];

const normalizeTitle = (title: string): string => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Words too common to show that two titles are about the same thing. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'are', 'was', 'not', 'all', 'any', 'out', 'new', 'add', 'make', 'part',
  'egy', 'hogy', 'vagy', 'meg', 'azt', 'van', 'nem', 'jó', 'már', 'még', 'is', 'és', 'ami', 'ezt', 'volt', 'lesz', 'kell',
]);
const words = (text: string): string[] => Array.from(new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])).filter((w) => !STOP_WORDS.has(w));

export function runWatch(input: WatchInput): WatchReport {
  const given = Object.fromEntries(Object.entries(input.thresholds ?? {}).filter(([, v]) => v !== undefined));
  const th: WatchThresholds = { ...DEFAULT_WATCH_THRESHOLDS, ...given };
  for (const [key, value] of Object.entries(th)) {
    if (!Number.isFinite(value) || value < 1) throw new Error(`watch threshold '${key}' must be a number of at least 1`);
  }
  const { tasks, audit, now } = input;
  const findings: Finding[] = [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // ---- the log itself
  if (!input.chainOk) {
    findings.push({ kind: 'audit_integrity', severity: 'critical', subject: 'audit log', detail: 'The hash chain of the audit log is broken.', taskIds: [], auditSeqs: [] });
  }
  if (input.anchorHeld === false) {
    findings.push({ kind: 'audit_integrity', severity: 'critical', subject: 'audit log', detail: 'The audit log no longer holds the entry anchored at the last boot (cut or rewritten).', taskIds: [], auditSeqs: [] });
  }

  // ---- overrides nobody reviewed
  for (const e of audit) {
    if (e.type !== 'chief.override') continue;
    const reviewed = audit.some((r) => r.seq > e.seq && r.type === 'deputy.reviewed' && r.aggregateId === e.aggregateId);
    if (!reviewed) {
      findings.push({ kind: 'unreviewed_override', severity: 'high', subject: e.aggregateId, detail: `A chief override by ${e.actor} has no review by the Deputy.`, taskIds: taskById.has(e.aggregateId) ? [e.aggregateId] : [], auditSeqs: [e.seq] });
    }
  }

  // ---- holds released by whoever put them on
  for (const e of audit) {
    if (e.type === 'task.hold_released' && e.payload.heldBy !== undefined && e.payload.heldBy === e.payload.releasedBy) {
      findings.push({ kind: 'self_released_hold', severity: 'high', subject: e.aggregateId, detail: `The hold on ${e.aggregateId} was released by ${String(e.payload.releasedBy)}, who put it there: the escalation to the user did not happen.`, taskIds: [e.aggregateId], auditSeqs: [e.seq] });
    }
  }

  // ---- the same work failing or being recreated again and again
  const byTitle = new Map<string, ColonyTask[]>();
  for (const t of tasks) {
    const key = normalizeTitle(t.title);
    if (key) byTitle.set(key, [...(byTitle.get(key) ?? []), t]);
  }
  for (const [title, group] of [...byTitle.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const failed = group.filter((t) => t.status === 'failed');
    if (failed.length >= th.repeatedFailures) {
      findings.push({ kind: 'repeated_failure', severity: 'high', subject: title, detail: `${failed.length} tasks titled "${title}" failed.`, taskIds: failed.map((t) => t.id), auditSeqs: [] });
    } else if (group.length >= th.duplicateTitles && !group.some((t) => t.status === 'completed')) {
      findings.push({ kind: 'duplicate_task_loop', severity: 'medium', subject: title, detail: `"${title}" was created ${group.length} times and none of them was completed.`, taskIds: group.map((t) => t.id), auditSeqs: [] });
    }
  }

  // ---- a claim that keeps changing hands
  const handovers = new Map<string, AuditEntry[]>();
  for (const e of audit) {
    if (e.type === 'claim.stolen' || e.type === 'claim.handoff_accepted') handovers.set(e.aggregateId, [...(handovers.get(e.aggregateId) ?? []), e]);
  }
  for (const [taskId, entries] of handovers) {
    if (entries.length >= th.claimCycles) {
      findings.push({ kind: 'claim_cycle', severity: 'high', subject: taskId, detail: `The claim on ${taskId} changed hands ${entries.length} times.`, taskIds: [taskId], auditSeqs: entries.map((e) => e.seq) });
    }
  }

  // ---- open tasks nobody touched
  const lastRecord = new Map<string, number>();
  for (const e of audit) lastRecord.set(e.aggregateId, Math.max(lastRecord.get(e.aggregateId) ?? 0, e.at));
  for (const t of tasks) {
    if (!OPEN.has(t.status) || t.hold) continue;
    const last = lastRecord.get(t.id) ?? t.startedAt ?? t.createdAt;
    if (now - last > th.stalledMinutes * MINUTE) {
      findings.push({ kind: 'stalled_task', severity: 'medium', subject: t.id, detail: `${t.id} is ${t.status} and has had no record for over ${th.stalledMinutes} minutes.`, taskIds: [t.id], auditSeqs: [] });
    }
  }

  // ---- split tasks whose parts share nothing with the root
  const rootOf = (t: ColonyTask): ColonyTask => {
    let cur = t;
    const seen = new Set<string>();
    while (cur.parentId && taskById.has(cur.parentId) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = taskById.get(cur.parentId)!;
    }
    return cur;
  };
  for (const t of tasks) {
    if (!t.parentId) continue;
    const root = rootOf(t);
    const rootWords = new Set(words(`${root.title} ${root.description}`));
    const own = words(t.title);
    if (own.length >= 2 && !own.some((w) => rootWords.has(w))) {
      findings.push({ kind: 'goal_drift', severity: 'low', subject: t.id, detail: `The title of ${t.id} shares no word with its root task ${root.id} (weak lexical signal).`, taskIds: [t.id, root.id], auditSeqs: [] });
    }
  }

  // ---- holds still open
  for (const t of tasks) {
    if (t.hold && (OPEN.has(t.status) || t.status === 'pending')) {
      findings.push({ kind: 'hold_open', severity: 'low', subject: t.id, detail: `${t.id} is on hold since ${new Date(t.hold!.at).toISOString()} (by ${t.hold!.by}): waiting for the user.`, taskIds: [t.id], auditSeqs: [] });
    }
  }

  const kept = input.focusTaskId === undefined ? findings : findings.filter((f) => f.subject === input.focusTaskId || f.taskIds.includes(input.focusTaskId!));
  kept.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.subject < b.subject ? -1 : 1));
  return { heuristic: true, at: now, findings: kept, checked: { tasks: tasks.length, auditEntries: audit.length }, limits: LIMITS };
}
