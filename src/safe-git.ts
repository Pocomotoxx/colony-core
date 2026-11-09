/**
 * Git calls that cannot be steered by the repository they inspect.
 *
 * From the legacy `security` safe-git wrapper. `core.fsmonitor` is repository-local configuration
 * that names a command; a copied or hostile repository can use it to make `git status` run that
 * command. A `-c` on the command line outranks local configuration, so every call sets it off.
 *
 * Honest limit: this closes that one known route. It does not claim that every command-bearing
 * git setting is neutralized, so this wrapper is the single place to add reviewed overrides.
 */

import { execFileSync } from 'node:child_process';

const OVERRIDES = ['-c', 'core.fsmonitor=false'] as const;
const MAX_BUFFER = 4 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export function safeGitArgv(repoDir: string, args: readonly string[]): string[] {
  if (!repoDir || repoDir.includes('\0')) throw new Error('git repository path is invalid');
  for (const arg of args) if (arg.includes('\0')) throw new Error('git argument contains a NUL byte');
  return [...OVERRIDES, '-C', repoDir, ...args];
}

/** Run git in `repoDir` and return trimmed stdout. Throws on a non-zero exit. */
export function safeGitText(repoDir: string, args: readonly string[]): string {
  return execFileSync('git', safeGitArgv(repoDir, args), {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: MAX_BUFFER,
    timeout: TIMEOUT_MS,
    windowsHide: true,
  }).trim();
}
