import path from 'node:path';
import { aggregateDecision, checkDestructive, checkDiffSize, checkSecrets, GateResult } from '../gates.js';
import { resolveInside, SafePathError } from '../safe-path.js';
import { toHostRequest } from '../host/claude-code.js';
import type { GuardDecision, GuardVerdict, ToolCall } from '../host/types.js';
import { scanBashCommand } from './bash-rules.js';
import { findProtectedWrite } from './shell-paths.js';

/**
 * The gates as an interceptor. A host that supports tool hooks (Claude Code's PreToolUse) calls
 * this BEFORE a tool runs, and the answer decides whether it runs. This is what turns the gates
 * from "a check you may call" into a rule the host cannot skip for the tools it covers.
 *
 * The checks work on host-neutral `ToolCall`s (see `../host/types.ts`); an adapter translates a
 * host's payload. Covered: shell commands (destructive operations, secrets, writes into the
 * colony's own directories), file writes and edits (path stays inside the project, the colony's
 * state files and `.git` are not edited directly, secrets, very large writes). Not covered: tools
 * the host did not wire to the hook, and anything the checks cannot see (a command built at run
 * time, a script that does the damage).
 */

export type HookDecision = GuardDecision;
export type HookVerdict = GuardVerdict;

export interface HookInput {
  tool_name?: unknown;
  tool_input?: unknown;
}

const LARGE_WRITE_LINES = 300;
const PROTECTED_TOP = new Set(['.colony', '.git']);

/** Judge one tool call. */
export async function evaluateToolCall(call: ToolCall, projectDir: string): Promise<GuardVerdict> {
  const results: GateResult[] = [];
  const add = (r: GateResult | null) => {
    if (r) results.push(r);
  };
  const reasons: string[] = [];
  let deny = false;
  let ask = false;

  if (call.kind === 'shell') {
    add(checkDestructive(call.command));
    add(checkSecrets(call.command));
    const protectedWrite = findProtectedWrite(call.command, projectDir);
    if (protectedWrite) {
      deny = true;
      reasons.push(protectedWrite.reason);
    }
    for (const finding of scanBashCommand(call.command)) {
      if (finding.decision === 'deny') deny = true;
      else ask = true;
      reasons.push(finding.reason);
    }
  } else if (call.kind === 'file-write') {
    if (!call.path) {
      deny = true;
      reasons.push(`${call.tool} without a file path is refused`);
    } else {
      try {
        const { relative } = await resolveInside(projectDir, call.path);
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
    for (const text of call.texts) {
      add(checkSecrets(text));
      add(checkDiffSize(call.path ?? 'file', text.split('\n').length, LARGE_WRITE_LINES));
    }
  }

  const gateDecision = aggregateDecision(results);
  for (const r of results) if (r.decision !== 'warn') reasons.push(r.reason);
  const notes = results.filter((r) => r.decision === 'warn').map((r) => r.reason);

  let decision: GuardDecision = 'allow';
  if (deny || gateDecision === 'block') decision = 'deny';
  else if (ask || gateDecision === 'require-confirmation') decision = 'ask';

  return {
    decision,
    reason: reasons.length > 0 ? `Colony guard: ${reasons.join('; ')}` : '',
    gates: results.map((r) => r.gate),
    notes,
  };
}

/** Judge a Claude Code PreToolUse payload (kept for callers and tests that hold the host's own format). */
export async function evaluatePreToolUse(input: HookInput, projectDir: string): Promise<GuardVerdict> {
  return evaluateToolCall(toHostRequest(input).call, projectDir);
}
