import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LockTimeoutError, withStateLock } from '../state-lock.js';
import { runCommand } from '../cli/commands.js';

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-lock-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('the lock serializes work and is released afterwards, also after an error', async () => {
  const dir = path.join(root, 'a');
  const order: string[] = [];
  const job = (name: string, ms: number) => withStateLock(dir, async () => {
    order.push(`${name}:start`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${name}:end`);
  });
  await Promise.all([job('one', 60), job('two', 10)]);
  assert.deepEqual(order.map((x) => x.split(':')[1]), ['start', 'end', 'start', 'end']); // never interleaved

  await assert.rejects(withStateLock(dir, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withStateLock(dir, async () => 'free again'), 'free again');
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.lock')), []);
});

test('a lock left by a dead process is taken over; a busy lock times out with a clear error', async () => {
  const dir = path.join(root, 'b');
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, 'state.lock');

  await fs.writeFile(lock, JSON.stringify({ pid: 2_000_000_000, host: os.hostname(), at: Date.now(), token: 'test-token' }));
  assert.equal(await withStateLock(dir, async () => 'took over'), 'took over');

  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), token: 'test-token' })); // alive, and fresh
  await assert.rejects(withStateLock(dir, async () => 'no', { timeoutMs: 100, pollMs: 10 }), LockTimeoutError);

  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, host: 'other-machine', at: Date.now() - 120_000, token: 'test-token' })); // old
  assert.equal(await withStateLock(dir, async () => 'stale by age'), 'stale by age');
});

test('parallel hosts adding tasks do not lose each other\'s updates', async () => {
  const dir = path.join(root, 'c');
  await fs.mkdir(dir);
  await runCommand(['boot'], dir);
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => runCommand(['task', 'add', `Task ${i}`, `description ${i}`, '--role', 'engineer'], dir)),
  );
  assert.ok(results.every((r) => r.code === 0), JSON.stringify(results.map((r) => r.output)));
  const status = (await runCommand(['status'], dir)).output as any;
  assert.equal(status.tasks.length, 6);
});
