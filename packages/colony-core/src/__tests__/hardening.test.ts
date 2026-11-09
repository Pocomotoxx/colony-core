import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../atomic-write.js';
import { ColonyHub } from '../colony-hub.js';
import { VectorCodex } from '../memory/vector-codex.js';
import { InMemoryVectorStore } from '../memory/vector-store.js';
import { runCommand } from '../cli/commands.js';
import type { MemoryDocument } from '../memory/types.js';

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-hardening-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const hubWith = (codex?: VectorCodex) => {
  const hub = new ColonyHub(codex ? { name: 'T', codex } : undefined);
  hub.registry.register({ id: 'e1', name: 'e1', role: 'engineer', capabilities: { maxConcurrentTasks: 5 } });
  return hub;
};

// ---- atomic write

test('writeFileAtomic replaces the content and leaves no temp file behind', async () => {
  const file = path.join(root, 'state.json');
  await writeFileAtomic(file, 'one');
  await writeFileAtomic(file, 'two');
  assert.equal(await fs.readFile(file, 'utf-8'), 'two');
  assert.deepEqual((await fs.readdir(root)).filter((n) => n.endsWith('.tmp')), []);
});

test('a failed atomic write keeps the old content and removes its temp file', async () => {
  const dir = path.join(root, 'blocked');
  await fs.mkdir(dir);
  await assert.rejects(writeFileAtomic(dir, 'x')); // the target is a directory: the rename fails
  assert.deepEqual((await fs.readdir(root)).filter((n) => n.endsWith('.tmp')), []);
  assert.ok((await fs.stat(dir)).isDirectory());
});

// ---- learning failures are audited

test('a failing memory store is written to the audit log, and the task still completes', async () => {
  const store = new InMemoryVectorStore();
  store.upsert = async () => {
    throw Object.assign(new Error('disk full: SECRET-DETAIL'), { code: 'ENOSPC' });
  };
  const hub = hubWith(new VectorCodex({ vectorStore: store }));
  const t = await hub.orchestrator.createTask({ title: 'T', description: 'D', requiredRole: 'engineer' });
  await hub.orchestrator.completeTask(t.id, 'e1', 'result', { quality: 0.9 });
  assert.equal(hub.orchestrator.getTask(t.id)!.status, 'completed');
  const failed = hub.audit.list({ type: 'learning.failed' });
  assert.deepEqual(failed.map((e) => e.payload.store).sort(), ['outcomes', 'reasoning-bank']);
  assert.equal(failed[0].payload.code, 'ENOSPC');
  assert.ok(!JSON.stringify(failed).includes('SECRET-DETAIL'));
});

// ---- rating after the fact

test('rating a finished task puts it in the bank, and a re-rating replaces it', async () => {
  const hub = hubWith();
  const t = await hub.orchestrator.createTask({ title: 'Parse the ledger', description: 'read rows', requiredRole: 'engineer' });
  await hub.orchestrator.completeTask(t.id, 'e1', 'streamed the rows');
  assert.equal(await hub.reasoningBank.count(), 0);

  await hub.orchestrator.rateTask(t.id, 0.9);
  assert.equal(await hub.reasoningBank.count(), 1);
  await hub.orchestrator.rateTask(t.id, 0.2);
  assert.equal(await hub.reasoningBank.count(), 1);
  const [pattern] = await hub.reasoningBank.recallPatterns('Parse the ledger read rows', { minScore: 0 });
  assert.equal(pattern.successScore, 0.2);
  assert.equal(await hub.codex.count('outcomes'), 1);
});

test('a failed task can be rated without entering the bank; an open task cannot be rated', async () => {
  const hub = hubWith();
  const bad = await hub.orchestrator.createTask({ title: 'Break it', description: 'oops', requiredRole: 'engineer' });
  await hub.orchestrator.failTask(bad.id, 'e1', 'no');
  await hub.orchestrator.rateTask(bad.id, 0.3);
  assert.equal(await hub.reasoningBank.count(), 0);

  const open = await hub.orchestrator.createTask({ title: 'Later', description: 'not yet', requiredRole: 'engineer' });
  await assert.rejects(hub.orchestrator.rateTask(open.id, 0.5), /only a completed or failed task/);
  await assert.rejects(hub.orchestrator.rateTask(bad.id, 1.5), /between 0 and 1/);
  await assert.rejects(hub.orchestrator.rateTask('missing', 0.5), /not found/);
});

test('the rate command rates a finished task and rejects bad input', async () => {
  const dir = path.join(root, 'rate-cli');
  await fs.mkdir(dir);
  const run = async (...args: string[]) => {
    const { code, output } = await runCommand(args, dir);
    return { code, out: output as any };
  };
  await run('boot');
  const id = (await run('task', 'add', 'Parse widgets', 'parse the widget feed', '--role', 'engineer')).out.task.id;
  await run('done', id, '--result', 'widget parser implemented');

  assert.equal((await run('rate', id)).code, 1);
  assert.equal((await run('rate', id, '--quality', '2')).code, 1);
  assert.equal((await run('rate', 'missing', '--quality', '0.5')).code, 1);
  const ok = await run('rate', id, '--quality', '0.75');
  assert.equal(ok.code, 0);
  assert.equal(ok.out.rated.quality, 0.75);
  const learned = await run('memory', 'search', 'Parse widgets: parse the widget feed');
  assert.ok(learned.out.results.some((r: any) => /widget parser implemented/.test(r.text)));
});

// ---- vector codex

test('VectorCodex stores, searches by namespace, counts and clears', async () => {
  const codex = new VectorCodex();
  const docs = await codex.storeDocuments([
    { id: 'a', text: 'deploy pipeline uses blue green releases', namespace: 'ops' },
    { text: 'recipe for goulash soup with paprika', namespace: 'food' },
  ]);
  assert.equal(docs[0].id, 'a');
  assert.match(docs[1].id, /^doc_/);
  assert.equal(docs[0].vector!.length, codex.embeddings.dimension);

  assert.equal(await codex.count(), 2);
  assert.equal(await codex.count('ops'), 1);
  const hits = await codex.search('blue green deploy pipeline', { namespace: 'ops', topK: 5, minScore: 0 });
  assert.deepEqual(hits.map((h) => h.document.id), ['a']);
  assert.ok(hits[0].score > 0 && hits[0].score <= 1);

  await codex.clear('ops');
  assert.equal(await codex.count('ops'), 0);
  assert.equal(await codex.count(), 1);
});

test('VectorCodex upserts by id instead of duplicating, and ranks the closer text first', async () => {
  const codex = new VectorCodex();
  await codex.storeDocuments([{ id: 'x', text: 'first version of the note' }]);
  await codex.storeDocuments([{ id: 'x', text: 'second version of the note' }]);
  assert.equal(await codex.count(), 1);

  await codex.storeDocuments([
    { id: 'near', text: 'parse the widget feed into rows' },
    { id: 'far', text: 'paprika goulash soup recipe' },
  ]);
  const hits = await codex.search('parse widget feed rows', { minScore: 0, topK: 3 });
  assert.equal(hits[0].document.id, 'near');
});

test('VectorCodex works with a custom store', async () => {
  const seen: MemoryDocument[] = [];
  const store = new InMemoryVectorStore();
  const original = store.upsert.bind(store);
  store.upsert = async (docs) => {
    seen.push(...docs);
    return original(docs);
  };
  const codex = new VectorCodex({ vectorStore: store });
  await codex.storeDocuments([{ id: 'k', text: 'hello' }]);
  assert.equal(seen.length, 1);
  assert.equal(codex.store, store);
});
