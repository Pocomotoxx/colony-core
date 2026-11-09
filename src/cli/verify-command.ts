import type { ColonyHub } from '../colony-hub.js';
import { checkDestructive, checkSecrets } from '../gates.js';
import { redactText } from '../redact.js';
import { runVerification, VerifyError } from '../verify/run.js';
import type { TaskVerification } from '../types.js';

export { VerifyError };

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 600;

export interface VerifyOutput {
  output: Record<string, unknown>;
  /** What goes into the audit log: no output text and no arguments. */
  audit: Record<string, unknown>;
}

export function parseTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_SEC;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TIMEOUT_SEC) throw new VerifyError(`--timeout-sec must be a whole number from 1 to ${MAX_TIMEOUT_SEC}`);
  return n;
}

/**
 * `verify <taskId> -- <command...>`: the colony runs the check itself and records the evidence on
 * the task. Evidence from the colony's own run outranks a host's "tests pass".
 */
export async function verifyTaskCommand(hub: ColonyHub, taskId: string | undefined, argv: string[], cwd: string, timeoutSec: number): Promise<VerifyOutput> {
  const task = taskId ? hub.orchestrator.getTask(taskId) : undefined;
  if (!task) throw new VerifyError(`task '${taskId ?? ''}' not found`);
  if (task.status !== 'completed') throw new VerifyError(`task '${task.id}' is ${task.status}: only a completed task can be verified`);
  if (argv.length === 0) throw new VerifyError('usage: verify <taskId> [--timeout-sec N] -- <command> [args...]');

  const joined = argv.join(' ');
  const refused = [checkDestructive(joined), checkSecrets(joined)].filter((r) => r !== null);
  if (refused.length > 0) throw new VerifyError(`the command is refused by the gates: ${refused.map((r) => r!.reason).join('; ')}`);

  const run = await runVerification(argv, cwd, timeoutSec * 1000);
  const verification: TaskVerification = {
    command: joined,
    exitCode: run.exitCode,
    passed: run.passed,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    at: Date.now(),
    outputHash: run.outputHash,
    outputBytes: run.outputBytes,
  };
  const { contradiction, capped } = await hub.orchestrator.verifyTask(task.id, verification);
  const after = hub.orchestrator.getTask(task.id)!;

  return {
    output: {
      verification: { ...verification, outputTail: redactText(run.tail).text },
      claimedTestRun: Boolean(task.verifiedByTest),
      contradiction,
      quality: { reported: after.reportedQuality ?? after.quality ?? null, effective: after.quality ?? null, loweredByCheck: capped },
      note: contradiction
        ? 'The host said a test run backed this work, but the colony\'s own run failed. The failed run counts; the quality was lowered.'
        : run.passed
          ? 'The colony ran the check itself and it passed. This is evidence the host did not just claim.'
          : 'The colony ran the check itself and it did not pass.',
    },
    audit: { tool: argv[0], exitCode: run.exitCode, passed: run.passed, timedOut: run.timedOut, outputHash: run.outputHash, contradiction, capped },
  };
}
