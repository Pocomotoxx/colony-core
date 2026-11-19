import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertPresidio, IBAN_FILE, PRESIDIO_FILES } from '../rulesets/convert-presidio.js';
import { loadRuleset, loadRulesets, type LoadedRuleset } from '../rulesets/loader.js';
import { findPii } from '../rulesets/pii.js';
import { evaluateRegexTable, extractPatternCalls, PyParseError } from '../rulesets/py-patterns.js';
import { ibanValid, ipValid, macValid } from '../rulesets/validators.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vendored = path.join(repo, 'rulesets', 'presidio');

let root: string;
let n = 0;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-presidio-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// Made-up numbers, built here from a fixed generator and the check-digit rules: never real ones, never one literal.
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
const group4 = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

// ---- the Python reader

test('pattern calls are read from Python source: adjacent literals, comments, raw strings; the rest is refused', () => {
  const src = [
    'from x import Pattern',
    'PATTERNS = [',
    '    Pattern(',
    '        "Name (weak)",',
    '        r"\\b(a|b)\\d{3}" r"[- ]?x",  # a comment',
    '        0.3,',
    '    ),',
    '    Pattern("Second", r"c+", 0.6),',
    ']',
  ].join('\n');
  assert.deepEqual(extractPatternCalls(src), [
    { name: 'Name (weak)', regex: '\\b(a|b)\\d{3}[- ]?x', score: 0.3 },
    { name: 'Second', regex: 'c+', score: 0.6 },
  ]);
  for (const bad of [
    'Pattern("n", f"x{y}", 0.5)',
    'Pattern("n", rb"x", 0.5)',
    'Pattern("n", r"""x""", 0.5)',
    'Pattern(NAME, r"x", 0.5)',
    'Pattern("n", r"x", SCORE)',
    'Pattern("n", r"x" + OTHER, 0.5)',
    'no patterns here',
  ]) {
    assert.throws(() => extractPatternCalls(bad), PyParseError, bad);
  }
});

test('a table of concatenated strings is evaluated from its constants, and nothing else is', () => {
  const src = ['"""A docstring."""', '# comment', 'CK = "[0-9]{2}"', 'N4 = "([0-9]){4}"', 'regex_per_country = {', '    # Albania', '    "AL": "(AL)" + CK + N4 + N4,', '    "AD": "(AD)" + CK,', '}'].join('\n');
  assert.deepEqual(evaluateRegexTable(src), { AL: '(AL)[0-9]{2}([0-9]){4}([0-9]){4}', AD: '(AD)[0-9]{2}' });
  for (const bad of ['regex_per_country = { "AL": UNKNOWN + "x" }', 'x = 1', 'other = { "a": "b" }', 'CK = "x"', 'regex_per_country = { "AL": "a" "b" }']) {
    assert.throws(() => evaluateRegexTable(bad), PyParseError, bad);
  }
});

// ---- the vendored set

async function sourcesOf(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of [...Object.keys(PRESIDIO_FILES), IBAN_FILE]) out[f] = await fs.readFile(path.join(vendored, 'source', f), 'utf-8');
  return out;
}

test('the vendored files convert: the one skipped pattern is named, and the report adds up', async () => {
  const { ruleset, report } = convertPresidio(await sourcesOf(), { name: 'presidio', version: '2.2.366' });
  assert.equal(report.total, 84);
  assert.equal(report.converted + report.skipped.length, report.total);
  assert.deepEqual(report.skipped.map((s) => s.id), ['ip_address:IPv6_unspecified']);
  const by = (entity: string) => ruleset.rules.filter((r) => r.entity === entity).length;
  assert.equal(by('ip_address'), 4);
  assert.equal(by('mac_address'), 2);
  assert.equal(by('credit_card'), 1);
  assert.equal(by('iban'), 76, 'one pattern per country of the upstream table');
  for (const r of ruleset.rules) assert.doesNotThrow(() => new RegExp(r.pattern.source, `${r.pattern.flags}dg`), r.id);
});

