import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../atomic-write.js';
import { errorCode, errorMessage } from '../errors.js';
import { contextOutput, hookSettings, mergeHookSettings, preToolUseOutput, promptText, sessionIdOf, toHostRequest, toToolOutcome } from '../host/claude-code.js';
import { evaluateToolCall } from './pretool.js';

export interface HookRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HookOptions {
  /** `--dir`: the project directory, instead of the one the host reports. */
  dirArg?: string;
  /** `hook install --apply`: write the settings instead of printing them. */
  apply?: boolean;
  /** The host's environment file, where a session hook can export variables for later shell commands. */
  envFile?: string;
}

const USAGE = 'usage: colony hook pretool|posttool|session|prompt (the host calls these; the event arrives as JSON on stdin) | colony hook install [--apply]\n';

function parseInput(stdinText: string): { cwd?: unknown } | null {
  try {
    // Windows PowerShell 5.1 puts a UTF-8 byte order mark in front of text piped to a program; JSON.parse rejects it.
    const input = JSON.parse(stdinText.replace(/^\uFEFF/, ''));
    return typeof input === 'object' && input !== null ? input : null;
  } catch {
    return null;
  }
}

/**
 * The colony's hook entry points, one subcommand per host event.
 *
 * - `pretool` (PreToolUse), the guard:
 *   deny -> JSON with permissionDecision "deny"; ask -> "ask"; allow -> NOTHING on stdout, because an
 *   explicit "allow" would also skip the host's own permission prompts (the guard only takes
 *   permissions away). Unreadable input or any internal failure -> exit 2: a guard that cannot do its
 *   job must not let the tool through (an uncaught crash would exit 1, a non-blocking error).
 * - `posttool` (PostToolUse and PostToolUseFailure): record a finished test/build command as evidence.
 * - `session` (SessionStart): export the session id for later commands, say what the colony is.
 * - `prompt` (UserPromptSubmit): recall similar earlier work for the model to show the user.
 *   The last three NEVER block: exit 2 on UserPromptSubmit would swallow the user's prompt, so a
 *   failure there is reported on stderr and the host carries on.
 */
export async function runHook(sub: string | undefined, stdinText: string, defaultDir: string, dirArg?: string, options: Omit<HookOptions, 'dirArg'> = {}): Promise<HookRun> {
  if (sub === 'install') return install(dirArg ?? defaultDir, Boolean(options.apply));
  if (sub !== 'pretool' && sub !== 'posttool' && sub !== 'session' && sub !== 'prompt') {
    return { code: 1, stdout: '', stderr: USAGE };
  }

  const input = parseInput(stdinText);
  if (!input) {
    return sub === 'pretool'
      ? { code: 2, stdout: '', stderr: 'Colony guard: the hook input is not valid JSON, so the tool call is refused.\n' }
      : { code: 0, stdout: '', stderr: `Colony hook ${sub}: the input is not valid JSON; nothing was done.\n` };
  }
  const projectDir = path.resolve(dirArg ?? (typeof input.cwd === 'string' ? input.cwd : defaultDir));

  if (sub === 'pretool') {
    let verdict;
    try {
      verdict = await evaluateToolCall(toHostRequest(input).call, projectDir);
    } catch (err) {
      return { code: 2, stdout: '', stderr: `Colony guard: the check failed (${errorMessage(err)}), so the tool call is refused.\n` };
    }
    const stderr = verdict.notes.length > 0 ? `Colony guard notes: ${verdict.notes.join('; ')}\n` : '';
    return { code: 0, stdout: preToolUseOutput(verdict), stderr };
  }

  try {
    const events = await import('./events.js');
    if (sub === 'posttool') {
      const outcome = toToolOutcome(input);
      if (outcome) await events.handleToolOutcome(outcome, projectDir);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (sub === 'session') {
      const result = await events.handleSessionStart(sessionIdOf(input), projectDir);
      if (result.envLine && options.envFile) await fs.appendFile(options.envFile, `${result.envLine}\n`, 'utf-8');
      return { code: 0, stdout: contextOutput('SessionStart', result.context), stderr: '' };
    }
    const context = await events.handlePrompt(promptText(input), sessionIdOf(input), projectDir);
    return { code: 0, stdout: contextOutput('UserPromptSubmit', context), stderr: '' };
  } catch (err) {
    return { code: 0, stdout: '', stderr: `Colony hook ${sub} failed and was skipped: ${errorMessage(err)}\n` };
  }
}

async function install(dir: string, apply: boolean): Promise<HookRun> {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
  const ours = hookSettings(cli);
  if (!apply) {
    const out = {
      ok: true,
      applied: false,
      note: `These are the hooks the colony wants in ${path.join(dir, '.claude', 'settings.json')}. Nothing was written. \`colony hook install --apply\` merges them in (an existing file is kept as settings.json.bak). The guard can refuse or ask; it never grants permissions.`,
      settings: ours,
    };
    return { code: 0, stdout: `${JSON.stringify(out, null, 2)}\n`, stderr: '' };
  }

  const file = path.join(dir, '.claude', 'settings.json');
  let existing: unknown = {};
  let hadFile = false;
  try {
    existing = JSON.parse(await fs.readFile(file, 'utf-8'));
    hadFile = true;
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') {
      return { code: 1, stdout: '', stderr: `${file} exists but is not valid JSON (${errorMessage(err)}); fix or remove it first, nothing was changed.\n` };
    }
  }
  const { merged, added } = mergeHookSettings(existing, ours);
  if (added.length > 0) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (hadFile) await fs.copyFile(file, `${file}.bak`);
    await writeFileAtomic(file, `${JSON.stringify(merged, null, 2)}\n`);
  }
  const out = { ok: true, applied: added.length > 0, file, backup: hadFile && added.length > 0 ? `${file}.bak` : null, added, note: added.length === 0 ? 'The colony hooks were already there; nothing changed.' : 'Written. Restart the Claude Code session for the hooks to take effect.' };
  return { code: 0, stdout: `${JSON.stringify(out, null, 2)}\n`, stderr: '' };
}
