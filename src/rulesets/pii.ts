import { luhnValid } from '../injection-scan.js';
import type { LoadedRuleset } from './loader.js';
import type { PiiEntity } from './types.js';
import { ibanValid, ipValid, macValid } from './validators.js';

/**
 * Where the personal data rule sets find IP addresses, IBANs, bank card numbers and MAC addresses in a text. A pattern
 * only finds a shape; the colony's own check decides (Luhn, IBAN mod-97, a valid address). The value is never copied out.
 */

export interface PiiFinding {
  ruleset: string;
  rule: string;
  entity: PiiEntity;
  offset: number;
  length: number;
}

const MAX_TEXT_CHARS = 2_000_000;
const MAX_MATCHES_PER_RULE = 1000;

function accepts(entity: PiiEntity, value: string): boolean {
  switch (entity) {
    case 'ip_address':
      return ipValid(value);
    case 'credit_card': {
      const digits = value.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    }
    case 'iban':
      return ibanValid(value);
    case 'mac_address':
      return macValid(value);
  }
}

export function findPii(text: string, sets: LoadedRuleset[], options: { maxChars?: number } = {}): { findings: PiiFinding[]; truncated: boolean } {
  const limit = options.maxChars ?? MAX_TEXT_CHARS;
  const truncated = text.length > limit;
  const body = truncated ? text.slice(0, limit) : text;
  const raw: PiiFinding[] = [];

  for (const set of sets) {
    if (set.kind !== 'pii') continue;
    for (const rule of set.pii) {
      let count = 0;
      for (const m of body.matchAll(rule.regex)) {
        if (++count > MAX_MATCHES_PER_RULE) break;
        const start = m.index ?? 0;
        // a pattern may take a trailing separator with it (the IBAN patterns allow a space after each group)
        const value = m[0].replace(/\s+$/, '');
        if (value.length === 0 || !accepts(rule.entity, value)) continue;
        raw.push({ ruleset: set.name, rule: rule.id, entity: rule.entity, offset: start, length: value.length });
      }
    }
  }

  // two rules on the same place (IPv4 and an IPv4-mapped IPv6 address): keep the longer one
  raw.sort((a, b) => a.offset - b.offset || b.length - a.length);
  const kept: PiiFinding[] = [];
  for (const f of raw) {
    const last = kept[kept.length - 1];
    if (last && f.offset < last.offset + last.length) {
      if (f.length > last.length) kept[kept.length - 1] = f;
      continue;
    }
    kept.push(f);
  }
  return { findings: kept, truncated };
}
