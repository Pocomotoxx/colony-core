/**
 * Redact personal data and secrets from text before it leaves the project (a report, a pasted
 * result, an issue comment).
 *
 * Rewritten from the PII pipeline of the legacy `plugin-agent-federation`. The federation itself
 * (peers, transports, trust levels between installations) is network machinery the colony does not
 * have, so only the sanitizing step was kept, without the trust-level matrix.
 *
 * Differences from the legacy code:
 * - Overlapping matches are resolved first (a card number also looks like a phone number). The
 *   legacy replacement ran over overlapping spans and could mangle the text.
 * - Card numbers need a valid Luhn checksum, IPv4 octets must be 0..255, and an IBAN must pass the
 *   mod-97 check. The legacy patterns took any digit group.
 * - The US-only SSN, street-suffix and "Mr./Dr." name patterns are gone: they do not fit this
 *   project's data and mostly produced false hits. Names and postal addresses are NOT detected.
 * - Hungarian forms are covered: the domestic phone number (06 ...), bank account numbers (8-8-8),
 *   tax numbers (8-1-2) and TAJ numbers (9 digits with the check digit). A TAJ-shaped number that
 *   happens to pass the check digit (about one in ten nine-digit numbers) is redacted too: for a
 *   redactor, a false hit is the safe error.
 * - A hash needs a salt to mean anything: without one, a hashed phone number or e-mail address can
 *   be recovered by trying candidates. `hash` is pseudonymization, not anonymization.
 *
 * Honest limit: patterns find common shapes. Free-text names, addresses and anything unusual pass
 * through unchanged. Redaction lowers the risk of a leak, it does not remove it; read the result
 * before sending it anywhere.
 */

import { createHmac } from 'node:crypto';
import path from 'node:path';
import { findSecretSpans } from './gates.js';
import { luhnValid } from './injection-scan.js';
import { ibanValid } from './rulesets/validators.js';
import { activeRulesetsSync } from './rulesets/active.js';
import { findPii } from './rulesets/pii.js';
import { scanSecrets } from './rulesets/loader.js';
import type { LoadedRuleset, LoadResult } from './rulesets/loader.js';

export type RedactKind = 'email' | 'credit_card' | 'iban' | 'phone' | 'ip_address' | 'jwt' | 'database_url' | 'secret' | 'bank_account' | 'tax_id' | 'taj' | 'mac_address';
export type RedactAction = 'redact' | 'hash';

export const REDACT_KINDS: readonly RedactKind[] = ['email', 'credit_card', 'iban', 'phone', 'ip_address', 'jwt', 'database_url', 'secret', 'bank_account', 'tax_id', 'taj', 'mac_address'];

export interface RedactOptions {
  /** Kinds to replace by a salted hash instead of a placeholder. Secrets are always redacted. */
  hash?: readonly RedactKind[];
  /** Required when `hash` is used. */
  salt?: string;
  /**
   * Kinds to LEAVE in the text, for one shape that gives false alarms: a four-part version number such as 13.6.233.17
   * is a valid IPv4 address, so release notes lose their versions. For ip_address this leaves the IPv4 form only: an
   * IPv6 address cannot be a version number and is still redacted. A secret is never left: asking for it is an error.
   */
  skip?: readonly RedactKind[];
  /**
   * Only the colony's own built-in patterns, not the vendored rule sets (presidio, gitleaks). A fixed baseline for measurements:
   * what the own patterns find does not change when a rule set is added or updated.
   */
  builtinOnly?: boolean;
}

export interface RedactResult {
  text: string;
  findings: Array<{ kind: RedactKind; count: number }>;
  changed: boolean;
}

interface Span {
  kind: RedactKind;
  start: number;
  end: number;
  value: string;
  /** An IPv6 address: not affected by skipping ip_address. */
  v6?: boolean;
}

let warnedFor: LoadResult | undefined;

/**
 * The vendored personal data rule sets (presidio): IPv6 and IPv4 addresses with a prefix, IBANs of every country, bank cards of
 * 13 to 19 digits, MAC addresses. A set that failed its hash checks is not used, and that is said once per load, loudly:
 * the own patterns below still redact, so a broken set means less redaction, never none.
 */
function personalDataSets(): LoadedRuleset[] {
  const result = activeRulesetsSync();
  if (result.failed.length > 0 && warnedFor !== result) {
    warnedFor = result;
    for (const f of result.failed) console.warn(`[redact] the rule set '${f.name}' failed its checks and is NOT used (${f.error}); only the colony's own patterns redact personal data.`);
  }
  return result.loaded.filter((s) => s.kind === 'pii');
}

/** The IPv6 loopback address is not personal data, and it turns up in code (a host check): it is left alone. */
const isIpv6Loopback = (value: string): boolean => /^::1(?:\/128)?$/.test(value);

/** Hungarian TAJ (social security) number: nine digits, the last is a check digit (weights 3 and 7 alternating over the first eight, mod 10). */
function tajValid(raw: string): boolean {
  const d = raw.replace(/\D/g, '');
  if (d.length !== 9) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(d[i]) * (i % 2 === 0 ? 3 : 7);
  return sum % 10 === Number(d[8]);
}

const ipv4Valid = (value: string): boolean => value.split('.').every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);

const SECRET_SCAN_BUDGET_MS = 3000;

/** A file name for a message: inside the project it is shown relative to it, else only its last part; redacted and short. */
export function displayPath(file: string, projectDir?: string): string {
  let shown = file;
  if (projectDir && path.isAbsolute(file)) {
    const rel = path.relative(projectDir, file);
    shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.basename(file);
  }
  // piece by piece: a key right before ".txt" or a separator has no boundary after it for the rules
  const text = shown.split(/([\\/.])/).map((piece) => redactText(piece).text).join('');
  return text.length > 120 ? `...${text.slice(-117)}` : text;
}

