import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendEvidence, classifyCommand, EVIDENCE_FILE, latestAsVerification, readEvidence, toEvidence, ToolOutcome } from '../evidence/evidence.js';

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-evidence-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const outcome = (over: Partial<ToolOutcome>): ToolOutcome => ({
  session: 's1', tool: 'Bash', command: 'pnpm test', succeeded: true, durationMs: 1200, interrupted: false, outputText: 'ok', ...over,
});

test('test, build, lint and typecheck commands are checks, however they are launched', () => {
  for (const command of [
    'pnpm test', 'npm run build', 'yarn lint', 'bun run typecheck', 'npx tsc --noEmit', 'npx --yes vitest run', 'tsc -p .', 'eslint .',
    'node --test dist/x.test.js', 'node --experimental-test-coverage --test a.js', 'python -m pytest -q', 'pytest', 'ruff check .', 'go test ./...',
    'cargo test', 'cargo clippy', 'dotnet test', 'dotnet build -c Release', 'mvn -q verify', './gradlew test', 'make test', 'phpunit', 'rspec',
    'CI=1 pnpm test', 'cd app && pnpm test', 'git pull; pnpm build',
  ]) assert.equal(classifyCommand(command).check, true, command);
  for (const command of ['ls -la', 'git status', 'echo pnpm test', 'cat package.json', 'node app.js', 'python script.py', 'curl http://x', 'pnpm install', 'rm -rf build']) {
    assert.equal(classifyCommand(command).check, false, command);
  }
});

test('a check whose exit status is not the check\'s is not reliable: a pipe or a masked status', () => {
  assert.deepEqual(classifyCommand('pnpm test'), { check: true, reliable: true });
  assert.deepEqual(classifyCommand('cd app && pnpm test && pnpm build'), { check: true, reliable: true });
  for (const command of ['pnpm test | tail -5', 'pnpm test 2>&1 | tee log.txt', 'pnpm test || true', 'pnpm test || exit 0', 'pnpm test; true', 'node --test a.js || :']) {
    assert.equal(classifyCommand(command).reliable, false, command);
  }
  assert.equal(classifyCommand('pnpm test --reporter "a|b"').reliable, true); // a pipe inside quotes is not a pipe
});

test('a pass and a failure become records; exit code, duration and a hash of the output are kept, not the output', () => {
  const pass = toEvidence(outcome({}), 1000)!;
  assert.deepEqual([pass.outcome, pass.exitCode, pass.durationMs, pass.session, pass.at], ['passed', 0, 1200, 's1', 1000]);
  assert.match(pass.outputHash, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(pass).includes('"ok"') || pass.outputBytes === 2);

  const fail = toEvidence(outcome({ succeeded: false, outputText: 'Exit code 3\nboom: secret-looking text stays out' }), 2000)!;
  assert.deepEqual([fail.outcome, fail.exitCode], ['failed', 3]);
  assert.ok(!JSON.stringify(fail).includes('boom'));

  const interrupted = toEvidence(outcome({ succeeded: false, interrupted: true, outputText: 'interrupted' }))!;
  assert.deepEqual([interrupted.outcome, interrupted.exitCode, interrupted.interrupted], ['failed', null, true]);
});

test('not-a-check and unreliable commands produce no evidence; a command with a secret is withheld', () => {
  assert.equal(toEvidence(outcome({ command: 'ls' })), null);
  assert.equal(toEvidence(outcome({ command: 'pnpm test | tail' })), null);
  const withSecret = toEvidence(outcome({ command: 'API_KEY="abcdef123456" pnpm test' }))!;
  assert.match(withSecret.command, /withheld/);
  assert.ok(!JSON.stringify(withSecret).includes('abcdef123456'));
});

test('records are appended, filtered by time and session, and a damaged line is skipped', async () => {
  const dir = path.join(root, 'store');
  await appendEvidence(dir, toEvidence(outcome({ session: 'a' }), 100)!);
  await appendEvidence(dir, toEvidence(outcome({ session: 'b', succeeded: false, outputText: 'Exit code 1\nx' }), 200)!);
  await fs.appendFile(path.join(dir, EVIDENCE_FILE), '{ half a line\n');
  await appendEvidence(dir, toEvidence(outcome({ session: 'a', command: 'npm run build' }), 300)!);

  assert.equal((await readEvidence(dir)).length, 3);
  assert.equal((await readEvidence(dir, { since: 150 })).length, 2);
  assert.equal((await readEvidence(dir, { session: 'a' })).length, 2);
  assert.deepEqual(await readEvidence(path.join(root, 'nothing')), []);
});

test('only the latest check counts as the verification: a fixed failure is a pass, a pass then a failure is a fail', () => {
  const rec = (at: number, succeeded: boolean) => toEvidence(outcome({ succeeded, outputText: succeeded ? 'ok' : 'Exit code 1\nx' }), at)!;
  assert.equal(latestAsVerification([]), null);
  assert.equal(latestAsVerification([rec(1, false), rec(2, true)])!.passed, true);
  assert.equal(latestAsVerification([rec(1, true), rec(2, false)])!.passed, false);
  const v = latestAsVerification([rec(5, true)])!;
  assert.equal(v.source, 'observed');
  assert.equal(v.exitCode, 0);
});
