import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../cli/commands.js';
import { runHook } from '../hook/cli.js';
import { evaluatePreToolUse } from '../hook/pretool.js';
import { findProjectRoot } from '../hook/project-root.js';
import { FileVectorStore } from '../memory/file-vector-store.js';
import { LockTimeoutError, withStateLock } from '../state-lock.js';

// Findings A-1, D-3 and D-1 of the external audit.

let root: string;
let n = 0;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-round2-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function dir(name: string) {
  const d = path.join(root, `${name}${n++}`);
  await fs.mkdir(d, { recursive: true });
  return d;
}
async function project() {
  const d = await dir('proj');
  await fs.mkdir(path.join(d, '.colony'));
  await fs.mkdir(path.join(d, 'docs'));
  return d;
}

// ---- A-1: the guard's root is the project, and a link into .colony is .colony

test('the host in a subdirectory: the project is found above it, and a write to the project .colony is denied', async () => {
  const proj = await project();
  const docs = path.join(proj, 'docs');
  assert.equal(await findProjectRoot(docs), proj);
  assert.equal(await findProjectRoot(proj), proj);
  const bare = await dir('bare');
  assert.equal(await findProjectRoot(bare), bare, 'with no .colony or .git above, the directory itself is the project');

  const hook = async (cwd: string, command: string) => (await runHook('pretool', JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } }), proj)).stdout;
  assert.match(await hook(docs, 'echo x > ../.colony/ledger.json'), /deny/);
  assert.match(await hook(proj, 'echo x > .colony/ledger.json'), /deny/);
  assert.equal(await hook(docs, 'echo x > notes.txt'), '', 'an ordinary write passes untouched');

  // a relative path of a file tool starts where the host is
  const write = (file: string) => evaluatePreToolUse({ tool_name: 'Write', tool_input: { file_path: file, content: 'x' } }, proj, docs);
  assert.equal((await write('../.colony/ledger.json')).decision, 'deny');
  assert.equal((await write('notes.txt')).decision, 'allow');
});

test('a symlink or junction that points into .colony or .git is that directory for a shell command too', async () => {
  const proj = await project();
  await fs.mkdir(path.join(proj, '.git'));
  await fs.symlink(path.join(proj, '.colony'), path.join(proj, 'lnk'), 'junction');
  await fs.symlink(path.join(proj, '.git'), path.join(proj, 'gitlink'), 'junction');
  const verdict = async (command: string) => (await evaluatePreToolUse({ tool_name: 'Bash', tool_input: { command } }, proj)).decision;
  assert.equal(await verdict('echo x > lnk/ledger.json'), 'deny');
  assert.equal(await verdict('cd lnk && echo x > ledger.json'), 'deny');
  assert.equal(await verdict('tee gitlink/config'), 'deny');
  assert.equal(await verdict('echo x > docs/a.txt'), 'allow');
});

// ---- D-3: a memory file that was not read cleanly is never written over

const doc = (id: string) => ({ id, text: id, vector: [1, 0], namespace: 'x', createdAt: 1 });

test('a null row in the memory file: the other rows can be read, and nothing is written over the file', async () => {
  const d = await dir('mem');
  const file = path.join(d, 'memory.json');
  await fs.writeFile(file, JSON.stringify([doc('a'), null, doc('b')]));
  const before = await fs.readFile(file, 'utf-8');
  const store = new FileVectorStore({ storagePath: file, index: 'linear' });
  assert.deepEqual((await store.list()).map((x) => x.id).sort(), ['a', 'b']);
  await assert.rejects(store.upsert([doc('c')]), /not read cleanly/);
  assert.equal(await fs.readFile(file, 'utf-8'), before, 'the file is as it was');
});

test('an unreadable memory file is not written over either; a clean one is written as before', async () => {
  const d = await dir('mem');
  const broken = path.join(d, 'broken.json');
  await fs.writeFile(broken, '{ not json');
  const store = new FileVectorStore({ storagePath: broken, index: 'linear' });
  await assert.rejects(store.upsert([doc('a')]), /not read cleanly/);
  assert.equal(await fs.readFile(broken, 'utf-8'), '{ not json');

  const fine = path.join(d, 'fine.json');
  const ok = new FileVectorStore({ storagePath: fine, index: 'linear' });
  await ok.upsert([doc('a')]);
  await ok.upsert([doc('b')]);
  assert.deepEqual((await new FileVectorStore({ storagePath: fine, index: 'linear' }).list()).map((x) => x.id).sort(), ['a', 'b']);
});

test('boot is blocked by a memory row that is not a document', async () => {
  const d = await dir('boot');
  assert.equal((await runCommand(['boot', '--dir', d], process.cwd())).code, 0);
  await fs.writeFile(path.join(d, '.colony', 'memory.json'), JSON.stringify({ v: 2, docs: [null] }));
  const r = await runCommand(['boot', '--dir', d], process.cwd());
  assert.equal(r.code, 2);
  assert.equal((r.output as any).boot.status, 'BLOCKED');
});

// ---- D-1: a live holder is never taken over

test('a holder that is alive on this machine is not taken over, however long its work runs', async () => {
  const d = await dir('lock');
  const log: string[] = [];
  const a = withStateLock(d, async () => { log.push('A in'); await sleep(1500); log.push('A out'); }, { staleMs: 400 });
  await sleep(100);
  const b = withStateLock(d, async () => { log.push('B in'); await sleep(50); log.push('B out'); }, { staleMs: 400, timeoutMs: 10_000, pollMs: 25 });
  await Promise.all([a, b]);
  assert.deepEqual(log, ['A in', 'A out', 'B in', 'B out'], 'B waited for A');
});

test('a lock of a live process id is taken over only when it is very old (the id may have been reused)', async () => {
  const d = await dir('lock');
  const lock = path.join(d, 'state.lock');
  const mine = (at: number) => JSON.stringify({ pid: process.pid, host: os.hostname(), at, token: 'test-token' });
  await fs.writeFile(lock, mine(Date.now() - 10 * 60_000));
  await assert.rejects(withStateLock(d, async () => 'no', { timeoutMs: 100, pollMs: 10 }), LockTimeoutError);
  await fs.writeFile(lock, mine(Date.now() - 31 * 60_000));
  assert.equal(await withStateLock(d, async () => 'took over', { pollMs: 10 }), 'took over');
});

test('while the work runs, the holder keeps the time in the lock fresh', async () => {
  const d = await dir('lock');
  const lock = path.join(d, 'state.lock');
  const at = async () => (JSON.parse(await fs.readFile(lock, 'utf-8')) as { at: number }).at;
  await withStateLock(d, async () => {
    const first = await at();
    await sleep(2500);
    assert.ok((await at()) > first, 'the time was rewritten');
  }, { staleMs: 3000 });
  await assert.rejects(fs.access(lock), 'the lock is gone afterwards');
});
