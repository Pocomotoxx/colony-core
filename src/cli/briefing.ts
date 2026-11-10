import type { ColonyHub } from '../colony-hub.js';
import type { ReasoningBank } from '../neural/reasoning-bank.js';
import type { ColonyTask } from '../types.js';
import { effectivePreferences, loadProfile } from '../profile/profile.js';

export interface RecalledWork {
  problem: string;
  approach: string;
  /** The quality you gave that work, 0..1. */
  rating: number;
  /** How close the old problem is to this task, 0..1. */
  similarity: number;
  /** The colony ran a check on that work itself and it passed. */
  verified: boolean;
}

export interface Briefing {
  /** What the developer said about how they work (skipped questions are absent). */
  profile: Record<string, string | string[]>;
  recall: {
    /** Similar work that was rated well: a starting point. */
    worked: RecalledWork[];
    /** Similar work that was rated poorly: what not to repeat. */
    caution: RecalledWork[];
    /** What the host should do with it. */
    ask: string | null;
  };
}

const GOOD = 0.6;
const POOR = 0.4;
const SNIPPET = 240;

const snippet = (text: string) => (text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text);
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * What the colony knows before a member starts: the developer's profile and the similar work it
 * remembers, split into what worked and what to avoid. The point is that the user sees what the
 * colony remembers BEFORE it acts, and can overrule it.
 */
export async function buildBriefing(hub: ColonyHub, task: ColonyTask, profileFile: string): Promise<{ briefing: Briefing; warnings: string[] }> {
  const warnings: string[] = [];
  let profile: Briefing['profile'] = {};
  try {
    profile = effectivePreferences(await loadProfile(profileFile));
  } catch (err) {
    warnings.push(`profile not used: ${(err as Error).message}`);
  }

  const { ids: _ids, ...recall } = await recallFor(hub.reasoningBank, `${task.title} ${task.description}`);
  return { briefing: { profile, recall }, warnings };
}

export const RECALL_ASK = 'Show the user what the colony remembers about similar work before you start, and ask whether to apply it or to take another approach. The user decides.';

/** Similar earlier work for a text, split into what worked and what to avoid. */
export async function recallFor(bank: ReasoningBank, text: string): Promise<Briefing['recall'] & { ids: string[] }> {
  const patterns = await bank.recallPatterns(text, { topK: 5, minScore: 0.3 });
  const toWork = (p: (typeof patterns)[number]): RecalledWork => ({
    problem: snippet(p.problem),
    approach: snippet(p.solution),
    rating: round(p.successScore),
    similarity: round(p.relevance ?? 0),
    verified: Boolean(p.verified),
  });
  const keptWorked = patterns.filter((p) => p.successScore >= GOOD);
  const keptCaution = patterns.filter((p) => p.successScore < POOR);
  return {
    worked: keptWorked.map(toWork),
    caution: keptCaution.map(toWork),
    ask: keptWorked.length + keptCaution.length === 0 ? null : RECALL_ASK,
    ids: [...keptWorked, ...keptCaution].map((p) => p.id),
  };
}
