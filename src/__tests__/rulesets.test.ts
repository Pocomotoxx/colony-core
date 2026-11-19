import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertGitleaks } from '../rulesets/convert-gitleaks.js';
import { gitBlobSha1, loadRuleset, loadRulesets, RulesetError, scanSecrets, shannonEntropy } from '../rulesets/loader.js';
import { translateRe2, UnsupportedRegex } from '../rulesets/re2.js';
import { parseToml, TomlError } from '../rulesets/toml-lite.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vendored = path.join(repo, 'rulesets', 'gitleaks');

let root: string;
let n = 0;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-rulesets-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// The tokens of these tests are made up here from a fixed generator: never a real credential, and never written out
// as a literal (so that nothing that scans this file takes them for one).
function fake(length: number, alphabet: string, seed: number): string {
  let s = seed;
  let out = '';
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out += alphabet[Math.floor((s / 2147483648) * alphabet.length)];
  }
  return out;
}
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LOWER_DIGITS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ---- the TOML reader

test('the TOML reader reads the subset the rule files use, and refuses the rest', () => {
  const doc = parseToml(
    [
      '# comment',
      'title = "t"',
      'minVersion = "v8.25.0"',
      '[allowlist]',
      "paths = ['''a\\.b''', '''c''']",
      '[[rules]]',
      'id = "r1"',
      "regex = '''(?i)x\\.y[a-z]{3}'''",
      'entropy = 3.5',
      'keywords = [',
      '  "k1", # a comment inside',
      '  "k2",',
      ']',
      '[[rules.allowlists]]',
      "stopwords = ['''s''']",
      '[[rules]]',
      'id = "r2"',
    ].join('\n'),
  ) as any;
  assert.equal(doc.title, 't');
  assert.deepEqual(doc.allowlist.paths, ['a\\.b', 'c']);
  assert.equal(doc.rules.length, 2);
  assert.equal(doc.rules[0].regex, '(?i)x\\.y[a-z]{3}', 'a literal string keeps its backslashes');
  assert.equal(doc.rules[0].entropy, 3.5);
  assert.deepEqual(doc.rules[0].keywords, ['k1', 'k2']);
  assert.deepEqual(doc.rules[0].allowlists, [{ stopwords: ['s'] }], 'an array of tables inside the last element of its parent');
  assert.equal(doc.rules[1].id, 'r2');

  for (const bad of ['a.b = 1', 'a = {x = 1}', 'a = 1\na = 2', 'a = "open', 'a = 1979-05-27', 'a = """x"""', '[t]\n[t]', 'a = [1, 2', 'a = 1 junk']) {
    assert.throws(() => parseToml(bad), TomlError, bad);
  }
});

// ---- Go regular expressions in JavaScript

const run = (pattern: string, text: string): boolean => {
  const t = translateRe2(pattern);
  return new RegExp(t.source, t.flags).test(text);
};

test('a leading flag stays a flag; a flag in the middle holds to the end of its group', () => {
  assert.deepEqual(translateRe2('(?i)abc'), { source: 'abc', flags: 'i' });
  // adobe-client-secret style: the prefix is case-sensitive, what follows (?i) is not
  const p = '\\b(p8e-(?i)[a-z0-9]{4})(?:\\s|$)';
  assert.equal(run(p, 'p8e-AbC9 '), true);
  assert.equal(run(p, 'P8E-AbC9 '), false, 'the part before (?i) stays case-sensitive');
  // a case-sensitive island inside a case-insensitive pattern
  const q = '(?i)abc(?-i:acc)x';
  assert.equal(run(q, 'ABCaccX'), true);
  assert.equal(run(q, 'ABCACCX'), false);
  // the flag ends with its group
  assert.equal(run('(?:(?i)a)b', 'Ab'), true);
  assert.equal(run('(?:(?i)a)b', 'AB'), false);
});

