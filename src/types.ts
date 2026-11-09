/**
 * Colony Core Type Definitions
 * Modern ESM, model-agnostic agent orchestration system
 */

export type AgentRole =
  | 'director'
  | 'architect'
  | 'engineer'
  | 'reviewer'
  | 'tester'
  | 'analyst'
  | 'security'
  | 'auditor'
  | 'researcher'
  | 'writer'
  | 'exobiologist'
  | 'custom';

/**
 * Roles that only receive a task when it asks for them by name. Left in the open pool, the
 * auditor would lose its independence by doing ordinary work, and the exobiologist would be handed
 * routine tasks it is not meant for. Neither counts as an implicit candidate in dispatch.
 */
export const ADVISORY_ROLES: readonly AgentRole[] = ['auditor', 'exobiologist'];

export type AgentStatus = 'idle' | 'busy' | 'voting' | 'offline' | 'error';

export interface ColonyAgentCapabilities {
  tools: string[];
  maxConcurrentTasks: number;
  languages?: string[];
  specializations?: string[];
  contextWindowLimit?: number;
}

export interface ColonyMember {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  capabilities: ColonyAgentCapabilities;
  currentTaskIds: string[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  lastActiveAt: number;
}

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'review'
  | 'consensus'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** One verdict of a reviewer on a task. The reason is stored redacted and shortened. */
export interface ReviewRecord {
  by: string;
  verdict: 'approve' | 'reject';
  reason: string;
  at: number;
}

export interface TaskVerification {
  command: string;
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  durationMs: number;
  at: number;
  /** Short hash of the output; the output itself is not stored. */
  outputHash: string;
  outputBytes: number;
}

export interface ColonyTask {
  id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  requiredRole?: AgentRole;
  requiredCapabilities?: string[];
  assignedAgentId?: string;
  assignedAgentIds?: string[]; // Multiple agents for collaborative or consensus tasks
  parentId?: string;
  subTaskIds?: string[];
  dependencies?: string[]; // IDs of tasks that must be completed first
  inputData?: Record<string, unknown>;
  outputResult?: unknown;
  error?: string;
  /**
   * A hold put on the task by the auditor: it cannot be completed or dispatched until released.
   * The release note is what the host says the user decided; the colony cannot check that a person did.
   */
  hold?: { by: string; reason: string; at: number };
  /** The task cannot be completed until a reviewer approves it. A rejection blocks completion either way. */
  reviewRequired?: boolean;
  /** Rejections after which the task is put on hold for the user. Default 3. */
  maxReviewRounds?: number;
  /** Rejections so far (reset when the user releases a hold the review limit put on). */
  reviewRounds?: number;
  /** The most recent verdicts, oldest first (at most 20). */
  reviews?: ReviewRecord[];
  /** Quality 0..1 as REPORTED by the host when it closed the task. Not measured by the colony. */
  quality?: number;
  /** The host says a test run backed this outcome. The colony cannot check that; it only keeps the label apart. */
  verifiedByTest?: boolean;
  /** Evidence from a check the COLONY ran itself (unlike `verifiedByTest`, which is the host's statement). */
  verification?: TaskVerification;
  /** The quality the host reported, when a failed colony check lowered `quality`. */
  reportedQuality?: number;
  consensusRequired?: boolean;
  minConsensusQuorum?: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface ColonyEvent<T = unknown> {
  id: string;
  topic: string;
  senderId: string;
  timestamp: number;
  payload: T;
}

export interface ConsensusProposal<T = unknown> {
  id: string;
  taskId: string;
  proposerId: string;
  topic: string;
  data: T;
  votes: Map<string, ConsensusVote>;
  status: 'open' | 'approved' | 'rejected' | 'timeout';
  quorum: number;
  /** Set when the quorum was derived from a strategy: the number of eligible voters. */
  voters?: number;
  strategy?: string;
  createdAt: number;
  expiresAt: number;
}

export interface ConsensusVote {
  voterId: string;
  approve: boolean;
  /** Validated 0..1, advisory: it is stored and reported but does not change the quorum count. */
  confidence: number;
  reason?: string;
  timestamp: number;
}
