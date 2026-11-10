/**
 * The review loop: a reviewer approves or rejects work in progress, a rejection sends it back with
 * the reason, and a limit on rejections hands the decision to the user.
 *
 * This is the "Critic" of the agent-system design. The legacy code had no such loop; the central coordinator
 * only recorded outcomes after the fact.
 *
 * Limits, said plainly:
 * - The reviewer is a member driven by the host. If the same model wrote the work and reviews it,
 *   the review shares its blind spots. The colony at least refuses a review by the member who holds the task.
 * - An approval is the reviewer's statement. It is not a test result; the colony does not check it.
 */

import type { ColonyTask, ReviewRecord } from '../types.js';

export const DEFAULT_MAX_REVIEW_ROUNDS = 3;
/** The `by` of a hold the review limit places. Releasing such a hold gives the task a fresh set of rounds. */
export const REVIEW_LIMIT_HOLDER = 'review-limit';
export const MAX_KEPT_REVIEWS = 20;

export function lastVerdict(task: Pick<ColonyTask, 'reviews'>): ReviewRecord['verdict'] | null {
  const reviews = task.reviews ?? [];
  return reviews.length === 0 ? null : reviews[reviews.length - 1].verdict;
}

/** Why a review stands between the task and its completion, or null when none does. */
export function reviewBlocksCompletion(task: Pick<ColonyTask, 'reviewRequired' | 'reviews'>): string | null {
  const verdict = lastVerdict(task);
  if (verdict === 'reject') return 'its last review rejected it: address the feedback and ask for a new review';
  if (task.reviewRequired && verdict !== 'approve') return 'it needs a reviewer\'s approval first';
  return null;
}

export function maxRoundsOf(task: Pick<ColonyTask, 'maxReviewRounds'>): number {
  return task.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS;
}

export function validateMaxRounds(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('the review round limit must be a whole number from 1 to 20');
  return n;
}
