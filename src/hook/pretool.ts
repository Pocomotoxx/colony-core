import path from 'node:path';
import { aggregateDecision, checkDestructive, checkDiffSize, checkSecrets, GateResult } from '../gates.js';
import { resolveInside, SafePathError } from '../safe-path.js';
import { scanBashCommand } from './bash-rules.js';
import { findProtectedWrite } from './shell-paths.js';

/**
 * The gates as an interceptor. A host that supports tool hooks (Claude Code's PreToolUse) calls
 * this BEFORE a tool runs, and the answer decides whether it runs. This is what turns the gates
 * from "a check you may call" into a rule the host cannot skip for the tools it covers.
 *
 * Covered: shell commands (destructive operations, secrets), file writes and edits (path stays
 * inside the project, the colony's own state files and `.git` are not edited directly, secrets,
 * very large writes). Not covered: tools the host did not wire to the hook, and anything the
 * checks cannot see (a command built at run time, a script that does the damage).
 */

export type HookDecision = 'allow' | 'ask' | 'deny';

export interface HookVerdict {
  decision: HookDecision;
  /** Shown to the host/user. Never contains a secret. */
  reason: string;
  /** Names of the gates that fired. */
  gates: string[];
  /** Non-blocking notes (warnings). */
  notes: string[];
}

export interface HookInput {
  tool_name?: unknown;
  tool_input?: unknown;
}

const LARGE_WRITE_LINES = 300;
const PROTECTED_TOP = new Set(['.colony', '.git']);

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The tools that run a shell command. The host has a separate PowerShell tool (the usual shell on Windows). */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** The tools that write files, and the field that names the file (NotebookEdit uses notebook_path). */
const FILE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

function collectText(tool: string, input: Record<string, unknown>): string[] {
  if (tool === 'NotebookEdit') return [asString(input.new_source) ?? ''];
  if (tool === 'Write') return [asString(input.content) ?? ''];
  if (tool === 'Edit') return [asString(input.new_string) ?? ''];
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits.map((e) => asString(asRecord(e).new_string) ?? '');
  }
  return [];
}

export async function evaluatePreToolUse(input: HookInput, projectDir: string): Promise<HookVerdict> {
  const tool = asString(input.tool_name) ?? '';
  const args = asRecord(input.tool_input);
  const results: GateResult[] = [];
  const add = (r: GateResult | null) => {
    if (r) results.push(r);
  };
  const reasons: string[] = [];
  let deny = false;

  let ask = false;
  if (SHELL_TOOLS.has(tool)) {
    const command = asString(args.command) ?? '';
    add(checkDestructive(command));
    add(checkSecrets(command));
    const protectedWrite = findProtectedWrite(command, projectDir);
    if (protectedWrite) {
      deny = true;
      reasons.push(protectedWrite.reason);
    }
    for (const finding of scanBashCommand(command)) {
      if (finding.decision === 'deny') deny = true;
      else ask = true;
      reasons.push(finding.reason);
    }
  } else if (tool in FILE_TOOLS) {
    const file = asString(args[FILE_TOOLS[tool]]);
    if (!file) {
      deny = true;
      reasons.push(`${tool} without a file path is refused`);
    } else {
      try {
        const { relative } = await resolveInside(projectDir, file);
        const top = relative.split(path.sep)[0].toLowerCase(); // .COLONY is the same directory on Windows and macOS
        if (PROTECTED_TOP.has(top)) {
          deny = true;
          reasons.push(top === '.colony'
            ? "the colony's state and rule files change only through colony commands, not by editing them directly"
            : 'files under .git are not edited directly');
        }
      } catch (err) {
        if (!(err instanceof SafePathError)) throw err;
        deny = true;
        reasons.push(err.code === 'OUTSIDE' ? 'the path is outside the project directory' : `the path is refused (${err.message})`);
      }
    }
    for (const text of collectText(tool, args)) {
      add(checkSecrets(text));
      add(checkDiffSize(file ?? 'file', text.split('\n').length, LARGE_WRITE_LINES));
    }
  }

  const gateDecision = aggregateDecision(results);
  for (const r of results) if (r.decision !== 'warn') reasons.push(r.reason);
  const notes = results.filter((r) => r.decision === 'warn').map((r) => r.reason);

  let decision: HookDecision = 'allow';
  if (deny || gateDecision === 'block') decision = 'deny';
  else if (ask || gateDecision === 'require-confirmation') decision = 'ask';

  return {
    decision,
    reason: reasons.length > 0 ? `Colony guard: ${reasons.join('; ')}` : '',
    gates: results.map((r) => r.gate),
    notes,
  };
}
