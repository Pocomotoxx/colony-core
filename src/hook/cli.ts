import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePreToolUse, HookInput } from './pretool.js';

export interface HookRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * `colony hook pretool` for a host's PreToolUse hook: the tool call arrives as JSON on stdin.
 *
 * - deny  -> JSON with permissionDecision "deny" (the tool does not run).
 * - ask   -> JSON with permissionDecision "ask" (the host asks the user).
 * - allow -> NOTHING on stdout. An explicit "allow" would also skip the host's own permission
 *   prompts; the guard may only take permissions away, never grant them.
 * - unreadable input, or any internal failure -> exit 2: a guard that cannot do its job must not let
 *   the tool through. (An uncaught crash would exit 1, which a host treats as a non-blocking error.)
 */
export async function runHook(sub: string | undefined, stdinText: string, defaultDir: string, dirArg?: string): Promise<HookRun> {
  if (sub === 'install') return install(defaultDir);
  if (sub !== 'pretool') {
    return { code: 1, stdout: '', stderr: 'usage: colony hook pretool (reads the tool call as JSON on stdin) | colony hook install\n' };
  }
  let input: HookInput & { cwd?: unknown };
  try {
    input = JSON.parse(stdinText);
    if (typeof input !== 'object' || input === null) throw new Error('not an object');
  } catch {
    return { code: 2, stdout: '', stderr: 'Colony guard: the hook input is not valid JSON, so the tool call is refused.\n' };
  }
  const projectDir = path.resolve(dirArg ?? (typeof input.cwd === 'string' ? input.cwd : defaultDir));
  let verdict;
  try {
    verdict = await evaluatePreToolUse(input, projectDir);
  } catch (err) {
    return { code: 2, stdout: '', stderr: `Colony guard: the check failed (${err instanceof Error ? err.message : String(err)}), so the tool call is refused.
` };
  }
  const stderr = verdict.notes.length > 0 ? `Colony guard notes: ${verdict.notes.join('; ')}\n` : '';
  if (verdict.decision === 'allow') return { code: 0, stdout: '', stderr };
  const body = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: verdict.decision, permissionDecisionReason: verdict.reason } };
  return { code: 0, stdout: `${JSON.stringify(body)}\n`, stderr };
}

function install(dir: string): HookRun {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
  const snippet = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `node "${cli}" hook pretool` }] },
      ],
    },
  };
  const out = {
    ok: true,
    note: `Merge this into .claude/settings.json (or settings.local.json) of ${dir}. Nothing was written. The guard can refuse or ask; it never grants permissions.`,
    settings: snippet,
  };
  return { code: 0, stdout: `${JSON.stringify(out, null, 2)}\n`, stderr: '' };
}
