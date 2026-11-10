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
