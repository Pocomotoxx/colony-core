import { parseArgs } from 'node:util';
import type { AgentRole, ColonyMember, ColonyTask, TaskPriority } from '../types.js';
import { ColonySession } from './session.js';
import { lastVerdict, maxRoundsOf } from '../chief/review.js';


export interface CommandResult {
  code: number;
  output: unknown;
}

export class CliError extends Error {
  constructor(message: string, public readonly code = 1) {
    super(message);
  }
}

export const ROLES: AgentRole[] = ['director', 'architect', 'engineer', 'reviewer', 'tester', 'analyst', 'security', 'auditor', 'researcher', 'writer', 'exobiologist', 'custom'];
export const PRIORITIES: TaskPriority[] = ['low', 'normal', 'high', 'critical'];
export const PRIORITY_RANK: Record<TaskPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
export const OPEN_STATUSES = ['assigned', 'in_progress', 'review', 'consensus'];


export function resolveMembers(session: ColonySession, who: string | undefined): ColonyMember[] {
  if (!who) throw new CliError('--as <role|memberId> is required');
  const all = session.hub.registry.getAllMembers();
  const byId = all.find((m) => m.id === who);
  const members = byId ? [byId] : all.filter((m) => m.role === who);
  if (members.length === 0) throw new CliError(`no member or role '${who}'`);
  return members;
}

export const serializeProposal = (p: { votes: Map<string, unknown> }) => ({ ...p, votes: Array.from(p.votes.values()) });

export function summarizeTask(t: ColonyTask) {
  const verdict = lastVerdict(t);
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    assignedAgentId: t.assignedAgentId,
    dependencies: t.dependencies,
    ...(t.hold ? { onHold: { by: t.hold.by, reason: t.hold.reason } } : {}),
    ...(t.reviewRequired || verdict ? { review: { required: Boolean(t.reviewRequired), rounds: t.reviewRounds ?? 0, maxRounds: maxRoundsOf(t), last: verdict } } : {}),
  };
}


/** Every option the CLI knows, with its type. */
export const OPTIONS = {
    dir: { type: 'string' },
    as: { type: 'string' },
    role: { type: 'string' },
    after: { type: 'string' },
    priority: { type: 'string' },
    consensus: { type: 'string' },
    quorum: { type: 'string' },
    strategy: { type: 'string' },
    type: { type: 'string' },
    fanout: { type: 'string' },
    degree: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    'timeout-min': { type: 'string' },
    data: { type: 'string' },
    result: { type: 'string' },
    error: { type: 'string' },
    reason: { type: 'string' },
    confidence: { type: 'string' },
    progress: { type: 'string' },
    command: { type: 'string' },
    text: { type: 'string' },
    file: { type: 'string' },
    tool: { type: 'string' },
    task: { type: 'string' },
    reward: { type: 'string' },
    allow: { type: 'string' },
    'diff-lines': { type: 'string' },
    threshold: { type: 'string' },
    note: { type: 'string' },
    review: { type: 'boolean' },
    'max-review-rounds': { type: 'string' },
    kind: { type: 'string' },
    apply: { type: 'boolean' },
    quality: { type: 'string' },
    'verified-by-test': { type: 'boolean' },
  'accept-changes': { type: 'boolean' },
    'queue-depth': { type: 'string' },
    'long-wait-min': { type: 'string' },
    approve: { type: 'boolean' },
    'allow-risky': { type: 'boolean' },
    hash: { type: 'string' },
    salt: { type: 'string' },
    reject: { type: 'boolean' },
    ns: { type: 'string' },
    k: { type: 'string' },
    section: { type: 'string' },
    'timeout-sec': { type: 'string' },
    skip: { type: 'boolean' },
    help: { type: 'boolean' },
} as const;

export type ParsedValues = ReturnType<typeof parseArgs<{ args: string[]; options: typeof OPTIONS; allowPositionals: true; strict: true }>>['values'];

export interface CommandContext {
  values: ParsedValues;
  positionals: string[];
  command: string;
  sub: string | undefined;
  dir: string;
  boot: NonNullable<Awaited<ReturnType<typeof ColonySession.readBootRecord>>>;
  session: ColonySession;
  hub: ColonySession['hub'];
  warnings: string[];
  log: (type: string, aggregateId: string, payload?: Record<string, unknown>) => unknown;
  reply: (output: Record<string, unknown>) => CommandResult;
  /** What the Deputy's watch says about this task, right after it was closed. Advice, not a gate. */
  deputyNotes: (taskId: string) => Array<{ kind: string; severity: string; detail: string }>;
}

export type Handler = (ctx: CommandContext) => Promise<CommandResult>;
