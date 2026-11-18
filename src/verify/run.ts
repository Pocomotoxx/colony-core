import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * The colony runs a check itself, so a result does not rest on what the host says.
 *
 * - No shell on POSIX: the command is an argument list, so nothing in it is interpreted.
 * - On Windows the package managers are .cmd files that need cmd.exe; there every argument must be
 *   plain (letters, digits and `@ . / : = + -`), so no shell syntax can get through.
 * - Time limit, with the whole process tree stopped when it runs out.
 * - Output is hashed and counted, never stored. Only a redactable tail comes back to the caller.
 */

export interface RunResult {
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  durationMs: number;
  outputHash: string;
  outputBytes: number;
  /** The last part of the output, for the caller to show. Not persisted. */
  tail: string;
}

export class VerifyError extends Error {}

const MAX_HASHED = 4 * 1024 * 1024;
const TAIL_CHARS = 2000;
const WIN_CMD_TOOLS = new Set(['npm', 'pnpm', 'npx', 'yarn']);
const PLAIN_ARG = /^[A-Za-z0-9@._/:=+\\-]+$/;

/**
 * Stops the child and everything it started. On POSIX the child leads its own process group (see the spawn below),
 * so the signal goes to the group; the direct child alone is the fallback.
 */
function killGroup(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export function runVerification(argv: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  if (argv.length === 0 || !argv[0]) return Promise.reject(new VerifyError('no command given'));
  const [tool, ...args] = argv;
  const win = process.platform === 'win32';
  let file = tool;
  let fileArgs = args;
  if (win && WIN_CMD_TOOLS.has(tool.toLowerCase())) {
    const bad = argv.find((a) => !PLAIN_ARG.test(a));
    if (bad !== undefined) return Promise.reject(new VerifyError('on Windows, package-manager commands may only use plain arguments (letters, digits and @ . / : = + -)'));
    file = process.env.ComSpec ?? 'cmd.exe';
    fileArgs = ['/d', '/s', '/c', [tool, ...args].join(' ')];
  }

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const hash = createHash('sha256');
    let bytes = 0;
    let tail = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(file, fileArgs, { cwd, shell: false, windowsHide: true, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new VerifyError(`could not start '${tool}': ${(err as Error).message}`));
      return;
    }
    const onData = (chunk: Buffer) => {
      if (bytes < MAX_HASHED) hash.update(chunk);
      bytes += chunk.length;
      tail = (tail + chunk.toString('utf-8')).slice(-TAIL_CHARS);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      timedOut = true;
      if (win && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      else killGroup(child);
    }, timeoutMs);

    // The child leads its own process group on POSIX, so a Ctrl-C or a termination of the colony no longer
    // reaches it through the terminal: stop the group here, then let the signal take its default course.
    const onSignal = (signal: NodeJS.Signals) => {
      killGroup(child);
      release();
      process.kill(process.pid, signal);
    };
    const release = () => {
      clearTimeout(timer);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    };
    if (!win) {
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
    }

    child.on('error', (err) => {
      release();
      reject(new VerifyError(`could not run '${tool}': ${err.message}`));
    });
    child.on('close', (code) => {
      release();
      resolve({
        exitCode: code,
        passed: code === 0 && !timedOut,
        timedOut,
        durationMs: Date.now() - started,
        outputHash: hash.digest('hex').slice(0, 16),
        outputBytes: bytes,
        tail,
      });
    });
  });
}
