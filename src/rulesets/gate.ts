import fs from 'node:fs/promises';
import path from 'node:path';
import type { GateResult } from '../gates.js';
import { activeRulesets } from './active.js';
import { scanSecrets } from './loader.js';

/**
 * The vendored rule sets as a gate that only WARNS. The colony's own secret patterns still decide what is blocked; this
 * gate adds what a maintained rule set sees on top, and every such warning is recorded (rule names and counts, never a
 * value) in .colony/ruleset-warnings.jsonl, so that the false positives can be counted before anything blocks on it.
 * See docs/RULESETS-PLAN.md, section 6.
 */

/** A hook call checks at most this many characters of one text: the guard must not hold up a tool call. */
export const GUARD_SCAN_CHARS = 200_000;
/** ... and for at most this long (some rules are slow on long alphanumeric text): a partly checked text is said so. */
export const GUARD_BUDGET_MS = 1500;
export const WARNINGS_FILE = 'ruleset-warnings.jsonl';

export async function checkSecretsWithRulesets(text: string): Promise<GateResult[]> {
  const { loaded, failed } = await activeRulesets();
  const out: GateResult[] = [];
  for (const f of failed) {
    out.push({
      gate: 'secret-rulesets',
      decision: 'warn',
      reason: `The rule set '${f.name}' failed its checks and is NOT used (${f.error}). Secret detection runs without it.`,
      remediation: ['Run pnpm rulesets:verify to see which file differs.', 'Restore the rule set from git, or run the update again.'],
      details: { ruleset: f.name, unavailable: true },
    });
  }
  if (loaded.length === 0) return out;

  const scan = scanSecrets(text, loaded, { maxChars: GUARD_SCAN_CHARS, budgetMs: GUARD_BUDGET_MS });
  if (scan.incomplete) {
    out.push({
      gate: 'secret-rulesets',
      decision: 'warn',
      reason: `The rule set scan used up its time budget (${GUARD_BUDGET_MS} ms) on this text: only part of it was checked for secrets.`,
      remediation: ['Check the text yourself, or run colony check --file on a smaller piece.'],
      details: { incomplete: true },
    });
  }
  if (scan.truncated) {
    // said whatever the scan found: a text that is cut and has no finding must not look checked
    out.push({
      gate: 'secret-rulesets',
      decision: 'warn',
      reason: `This text is longer than ${GUARD_SCAN_CHARS} characters: only the first ${GUARD_SCAN_CHARS} were checked for secrets.`,
      remediation: ['Check the rest yourself, or run colony check --file on smaller pieces.'],
      details: { truncated: true, checkedChars: GUARD_SCAN_CHARS, totalChars: text.length },
    });
  }
  if (scan.findings.length === 0) return out;
  const rules = [...new Set(scan.findings.map((f) => f.rule))];
  // two rules often name the same secret (a provider rule and a generic one): that is one possible secret, not two
  let distinct = 0;
  let end = -1;
  for (const f of scan.findings) {
    if (f.offset >= end) {
      distinct++;
      end = f.offset + f.length;
    } else end = Math.max(end, f.offset + f.length);
  }
  const names = [...new Set(scan.findings.map((f) => `${f.ruleset} ${loaded.find((s) => s.name === f.ruleset)?.version ?? ''}`.trim()))];
  out.push({
    gate: 'secret-rulesets',
    decision: 'warn',
    reason: `${names.join(', ')} flags ${distinct} possible secret(s) (rule: ${rules.slice(0, 5).join(', ')}${rules.length > 5 ? ', ...' : ''}). This is a warning only; it does not block.`,
    remediation: [
      'If it is a real secret: move it to an environment variable or a secret store, and rotate it if it was shared.',
      'If it is not: nothing to do; the warning is recorded so that false positives can be counted.',
    ],
    details: {
      count: distinct,
      rules,
      findings: scan.findings.slice(0, 20),
      truncated: scan.truncated,
    },
  });
  return out;
}

/** Record the findings of this gate in the project's state folder, if it has one. Never throws, never holds a value. */
export async function logRulesetWarnings(projectDir: string, tool: string, results: GateResult[]): Promise<void> {
  const hits = results.filter((r) => (r.gate === 'secret-rulesets' || r.gate === 'command-rulesets') && typeof r.details.count === 'number');
  if (hits.length === 0) return;
  try {
    const stateDir = path.join(projectDir, '.colony');
    if (!(await fs.stat(stateDir)).isDirectory()) return;
    const lines = hits.map((r) => JSON.stringify({ at: Date.now(), tool, gate: r.gate, rules: r.details.rules, ...(Array.isArray(r.details.titles) ? { titles: r.details.titles } : {}), ...(Array.isArray(r.details.findings) && r.gate === 'command-rulesets' ? { findings: (r.details.findings as Array<Record<string, unknown>>).map((f) => ({ ruleset: f.ruleset, rule: f.rule, author: f.author })) } : {}), count: r.details.count, truncated: r.details.truncated === true }));
    await fs.appendFile(path.join(stateDir, WARNINGS_FILE), lines.join('\n') + '\n', 'utf-8');
  } catch {
    /* no state folder, or not writable: the warning was still shown */
  }
}
