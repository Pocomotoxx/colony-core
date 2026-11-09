/**
 * Enforcement gates: pure checks a host runs BEFORE it acts.
 *
 * Rewritten from the legacy `guidance` gates (destructive operations, secrets, diff size, tool
 * allowlist). Honest limit: a gate here is a check the host chooses to call (`colony check`).
 * Nothing intercepts the host, so a gate proves nothing about work that skipped it.
 *
 * Differences from the legacy code:
 * - A detected secret is never echoed, not even partly: the result names the pattern and the
 *   position only. The legacy gate showed the first and last four characters.
 * - No rule objects and no hook plumbing: the result carries the gate name and a remediation.
 * - Broader destructive patterns (`rm -fr`, `rm -r -f`, `git push -f`).
 */

export type GateDecision = 'allow' | 'warn' | 'require-confirmation' | 'block';

export interface GateResult {
  gate: 'destructive-ops' | 'secrets' | 'diff-size' | 'tool-allowlist';
  decision: Exclude<GateDecision, 'allow'>;
  reason: string;
  remediation: string[];
  /** Gate-specific facts. Never contains the text of a secret. */
  details: Record<string, unknown>;
}

const SEVERITY: Record<GateDecision, number> = { allow: 0, warn: 1, 'require-confirmation': 2, block: 3 };

const DESTRUCTIVE: Array<{ name: string; pattern: RegExp }> = [
  { name: 'rm with -r or -f', pattern: /\brm\s+(?:-[a-z]+\s+)*-[a-z]*[rf][a-z]*\b/i },
  { name: 'drop database/table/schema/index', pattern: /\bdrop\s+(?:database|table|schema|index)\b/i },
  { name: 'truncate table', pattern: /\btruncate\s+table\b/i },
  { name: 'git force push', pattern: /\bgit\s+push\b[^\n]*\s(?:--force\b|-f\b)/i },
  { name: 'git reset --hard', pattern: /\bgit\s+reset\s+--hard\b/i },
  { name: 'git clean -f', pattern: /\bgit\s+clean\s+-[a-z]*f/i },
  { name: 'format drive', pattern: /\bformat\s+[a-z]:/i },
  { name: 'del /s or /f', pattern: /\bdel\s+\/[sf]\b/i },
  { name: 'kubectl/helm delete all or namespace', pattern: /\b(?:kubectl|helm)\s+delete\s+(?:--all|namespace)\b/i },
  { name: 'delete without where', pattern: /\bdelete\s+from\s+\w+\s*(?:;|["'`)]|$)/i },
  { name: 'alter table drop', pattern: /\balter\s+table\s+\w+\s+drop\b/i },
];

const SECRETS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'api key assignment', pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{8,}['"]/gi },
  { name: 'password/secret assignment', pattern: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi },
  { name: 'token assignment', pattern: /(?:token|bearer)\s*[:=]\s*['"][^'"]{10,}['"]/gi },
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'sk- style key', pattern: /\bsk-[a-zA-Z0-9]{20,}/g },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[a-zA-Z0-9]{36}\b/g },
  { name: 'npm token', pattern: /\bnpm_[a-zA-Z0-9]{36}\b/g },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
];

export function checkDestructive(command: string): GateResult | null {
  for (const { name, pattern } of DESTRUCTIVE) {
    if (pattern.test(command)) {
      return {
        gate: 'destructive-ops',
        decision: 'require-confirmation',
        reason: `Destructive operation: ${name}. It needs explicit confirmation and a rollback plan first.`,
        remediation: [
          'Confirm with the user that the operation is intended.',
          'Write down the rollback (git ref, backup, undo command) before running it.',
          'For a migration, make sure it has a down step.',
        ],
        details: { matched: name },
      };
    }
  }
  return null;
}

/** Where secret-looking text sits in `text`: pattern name, offset and length. The value is not copied out. */
export function findSecretSpans(text: string): Array<{ pattern: string; offset: number; length: number }> {
  const found: Array<{ pattern: string; offset: number; length: number }> = [];
  for (const { name, pattern } of SECRETS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      found.push({ pattern: name, offset: match.index ?? 0, length: match[0].length });
    }
  }
  return found.sort((a, b) => a.offset - b.offset);
}

/** Find secret-looking text. The result reports the pattern name and offsets, never the value. */
export function checkSecrets(text: string): GateResult | null {
  const found = findSecretSpans(text);
  if (found.length === 0) return null;
  return {
    gate: 'secrets',
    decision: 'block',
    reason: `Found ${found.length} potential secret(s). Secrets must not be committed or exposed.`,
    remediation: [
      'Move the secret to an environment variable or a secret store.',
      'If it was already committed or shared, treat it as leaked and rotate it.',
    ],
    details: { count: found.length, findings: found },
  };
}

export function checkDiffSize(path: string, lines: number, threshold = 300): GateResult | null {
  if (!Number.isFinite(lines) || lines < 0) throw new Error('diff size must be a non-negative number');
  if (lines <= threshold) return null;
  return {
    gate: 'diff-size',
    decision: 'warn',
    reason: `The diff for '${path}' is ${lines} lines (threshold ${threshold}). Large changes should be planned and staged.`,
    remediation: [
      'Plan the change as a few logical commits.',
      'Run the tests after each commit.',
      'Consider splitting it into several pull requests.',
    ],
    details: { path, lines, threshold },
  };
}

/** An allowlist entry is an exact tool name, `*`, or a prefix ending in `*`. An empty list allows everything. */
export function checkToolAllowed(tool: string, allowlist: readonly string[]): GateResult | null {
  if (allowlist.length === 0) return null;
  const allowed = allowlist.some((entry) => entry === '*' || entry === tool || (entry.endsWith('*') && tool.startsWith(entry.slice(0, -1))));
  if (allowed) return null;
  return {
    gate: 'tool-allowlist',
    decision: 'block',
    reason: `Tool '${tool}' is not on the allowlist.`,
    remediation: [`Get the user's approval for '${tool}' or add it to the allowlist.`],
    details: { tool, allowlist: [...allowlist] },
  };
}

/** The most restrictive decision among the results. */
export function aggregateDecision(results: readonly GateResult[]): GateDecision {
  let worst: GateDecision = 'allow';
  for (const r of results) if (SEVERITY[r.decision] > SEVERITY[worst]) worst = r.decision;
  return worst;
}
