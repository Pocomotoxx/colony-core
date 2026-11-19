import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REDACT_KINDS, redactText } from '../redact.js';
import { useRulesetsDir } from '../rulesets/active.js';

// The presidio personal data patterns in the redaction.

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-redact-rs-'));
});
after(async () => {
  useRulesetsDir(undefined);
  await fs.rm(root, { recursive: true, force: true });
});

// Made-up numbers from a fixed generator and the check-digit rules: never real ones, never one literal.
function digits(length: number, seed: number): string {
  let s = seed;
  let out = '';
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out += String(Math.floor((s / 2147483648) * 10));
  }
  return out;
}
function withLuhn(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body + String((10 - (sum % 10)) % 10);
}
function makeIban(cc: string, bban: string): string {
  const numeric = (bban + cc + '00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let r = 0;
  for (const d of numeric) r = (r * 10 + Number(d)) % 97;
  return cc + String(98 - r).padStart(2, '0') + bban;
}

test('what the own patterns missed is redacted now: IPv6, MAC addresses, 15 and 13 digit cards, lower case IBANs', () => {
  const amex = withLuhn('37' + digits(12, 1));
  const short = withLuhn('4' + digits(11, 2));
  const iban = makeIban('DE', digits(18, 3)).toLowerCase();
  const text = `host 2001:db8::ff00:42:8329 mac 00:1A:2B:3C:4D:5E card ${amex} and ${short} iban ${iban}`;
  const r = redactText(text);
  assert.equal(r.text, 'host [REDACTED:ip_address] mac [REDACTED:mac_address] card [REDACTED:credit_card] and [REDACTED:credit_card] iban [REDACTED:iban]');
  assert.deepEqual(r.findings.map((f) => f.kind).sort(), ['credit_card', 'iban', 'ip_address', 'mac_address']);
  assert.equal(r.changed, true);
  assert.ok(REDACT_KINDS.includes('mac_address'));
});

test('the loopback address is not personal data; other addresses and the IPv4 behaviour of before are unchanged', () => {
  assert.equal(redactText('if (host === \'::1\') return').changed, false, 'the IPv6 loopback in code');
  assert.equal(redactText('bind ::1/128 now').changed, false);
  assert.equal(redactText('link fe80::1 up').text, 'link [REDACTED:ip_address] up');
  assert.equal(redactText('ping 127.0.0.1 now').text, 'ping [REDACTED:ip_address] now', 'IPv4 is redacted as before, loopback included');
  assert.equal(redactText('mapped ::ffff:203.0.113.77 only').text, 'mapped [REDACTED:ip_address] only', 'the whole address, not only its IPv4 tail');
});

test('skipping ip_address leaves version numbers and still redacts an IPv6 address', () => {
  const r = redactText('node 13.6.233.17 on 2001:db8::1 and 10.1.2.3', { skip: ['ip_address'] });
  assert.equal(r.text, 'node 13.6.233.17 on [REDACTED:ip_address] and 10.1.2.3');
});

test('a hash of a MAC address needs the salt like the other kinds, and the own kinds still work next to the new ones', () => {
  assert.throws(() => redactText('nic 00:1A:2B:3C:4D:5E', { hash: ['mac_address'] }), /salt/);
  const h = redactText('nic 00:1A:2B:3C:4D:5E', { hash: ['mac_address'], salt: 'pepper' });
  assert.match(h.text, /^nic \[HASH:mac_address:[0-9a-f]{10}\]$/);
  const mixed = redactText('write to a.b@example.test or call +36 30 123 4567; host 2001:db8::7');
  assert.equal(mixed.text, 'write to [REDACTED:email] or call [REDACTED:phone]; host [REDACTED:ip_address]');
});

test('ordinary text is left alone: times, scopes, versions, short numbers', () => {
  for (const text of ['at 12:30:45 today', 'std::vector<int> v;', 'version 1.2.3 of it', 'order 123456789012', 'ID HU12 and DE12', 'ratio 3:2 and 10:20:30']) {
    assert.equal(redactText(text).changed, false, text);
  }
});

test('a rule set that failed its checks is said once, loudly, and the own patterns still redact', async () => {
  const sets = path.join(root, 'rulesets');
  await fs.cp(path.join(repo, 'rulesets'), sets, { recursive: true });
  await fs.appendFile(path.join(sets, 'presidio', 'ruleset.json'), ' ');
  useRulesetsDir(sets);
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    const r = redactText('host 2001:db8::ff00:42:8329 and 10.1.2.3 and a.b@example.test');
    assert.equal(r.text, 'host 2001:db8::ff00:42:8329 and [REDACTED:ip_address] and [REDACTED:email]', 'IPv6 is not covered without the set; the own patterns are');
    redactText('again 2001:db8::1');
    assert.equal(warn.mock.callCount(), 1, 'once per load, not on every call');
    assert.match(String(warn.mock.calls[0].arguments[0]), /rule set 'presidio' failed its checks and is NOT used/);
  } finally {
    warn.mock.restore();
    useRulesetsDir(undefined);
  }
});

test('a large text is redacted in reasonable time', () => {
  const code = ("const x = 'a'; // 12:30 std::map<int,int> v; 1.2.3 and 0x1f2e3d\n").repeat(8000);
  const started = Date.now();
  const r = redactText(code + ' host 2001:db8::5');
  assert.ok(Date.now() - started < 10_000);
  assert.match(r.text, /\[REDACTED:ip_address\]$/);
});