test('named groups, \\z, \\A and POSIX classes are translated; what changes meaning is refused', () => {
  assert.equal(translateRe2('(?P<name>a)b').source, '(?<name>a)b');
  assert.equal(run('a\\z', 'ba'), true);
  assert.equal(run('a\\z', 'a\n'), false, '\\z is the end of the text, not before a final line break');
  assert.equal(run('\\Aa', 'ab'), true);
  assert.equal(run('\\Aa', 'ba'), false);
  assert.equal(run('^[[:alpha:]]+$', 'abcXYZ'), true);
  assert.equal(run('^[[:alpha:]]+$', 'abc1'), false);
  assert.equal(run('(?s:a.b)', 'a\nb'), true);
  for (const bad of ['(?=a)', '(?!a)', '(?<=a)b', '\\Qa.b\\E', '\\pL', '(?U)a+', '(a)\\1', '\\x{263a}', '[[:nope:]]', 'a(?m)']) {
    assert.throws(() => translateRe2(bad), UnsupportedRegex, bad);
  }
});

// ---- the vendored gitleaks set

test('the vendored file converts with a reported skip, and the report adds up', async () => {
  const text = await fs.readFile(path.join(vendored, 'source', 'gitleaks.toml'), 'utf-8');
  const { ruleset, report } = convertGitleaks(text, { name: 'gitleaks', version: 'v8.30.1' });
  assert.equal(report.total, 222);
  assert.equal(report.converted + report.skipped.length, report.total);
  assert.equal(ruleset.rules.length, report.converted);
  assert.deepEqual(report.skipped.map((s) => s.id), ['pkcs12-file'], 'the one path-only rule');
  for (const r of ruleset.rules) assert.doesNotThrow(() => new RegExp(r.pattern.source, `${r.pattern.flags}dg`), r.id);
});

test('the vendored files are the upstream ones: the hashes match, and the set loads', async () => {
  const toml = await fs.readFile(path.join(vendored, 'source', 'gitleaks.toml'));
  assert.equal(gitBlobSha1(toml), '256f64790ea6d954f0041024be2938089ae1e7a7', 'the git blob hash the upstream repository reports for v8.30.1');
  const license = await fs.readFile(path.join(vendored, 'LICENSE'));
  assert.equal(gitBlobSha1(license), '3c270b36c539ca8fbc4cc1017d3cbb7be1e44bbc');
  const set = await loadRuleset(vendored);
  assert.equal(set.name, 'gitleaks');
  assert.equal(set.version, 'v8.30.1');
  assert.equal(set.rules.length, 221);
  assert.equal(set.provenance.license, 'MIT');
  assert.equal(set.provenance.commit, '83d9cd684c87d95d656c1458ef04895a7f1cbd8e');
});

async function copyOfVendored(): Promise<string> {
  const dest = path.join(root, `copy${n++}`);
  await fs.cp(vendored, dest, { recursive: true });
  return dest;
}

test('a changed file is not loaded: converted rules, upstream source, license, provenance', async () => {
  const a = await copyOfVendored();
  await fs.appendFile(path.join(a, 'ruleset.json'), ' ');
  await assert.rejects(loadRuleset(a), (e: Error) => e instanceof RulesetError && /changed after the conversion/.test(e.message));

  const b = await copyOfVendored();
  await fs.appendFile(path.join(b, 'source', 'gitleaks.toml'), '\n# edited');
  await assert.rejects(loadRuleset(b), /upstream source file .* does not match/);

  const c = await copyOfVendored();
  await fs.rm(path.join(c, 'LICENSE'));
  await assert.rejects(loadRuleset(c), /license file is missing/);

  const d = await copyOfVendored();
  const prov = JSON.parse(await fs.readFile(path.join(d, 'PROVENANCE.json'), 'utf-8'));
  prov.normalized.sha256 = '0'.repeat(64);
  await fs.writeFile(path.join(d, 'PROVENANCE.json'), JSON.stringify(prov));
  await assert.rejects(loadRuleset(d), /do not match their recorded hash/);

  const e = await copyOfVendored();
  await fs.writeFile(path.join(e, 'PROVENANCE.json'), '{ not json');
  await assert.rejects(loadRuleset(e), /not valid JSON/);
});

test('loading a folder of rule sets returns the good ones and names the failed ones; it never throws or drops one silently', async () => {
  const rootDir = path.join(root, `sets${n++}`);
  await fs.mkdir(rootDir);
  await fs.cp(vendored, path.join(rootDir, 'good'), { recursive: true });
  await fs.cp(vendored, path.join(rootDir, 'tampered'), { recursive: true });
  await fs.appendFile(path.join(rootDir, 'tampered', 'ruleset.json'), ' ');
  await fs.mkdir(path.join(rootDir, 'not-a-set'));
  const result = await loadRulesets(rootDir);
  assert.deepEqual(result.loaded.map((s) => path.basename(s.dir)), ['good']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].name, 'tampered');
  assert.match(result.failed[0].error, /changed after the conversion/);
  assert.deepEqual((await loadRulesets(path.join(root, 'does-not-exist'))).loaded, []);
});

