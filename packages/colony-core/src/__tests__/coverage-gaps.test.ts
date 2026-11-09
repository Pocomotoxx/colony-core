import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageBus } from '../message-bus.js';
import { LockTimeoutError, withStateLock } from '../state-lock.js';
import { runVerification, VerifyError } from '../verify/run.js';

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-gaps-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

function runCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ---- the real binary, the normal (non-hook) path

test('the binary prints JSON on stdout for success and on stderr for failure, with the exit code', async () => {
  const dir = path.join(root, 'bin');
  await fs.mkdir(dir);
  const help = await runCli(['help'], dir);
  assert.equal(help.code, 0);
  assert.equal(JSON.parse(help.stdout).ok, true);
  assert.equal(help.stderr, '');

  const noBoot = await runCli(['status'], dir);
  assert.equal(noBoot.code, 2);
  assert.match(JSON.parse(noBoot.stderr).error, /not booted/);
  assert.equal(noBoot.stdout, '');

  assert.equal((await runCli(['boot'], dir)).code, 0);
  const unknown = await runCli(['nope'], dir);
  assert.equal(unknown.code, 1);
  assert.match(JSON.parse(unknown.stderr).error, /unknown command/);
  const status = await runCli(['status'], dir);
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.stdout).tasks.length, 0);
});

test('the hook entry reports usage for an unknown hook command', async () => {
  const r = await runCli(['hook', 'nope'], root);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: colony hook/);
});

// ---- message bus

test('the bus delivers to topic and wildcard handlers, unsubscribes, keeps bounded history, and survives a throwing handler', async () => {
  const bus = new MessageBus(3);
  const seen: string[] = [];
  const off = bus.subscribe('a:one', (e) => { seen.push(`topic:${e.topic}`); });
  bus.subscribe('*', (e) => { seen.push(`all:${e.topic}`); });
  bus.subscribe('a:boom', () => { throw new Error('handler failed'); });
  bus.subscribe('*', () => Promise.reject(new Error('wildcard failed')));

  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await bus.publish('a:one', 's', {});
    await bus.publish('a:boom', 's', {}); // a failing handler must not break publishing
    off();
    await bus.publish('a:one', 's', {});
  } finally {
    console.error = original;
  }
  assert.deepEqual(seen, ['topic:a:one', 'all:a:one', 'all:a:boom', 'all:a:one']); // the unsubscribed handler is silent
  assert.ok(errors.length >= 2);

  await bus.publish('x', 's', 1);
  assert.equal(bus.getHistory().length, 3); // bounded
  assert.equal(bus.getHistory('a:').length, 2);
  bus.clear();
  assert.equal(bus.getHistory().length, 0);
});

// ---- state lock: unreadable lock content

test('a lock file with unreadable content is waited on while fresh and taken over once old', async () => {
  const dir = path.join(root, 'lock-garbage');
  await fs.mkdir(dir);
  const lock = path.join(dir, 'state.lock');
  await fs.writeFile(lock, 'not json');
  await assert.rejects(withStateLock(dir, async () => 'no', { timeoutMs: 80, pollMs: 10 }), LockTimeoutError);

  const old = new Date(Date.now() - 5 * 60_000);
  await fs.utimes(lock, old, old);
  assert.equal(await withStateLock(dir, async () => 'took over', { staleMs: 60_000 }), 'took over');
});

test('a stale lock is claimed by exactly one of several waiters', async () => {
  const dir = path.join(root, 'lock-race');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'state.lock'), JSON.stringify({ pid: 2_000_000_000, host: os.hostname(), at: Date.now(), token: 'test-token' }));
  let inside = 0;
  let maxInside = 0;
  const job = () => withStateLock(dir, async () => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    await new Promise((r) => setTimeout(r, 20));
    inside--;
  }, { pollMs: 5 });
  await Promise.all(Array.from({ length: 8 }, job));
  assert.equal(maxInside, 1); // never two holders at once, including the takeover moment
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.startsWith('state.lock')), []);
});

// ---- verification runner edges

test('the runner rejects an empty command and a program that does not exist', async () => {
  await assert.rejects(runVerification([], root, 1000), VerifyError);
  await assert.rejects(runVerification(['definitely-not-a-program-xyz'], root, 1000), /could not run/);
});

test('on Windows, package-manager commands accept only plain arguments', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(runVerification(['pnpm', 'test', '& echo hacked'], root, 1000), /plain arguments/);
  await assert.rejects(runVerification(['npm', 'run', 'a|b'], root, 1000), /plain arguments/);
});
