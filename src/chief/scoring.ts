/**
 * Member scoring for a task: who should take it, and who is next in line.
 *
 * Rewritten from the Queen's agent scoring (legacy `queen-coordinator`). The weights are the
 * legacy ones and are HEURISTIC: hand-picked constants, not fitted to anything. They are the
 * default and can be overridden.
 *
 *   capability 0.30 + load 0.20 + performance 0.25 + health 0.15 + availability 0.10
 *
 * Differences from the legacy code: the performance term is a smoothed rate computed from the
 * ledger (see member-stats), not a stored field; health counts the member's stale claims; ties are
 * broken by member id, so the same ledger always gives the same order; advisory roles are never an
 * implicit candidate. The legacy "prefer an agent of the recommended domain, even if it scores
 * worse" rule is dropped: the score decides.
 */

import type { AgentStatus, ColonyMember, ColonyTask } from '../types.js';
import { ineligibleReason } from '../coordination/colony-registry.js';
import type { MemberStats } from './member-stats.js';

export interface ScoreWeights {
  capability: number;
  load: number;
  performance: number;
  health: number;
  availability: number;
}

export const DEFAULT_SCORE_WEIGHTS: Readonly<ScoreWeights> = { capability: 0.3, load: 0.2, performance: 0.25, health: 0.15, availability: 0.1 };

export interface ScoreComponents {
  capability: number;
  load: number;
  performance: number;
  health: number;
  availability: number;
}

export interface MemberScore {
  memberId: string;
  role: ColonyMember['role'];
  total: number;
  components: ScoreComponents;
}

export interface Ineligible {
  memberId: string;
  reason: string;
}

export interface Ranking {
  /** Marked `heuristic`: the weights and the component formulas are not measured. */
  heuristic: true;
  weights: ScoreWeights;
  primary: MemberScore | null;
  backups: MemberScore[];
  ranked: MemberScore[];
  ineligible: Ineligible[];
}

export interface RankOptions {
  weights?: Partial<ScoreWeights>;
  /** How many backups to name. Default 2. */
  backups?: number;
  /** A backup must score at least this much. Default 0.3. */
  minBackupScore?: number;
  /** Members to leave out (for example the current holder of a stale claim). */
  exclude?: readonly string[];
}

const AVAILABILITY: Record<AgentStatus, number> = { idle: 1, voting: 0.5, busy: 0.3, offline: 0, error: 0 };

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

function components(task: ColonyTask, member: ColonyMember, stats: MemberStats | undefined): ScoreComponents {
  // Capability: a base of 0.5, +0.3 when the member has exactly the role the task asks for,
  // +0.2 scaled by how much of the required capability list it covers (all of it, once eligible).
  const needed = task.requiredCapabilities ?? [];
  const covered = needed.length === 0 ? 1 : needed.filter((c) => member.capabilities.tools.includes(c) || member.capabilities.specializations?.includes(c)).length / needed.length;
  const capability = clamp01(0.5 + (task.requiredRole && member.role === task.requiredRole ? 0.3 : 0) + 0.2 * covered);

  const load = clamp01(1 - member.currentTaskIds.length / Math.max(1, member.capabilities.maxConcurrentTasks));
  // Performance: the smoothed success rate; when the host reported qualities, 30% of it is their mean.
  const rate = stats?.successRate ?? 0.5;
  const performance = stats?.avgQuality != null ? 0.7 * rate + 0.3 * stats.avgQuality : rate;
  const health = clamp01(1 - 0.3 * (stats?.staleClaims ?? 0));
  return { capability, load, performance, health, availability: AVAILABILITY[member.status] };
}

function validatedWeights(override: Partial<ScoreWeights> | undefined): ScoreWeights {
  // An explicit `undefined` must not overwrite the default.
  const given = Object.fromEntries(Object.entries(override ?? {}).filter(([, v]) => v !== undefined));
  const weights: ScoreWeights = { ...DEFAULT_SCORE_WEIGHTS, ...given };
  for (const [key, value] of Object.entries(weights)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`score weight '${key}' must be a non-negative number`);
  }
  return weights;
}

/** Rank the members that can take `task`; list the ones that cannot, with the reason. */
export function rankMembers(
  task: ColonyTask,
  members: readonly ColonyMember[],
  stats: ReadonlyMap<string, MemberStats>,
  options: RankOptions = {}
): Ranking {
  const weights = validatedWeights(options.weights);
  const excluded = new Set(options.exclude ?? []);
  const ranked: MemberScore[] = [];
  const ineligible: Ineligible[] = [];

  for (const member of members) {
    if (excluded.has(member.id)) continue;
    const reason = ineligibleReason(task, member);
    if (reason) {
      ineligible.push({ memberId: member.id, reason });
      continue;
    }
    const c = components(task, member, stats.get(member.id));
    const total = c.capability * weights.capability + c.load * weights.load + c.performance * weights.performance + c.health * weights.health + c.availability * weights.availability;
    ranked.push({ memberId: member.id, role: member.role, total: Math.round(total * 10000) / 10000, components: c });
  }

  ranked.sort((a, b) => b.total - a.total || (a.memberId < b.memberId ? -1 : 1));
  ineligible.sort((a, b) => (a.memberId < b.memberId ? -1 : 1));

  const [primary = null, ...rest] = ranked;
  const minBackup = options.minBackupScore ?? 0.3;
  const backups = rest.filter((s) => s.total >= minBackup).slice(0, options.backups ?? 2);
  return { heuristic: true, weights, primary, backups, ranked, ineligible };
}