test('the set loads with its hashes verified; a changed or missing file is not loaded', async () => {
  const set = await loadRuleset(vendored);
  assert.equal(set.kind, 'pii');
  assert.equal(set.version, '2.2.366');
  assert.equal(set.pii.length, 83);
  assert.equal(set.provenance.license, 'MIT');
  assert.equal(set.provenance.sources?.length, 4);

  const copy = async () => {
    const dest = path.join(root, `copy${n++}`);
    await fs.cp(vendored, dest, { recursive: true });
    return dest;
  };
  const a = await copy();
  await fs.appendFile(path.join(a, 'source', 'ip_recognizer.py'), '\n# edited');
  await assert.rejects(loadRuleset(a), /ip_recognizer\.py does not match its recorded SHA-256/);
  const b = await copy();
  await fs.rm(path.join(b, 'source', 'iban_patterns.py'));
  await assert.rejects(loadRuleset(b), /upstream source file is missing/);
  const c = await copy();
  await fs.appendFile(path.join(c, 'ruleset.json'), ' ');
  await assert.rejects(loadRuleset(c), /changed after the conversion/);

  const all = await loadRulesets();
  assert.deepEqual(all.failed, []);
  assert.deepEqual(all.loaded.map((s) => `${s.name}:${s.kind}`).sort(), ['gitleaks:secrets', 'presidio:pii', 'sigma:commands']);
});

// ---- the checks

