/**
 * ClaimLedger: who holds which task, and for how long.
 *
 * Rewritten from the legacy `claims` package (domain rules, work stealing, handoff) as pure,
 * deterministic bookkeeping: no timers, no randomness, no events. Every operation takes the
 * current time as an argument, so a host-driven colony can replay and test it exactly.
 *
 * Deliberate differences from the legacy code:
 * - There is no contest window and no queen/human arbiter. A steal is final; the colony's
 *   consensus engine is the place for a vote if one is wanted.
 * - A high progress value does not make a stale claim unstealable: a dead host session at 80%
 *   would otherwise block the task forever. The stolen progress is recorded for the new holder.
 */

export type ClaimStatus = 'active' | 'blocked' | 'handoff_pending' | 'stealable' | 'closed';
export type StealableReason = 'stale' | 'blocked' | 'voluntary';
export type ClaimOutcome = 'completed' | 'failed' | 'released';

export interface ClaimPolicy {
  /** Minutes without activity before an active claim becomes stealable. */
  staleMinutes: number;
  /** Minutes blocked before a claim becomes stealable. */
  blockedMinutes: number;
  /** Minutes after a claim became stealable during which the holder can still take it back. */
  graceMinutes: number;
}

export const DEFAULT_CLAIM_POLICY: ClaimPolicy = { staleMinutes: 30, blockedMinutes: 60, graceMinutes: 10 };

export interface ClaimEvent {
  type: 'claimed' | 'heartbeat' | 'blocked' | 'unblocked' | 'stealable' | 'reclaimed' | 'stolen' | 'handoff_requested' | 'handoff_accepted' | 'handoff_rejected' | 'closed';
  at: number;
  by: string;
  detail?: string;
}

export interface Handoff {
  from: string;
  to: string;
  reason: string;
  requestedAt: number;
}

export interface Claim {
  taskId: string;
  holderId: string;
  status: ClaimStatus;
  claimedAt: number;
  lastActivityAt: number;
  progress: number;
  blockedReason?: string;
  blockedAt?: number;
  stealableReason?: StealableReason;
  stealableAt?: number;
  graceEndsAt?: number;
  handoff?: Handoff;
  outcome?: ClaimOutcome;
  history: ClaimEvent[];
}

export class ClaimError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const MINUTE = 60_000;

export class ClaimLedger {
  private claims = new Map<string, Claim>();
  public readonly policy: ClaimPolicy;

  constructor(policy: Partial<ClaimPolicy> = {}) {
    this.policy = { ...DEFAULT_CLAIM_POLICY, ...policy };
    for (const [key, value] of Object.entries(this.policy)) {
      if (!(value >= 0) || !Number.isFinite(value)) throw new Error(`claim policy '${key}' must be a non-negative number`);
    }
  }

  public get(taskId: string): Claim | undefined {
    return this.claims.get(taskId);
  }

  public list(): Claim[] {
    return Array.from(this.claims.values());
  }

  public open(): Claim[] {
    return this.list().filter((c) => c.status !== 'closed');
  }

  public heldBy(holderId: string): Claim[] {
    return this.open().filter((c) => c.holderId === holderId);
  }

  /** Start a claim. A closed claim on the same task may be replaced. */
  public claim(taskId: string, holderId: string, now: number): Claim {
    const existing = this.claims.get(taskId);
    if (existing && existing.status !== 'closed') {
      throw new ClaimError('ALREADY_CLAIMED', `task '${taskId}' is already claimed by '${existing.holderId}'`);
    }
    const claim: Claim = {
      taskId,
      holderId,
      status: 'active',
      claimedAt: now,
      lastActivityAt: now,
      progress: 0,
      history: [{ type: 'claimed', at: now, by: holderId }],
    };
    this.claims.set(taskId, claim);
    return claim;
  }

  /** The holder shows life and optionally reports progress (0..100). A stealable claim comes back to active. */
  public heartbeat(taskId: string, holderId: string, now: number, progress?: number): Claim {
    const claim = this.requireHolder(taskId, holderId);
    if (claim.status === 'handoff_pending') throw new ClaimError('HANDOFF_PENDING', 'a handoff is pending for this claim');
    if (progress !== undefined) {
      if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw new ClaimError('VALIDATION_ERROR', 'progress must be between 0 and 100');
      claim.progress = progress;
    }
    claim.lastActivityAt = now;
    if (claim.status === 'stealable') {
      claim.status = claim.blockedAt !== undefined ? 'blocked' : 'active';
      this.clearStealable(claim);
      claim.history.push({ type: 'reclaimed', at: now, by: holderId });
    } else {
      claim.history.push({ type: 'heartbeat', at: now, by: holderId, detail: progress === undefined ? undefined : `progress ${progress}` });
    }
    return claim;
  }

