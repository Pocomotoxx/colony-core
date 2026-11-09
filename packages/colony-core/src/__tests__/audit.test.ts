import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuditLog, canonicalJson, GENESIS_HASH } from '../audit-log.js';
import { runCommand } from '../cli/commands.js';

const T0 = 1_000_000;

function sample(): AuditLog {
  const log = new AuditLog();
  log.append({ type: 'task.added', aggregateId: 't1', actor: 'a', payload: { title: 'x' } }, T0);
  log.append({ type: 'task.started', aggregateId: 't1', actor: 'b' }, T0 + 1);
  log.append({ type: 'task.added', aggregateId: 't2', actor: 'a' }, T0 + 2);
  return log;
}

// ---- log

test('canonicalJson sorts keys and ignores undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
});

test('entries chain from the genesis hash and count versions per aggregate', () => {
  const log = sample();
  const [first, second, third] = log.snapshot();
  assert.equal(first.prevHash, GENESIS_HASH);
  assert.equal(second.prevHash, first.hash);
  assert.equal(third.prevHash, second.hash);
  assert.deepEqual([first.version, second.version, third.version], [1, 2, 1]);
  assert.deepEqual(log.verify(), { ok: true, entries: 3, head: third.hash });
  assert.equal(new AuditLog().head(), GENESIS_HASH);
});

test('the same appends give the same hashes', () => {
  assert.deepEqual(sample().snapshot(), sample().snapshot());
});

test('list filters by aggregate, type and actor and keeps the last matches', () => {
  const log = sample();
  assert.equal(log.list({ aggregateId: 't1' }).length, 2);
  assert.equal(log.list({ type: 'task.added' }).length, 2);
  assert.equal(log.list({ actor: 'b' }).length, 1);
  assert.deepEqual(log.list({ limit: 1 }).map((e) => e.seq), [2]);
  assert.deepEqual(log.list({ limit: 0 }), []);
});

test('verify finds an edited, removed, reordered or forged entry', () => {
  const edit = sample().snapshot();
  edit[1].actor = 'mallory';
  assert.deepEqual(AuditLog.verifyEntries(edit), { ok: false, brokenAt: 1, reason: 'entry 1 was changed (hash mismatch)' });

  const removed = sample().snapshot();
  removed.splice(1, 1);
  const r = AuditLog.verifyEntries(removed);
  assert.equal(r.ok, false);

  const swapped = sample().snapshot();
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.equal(AuditLog.verifyEntries(swapped).ok, false);

  const forged = sample().snapshot();
  forged[2].version = 5;
  assert.equal(AuditLog.verifyEntries(forged).ok, false);
});

test('restore refuses a broken chain and keeps the old state', () => {
  const log = sample();
  const broken = sample().snapshot();
  broken[0].payload = { title: 'other' };
  assert.throws(() => log.restore(broken), /audit log is broken/);
  assert.equal(log.length, 3);

  const copy = new AuditLog();
  copy.restore(log.snapshot());
  copy.append({ type: 'task.started', aggregateId: 't2', actor: 'a' }, T0 + 9);
  assert.equal(copy.list({ aggregateId: 't2' }).at(-1)?.version, 2); // versions continue after a restore
});

test('an anchor detects a cut and a rewrite, but a longer log still holds it', () => {
  const log = sample();
  const anchor = log.anchor();
  log.append({ type: 'x', aggregateId: 't3', actor: 'a' }, T0 + 5);
  assert.equal(log.contains(anchor), true);
  assert.equal(log.contains({ entries: 0, head: GENESIS_HASH }), true);

  const cut = new AuditLog();
  cut.restore(log.snapshot().slice(0, 2));
  assert.equal(cut.contains(anchor), false);

  const rewritten = new AuditLog();
  rewritten.append({ type: 'task.added', aggregateId: 't1', actor: 'someone else' }, T0);
  rewritten.append({ type: 'task.started', aggregateId: 't1', actor: 'b' }, T0 + 1);
  rewritten.append({ type: 'task.added', aggregateId: 't2', actor: 'a' }, T0 + 2);
  assert.equal(rewritten.verify().ok, true); // a recomputed chain is valid on its own ...
  assert.equal(rewritten.contains(anchor), false); // ... but is not the log that was anchored
});

