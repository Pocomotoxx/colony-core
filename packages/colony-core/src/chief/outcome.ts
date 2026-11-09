/**
 * Outcome reports and the reward the colony learns from.
 *
 * Rewritten from the Queen's `recordOutcome` / `learnFromOutcome` (legacy `queen-coordinator`).
 * The legacy reward was `quality * 0.8 + 0.2` on success and `quality * 0.3` on failure. The
 * second branch never goes below zero, so a failed task still pushed the learner TOWARDS the role
 * that failed it. Here a failure is negative: `-(1 - 0.3 * quality)`, from -1 down to -0.7 for a
 * failure that got most of the way there.
 *
 * Honest limit: the quality figure is whatever the host reports. Nothing in the colony measures
 * it, so everything learned from it is "reported". `verifiedByTest` keeps a separate label for an
 * outcome the host says a test run backed; it is the host's statement too, and it is not weighted.
 */

export interface OutcomeReport {
  /** 0..1, reported by the host. */
  quality?: number;
  verifiedByTest?: boolean;
}

export function validateQuality(quality: number): number {
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) throw new Error('quality must be a number between 0 and 1');
  return quality;
}

/**
 * Reward in -1..1 for one finished task.
 * Success with a quality: 0.2 + 0.8 * quality. Without one: 0.5 (a plain "done" is worth something, but less than a rated success).
 * Failure with a quality: -(1 - 0.3 * quality). Without one: -1.
 */
export function outcomeReward(success: boolean, quality?: number): number {
  if (quality === undefined) return success ? 0.5 : -1;
  validateQuality(quality);
  const reward = success ? quality * 0.8 + 0.2 : -(1 - quality * 0.3);
  return Math.round(reward * 1e6) / 1e6; // no float noise in stored sums and averages
}
