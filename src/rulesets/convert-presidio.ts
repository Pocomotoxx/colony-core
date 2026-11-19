import { evaluateRegexTable, extractPatternCalls, PyParseError } from './py-patterns.js';
import type { ConversionReport, PiiEntity, PiiRule, PiiRulesetFile, SkippedRule } from './types.js';

/**
 * Convert the personal data patterns of presidio (IP address, IBAN, bank card, MAC address recognizers) into the
 * colony's rule set format. Only the PATTERNS are carried over; the checks that go with them (Luhn, the IBAN mod-97,
 * address validity) are the colony's own, in validators.ts.
 *
 * Presidio matches its patterns case-insensitively, multi-line and with `.` matching a line break (its default regex
 * flags are IGNORECASE | MULTILINE | DOTALL, value 26): the same flags are used here, so that a pattern means what it
 * means upstream. Python's \w and \b are Unicode-aware and JavaScript's are ASCII: for these patterns that only changes
 * what counts as the neighbouring character of a match.
 *
 * A pattern with a score below MIN_SCORE is skipped (the IPv6 "unspecified" pattern, score 0.1, is a bare "::", which
 * is just as often C++ or Rust as an address).
 */

export const PRESIDIO_FLAGS = 'ims';
export const MIN_SCORE = 0.3;

/** The files the conversion reads, by their upstream name, and what each one holds. */
export const PRESIDIO_FILES = {
  'ip_recognizer.py': 'ip_address',
  'mac_recognizer.py': 'mac_address',
  'credit_card_recognizer.py': 'credit_card',
} as const satisfies Record<string, PiiEntity>;
export const IBAN_FILE = 'iban_patterns.py';

function compiles(source: string): string | null {
  try {
    new RegExp(source, `${PRESIDIO_FLAGS}dg`);
    return null;
  } catch (err) {
    return `does not compile in JavaScript (${err instanceof Error ? err.message : String(err)})`;
  }
}

export function convertPresidio(files: Record<string, string>, meta: { name: string; version: string }): { ruleset: PiiRulesetFile; report: ConversionReport } {
  const rules: PiiRule[] = [];
  const skipped: SkippedRule[] = [];
  let total = 0;

  const add = (id: string, entity: PiiEntity, source: string, score: number | undefined) => {
    total++;
    if (score !== undefined && score < MIN_SCORE) return void skipped.push({ id, reason: `the score ${score} is below ${MIN_SCORE}: the pattern alone is too weak` });
    const problem = compiles(source);
    if (problem) return void skipped.push({ id, reason: problem });
    rules.push({ id, entity, pattern: { source, flags: PRESIDIO_FLAGS }, ...(score !== undefined ? { score } : {}) });
  };

  for (const [file, entity] of Object.entries(PRESIDIO_FILES) as Array<[keyof typeof PRESIDIO_FILES, PiiEntity]>) {
    const text = files[file];
    if (text === undefined) throw new Error(`the source file ${file} is missing`);
    for (const p of extractPatternCalls(text)) add(`${entity}:${p.name}`, entity, p.regex, p.score);
  }

  const ibanText = files[IBAN_FILE];
  if (ibanText === undefined) throw new Error(`the source file ${IBAN_FILE} is missing`);
  const table = evaluateRegexTable(ibanText);
  const countries = Object.keys(table);
  if (countries.length === 0) throw new PyParseError('the IBAN table is empty');
  for (const cc of countries) {
    // The upstream patterns have no boundary of their own here; a match must not start or end inside a longer run of letters or digits.
    add(`iban:${cc}`, 'iban', `(?<![A-Za-z0-9])${table[cc]}(?![A-Za-z0-9])`, undefined);
  }

  return {
    ruleset: { format: 1, kind: 'pii', name: meta.name, version: meta.version, rules },
    report: { total, converted: rules.length, skipped, dropped: {} },
  };
}
