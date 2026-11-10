import type { ToolOutcome } from '../evidence/evidence.js';
import type { GuardVerdict, HostRequest, ToolCall } from './types.js';

/**
 * The Claude Code adapter: its hook payloads in, its hook answers out.
 *
 * Checked against the hooks documentation and against a live Claude Code 2.1.281 session (the
 * PreToolUse payload: session_id, transcript_path, cwd, prompt_id, permission_mode, effort,
 * hook_event_name, tool_name, tool_input, tool_use_id; Windows paths are absolute with backslashes).
 */

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The tools that run a shell command. PowerShell is a separate tool from Bash (the usual shell on Windows). */
export const SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell'];
/** The tools that write files, and the field that names the file (NotebookEdit uses notebook_path). */
export const FILE_TOOLS: Readonly<Record<string, string>> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

/** The PreToolUse matcher that covers every tool the guard understands. */
export const PRETOOL_MATCHER = [...SHELL_TOOLS, ...Object.keys(FILE_TOOLS)].join('|');

function texts(tool: string, input: Record<string, unknown>): string[] {
  if (tool === 'NotebookEdit') return [asString(input.new_source) ?? ''];
  if (tool === 'Write') return [asString(input.content) ?? ''];
  if (tool === 'Edit') return [asString(input.new_string) ?? ''];
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits.map((e) => asString(asRecord(e).new_string) ?? '');
  }
  return [];
}

/** A Claude Code hook payload as a host-neutral request. */
export function toHostRequest(payload: unknown): HostRequest {
  const p = asRecord(payload);
  const tool = asString(p.tool_name) ?? '';
  const input = asRecord(p.tool_input);
  let call: ToolCall;
  if (SHELL_TOOLS.includes(tool)) call = { kind: 'shell', command: asString(input.command) ?? '' };
  else if (tool in FILE_TOOLS) call = { kind: 'file-write', tool, path: asString(input[FILE_TOOLS[tool]]), texts: texts(tool, input) };
  else call = { kind: 'other', name: tool };
  return { call, session: { id: asString(p.session_id), cwd: asString(p.cwd) } };
}

/**
 * What a PreToolUse hook prints for a verdict. `allow` prints NOTHING: an explicit "allow" would also
 * skip the host's own permission prompts, and the guard may only take permissions away.
 */
export function preToolUseOutput(verdict: GuardVerdict): string {
  if (verdict.decision === 'allow') return '';
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: verdict.decision, permissionDecisionReason: verdict.reason } })}\n`;
}

/**
 * A finished shell command as the host's hook reports it. Measured live (Claude Code 2.1.281):
 * a command that exits 0 fires `PostToolUse` with `tool_response.stdout`; a non-zero exit fires
 * `PostToolUseFailure` with `error: "Exit code N\n<stderr>"` and `is_interrupt`. There is no exit
 * code field on the success event, which is why the event itself is the outcome.
 */
export function toToolOutcome(payload: unknown): ToolOutcome | null {
  const p = asRecord(payload);
  const tool = asString(p.tool_name) ?? '';
  if (!SHELL_TOOLS.includes(tool)) return null;
  const event = asString(p.hook_event_name);
  if (event !== 'PostToolUse' && event !== 'PostToolUseFailure') return null;
  const command = asString(asRecord(p.tool_input).command);
  if (!command) return null;
  const response = asRecord(p.tool_response);
  const succeeded = event === 'PostToolUse';
  return {
    session: asString(p.session_id) ?? null,
    tool,
    command,
    succeeded,
    durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : null,
    interrupted: p.is_interrupt === true || response.interrupted === true,
    outputText: succeeded ? (asString(response.stdout) ?? '') : (asString(p.error) ?? ''),
  };
}

/** The submitted prompt of a UserPromptSubmit payload. */
export function promptText(payload: unknown): string {
  return asString(asRecord(payload).prompt) ?? '';
}

export function sessionIdOf(payload: unknown): string | undefined {
  return asString(asRecord(payload).session_id);
}

/** What a SessionStart / UserPromptSubmit hook prints to hand the model some context. Nothing when there is none. */
export function contextOutput(event: 'SessionStart' | 'UserPromptSubmit', context: string | null): string {
  if (!context) return '';
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } })}\n`;
}

export interface HookSpec {
  event: string;
  matcher?: string;
  /** The colony hook subcommand. */
  sub: string;
  timeoutSeconds: number;
}

/** Every hook the colony wants installed, in Claude Code's settings format. */
export const COLONY_HOOKS: readonly HookSpec[] = [
  { event: 'PreToolUse', matcher: PRETOOL_MATCHER, sub: 'pretool', timeoutSeconds: 10 },
  { event: 'PostToolUse', matcher: SHELL_TOOLS.join('|'), sub: 'posttool', timeoutSeconds: 10 },
  { event: 'PostToolUseFailure', matcher: SHELL_TOOLS.join('|'), sub: 'posttool', timeoutSeconds: 10 },
  { event: 'SessionStart', sub: 'session', timeoutSeconds: 10 },
  { event: 'UserPromptSubmit', sub: 'prompt', timeoutSeconds: 10 },
];

type HookGroup = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> };

/** The settings.json `hooks` block for the colony, given the path of its CLI. */
export function hookSettings(cliPath: string): { hooks: Record<string, HookGroup[]> } {
  const cli = cliPath.replace(/\\/g, '/'); // forward slashes: the host runs the command through a shell
  const hooks: Record<string, HookGroup[]> = {};
  for (const h of COLONY_HOOKS) {
    const group: HookGroup = { hooks: [{ type: 'command', command: `node "${cli}" hook ${h.sub}`, timeout: h.timeoutSeconds }] };
    if (h.matcher) group.matcher = h.matcher;
    (hooks[h.event] ??= []).push(group);
  }
  return { hooks };
}

/**
 * Add the colony's hooks to an existing settings object without touching anything else. A hook that
 * is already there (same command in the same event) is not added twice.
 */
export function mergeHookSettings(existing: unknown, ours: { hooks: Record<string, HookGroup[]> }): { merged: Record<string, unknown>; added: string[] } {
  const merged = JSON.parse(JSON.stringify(typeof existing === 'object' && existing !== null && !Array.isArray(existing) ? existing : {})) as Record<string, unknown>;
  const hooks = (typeof merged.hooks === 'object' && merged.hooks !== null && !Array.isArray(merged.hooks) ? merged.hooks : {}) as Record<string, HookGroup[]>;
  const added: string[] = [];
  for (const [event, groups] of Object.entries(ours.hooks)) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : [];
    for (const group of groups) {
      const command = group.hooks[0].command;
      if (current.some((g) => Array.isArray(g?.hooks) && g.hooks.some((x) => x?.command === command))) continue;
      current.push(group);
      added.push(`${event}: ${command.replace(/^.*\bhook /, 'hook ')}`);
    }
    hooks[event] = current;
  }
  merged.hooks = hooks;
  return { merged, added };
}