  public block(taskId: string, holderId: string, reason: string, now: number): Claim {
    const claim = this.requireHolder(taskId, holderId);
    if (claim.status !== 'active') throw new ClaimError('INVALID_STATUS_TRANSITION', `cannot block a '${claim.status}' claim`);
    if (!reason.trim()) throw new ClaimError('VALIDATION_ERROR', 'a block needs a reason');
    claim.status = 'blocked';
    claim.blockedReason = reason;
    claim.blockedAt = now;
    claim.lastActivityAt = now;
    claim.history.push({ type: 'blocked', at: now, by: holderId, detail: reason });
    return claim;
  }

  public unblock(taskId: string, holderId: string, now: number): Claim {
    const claim = this.requireHolder(taskId, holderId);
    if (claim.status !== 'blocked') throw new ClaimError('INVALID_STATUS_TRANSITION', `claim is '${claim.status}', not blocked`);
    claim.status = 'active';
    claim.blockedReason = undefined;
    claim.blockedAt = undefined;
    claim.lastActivityAt = now;
    claim.history.push({ type: 'unblocked', at: now, by: holderId });
    return claim;
  }

  /** The holder gives the task up. Anyone may take it over immediately (no grace period). */
  public release(taskId: string, holderId: string, now: number): Claim {
    const claim = this.requireHolder(taskId, holderId);
    if (claim.status === 'handoff_pending') throw new ClaimError('HANDOFF_PENDING', 'a handoff is pending for this claim');
    this.markStealable(claim, 'voluntary', now, 0, holderId);
    return claim;
  }

  /**
   * Mark every active or blocked claim that exceeded the policy as stealable.
   * Returns the claims that changed. Stale is checked before blocked.
   */
  public sweep(now: number): Claim[] {
    const changed: Claim[] = [];
    for (const claim of this.claims.values()) {
      if (claim.status !== 'active' && claim.status !== 'blocked') continue;
      let reason: StealableReason | undefined;
      if (now - claim.lastActivityAt >= this.policy.staleMinutes * MINUTE) reason = 'stale';
      else if (claim.blockedAt !== undefined && now - claim.blockedAt >= this.policy.blockedMinutes * MINUTE) reason = 'blocked';
      if (reason) {
        this.markStealable(claim, reason, now, this.policy.graceMinutes * MINUTE, 'sweep');
        changed.push(claim);
      }
    }
    return changed;
  }

  /**
   * Take over a stealable claim. `challengerOpenClaims` and `maxClaims` express the challenger's capacity.
   * Returns the previous holder and the progress the claim had.
   */
  public steal(
    taskId: string,
    challengerId: string,
    now: number,
    capacity: { challengerOpenClaims: number; maxClaims: number }
  ): { claim: Claim; previousHolderId: string; previousProgress: number } {
    const claim = this.requireClaim(taskId);
    if (claim.status !== 'stealable') throw new ClaimError('NOT_STEALABLE', `claim is '${claim.status}', not stealable`);
    if (claim.holderId === challengerId) throw new ClaimError('UNAUTHORIZED', 'cannot steal your own claim');
    if (claim.graceEndsAt !== undefined && now < claim.graceEndsAt) {
      throw new ClaimError('IN_GRACE_PERIOD', `the holder may still take the claim back until ${new Date(claim.graceEndsAt).toISOString()}`);
    }
    if (capacity.challengerOpenClaims >= capacity.maxClaims) {
      throw new ClaimError('CHALLENGER_AT_CAPACITY', `'${challengerId}' already holds ${capacity.challengerOpenClaims} of ${capacity.maxClaims} possible claims`);
    }
    const previousHolderId = claim.holderId;
    claim.holderId = challengerId;
    claim.status = 'active';
    claim.lastActivityAt = now;
    claim.blockedReason = undefined;
    claim.blockedAt = undefined;
    this.clearStealable(claim);
    claim.history.push({ type: 'stolen', at: now, by: challengerId, detail: `from ${previousHolderId}` });
    return { claim, previousHolderId, previousProgress: claim.progress };
  }

