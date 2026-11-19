import { parseToml, type TomlTable, type TomlValue } from './toml-lite.js';
import { translateRe2, UnsupportedRegex } from './re2.js';
import type { ConversionReport, RuleAllowlist, RuleEntry, RulePattern, RulesetFile, SkippedRule } from './types.js';

/**
 * Convert a gitleaks configuration (the file `config/gitleaks.toml` of a release) into the colony's rule set format.
 * Nothing is converted on trust: a regex that does not compile after translation, a rule without a regex, or a rule
 * with a key this converter does not know is skipped with its reason, and the report says how many.
 */

const RULE_KEYS = new Set(['id', 'description', 'regex', 'path', 'keywords', 'entropy', 'secretGroup', 'tags', 'allowlists', 'skipReport']);
const ALLOWLIST_KEYS = new Set(['description', 'regexes', 'stopwords', 'regexTarget', 'condition', 'paths', 'commits', 'targetRules', 'matchCondition']);

const isTable = (v: TomlValue | undefined): v is TomlTable => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: TomlValue | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function compile(pattern: string): RulePattern {
  const t = translateRe2(pattern);
  try {
    new RegExp(t.source, `${t.flags}dg`);
  } catch (err) {
    throw new UnsupportedRegex(`does not compile in JavaScript (${err instanceof Error ? err.message : String(err)})`);
  }
  return { source: t.source, flags: t.flags };
}

function convertAllowlist(table: TomlTable, dropped: Record<string, number>): RuleAllowlist | null {
  const regexes: RulePattern[] = [];
  for (const r of strings(table.regexes)) {
    try {
      regexes.push(compile(r));
    } catch {
      // a regex that cannot be carried over would have allowed something: leaving it out only means more findings
      dropped['allowlist regexes that did not convert'] = (dropped['allowlist regexes that did not convert'] ?? 0) + 1;
    }
  }
  const stopwords = strings(table.stopwords).map((s) => s.toLowerCase());
  if (table.paths !== undefined) dropped['allowlist paths'] = (dropped['allowlist paths'] ?? 0) + 1;
  if (table.commits !== undefined) dropped['allowlist commits'] = (dropped['allowlist commits'] ?? 0) + 1;
  if (regexes.length === 0 && stopwords.length === 0) return null;
  const target = table.regexTarget;
  const condition = table.condition;
  return {
    regexes,
    stopwords,
    target: target === 'match' || target === 'line' ? target : 'secret',
    condition: condition === 'AND' ? 'AND' : 'OR',
  };
}

export function convertGitleaks(tomlText: string, meta: { name: string; version: string }): { ruleset: RulesetFile; report: ConversionReport } {
  const doc = parseToml(tomlText);
  const rulesIn = doc.rules;
  if (!Array.isArray(rulesIn)) throw new Error('the file has no [[rules]]');

  const dropped: Record<string, number> = {};
  const skipped: SkippedRule[] = [];
  const rules: RuleEntry[] = [];
  const seen = new Set<string>();

  rulesIn.forEach((raw, index) => {
    if (!isTable(raw)) return void skipped.push({ id: `#${index}`, reason: 'not a table' });
    const id = typeof raw.id === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(raw.id) ? raw.id : `#${index}`;
    const skip = (reason: string) => void skipped.push({ id, reason });
    if (id.startsWith('#')) return skip('no usable id');
    if (seen.has(id)) return skip('duplicate id');
    seen.add(id);
    const unknown = Object.keys(raw).filter((k) => !RULE_KEYS.has(k));
    if (unknown.length > 0) return skip(`a key this converter does not know (${unknown.join(', ')})`);
    if (typeof raw.regex !== 'string') return skip('a path-only rule: it matches file names, and the colony scans text');
    if (raw.path !== undefined) dropped['rule paths (the regex alone is used)'] = (dropped['rule paths (the regex alone is used)'] ?? 0) + 1;

    let pattern: RulePattern;
    try {
      pattern = compile(raw.regex);
    } catch (err) {
      return skip(err instanceof UnsupportedRegex ? err.message : `the regex could not be converted (${String(err)})`);
    }

    const allowlists: RuleAllowlist[] = [];
    if (Array.isArray(raw.allowlists)) {
      for (const a of raw.allowlists) {
        if (!isTable(a)) continue;
        const unknownKeys = Object.keys(a).filter((k) => !ALLOWLIST_KEYS.has(k));
        if (unknownKeys.length > 0) {
          dropped['allowlists with a key this converter does not know'] = (dropped['allowlists with a key this converter does not know'] ?? 0) + 1;
          continue;
        }
        const converted = convertAllowlist(a, dropped);
        if (converted) allowlists.push(converted);
      }
    }

    rules.push({
      id,
      description: typeof raw.description === 'string' ? raw.description : '',
      pattern,
      keywords: strings(raw.keywords).map((k) => k.toLowerCase()),
      entropy: typeof raw.entropy === 'number' && raw.entropy > 0 ? raw.entropy : null,
      secretGroup: typeof raw.secretGroup === 'number' && Number.isInteger(raw.secretGroup) && raw.secretGroup > 0 ? raw.secretGroup : null,
      allowlists,
    });
  });

  const globalTable = isTable(doc.allowlist) ? doc.allowlist : null;
  const globalAllowlist = globalTable ? convertAllowlist(globalTable, dropped) : null;

  return {
    ruleset: { format: 1, name: meta.name, version: meta.version, rules, globalAllowlist },
    report: { total: rulesIn.length, converted: rules.length, skipped, dropped },
  };
}
