import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../cli/commands.js';
import { runVerification } from '../verify/run.js';

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-verify-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const NODE = process.execPath;

async function project(name: string) {
  const dir = path.join(root, name);
  await fs.mkdir(dir);
  const run = async (...args: string[]) => {
    const { code, output } = await runCommand(args, dir);
    return { code, out: output as any };
  };
  await run('boot');
  return run;
}

async function finishedTask(run: Awaited<ReturnType<typeof project>>, extra: string[] = []) {
  const id = (await run('task', 'add', 'Fix parser', 'make the parser pass', '--role', 'engineer')).out.task.id;
  await run('next', '--as', 'engineer');
  await run('done', id, '--result', 'fixed it', ...extra);
  return id;
}

test('the runner reports the exit code, hashes the output and never stores it', async () => {
  const ok = await runVerification([NODE, '-e', 'console.log("hello")'], root, 10_000);
  assert.deepEqual([ok.passed, ok.exitCode, ok.timedOut], [true, 0, false]);
  assert.match(ok.outputHash, /^[0-9a-f]{16}$/);
  assert.match(ok.tail, /hello/);
  const bad = await runVerification([NODE, '-e', 'process.exit(3)'], root, 10_000);
  assert.deepEqual([bad.passed, bad.exitCode], [false, 3]);
});

test('no shell: metacharacters in an argument are just text', async () => {
  const r = await runVerification([NODE, '-e', 'console.log(process.argv[1])', '; echo INJECTED && exit 9'], root, 10_000);
  assert.equal(r.passed, true);
  assert.match(r.tail, /; echo INJECTED && exit 9/); // printed as an argument, not executed
});

test('a command that runs too long is stopped', async () => {
  const r = await runVerification([NODE, '-e', 'setTimeout(() => {}, 60000)'], root, 400);
  assert.equal(r.timedOut, true);
  assert.equal(r.passed, false);
  assert.ok(r.durationMs < 20_000);
});

test('a passed check marks the work verified, and the recall shows it', async () => {
  const run = await project('pass');
  const id = await finishedTask(run, ['--quality', '0.9']);
  const v = await run('verify', id, '--', NODE, '-e', 'process.exit(0)');
  assert.equal(v.code, 0, JSON.stringify(v.out));
  assert.equal(v.out.verification.passed, true);
  assert.equal(v.out.contradiction, false);
  assert.equal(v.out.quality.effective, 0.9);

  await run('task', 'add', 'Fix parser again', 'make the parser pass once more', '--role', 'engineer');
  const next = await run('next', '--as', 'engineer');
  assert.ok(next.out.recall.worked.some((w: any) => w.verified === true));
});

test('a failed check beats the host\'s claim: the contradiction is named and the quality is lowered', async () => {
  const run = await project('fail');
  const id = await finishedTask(run, ['--quality', '0.95', '--verified-by-test']);
  const v = await run('verify', id, '--', NODE, '-e', 'process.exit(1)');
  assert.equal(v.code, 0);
  assert.equal(v.out.claimedTestRun, true);
  assert.equal(v.out.contradiction, true);
  assert.deepEqual(v.out.quality, { reported: 0.95, effective: 0.3, loweredByCheck: true });
  assert.match(v.out.note, /failed/);

  // memory relearned from the lowered rating: it is now something to avoid, not a model to follow
  await run('task', 'add', 'Fix parser once more', 'make the parser pass yet again', '--role', 'engineer');
  const next = await run('next', '--as', 'engineer');
  assert.ok(next.out.recall.caution.some((c: any) => c.rating === 0.3));
  assert.ok(!next.out.recall.worked.some((w: any) => /fixed it/.test(w.approach)));

  const audit = await run('audit', 'list', '--type', 'task.verified');
  assert.equal(audit.out.entries.length, 1);
  assert.equal(audit.out.entries[0].payload.contradiction, true);
  assert.ok(!JSON.stringify(audit.out.entries).includes('process.exit'), 'the audit keeps the tool name, not the arguments');
});

test('the user\'s later rating still wins over the check', async () => {
  const run = await project('user-wins');
  const id = await finishedTask(run, ['--quality', '0.9']);
  await run('verify', id, '--', NODE, '-e', 'process.exit(1)');
  const rated = await run('rate', id, '--quality', '0.7');
  assert.equal(rated.out.rated.quality, 0.7);
});

test('verify refuses unfinished tasks, destructive commands, secrets and bad input', async () => {
  const run = await project('refuse');
  const open = (await run('task', 'add', 'Open', 'not done', '--role', 'engineer')).out.task.id;
  assert.equal((await run('verify', open, '--', NODE, '-v')).code, 1);
  const id = await finishedTask(run);
  assert.equal((await run('verify', id)).code, 1);
  assert.equal((await run('verify', 'missing', '--', NODE, '-v')).code, 1);
  assert.match((await run('verify', id, '--', 'rm', '-rf', 'build')).out.error, /refused by the gates/);
  assert.match((await run('verify', id, '--', 'curl', 'AKIA' + 'ABCDEFGHIJKLMNOP')).out.error, /refused by the gates/);
  assert.equal((await run('verify', id, '--timeout-sec', '0', '--', NODE, '-v')).code, 1);
  assert.equal((await run('verify', id, '--', 'definitely-not-a-program-xyz')).code, 1);
});