// ---- CLI

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-audit-test-'));
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
  const auditPath = path.join(dir, '.colony', 'audit.jsonl');
  await run('boot');
  return { run, auditPath };
}

test('commands leave a verified trail, and free text stays out of it', async () => {
  const { run, auditPath } = await project('trail');
  const taskId = (await run('task', 'add', 'Build', 'Write the thing', '--role', 'engineer')).out.task.id;
  await run('next', '--as', 'engineer');
  await run('check', '--command', 'curl -H "x: ' + 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1' + '" host');
  await run('done', taskId, '--result', 'SECRET-RESULT-TEXT');

  const types = (await run('audit', 'list', '--k', '50')).out.entries.map((e: any) => e.type);
  assert.deepEqual(types, ['task.added', 'task.started', 'check', 'task.completed']);
  assert.deepEqual((await run('audit', 'list', '--task', taskId)).out.entries.map((e: any) => e.version), [1, 2, 3]);
  assert.equal((await run('audit', 'list', '--type', 'check')).out.entries.length, 1);

  const raw = await fs.readFile(auditPath, 'utf-8');
  assert.ok(!raw.includes('SECRET-RESULT-TEXT'));
  assert.ok(!raw.includes('sk-a1B2'));
  assert.equal(raw.trim().split('\n').length, 4);

  const verify = await run('audit', 'verify');
  assert.equal(verify.code, 0);
  assert.equal(verify.out.chain.ok, true);
});

test('editing an entry in the middle of the file blocks the next command and boot', async () => {
  const { run, auditPath } = await project('tamper');
  await run('task', 'add', 'One', 'First', '--role', 'engineer');
  await run('task', 'add', 'Two', 'Second', '--role', 'engineer');
  const lines = (await fs.readFile(auditPath, 'utf-8')).trim().split('\n');
  const first = JSON.parse(lines[0]);
  first.actor = 'mallory';
  lines[0] = JSON.stringify(first);
  await fs.writeFile(auditPath, lines.join('\n') + '\n', 'utf-8');

  const status = await run('status');
  assert.equal(status.code, 1);
  assert.match(status.out.error, /audit log is broken/);
  const boot = await run('boot');
  assert.equal(boot.code, 2);
  assert.equal(boot.out.boot.status, 'BLOCKED');
});

test('cutting entries off the end is caught at the next boot, even though the chain is intact', async () => {
  const { run, auditPath } = await project('cut');
  await run('task', 'add', 'One', 'First', '--role', 'engineer');
  await run('task', 'add', 'Two', 'Second', '--role', 'engineer');
  assert.equal((await run('boot')).out.boot.audit.entries, 2); // anchor recorded

  const lines = (await fs.readFile(auditPath, 'utf-8')).trim().split('\n');
  await fs.writeFile(auditPath, lines[0] + '\n', 'utf-8');

  const verify = await run('audit', 'verify');
  assert.equal(verify.code, 2);
  assert.equal(verify.out.chain.ok, true);
  assert.equal(verify.out.sinceBoot.stillHeld, false);

  const boot = await run('boot');
  assert.equal(boot.code, 2);
  assert.ok(boot.out.boot.problems.some((p: string) => /truncated or rewritten/.test(p)));
  assert.equal(boot.out.boot.audit.entries, 2); // the anchor survives the blocked boot
});

test('a log that only grew since the last boot is fine, and a fresh colony starts empty', async () => {
  const { run } = await project('grow');
  assert.equal((await run('audit', 'list')).out.total, 0);
  const first = await run('boot');
  await run('task', 'add', 'One', 'First', '--role', 'engineer');
  const second = await run('boot');
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.equal(second.out.boot.audit.entries, 1);
  assert.equal((await run('audit', 'verify')).code, 0);
});

test('audit list rejects a bad --k and an unknown subcommand', async () => {
  const { run } = await project('args');
  assert.match((await run('audit', 'list', '--k', '-1')).out.error, /--k/);
  assert.match((await run('audit', 'wipe')).out.error, /usage: audit/);
});
