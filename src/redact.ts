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
 * - A hash needs a salt to mean anything: without one, a hashed phone number or e-mail address can
 *   be recovered by trying candidates. `hash` is pseudonymization, not anonymization.
 *
 * Honest limit: patterns find common shapes. Free-text names, addresses and anything unusual pass
 * through unchanged. Redaction lowers the risk of a leak, it does not remove it; read the result
 * before sending it anywhere.
 */

import { createHmac } from 'node:crypto';
import { findSecretSpans } from './gates.js';
import { luhnValid } from './injection-scan.js';

export type RedactKind = 'email' | 'credit_card' | 'iban' | 'phone' | 'ip_address' | 'jwt' | 'database_url' | 'secret';
export type RedactAction = 'redact' | 'hash';

export const REDACT_KINDS: readonly RedactKind[] = ['email', 'credit_card', 'iban', 'phone', 'ip_address', 'jwt', 'database_url', 'secret'];

export interface RedactOptions {
  /** Kinds to replace by a salted hash instead of a placeholder. Secrets are always redacted. */
  hash?: readonly RedactKind[];
  /** Required when `hash` is used. */
  salt?: string;
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
}

function ibanValid(raw: string): boolean {
  const iban = raw.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

const ipv4Valid = (value: string): boolean => value.split('.').every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);

function collect(text: string): Span[] {
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
  add('ip_address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, ipv4Valid);
  add('jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g);
  add('database_url', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"]+/g);
  for (const s of findSecretSpans(text)) {
    spans.push({ kind: 'secret', start: s.offset, end: s.offset + s.length, value: text.slice(s.offset, s.offset + s.length) });
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

export function redactText(input: string, options: RedactOptions = {}): RedactResult {
  const hashKinds = new Set(options.hash ?? []);
  if (hashKinds.size > 0 && !options.salt) throw new Error('hashing needs a salt: an unsalted hash of a phone number or e-mail address can be guessed back');
  hashKinds.delete('secret'); // a secret is never kept, not even hashed

  const spans = resolveOverlaps(collect(input));
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