function collect(text: string, builtinOnly = false): Span[] {
  const spans: Span[] = [];
  const add = (kind: RedactKind, regex: RegExp, accept: (value: string) => boolean = () => true) => {
    for (const m of text.matchAll(regex)) {
      if (accept(m[0])) spans.push({ kind, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, value: m[0] });
    }
  };

  // Bounded quantifiers keep the e-mail pattern linear on adversarial input.
  add('email', /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g);
  add('credit_card', /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, (v) => luhnValid(v.replace(/\D/g, '')));
  add('iban', /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g, ibanValid);
  // International form only (leading +): a bare digit run is far too often an id or a date.
  add('phone', /\+\d[\d\s().-]{7,17}\d/g, (v) => v.replace(/\D/g, '').length >= 8);
  // Hungarian domestic form: 06 30 123 4567, 06-1-234-5678, 06301234567
  add('phone', /(?<![\d-])06[\s-]?\(?\d{1,2}\)?[\s-]?\d{3}[\s-]?\d{3,4}(?![\d-])/g, (v) => {
    const n = v.replace(/\D/g, '').length;
    return n === 10 || n === 11;
  });
  // Hungarian bank account numbers (8-8 or 8-8-8), tax numbers (8-1-2), TAJ numbers (9 digits with a check digit)
  add('bank_account', /(?<![\d-])\d{8}-\d{8}(?:-\d{8})?(?![\d-])/g);
  add('tax_id', /(?<![\d-])\d{8}-[1-5]-\d{2}(?![\d-])/g);
  add('taj', /(?<![\d-])\d{3}[\s-]?\d{3}[\s-]?\d{3}(?![\d-])/g, tajValid);
  add('ip_address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, ipv4Valid);
  add('jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g);
  add('database_url', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"]+/g);
  const sets = builtinOnly ? [] : personalDataSets();
  if (sets.length > 0) {
    for (const f of findPii(text, sets).findings) {
      const value = text.slice(f.offset, f.offset + f.length);
      if (f.entity === 'ip_address' && isIpv6Loopback(value)) continue;
      spans.push({ kind: f.entity, start: f.offset, end: f.offset + f.length, value, ...(f.entity === 'ip_address' && value.includes(':') ? { v6: true } : {}) });
    }
  }
  for (const s of findSecretSpans(text)) {
    spans.push({ kind: 'secret', start: s.offset, end: s.offset + s.length, value: text.slice(s.offset, s.offset + s.length) });
  }
  // the vendored secret rules (gitleaks) too: a key only they know must not pass a redactor
  const secretSets = builtinOnly ? [] : activeRulesetsSync().loaded.filter((s) => s.kind === 'secrets');
  if (secretSets.length > 0) {
    for (const f of scanSecrets(text, secretSets, { budgetMs: SECRET_SCAN_BUDGET_MS }).findings) {
      spans.push({ kind: 'secret', start: f.offset, end: f.offset + f.length, value: text.slice(f.offset, f.offset + f.length) });
    }
  }
  return spans;
}

/** Keep the longest span where several overlap (earliest first on a tie), so every character is replaced at most once. */
function resolveOverlaps(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  for (const span of sorted) {
    const last = kept[kept.length - 1];
    if (last && span.start < last.end) {
      if (span.end - span.start > last.end - last.start) kept[kept.length - 1] = span;
      continue;
    }
    kept.push(span);
  }
  return kept;
}

/** Where redaction would act: kind, start and end of each span (no value). For measurements and tests. */
export function findRedactSpans(text: string, options: { builtinOnly?: boolean } = {}): Array<{ kind: RedactKind; start: number; end: number }> {
  return resolveOverlaps(collect(text, options.builtinOnly === true)).map((s) => ({ kind: s.kind, start: s.start, end: s.end }));
}

export function redactText(input: string, options: RedactOptions = {}): RedactResult {
  const hashKinds = new Set(options.hash ?? []);
  if (hashKinds.size > 0 && !options.salt) throw new Error('hashing needs a salt: an unsalted hash of a phone number or e-mail address can be guessed back');
  hashKinds.delete('secret'); // a secret is never kept, not even hashed
  const skipKinds = new Set(options.skip ?? []);
  if (skipKinds.has('secret')) throw new Error('a secret is always redacted and cannot be skipped');
  for (const kind of skipKinds) if (!REDACT_KINDS.includes(kind)) throw new Error(`unknown kind to skip: ${String(kind)}`);

  const spans = resolveOverlaps(collect(input, options.builtinOnly === true).filter((s) => !skipKinds.has(s.kind) || (s.kind === 'ip_address' && s.v6 === true)));
  const counts = new Map<RedactKind, number>();
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += input.slice(cursor, span.start);
    if (hashKinds.has(span.kind)) {
      const digest = createHmac('sha256', options.salt!).update(span.value).digest('hex').slice(0, 10);
      out += `[HASH:${span.kind}:${digest}]`;
    } else {
      out += `[REDACTED:${span.kind}]`;
    }
    cursor = span.end;
    counts.set(span.kind, (counts.get(span.kind) ?? 0) + 1);
  }
  out += input.slice(cursor);

  return {
    text: out,
    findings: REDACT_KINDS.filter((k) => counts.has(k)).map((kind) => ({ kind, count: counts.get(kind)! })),
    changed: spans.length > 0,
  };
}
