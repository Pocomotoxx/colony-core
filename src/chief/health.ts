/**
 * Colony health report: groups, bottlenecks, alerts, recommendations.
 *
 * Rewritten from the Queen's swarm health monitor (legacy `queen-coordinator`). A pure function of
 * the ledger and a clock value, so the same state at the same time always gives the same report.
 *
 * Differences from the legacy code:
 * - Response time and error rate per group are computed from the tasks. The legacy report
 *   hard-coded both to 0 ("Would need tracking").
 * - Idle capacity is not treated as a problem. The legacy group health lost 0.2 for every unit of
 *   unused capacity, so an idle colony looked unhealthy.
 * - No coordination-latency figure (it needs a running coordinator) and no alert "acknowledged"
 *   state (the report keeps no state between calls).
 * - A task that cannot be routed to anyone, a task waiting on a failed dependency and a long wait
 *   are reported; the legacy monitor did not look for them.
 *
 * All thresholds and the health formulas are HEURISTIC, carried over or chosen by hand, not fitted
 * to data. They can be overridden.
 */

import type { Claim } from '../coordination/claim-ledger.js';
import type { AgentRole, ColonyMember, ColonyTask, ConsensusProposal } from '../types.js';
import { ineligibleReason } from '../coordination/colony-registry.js';

export type HealthGroup = 'leadership' | 'research' | 'analysis' | 'delivery' | 'quality';

export const ROLE_GROUP: Record<AgentRole, HealthGroup> = {
  director: 'leadership',
  auditor: 'leadership',
  security: 'leadership',
  researcher: 'research',
  exobiologist: 'research',
  analyst: 'analysis',
  architect: 'delivery',
  engineer: 'delivery',
  writer: 'delivery',
  reviewer: 'quality',
  tester: 'quality',
  custom: 'delivery',
};

export const HEALTH_GROUPS: readonly HealthGroup[] = ['leadership', 'research', 'analysis', 'delivery', 'quality'];

export interface HealthThresholds {
  /** Pending tasks in one group above which it is a bottleneck. Legacy: 10. */
  queueDepth: number;
  /** Queue depth treated as critical. Legacy: 20. */
  queueCritical: number;
  /** Error rate of a group above which it is a bottleneck. Legacy config: 0.1. */
  errorRate: number;
  /** Minutes a task may wait unassigned before it is reported. */
  longWaitMinutes: number;
  /** Window for the throughput figure. */
  throughputWindowMinutes: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: Readonly<HealthThresholds> = { queueDepth: 10, queueCritical: 20, errorRate: 0.1, longWaitMinutes: 60, throughputWindowMinutes: 60 };

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface Bottleneck {
  type: 'group' | 'member' | 'task' | 'claim';
  location: string;
  severity: Severity;
  description: string;
  suggestedAction: string;
}

export interface GroupHealth {
  group: HealthGroup;
  health: number;
  members: number;
  available: number;
  busy: number;
  offline: number;
  queuedTasks: number;
  openTasks: number;
  /** failed / (completed + failed) of the group's tasks; null when it has none. */
  errorRate: number | null;
  /** Mean assigned-to-closed time of completed tasks, includes waiting; null when it has none. */
  avgResponseMs: number | null;
}

export interface HealthAlert {
  level: 'warning' | 'error' | 'critical';
  source: string;
  message: string;
}

export interface HealthReport {
  heuristic: true;
  at: number;
  overallHealth: number;
  groups: GroupHealth[];
  bottlenecks: Bottleneck[];
  alerts: HealthAlert[];
  metrics: {
    members: number;
    available: number;
    busy: number;
    offline: number;
    inError: number;
    tasks: number;
    pending: number;
    open: number;
    completed: number;
    failed: number;
    completedInWindow: number;
    /** Completed tasks per hour over the window. */
    throughputPerHour: number;
    /** Share of decided proposals that were approved; null when none was decided. */
    consensusSuccessRate: number | null;
    staleClaims: number;
    blockedClaims: number;
  };
  recommendations: string[];
}

export interface HealthInput {
  members: readonly ColonyMember[];
  tasks: readonly ColonyTask[];
  claims: readonly Claim[];
  proposals: readonly ConsensusProposal[];
  now: number;
  thresholds?: Partial<HealthThresholds>;
}

const OPEN: ReadonlySet<string> = new Set(['assigned', 'in_progress', 'review', 'consensus']);
const SEVERITY_PENALTY: Record<Severity, number> = { critical: 0.15, high: 0.08, medium: 0.03, low: 0.01 };
const MINUTE = 60_000;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const round = (x: number, digits = 3): number => Math.round(x * 10 ** digits) / 10 ** digits;

export function buildHealthReport(input: HealthInput): HealthReport {
  // An explicit `undefined` (an option not given) must not overwrite the default.
  const given = Object.fromEntries(Object.entries(input.thresholds ?? {}).filter(([, v]) => v !== undefined));
  const th: HealthThresholds = { ...DEFAULT_HEALTH_THRESHOLDS, ...given };
  for (const [key, value] of Object.entries(th)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`health threshold '${key}' must be a non-negative number`);
  }
  const { members, tasks, claims, now } = input;
  const memberGroup = new Map(members.map((m) => [m.id, ROLE_GROUP[m.role]]));
  const bottlenecks: Bottleneck[] = [];

