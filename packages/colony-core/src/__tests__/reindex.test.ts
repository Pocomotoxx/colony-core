import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VectorCodex } from '../memory/vector-codex.js';
import { FileVectorStore } from '../memory/file-vector-store.js';
import { PositionalCharEmbeddingProvider } from '../memory/embedding-providers.js';
import { runCommand } from '../cli/commands.js';

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-reindex-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('memory written by the old embedding is re-embedded once, keeps its text, and is searchable', async () => {
  const file = path.join(root, 'memory.json');
  const oldProvider = new PositionalCharEmbeddingProvider();
  const old = new VectorCodex({ embeddingProvider: oldProvider, vectorStore: new FileVectorStore({ storagePath: file }) });
  const [stored] = await old.storeDocuments([{ id: 'x', text: 'read invoice rows from the csv feed', namespace: 'ops' }]);
  // an old file: the legacy format, a plain array with number[] vectors and no embedder field
  await fs.writeFile(file, JSON.stringify([{ ...stored, vector: stored.vector, embedder: undefined }]));

  const fresh = new VectorCodex({ vectorStore: new FileVectorStore({ storagePath: file }) });
  assert.deepEqual(await fresh.search('invoice csv rows', { minScore: -1 }), []); // stale vector: skipped, not a crash
  assert.equal(await fresh.reindex(), 1);
  assert.equal(await fresh.reindex(), 0); // already current

  const hits = await fresh.search('invoice csv rows', { minScore: 0.2 });
  assert.equal(hits[0].document.id, 'x');
  assert.equal(hits[0].document.text, 'read invoice rows from the csv feed');
  assert.equal(hits[0].document.embedder, 'deterministic-local-v2');
  const reread = new FileVectorStore({ storagePath: file });
  assert.equal((await reread.list())[0].vector!.length, 512);
});

test('the CLI re-embeds an older memory file when a project is opened', async () => {
  const dir = path.join(root, 'project');
  await fs.mkdir(dir);
  await runCommand(['boot'], dir);
  await runCommand(['memory', 'add', 'deploy pipeline uses blue green releases'], dir);
  const memFile = path.join(dir, '.colony', 'memory.json');
  const current = await new FileVectorStore({ storagePath: memFile }).list();
  // rewrite as the legacy format: a plain array, 128-long number[] vectors, no embedder field
  await fs.writeFile(memFile, JSON.stringify(current.map((d) => ({ ...d, vector: d.vector!.slice(0, 128), embedder: undefined }))));

  const hit = (await runCommand(['memory', 'search', 'blue green deployment'], dir)).output as any;
  assert.equal(hit.results.length, 1);
  assert.match(hit.results[0].text, /blue green/);
});