  public requestHandoff(taskId: string, fromId: string, toId: string, reason: string, now: number, capacity: { targetOpenClaims: number; maxClaims: number }): Claim {
    const claim = this.requireHolder(taskId, fromId);
    if (claim.status === 'handoff_pending') throw new ClaimError('HANDOFF_PENDING', 'a handoff is already pending for this claim');
    if (claim.status === 'stealable') throw new ClaimError('INVALID_STATUS_TRANSITION', 'a stealable claim cannot be handed off; take it back first');
    if (fromId === toId) throw new ClaimError('VALIDATION_ERROR', 'cannot hand off to yourself');
    if (!reason.trim()) throw new ClaimError('VALIDATION_ERROR', 'a handoff needs a reason');
    if (capacity.targetOpenClaims >= capacity.maxClaims) {
      throw new ClaimError('TARGET_AT_CAPACITY', `'${toId}' already holds ${capacity.targetOpenClaims} of ${capacity.maxClaims} possible claims`);
    }
    claim.handoff = { from: fromId, to: toId, reason, requestedAt: now };
    claim.status = 'handoff_pending';
    claim.lastActivityAt = now;
    claim.history.push({ type: 'handoff_requested', at: now, by: fromId, detail: `to ${toId}: ${reason}` });
    return claim;
  }

  public acceptHandoff(taskId: string, byId: string, now: number): Claim {
    const claim = this.requireClaim(taskId);
    const handoff = this.requireHandoff(claim);
    if (handoff.to !== byId) throw new ClaimError('UNAUTHORIZED', 'only the target can accept this handoff');
    claim.holderId = handoff.to;
    claim.handoff = undefined;
    claim.status = 'active';
    claim.lastActivityAt = now;
    claim.history.push({ type: 'handoff_accepted', at: now, by: byId, detail: `from ${handoff.from}` });
    return claim;
  }

  /** Either side may reject; the claim returns to its original holder. */
  public rejectHandoff(taskId: string, byId: string, now: number): Claim {
    const claim = this.requireClaim(taskId);
    const handoff = this.requireHandoff(claim);
    if (byId !== handoff.to && byId !== handoff.from) throw new ClaimError('UNAUTHORIZED', 'only the target or the initiator can reject this handoff');
    claim.handoff = undefined;
    claim.status = 'active';
    claim.lastActivityAt = now;
    claim.history.push({ type: 'handoff_rejected', at: now, by: byId });
    return claim;
  }

  /** Close a claim when its task is completed or failed. Closing an unknown or already closed claim is a no-op. */
  public close(taskId: string, outcome: ClaimOutcome, by: string, now: number): Claim | undefined {
    const claim = this.claims.get(taskId);
    if (!claim || claim.status === 'closed') return claim;
    claim.status = 'closed';
    claim.outcome = outcome;
    claim.handoff = undefined;
    claim.history.push({ type: 'closed', at: now, by, detail: outcome });
    return claim;
  }

  public snapshot(): Claim[] {
    return structuredClone(this.list());
  }

  public restore(claims: Claim[]): void {
    this.claims.clear();
    for (const claim of structuredClone(claims)) this.claims.set(claim.taskId, claim);
  }

  private markStealable(claim: Claim, reason: StealableReason, now: number, graceMs: number, by: string): void {
    claim.status = 'stealable';
    claim.stealableReason = reason;
    claim.stealableAt = now;
    claim.graceEndsAt = now + graceMs;
    claim.history.push({ type: 'stealable', at: now, by, detail: reason });
  }

  private clearStealable(claim: Claim): void {
    claim.stealableReason = undefined;
    claim.stealableAt = undefined;
    claim.graceEndsAt = undefined;
  }

  private requireClaim(taskId: string): Claim {
    const claim = this.claims.get(taskId);
    if (!claim || claim.status === 'closed') throw new ClaimError('NOT_CLAIMED', `task '${taskId}' has no open claim`);
    return claim;
  }

  private requireHolder(taskId: string, holderId: string): Claim {
    const claim = this.requireClaim(taskId);
    if (claim.holderId !== holderId) throw new ClaimError('UNAUTHORIZED', `task '${taskId}' is held by '${claim.holderId}', not '${holderId}'`);
    return claim;
  }

  private requireHandoff(claim: Claim): Handoff {
    if (claim.status !== 'handoff_pending' || !claim.handoff) throw new ClaimError('HANDOFF_NOT_FOUND', 'no pending handoff on this claim');
    return claim.handoff;
  }
}
