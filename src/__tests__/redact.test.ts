import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redactText } from '../redact.js';
import { runCommand } from '../cli/commands.js';

const fakeKey = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1';
const fakeAws = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const CARD = '4539 5787 6362 1486';
const IBAN = 'HU42 1177 3016 1111 1018 0000 0000';

test('text without personal data comes back unchanged', () => {
  const text = 'Refactor src/parser.ts, ticket 2026-11-01, version 1.2.3, build 12345678.';
  assert.deepEqual(redactText(text), { text, findings: [], changed: false });
});

test('e-mail, card, IBAN, phone, IP, JWT and database URL are replaced by placeholders', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
  const text = [`mail anna@example.org`, `card ${CARD}`, `iban ${IBAN}`, `tel +36 30 123 4567`, `host 192.168.1.20`, `jwt ${jwt}`, `db postgres://u:p@db.example.org/app`].join('\n');
  const r = redactText(text);
  assert.equal(r.changed, true);
  assert.deepEqual(r.findings.map((f) => f.kind), ['email', 'credit_card', 'iban', 'phone', 'ip_address', 'jwt', 'database_url']);
  for (const original of ['anna@example.org', CARD, IBAN, '+36 30 123 4567', '192.168.1.20', jwt, 'postgres://u:p@db.example.org/app']) {
    assert.ok(!r.text.includes(original), original);
  }
  assert.match(r.text, /mail \[REDACTED:email\]\ncard \[REDACTED:credit_card\]\niban \[REDACTED:iban\]\ntel \[REDACTED:phone\]/);
});

test('a second valid IBAN and the validity checks', () => {
  assert.equal(redactText('DE89 3704 0044 0532 0130 00').findings[0]?.kind, 'iban');
  assert.equal(redactText('HU42 1177 3016 1111 1018 0000 0001').changed, false); // wrong checksum
  assert.equal(redactText('card 4539 5787 6362 1487').changed, false); // wrong Luhn
  assert.equal(redactText('ip 999.1.1.1 and 300.2.3.4').changed, false); // not addresses
  assert.equal(redactText('call 06 30 123 4567 or 123456789').text, 'call [REDACTED:phone] or 123456789'); // the domestic number is a phone; a bare nine digits with a wrong check digit is not a TAJ
});

test('secrets are always redacted, never hashed', () => {
  const r = redactText(`key ${fakeKey} and ${fakeAws}`, { hash: ['secret', 'email'], salt: 's' });
  assert.equal(r.text, 'key [REDACTED:secret] and [REDACTED:secret]');
  assert.deepEqual(r.findings, [{ kind: 'secret', count: 2 }]);
});

test('overlapping matches keep the longest span and leave no fragments', () => {
  const r = redactText('use postgres://u:p@db.example.org/app now');
  assert.equal(r.text, 'use [REDACTED:database_url] now');
  assert.deepEqual(r.findings, [{ kind: 'database_url', count: 1 }]);

  const both = redactText(`${CARD} then ${CARD}`);
  assert.equal(both.text, '[REDACTED:credit_card] then [REDACTED:credit_card]');
  assert.deepEqual(both.findings, [{ kind: 'credit_card', count: 2 }]);
});

test('hashing is salted, repeatable for one salt, and different across salts', () => {
  const text = 'anna@example.org wrote to anna@example.org';
  const a = redactText(text, { hash: ['email'], salt: 'one' });
  const b = redactText(text, { hash: ['email'], salt: 'one' });
  const c = redactText(text, { hash: ['email'], salt: 'two' });
  assert.deepEqual(a, b);
  assert.notEqual(a.text, c.text);
  const [first, second] = a.text.match(/\[HASH:email:[0-9a-f]{10}\]/g)!;
  assert.equal(first, second); // the same address gets the same token, so it stays referable
  assert.ok(!a.text.includes('anna'));
  assert.throws(() => redactText(text, { hash: ['email'] }), /needs a salt/);
});

test('the e-mail pattern stays fast on adversarial input', () => {
  const started = Date.now();
  redactText('a.'.repeat(60_000));
  assert.ok(Date.now() - started < 3000);
});

// ---- CLI

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-redact-test-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function project(name: string) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const run = async (...args: string[]) => {
    const { code, output } = await runCommand(args, dir);
    return { code, out: output as any };
  };
  await run('boot');
  return { dir, run };
}

test('redact: text, file, hashing options and errors', async () => {
  const { dir, run } = await project('cli');
  const t = await run('redact', '--text', 'write to anna@example.org');
  assert.equal(t.out.text, 'write to [REDACTED:email]');
  assert.equal(t.out.changed, true);

  await fs.writeFile(path.join(dir, 'report.md'), `owner anna@example.org\nkey ${fakeKey}\n`, 'utf-8');
  const f = await run('redact', '--file', 'report.md');
  assert.equal(f.out.text, 'owner [REDACTED:email]\nkey [REDACTED:secret]\n');

  const h = await run('redact', '--text', 'anna@example.org', '--hash', 'email', '--salt', 'x');
  assert.match(h.out.text, /^\[HASH:email:[0-9a-f]{10}\]$/);

  assert.match((await run('redact')).out.error, /needs --text or --file/);
  assert.match((await run('redact', '--text', 'a', '--file', 'b')).out.error, /not both/);
  assert.match((await run('redact', '--text', 'a', '--hash', 'email')).out.error, /needs --salt/);
  assert.match((await run('redact', '--text', 'a', '--hash', 'name', '--salt', 'x')).out.error, /unknown kind/);
  assert.match((await run('redact', '--file', '../x')).out.error, /inside the project/);
  assert.match((await run('redact', '--file', 'nope.md')).out.error, /not found/);
});

test('the audit log records what was redacted, not the text', async () => {
  const { dir, run } = await project('cli-audit');
  await run('redact', '--text', `anna@example.org ${fakeKey}`);
  const raw = await fs.readFile(path.join(dir, '.colony', 'audit.jsonl'), 'utf-8');
  assert.ok(raw.includes('"type":"redact"'));
  assert.ok(!raw.includes('anna@example.org'));
  assert.ok(!raw.includes(fakeKey));
});

test('Hungarian formats: domestic phone, bank account, tax number and TAJ with a valid check digit', () => {
  const text = 'Tel: 06 30 123 4567, 06301234567, 06-1-234-5678; számla: 11773016-11111018-00000000; adószám 12345678-1-42; TAJ 123 456 788 és 123456788';
  const r = redactText(text);
  assert.equal(
    r.text,
    'Tel: [REDACTED:phone], [REDACTED:phone], [REDACTED:phone]; számla: [REDACTED:bank_account]; adószám [REDACTED:tax_id]; TAJ [REDACTED:taj] és [REDACTED:taj]',
  );
  assert.deepEqual(r.findings, [{ kind: 'phone', count: 3 }, { kind: 'bank_account', count: 1 }, { kind: 'tax_id', count: 1 }, { kind: 'taj', count: 2 }]);
});

test('ordinary numbers are left alone: versions, dates, postal codes, an order number with a wrong check digit', () => {
  const text = 'verzió 1.2.3, dátum 2026-11-10, irsz 1051, rendelés 123456789, 12 345 678 forint';
  assert.equal(redactText(text).changed, false);
});
