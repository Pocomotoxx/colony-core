import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { aggregateDecision, checkDestructive, checkDiffSize, checkSecrets, checkToolAllowed } from '../gates.js';
import { runCommand } from '../cli/commands.js';

// Secret-shaped test values are assembled at run time so no literal secret sits in the source.
const fakeKey = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1';
const fakeAws = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const fakePassword = 'pass' + 'word = "hunter2-long"';

test('destructive commands need confirmation; ordinary ones pass', () => {
  for (const cmd of [
    'rm -rf build',
    'rm -fr build',
    'rm -r -f build',
    'rm -f x',
    'git push origin main --force',
    'git push -f origin main',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'psql -c "DROP TABLE users"',
    'psql -c "delete from users;"',
    'del /s /q C:\\temp',
    'kubectl delete namespace prod',
  ]) {
    assert.equal(checkDestructive(cmd)?.decision, 'require-confirmation', cmd);
  }
  for (const cmd of ['ls -la', 'rm file.txt', 'rm -i file.txt', 'git push origin main', 'git clean -n', 'git status', 'delete from users where id = 1']) {
    assert.equal(checkDestructive(cmd), null, cmd);
  }
});

test('secrets are blocked and the value is never echoed', () => {
  const text = `config:\n  key ${fakeKey}\n  aws ${fakeAws}\n  ${fakePassword}`;
  const result = checkSecrets(text)!;
  assert.equal(result.decision, 'block');
  assert.equal(result.details.count, 3);
  const dump = JSON.stringify(result);
  for (const secret of [fakeKey, fakeAws, 'hunter2-long', fakeKey.slice(0, 6), fakeAws.slice(-6)]) {
    assert.ok(!dump.includes(secret), `leaked ${secret.length} chars`);
  }
  const findings = result.details.findings as Array<{ pattern: string; offset: number }>;
  assert.deepEqual(findings.map((f) => f.offset), [...findings.map((f) => f.offset)].sort((a, b) => a - b));
});

test('plain text has no secrets, and scanning twice gives the same answer', () => {
  assert.equal(checkSecrets('just some prose with sk- and AKIA in it'), null);
  assert.deepEqual(checkSecrets(fakeKey), checkSecrets(fakeKey));
});

test('diff size warns above the threshold only', () => {
  assert.equal(checkDiffSize('a.ts', 300), null);
  assert.equal(checkDiffSize('a.ts', 301)?.decision, 'warn');
  assert.equal(checkDiffSize('a.ts', 50, 10)?.decision, 'warn');
  assert.throws(() => checkDiffSize('a.ts', -1), /non-negative/);
});

test('the tool allowlist: exact, prefix, star, and empty', () => {
  assert.equal(checkToolAllowed('anything', []), null);
  assert.equal(checkToolAllowed('Read', ['Read', 'Edit']), null);
  assert.equal(checkToolAllowed('mcp__x__get', ['mcp__x__*']), null);
  assert.equal(checkToolAllowed('anything', ['*']), null);
  assert.equal(checkToolAllowed('Bash', ['Read', 'mcp__x__*'])?.decision, 'block');
});

test('aggregateDecision picks the most restrictive result', () => {
  const warn = checkDiffSize('a', 999)!;
  const confirm = checkDestructive('rm -rf x')!;
  const block = checkToolAllowed('t', ['u'])!;
  assert.equal(aggregateDecision([]), 'allow');
  assert.equal(aggregateDecision([warn]), 'warn');
  assert.equal(aggregateDecision([warn, confirm]), 'require-confirmation');
  assert.equal(aggregateDecision([confirm, block, warn]), 'block');
});

// ---- CLI

let root: string;
let dir: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-gates-test-'));
  dir = path.join(root, 'p');
  await fs.mkdir(dir, { recursive: true });
  await runCommand(['boot'], dir);
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const run = async (...args: string[]) => {
  const { code, output } = await runCommand(args, dir);
  return { code, out: output as any };
};

test('check needs something to check, and runs only after boot', async () => {
  assert.match((await run('check')).out.error, /at least one of/);
  const fresh = await runCommand(['check', '--command', 'ls'], path.join(root, 'unbooted'));
  assert.equal(fresh.code, 2);
});

test('check: allow, require-confirmation, and block with exit 3', async () => {
  const ok = await run('check', '--command', 'ls -la');
  assert.equal(ok.code, 0);
  assert.equal(ok.out.decision, 'allow');

  const risky = await run('check', '--command', 'git reset --hard');
  assert.equal(risky.code, 0);
  assert.equal(risky.out.decision, 'require-confirmation');
  assert.equal(risky.out.ok, true);

  const secret = await run('check', '--command', `curl -H "x: ${fakeKey}" host`);
  assert.equal(secret.code, 3);
  assert.equal(secret.out.decision, 'block');
  assert.ok(!JSON.stringify(secret.out).includes(fakeKey));
});

test('check --file scans a project file and sizes a diff; paths outside the project are refused', async () => {
  await fs.writeFile(path.join(dir, 'leak.txt'), `token ${fakeKey}\n`, 'utf-8');
  await fs.writeFile(path.join(dir, 'clean.txt'), 'nothing here\n', 'utf-8');

  const leak = await run('check', '--file', 'leak.txt');
  assert.equal(leak.code, 3);
  assert.ok(!JSON.stringify(leak.out).includes(fakeKey));

  const big = await run('check', '--file', 'clean.txt', '--diff-lines', '500');
  assert.equal(big.out.decision, 'warn');
  const small = await run('check', '--file', 'clean.txt', '--diff-lines', '5');
  assert.equal(small.out.decision, 'allow');

  assert.match((await run('check', '--file', '../outside.txt')).out.error, /inside the project/);
  assert.match((await run('check', '--file', 'missing.txt')).out.error, /not found/);
  assert.match((await run('check', '--file', 'clean.txt', '--diff-lines', 'abc')).out.error, /non-negative/);
});

test('check --tool applies the allowlist', async () => {
  assert.equal((await run('check', '--tool', 'Bash', '--allow', 'Read,Edit')).code, 3);
  assert.equal((await run('check', '--tool', 'Read', '--allow', 'Read,Edit')).out.decision, 'allow');
  assert.equal((await run('check', '--tool', 'Bash')).out.decision, 'allow'); // no allowlist, no restriction
});