test('the checks: IBAN mod-97, IP addresses with prefix and zone, MAC addresses', () => {
  assert.equal(ibanValid(makeIban('HU', digits(24, 1))), true);
  assert.equal(ibanValid(makeIban('HU', digits(24, 1)).replace(/.$/, (d) => String((Number(d) + 1) % 10))), false);
  for (const ok of ['192.168.10.25', '10.0.0.0/8', '2001:db8::ff00:42:8329', 'fe80::1%eth0', '::ffff:192.0.2.1', '::1', '2001:db8::/32']) assert.equal(ipValid(ok), true, ok);
  for (const bad of ['999.1.1.1', '1.2.3', '10.0.0.0/33', '2001:db8::/129', 'abcd:efgh::', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7::8:9', '1::2::3', ':::1', '1:2:3:4:5:6:7', 'a::b:', '12345::1', '::1.2.3.4:5']) assert.equal(ipValid(bad), false, bad);
  for (const ok of ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7::', '::', '::1.2.3.4', '1:2:3:4:5:6:1.2.3.4']) assert.equal(ipValid(ok), true, ok);
  assert.equal(macValid('00:1A:2B:3C:4D:5E'), true);
  assert.equal(macValid('FF:FF:FF:FF:FF:FF'), false);
  assert.equal(macValid('00-00-00-00-00-00'), false);
});

// ---- finding personal data

const kinds = async (text: string) => {
  const set = await loadRuleset(vendored);
  return findPii(text, [set]).findings.map((f) => `${f.entity}:${text.slice(f.offset, f.offset + f.length)}`);
};

test('IP addresses: IPv4, IPv6, with a prefix, IPv4-mapped (one finding); times, scopes and words are not addresses', async () => {
  assert.deepEqual(await kinds('server 192.168.10.25 is up'), ['ip_address:192.168.10.25']);
  assert.deepEqual(await kinds('net 10.0.0.0/8 and host 2001:db8::ff00:42:8329.'), ['ip_address:10.0.0.0/8', 'ip_address:2001:db8::ff00:42:8329']);
  assert.deepEqual(await kinds('link fe80::1%eth0 here'), ['ip_address:fe80::1%eth0']);
  assert.deepEqual(await kinds('mapped ::ffff:192.0.2.1 only'), ['ip_address:::ffff:192.0.2.1'], 'the IPv4 inside it is not a second finding');
  for (const text of ['at 12:30:45 today', 'std::vector<int> v;', 'use a::b::c here', 'a lone :: is not one', 'version 1.2.3 of it', 'bad 999.1.1.1', 'abcd:efgh:: no']) {
    assert.deepEqual(await kinds(text), [], text);
  }
});

test('bank cards: 13 to 19 digits with a valid Luhn sum, grouped or compact; others are not cards', async () => {
  const visa = withLuhn('4' + digits(14, 2));
  const grouped = group4(visa);
  const amex = withLuhn('37' + digits(12, 3));
  assert.equal(visa.length, 16);
  assert.equal(amex.length, 15);
  assert.deepEqual(await kinds(`card ${grouped} ok`), [`credit_card:${grouped}`]);
  assert.deepEqual(await kinds(`card ${amex} ok`), [`credit_card:${amex}`], 'a 15-digit number, which the own 16-digit pattern does not see');
  const bad = visa.replace(/.$/, (d) => String((Number(d) + 1) % 10));
  assert.deepEqual(await kinds(`card ${bad}`), [], 'a wrong check digit');
  assert.deepEqual(await kinds('order 123456789012'), []);
});

test('IBANs: grouped, compact and lower case, by the pattern of the country; a wrong check digit is not one', async () => {
  const hu = makeIban('HU', digits(24, 4));
  const de = makeIban('DE', digits(18, 5));
  assert.deepEqual(await kinds(`pay ${hu} now`), [`iban:${hu}`]);
  assert.deepEqual(await kinds(`pay ${group4(de)}.`), [`iban:${group4(de)}`]);
  assert.deepEqual(await kinds(`pay ${de.toLowerCase()}`), [`iban:${de.toLowerCase()}`]);
  const bad = hu.replace(/.$/, (d) => String((Number(d) + 1) % 10));
  assert.deepEqual(await kinds(`pay ${bad}`), []);
  assert.deepEqual(await kinds('ID HU12 and DE12'), []);
});

test('MAC addresses in the three notations; the broadcast address and zeros are not', async () => {
  assert.deepEqual(await kinds('nic 00:1A:2B:3C:4D:5E up'), ['mac_address:00:1A:2B:3C:4D:5E']);
  assert.deepEqual(await kinds('nic 00-1a-2b-3c-4d-5e up'), ['mac_address:00-1a-2b-3c-4d-5e']);
  assert.deepEqual(await kinds('nic 001a.2b3c.4d5e up'), ['mac_address:001a.2b3c.4d5e']);
  assert.deepEqual(await kinds('bcast FF:FF:FF:FF:FF:FF'), []);
  assert.deepEqual(await kinds('zero 00:00:00:00:00:00'), []);
});

test('the findings are positions, never values', async () => {
  const set: LoadedRuleset = await loadRuleset(vendored);
  const ip = '203.0.113.77';
  const out = JSON.stringify(findPii(`host ${ip}`, [set]));
  assert.ok(!out.includes(ip));
  assert.equal(findPii('x'.repeat(5000), [set], { maxChars: 1000 }).truncated, true);
});

test('no personal data rule is slow on hostile input', async () => {
  const set = await loadRuleset(vendored);
  const inputs = ['a'.repeat(20_000), '0'.repeat(20_000), ' '.repeat(20_000), ':'.repeat(20_000), '1.'.repeat(10_000), 'AA00 '.repeat(4000), 'GB82 WEST 1234 '.repeat(1500), 'ab:'.repeat(7000), '12-'.repeat(7000)];
  const slow: string[] = [];
  for (const rule of set.pii) {
    for (const input of inputs) {
      const started = Date.now();
      for (const m of input.matchAll(rule.regex)) void m;
      const took = Date.now() - started;
      if (took > 1500) slow.push(`${rule.id}: ${took} ms on ${input.slice(0, 6)}...`);
    }
  }
  assert.deepEqual(slow, []);
});
