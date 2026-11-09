import type { ColonyHub } from '../colony-hub.js';
import { validateQuality } from '../chief/outcome.js';
import type { ColonyTask } from '../types.js';

export class RateError extends Error {}

/** Parse a `--quality` value: a number between 0 and 1. */
export function parseQuality(value: string | undefined): number {
  if (value === undefined || value.trim() === '') throw new RateError('rate needs --quality 0..1');
  try {
    return validateQuality(Number(value));
  } catch {
    throw new RateError('--quality must be a number between 0 and 1');
  }
}

/**
 * Rate a finished task after the fact. The rating is the user's, the one reliable source: it is
 * stored on the task, and the colony's memory (reasoning bank for a completed task, outcomes for
 * both) is updated from it. The router is not taught again: it already counted the task once.
 */
export async function rateTask(hub: ColonyHub, taskId: string | undefined, quality: number): Promise<ColonyTask> {
  const task = taskId ? hub.orchestrator.getTask(taskId) : undefined;
  if (!task) throw new RateError(`task '${taskId ?? ''}' not found`);
  await hub.orchestrator.rateTask(task.id, quality);
  return hub.orchestrator.getTask(task.id)!;
}