  // ---- groups
  const groups: GroupHealth[] = HEALTH_GROUPS.map((group) => {
    const inGroup = members.filter((m) => ROLE_GROUP[m.role] === group);
    const usable = inGroup.filter((m) => m.status !== 'offline' && m.status !== 'error');
    const groupTasks = tasks.filter((t) => t.assignedAgentId && memberGroup.get(t.assignedAgentId) === group);
    const completed = groupTasks.filter((t) => t.status === 'completed');
    const failed = groupTasks.filter((t) => t.status === 'failed');
    const durations = completed.filter((t) => t.startedAt !== undefined && t.completedAt !== undefined && t.completedAt >= t.startedAt).map((t) => t.completedAt! - t.startedAt!);
    const queued = tasks.filter((t) => t.status === 'pending' && t.requiredRole !== undefined && ROLE_GROUP[t.requiredRole] === group).length;
    const errorRate = completed.length + failed.length === 0 ? null : failed.length / (completed.length + failed.length);
    const offline = inGroup.length - usable.length;

    // Heuristic: queue pressure (legacy: 0.3 above 5 queued, else 0.05 each), half the error rate,
    // and the share of the group that cannot work.
    const queuePressure = queued > 5 ? 0.3 : queued * 0.05;
    const health = inGroup.length === 0 ? 1 : clamp01(1 - queuePressure - 0.5 * (errorRate ?? 0) - 0.2 * (offline / inGroup.length));

    if (queued > th.queueDepth) {
      bottlenecks.push({
        type: 'group',
        location: group,
        severity: queued > th.queueCritical ? 'critical' : 'high',
        description: `${queued} tasks wait for the ${group} group`,
        suggestedAction: `Bring more ${group} members online or take tasks off the queue`,
      });
    }
    if (errorRate !== null && errorRate > th.errorRate && completed.length + failed.length >= 3) {
      bottlenecks.push({
        type: 'group',
        location: group,
        severity: errorRate > 0.5 ? 'high' : 'medium',
        description: `${Math.round(errorRate * 100)}% of the ${group} group's finished tasks failed`,
        suggestedAction: `Look at the failed ${group} tasks before assigning more`,
      });
    }

    return {
      group,
      health: round(health),
      members: inGroup.length,
      available: usable.filter((m) => m.status === 'idle').length,
      busy: usable.filter((m) => m.status === 'busy').length,
      offline,
      queuedTasks: queued,
      openTasks: groupTasks.filter((t) => OPEN.has(t.status)).length,
      errorRate: errorRate === null ? null : round(errorRate),
      avgResponseMs: durations.length === 0 ? null : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    };
  });

  // ---- members in error
  const errored = members.filter((m) => m.status === 'error');
  if (errored.length > 0) {
    bottlenecks.push({
      type: 'member',
      location: errored.map((m) => m.id).join(', '),
      severity: errored.length > 3 ? 'critical' : 'medium',
      description: `${errored.length} member(s) in error state`,
      suggestedAction: 'Find out why they failed and bring them back, or hand their tasks to others',
    });
  }

  // ---- claims
  const live = claims.filter((c) => c.status !== 'closed');
  const stale = live.filter((c) => c.status === 'stealable');
  const blocked = live.filter((c) => c.status === 'blocked');
  for (const c of stale) {
    bottlenecks.push({
      type: 'claim',
      location: c.taskId,
      severity: 'medium',
      description: `Claim on ${c.taskId} held by ${c.holderId} went stealable (${c.stealableReason})`,
      suggestedAction: 'Run `claim sweep` to see the suggested takeover, then `claim steal`',
    });
  }
  for (const c of blocked) {
    bottlenecks.push({
      type: 'claim',
      location: c.taskId,
      severity: 'low',
      description: `${c.taskId} is blocked: ${c.blockedReason ?? 'no reason given'}`,
      suggestedAction: 'Resolve the blocker, or release the claim',
    });
  }

  // ---- holds waiting for the user
  const held = tasks.filter((t) => t.hold && (OPEN.has(t.status) || t.status === 'pending'));
  if (held.length > 0) {
    bottlenecks.push({
      type: 'task',
      location: 'on hold',
      severity: 'medium',
      description: `${held.length} task(s) are on hold, waiting for the user: ${held.slice(0, 5).map((t) => t.id).join(', ')}${held.length > 5 ? ', …' : ''}`,
      suggestedAction: 'Ask the user to decide on the held tasks, then release them with `hold release`',
    });
  }

