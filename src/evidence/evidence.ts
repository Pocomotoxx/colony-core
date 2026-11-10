import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkSecrets } from '../gates.js';
import { errorCode } from '../errors.js';
import type { TaskVerification } from '../types.js';

/**
 * Evidence the HOST'S HOOK saw: a test or build command ran and ended with this exit status.
 *
 * It is not the model's report. The host calls the hook after the tool ran, so the record exists
 * whatever the model later says. Claude Code (checked live, 2.1.281): a command that exits 0 fires
 * `PostToolUse`; one that exits non-zero fires `PostToolUseFailure` with `error: "Exit code N\n..."`.
 *
 * Honest limits: only commands that look like a check (see CHECK_PATTERNS) are recorded, a command
 * that pipes its output or masks its exit status (`| tail`, `|| true`) is NOT recorded because its
 * exit status says nothing about the check, and whoever can run the colony CLI could write a record
 * by hand (the guard refuses `hook` subcommands in shell tools, which is a text check, not a seal).
 */

export const EVIDENCE_FILE = 'evidence.jsonl';

export interface EvidenceRecord {
  v: 1;
  at: number;
  /** The host's session id, or null when the host gave none. */
  session: string | null;
  tool: string;
  command: string;
  outcome: 'passed' | 'failed';
  exitCode: number | null;
  durationMs: number | null;
  /** Short hash of the output (stdout for a pass, the error text for a failure); the output is not stored. */
  outputHash: string;
  outputBytes: number;
  interrupted: boolean;
}

/** Commands that are a check: they start with one of these (after environment assignments). */
const CHECK_PATTERNS: RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|build|lint|typecheck|type-check|check|ci|verify|coverage)\b/,
  /^(?:npx|pnpm\s+exec|pnpm\s+dlx|yarn\s+dlx|bunx)\s+(?:--?\S+\s+)*(?:tsc|vitest|jest|eslint|prettier|mocha|playwright|cypress|ava|tap|biome)\b/,
  /^(?:tsc|vitest|jest|eslint|mocha)\b/,
  /^biome\s+(?:check|ci)\b/,
  /^node\s+(?:--\S+\s+)*--test\b/,
  /^(?:python3?|py)\s+-m\s+(?:pytest|unittest|mypy|ruff|flake8|pylint)\b/,
  /^(?:pytest|mypy|ruff|flake8|pylint|tox|nox)\b/,
  /^go\s+(?:test|vet|build)\b/,
  /^cargo\s+(?:test|build|check|clippy)\b/,
  /^dotnet\s+(?:test|build)\b/,
  /^(?:mvn|\.\/mvnw|mvnw)\b.*\b(?:test|verify|package|install)\b/,
  /^(?:gradle|\.\/gradlew|gradlew)\b.*\b(?:test|build|check)\b/,
  /^make\s+(?:test|check|build|lint)\b/,
  /^(?:phpunit|rspec|rake\s+test|bundle\s+exec\s+rspec|composer\s+(?:run\s+)?test)\b/,
];

/** Split on `&&`, `;` and newlines outside quotes. A pipe is NOT split: its presence is what we look for. */
function chain(command: string): { parts: string[]; piped: boolean } {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  let piped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '|' && command[i + 1] !== '|') piped = true;
    if (ch === ';' || ch === '\n' || (ch === '&' && command[i + 1] === '&')) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      if (ch === '&') i++;
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return { parts, piped };
}

export interface CheckCommand {
  /** The command is a test/build/lint/typecheck. */
  check: boolean;
  /** Its exit status tells whether the check passed (no pipe, nothing masks the status). */
  reliable: boolean;
}

export function classifyCommand(command: string): CheckCommand {
  const { parts, piped } = chain(command);
  const isCheck = parts.some((p) => {
    const body = p.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').replace(/^cd\s+\S+\s*$/, '');
    return CHECK_PATTERNS.some((re) => re.test(body));
  });
  const masked = /\|\|\s*(?:true|:|exit\s+0)\b/.test(command) || /;\s*(?:true|:)\s*$/.test(command) || /^\s*!\s/.test(command);
  return { check: isCheck, reliable: !piped && !masked };
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export interface ToolOutcome {
  session: string | null;
  tool: string;
  command: string;
  /** The hook event: `PostToolUse` (the tool succeeded) or `PostToolUseFailure`. */
  succeeded: boolean;
  durationMs: number | null;
  interrupted: boolean;
  /** stdout of a success, or the error text of a failure. */
  outputText: string;
}

/** The record for a finished shell command, or null when it is not evidence (not a check, or unreliable). */
export function toEvidence(outcome: ToolOutcome, now: number = Date.now()): EvidenceRecord | null {
  const kind = classifyCommand(outcome.command);
  if (!kind.check || !kind.reliable) return null;
  const exit = outcome.succeeded ? 0 : Number(outcome.outputText.match(/^Exit code (\d+)/)?.[1] ?? NaN);
  const command = checkSecrets(outcome.command) ? '[command withheld: it contains a secret]' : outcome.command.slice(0, 300);
  return {
    v: 1,
    at: now,
    session: outcome.session,
    tool: outcome.tool,
    command,
    outcome: outcome.succeeded && !outcome.interrupted ? 'passed' : 'failed',
    exitCode: Number.isFinite(exit) ? exit : null,
    durationMs: outcome.durationMs,
    outputHash: hash(outcome.outputText),
    outputBytes: Buffer.byteLength(outcome.outputText),
    interrupted: outcome.interrupted,
  };
}

export async function appendEvidence(stateDir: string, record: EvidenceRecord): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.appendFile(path.join(stateDir, EVIDENCE_FILE), `${JSON.stringify(record)}\n`, 'utf-8');
}

export async function readEvidence(stateDir: string, filter: { since?: number; session?: string | null } = {}): Promise<EvidenceRecord[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(stateDir, EVIDENCE_FILE), 'utf-8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return [];
    throw err;
  }
  const out: EvidenceRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as EvidenceRecord;
      if (r?.v !== 1 || typeof r.at !== 'number') continue;
      if (filter.since !== undefined && r.at < filter.since) continue;
      if (filter.session && r.session !== filter.session) continue;
      out.push(r);
    } catch {
      // a half-written or damaged line is skipped, not fatal
    }
  }
  return out;
}

/**
 * The evidence as a task verification: the LATEST check the host's hook saw, from `since` on.
 * Only the latest counts: a failing run that was fixed and run again is a pass; a pass followed by
 * a failing run is a fail.
 */
export function latestAsVerification(records: readonly EvidenceRecord[]): TaskVerification | null {
  const last = [...records].sort((a, b) => a.at - b.at).pop();
  if (!last) return null;
  return {
    command: last.command,
    exitCode: last.exitCode,
    passed: last.outcome === 'passed',
    timedOut: false,
    durationMs: last.durationMs ?? 0,
    at: last.at,
    outputHash: last.outputHash,
    outputBytes: last.outputBytes,
    source: 'observed',
  };
}