// ---- finding secrets

test('made-up tokens of several kinds are found by the rule that names them; the value is never in the result', async () => {
  const set = await loadRuleset(vendored);
  const github = 'ghp_' + fake(36, ALNUM, 1);
  const aws = 'AKIA' + fake(16, BASE32, 2);
  const npm = 'npm_' + fake(36, LOWER_DIGITS, 3);
  const header = '-----BEGIN RSA PRIVATE' + ' KEY-----';
  const footer = '-----END RSA PRIVATE' + ' KEY-----';
  const pem = [header, fake(64, ALNUM, 4), fake(64, ALNUM, 5), footer].join('\n');
  const text = ['line one', `token = ${github}`, `id: ${aws} `, `NPM_TOKEN=${npm}`, pem, 'last line'].join('\n');

  const result = scanSecrets(text, [set]);
  assert.equal(result.truncated, false);
  const byRule = (id: string) => result.findings.find((f) => f.rule === id);
  for (const [id, value] of [['github-pat', github], ['aws-access-token', aws], ['npm-access-token', npm]] as const) {
    const f = byRule(id);
    assert.ok(f, `${id} was found`);
    assert.equal(text.slice(f.offset, f.offset + f.length), value, `${id} points at the token`);
  }
  assert.ok(byRule('private-key'), 'a private key block with a body');
  const out = JSON.stringify(result);
  for (const v of [github, aws, npm]) assert.ok(!out.includes(v), 'the result holds positions, not values');
});

test('ordinary text is not a finding, and a rule runs only when its keyword is there', async () => {
  const set = await loadRuleset(vendored);
  assert.deepEqual(scanSecrets('The council decided on a new cycle path. Install the package and run setup.', [set]).findings, []);
  assert.deepEqual(scanSecrets('x'.repeat(5000), [set]).findings, []);
  // a token shape without the word the rule needs is not looked for by that rule
  assert.equal(scanSecrets('ghp_' + fake(36, ALNUM, 9), [set]).findings.some((f) => f.rule === 'github-pat'), true, 'the prefix is the keyword');
});

test('a secret below the entropy of its rule is not a finding, a random one is', async () => {
  const set = await loadRuleset(vendored);
  const low = scanSecrets('api_key = "' + 'a'.repeat(40) + '"', [set]).findings.filter((f) => f.rule === 'generic-api-key');
  assert.equal(low.length, 0, 'forty equal characters have no entropy');
  const high = scanSecrets('api_key = "' + fake(40, ALNUM, 7) + '"', [set]).findings.filter((f) => f.rule === 'generic-api-key');
  assert.equal(high.length, 1);
  assert.ok(shannonEntropy(fake(40, ALNUM, 7)) > 4);
  assert.equal(shannonEntropy('aaaa'), 0);
});

test('a text longer than the limit is checked up to the limit and says so', async () => {
  const set = await loadRuleset(vendored);
  const result = scanSecrets('x'.repeat(5000), [set], { maxChars: 1000 });
  assert.equal(result.truncated, true);
});

test('no rule is slow on hostile input: the converted regexes finish on long repetitive text', async () => {
  const set = await loadRuleset(vendored);
  const inputs = ['a'.repeat(20_000), '0'.repeat(20_000), ' '.repeat(20_000), '='.repeat(20_000), '-----BEGIN '.repeat(2000), 'AKIA'.repeat(5000), 'a1'.repeat(10_000), '"\'`'.repeat(6000)];
  const slow: string[] = [];
  for (const rule of set.rules) {
    for (const input of inputs) {
      const started = Date.now();
      for (const m of input.matchAll(rule.regex)) void m;
      const took = Date.now() - started;
      if (took > 1500) slow.push(`${rule.id}: ${took} ms on ${input.slice(0, 6)}...`);
    }
  }
  assert.deepEqual(slow, [], 'a regex that backtracks catastrophically would show here');
});