  // ---- pending tasks that go nowhere (grouped, so a long queue is one finding, not hundreds)
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const unroutable = new Map<string, string[]>();
  const longWaiting: string[] = [];
  for (const t of tasks) {
    if (t.status !== 'pending' || t.hold) continue; // a held task waits on purpose
    const failedDeps = (t.dependencies ?? []).filter((d) => {
      const dep = taskById.get(d);
      return dep && (dep.status === 'failed' || dep.status === 'cancelled');
    });
    if (failedDeps.length > 0) {
      bottlenecks.push({
        type: 'task',
        location: t.id,
        severity: 'high',
        description: `${t.id} waits for ${failedDeps.join(', ')}, which failed or was cancelled and will never complete`,
        suggestedAction: 'Cancel the task or replace the failed dependency',
      });
      continue;
    }
    const depsDone = (t.dependencies ?? []).every((d) => taskById.get(d)?.status === 'completed');
    if (!depsDone) continue; // still waiting for a live dependency: normal
    if (members.every((m) => ineligibleReason(t, m) !== null)) {
      const key = t.requiredRole ?? 'any role';
      unroutable.set(key, [...(unroutable.get(key) ?? []), t.id]);
    } else if (now - t.createdAt > th.longWaitMinutes * MINUTE) {
      longWaiting.push(t.id);
    }
  }
  const listIds = (ids: string[]): string => `${ids.slice(0, 5).join(', ')}${ids.length > 5 ? `, … (+${ids.length - 5})` : ''}`;
  for (const [key, ids] of [...unroutable.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    bottlenecks.push({
      type: 'task',
      location: `needs ${key}`,
      severity: 'high',
      description: `${ids.length} ready task(s) cannot be taken by any member (needs ${key}): ${listIds(ids)}`,
      suggestedAction: 'Bring a member with that role online, free capacity, or change the task requirements',
    });
  }
  if (longWaiting.length > 0) {
    bottlenecks.push({
      type: 'task',
      location: 'long wait',
      severity: 'medium',
      description: `${longWaiting.length} task(s) have waited over ${th.longWaitMinutes} minutes for assignment: ${listIds(longWaiting)}`,
      suggestedAction: 'Run `next` for the right role, or check why dispatch skips them',
    });
  }

  // ---- metrics
  const completedTasks = tasks.filter((t) => t.status === 'completed');
  const windowStart = now - th.throughputWindowMinutes * MINUTE;
  const completedInWindow = completedTasks.filter((t) => (t.completedAt ?? 0) >= windowStart).length;
  const decided = input.proposals.filter((p) => p.status !== 'open');
  const metrics: HealthReport['metrics'] = {
    members: members.length,
    available: members.filter((m) => m.status === 'idle').length,
    busy: members.filter((m) => m.status === 'busy').length,
    offline: members.filter((m) => m.status === 'offline').length,
    inError: errored.length,
    tasks: tasks.length,
    pending: tasks.filter((t) => t.status === 'pending').length,
    open: tasks.filter((t) => OPEN.has(t.status)).length,
    completed: completedTasks.length,
    failed: tasks.filter((t) => t.status === 'failed').length,
    completedInWindow,
    throughputPerHour: th.throughputWindowMinutes === 0 ? 0 : round((completedInWindow * 60) / th.throughputWindowMinutes),
    consensusSuccessRate: decided.length === 0 ? null : round(decided.filter((p) => p.status === 'approved').length / decided.length),
    staleClaims: stale.length,
    blockedClaims: blocked.length,
  };

  // ---- overall: mean health of the groups that have members, less a penalty per bottleneck
  const populated = groups.filter((g) => g.members > 0);
  const base = populated.length === 0 ? 1 : populated.reduce((sum, g) => sum + g.health, 0) / populated.length;
  const penalty = bottlenecks.reduce((sum, b) => sum + SEVERITY_PENALTY[b.severity], 0);
  const overallHealth = round(clamp01(base - penalty));

  const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  bottlenecks.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.location < b.location ? -1 : a.location > b.location ? 1 : 0) || (a.description < b.description ? -1 : 1));

  const alerts: HealthAlert[] = bottlenecks
    .filter((b) => b.severity !== 'low')
    .map((b) => ({ level: b.severity === 'critical' ? 'critical' : b.severity === 'high' ? 'error' : 'warning', source: `${b.type}:${b.location}`, message: b.description }));

  const recommendations: string[] = [];
  const seen = new Set<string>();
  for (const b of bottlenecks) {
    if (!seen.has(b.suggestedAction)) {
      seen.add(b.suggestedAction);
      recommendations.push(b.suggestedAction);
    }
  }
  if (overallHealth < 0.5) recommendations.push('Overall health is low: work through the critical and high bottlenecks first');

  return { heuristic: true, at: now, overallHealth, groups, bottlenecks, alerts, metrics, recommendations };
}
