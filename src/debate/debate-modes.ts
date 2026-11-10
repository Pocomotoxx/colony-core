import type { AgentRole, ConsensusProposal, DebateMode, DebateModePair } from '../types.js';

/**
 * Every role has a default way of arguing and one alternate. The alternate is for the case where the
 * default did not carry the vote: the same agent then argues from another angle in another style.
 * The colony calls no model: it records and enforces which mode was used, not how well it was played.
 */
export const DEBATE_MODES_BY_ROLE: Readonly<Record<AgentRole, DebateModePair>> = Object.freeze({
  director: { default: 'rational', alternate: 'negotiation' },
  architect: { default: 'rational', alternate: 'fact-finding' },
  engineer: { default: 'rational', alternate: 'courtroom' },
  reviewer: { default: 'courtroom', alternate: 'rational' },
  tester: { default: 'fact-finding', alternate: 'courtroom' },
  analyst: { default: 'fact-finding', alternate: 'rational' },
  security: { default: 'courtroom', alternate: 'fact-finding' },
  auditor: { default: 'courtroom', alternate: 'negotiation' },
  researcher: { default: 'fact-finding', alternate: 'rational' },
  writer: { default: 'negotiation', alternate: 'rational' },
  exobiologist: { default: 'rational', alternate: 'fact-finding' },
  // The one role that may argue in `quarrel` mode: a deliberate, recorded dissenting opinion, not a vote.
  dissenter: { default: 'quarrel', alternate: 'courtroom' },
  custom: { default: 'rational', alternate: 'fact-finding' },
});

export const DEBATE_MODES: readonly DebateMode[] = Object.freeze(['rational', 'fact-finding', 'courtroom', 'negotiation', 'quarrel']);

export function debateModesForRole(role: AgentRole): DebateModePair {
  return DEBATE_MODES_BY_ROLE[role] ?? DEBATE_MODES_BY_ROLE.custom;
}

export function isDebateMode(value: unknown): value is DebateMode {
  return typeof value === 'string' && DEBATE_MODES.includes(value as DebateMode);
}

export function canUseDebateMode(role: AgentRole, mode: DebateMode): boolean {
  const pair = debateModesForRole(role);
  return mode === pair.default || mode === pair.alternate;
}

export interface DebateStats {
  proposals: number;
  entries: number;
  switches: number;
  hypotheses: { total: number; supported: number; refuted: number; unjudged: number };
  dissents: { total: number; supported: number; refuted: number; unjudged: number };
}

const tally = (items: Array<{ outcome?: 'supported' | 'refuted' }>) => ({
  total: items.length,
  supported: items.filter((i) => i.outcome === 'supported').length,
  refuted: items.filter((i) => i.outcome === 'refuted').length,
  unjudged: items.filter((i) => !i.outcome).length,
});

/** Counts only. Whether a debate helps is measured by comparing rated tasks with and without it. */
export function debateStats(proposals: Array<Pick<ConsensusProposal, 'discussion'>>): DebateStats {
  const entries = proposals.flatMap((p) => p.discussion ?? []);
  return {
    proposals: proposals.filter((p) => (p.discussion?.length ?? 0) > 0).length,
    entries: entries.length,
    switches: entries.filter((e) => e.switched).length,
    hypotheses: tally(entries.filter((e) => e.kind === 'hypothesis')),
    dissents: tally(entries.filter((e) => e.kind === 'dissent')),
  };
}
