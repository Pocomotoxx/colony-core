/**
 * The checks that go with the patterns of the personal data rule sets. A pattern finds a shape; these decide whether
 * the shape is really one (a checksum, a valid address). They are the colony's own: the upstream's checks are code in
 * another language and are not carried over.
 */

/** IBAN: country code, two check digits, the rest; the mod-97 check must give 1. */
export function ibanValid(raw: string): boolean {
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

export const ipv4Valid = (value: string): boolean => value.split('.').length === 4 && value.split('.').every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);

/**
 * An IPv6 address, written out here (the core imports nothing that opens a socket): eight groups of one to four hex
 * digits, one run of groups may be written as "::", and the last part may be an IPv4 address (which counts as two groups).
 */
export function ipv6Valid(value: string): boolean {
  if (value.length === 0 || value.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(value) || value.includes(':::')) return false;
  const double = value.indexOf('::');
  if (double !== value.lastIndexOf('::')) return false;
  const sides = double >= 0 ? [value.slice(0, double), value.slice(double + 2)] : [value];
  const groups: string[] = [];
  for (const side of sides) {
    if (side === '') continue;
    const parts = side.split(':');
    if (parts.some((p) => p === '')) return false;
    groups.push(...parts);
  }
  let count = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.includes('.')) {
      if (i !== groups.length - 1 || !ipv4Valid(g)) return false; // an IPv4 part only at the very end
      count += 2;
    } else if (/^[0-9A-Fa-f]{1,4}$/.test(g)) count += 1;
    else return false;
  }
  return double >= 0 ? count <= 7 : count === 8;
}

/** An IP address as the patterns find it: IPv4 or IPv6, with an optional /prefix and, for IPv6, a %zone. */
export function ipValid(raw: string): boolean {
  let value = raw;
  const slash = value.indexOf('/');
  if (slash >= 0) {
    const prefix = value.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefix)) return false;
    value = value.slice(0, slash);
    if (Number(prefix) > (value.includes(':') ? 128 : 32)) return false;
  }
  if (value.includes(':')) {
    const zone = value.indexOf('%');
    return ipv6Valid(zone >= 0 ? value.slice(0, zone) : value);
  }
  return ipv4Valid(value);
}

/** Twelve hex digits that are neither the broadcast address nor all zeros. */
export function macValid(raw: string): boolean {
  const cleaned = raw.replace(/[:.-]/g, '');
  if (!/^[0-9A-Fa-f]{12}$/.test(cleaned)) return false;
  const up = cleaned.toUpperCase();
  return up !== 'FFFFFFFFFFFF' && up !== '000000000000';
}
