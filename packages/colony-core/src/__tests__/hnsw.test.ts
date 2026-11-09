import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HnswIndex } from '../memory/hnsw-index.js';
import { FileVectorStore } from '../memory/file-vector-store.js';
import { cosineSimilarity } from '../memory/vector-store.js';

/** Small seeded generator so the tests themselves are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function vectors(count: number, dims: number, seed: number): Array<{ id: string; vector: number[] }> {
  const rnd = lcg(seed);
  return Array.from({ length: count }, (_, i) => ({ id: `v${i}`, vector: Array.from({ length: dims }, () => rnd() * 2 - 1) }));
}

const docs = (count: number, dims: number, seed: number, namespace?: (i: number) => string) =>
  vectors(count, dims, seed).map((d, i) => ({ ...d, text: d.id, createdAt: 0, ...(namespace ? { namespace: namespace(i) } : {}) }));

const exact =(data: Array<{ id: string; vector: number[] }>, query: number[], k: number) =>
  data
    .map((d) => ({ id: d.id, score: cosineSimilarity(query, d.vector) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, k);

test('the layer of an id is fixed and roughly geometric', () => {
  const index = new HnswIndex({ m: 4 });
  assert.equal(index.levelFor('same'), index.levelFor('same'));
  const levels = Array.from({ length: 2000 }, (_, i) => index.levelFor(`id-${i}`));
  const zero = levels.filter((l) => l === 0).length / levels.length;
  assert.ok(zero > 0.65 && zero < 0.85, `share of layer 0 was ${zero}`); // expected 1 - 1/4 = 0.75
  assert.ok(Math.max(...levels) >= 2);
});

test('an empty index finds nothing; one vector finds itself', () => {
  const index = new HnswIndex();
  assert.deepEqual(index.search([1, 0], 3), []);
  index.add('a', [1, 0]);
  const [hit] = index.search([2, 0], 3);
  assert.equal(hit.id, 'a');
  assert.ok(Math.abs(hit.score - 1) < 1e-12);
});

test('results are the true nearest neighbours on a small set', () => {
  const data = vectors(60, 8, 7);
  const index = new HnswIndex();
  for (const d of data) index.add(d.id, d.vector);
  for (const q of vectors(10, 8, 99)) {
    assert.deepEqual(index.search(q.vector, 5).map((h) => h.id), exact(data, q.vector, 5).map((h) => h.id));
  }
});

test('recall against the exact scan stays high on a larger set', () => {
  const data = vectors(1500, 16, 3);
  const index = new HnswIndex();
  for (const d of data) index.add(d.id, d.vector);
  let found = 0;
  let wanted = 0;
  for (const q of vectors(40, 16, 123)) {
    const truth = new Set(exact(data, q.vector, 10).map((h) => h.id));
    for (const h of index.search(q.vector, 10)) if (truth.has(h.id)) found++;
    wanted += 10;
  }
  assert.ok(found / wanted >= 0.9, `recall was ${found / wanted}`);
});

test('the same inserts give the same results, run after run', () => {
  const data = vectors(300, 8, 5);
  const build = () => {
    const index = new HnswIndex();
    for (const d of data) index.add(d.id, d.vector);
    return index;
  };
  const a = build();
  const b = build();
  for (const q of vectors(20, 8, 11)) assert.deepEqual(a.search(q.vector, 7), b.search(q.vector, 7));
});

test('re-adding an id replaces its vector; remove drops it and keeps the rest findable', () => {
  const data = vectors(200, 8, 17);
  const index = new HnswIndex();
  for (const d of data) index.add(d.id, d.vector);
  index.add('v0', [9, 9, 9, 9, 9, 9, 9, 9]);
  assert.equal(index.size, 200);
  assert.equal(index.search([1, 1, 1, 1, 1, 1, 1, 1], 1)[0].id, 'v0');

  for (let i = 0; i < 100; i++) assert.equal(index.remove(`v${i}`), true);
  assert.equal(index.remove('v0'), false);
  assert.equal(index.size, 100);
  const rest = data.slice(100);
  let found = 0;
  for (const q of vectors(20, 8, 31)) {
    const truth = new Set(exact(rest, q.vector, 5).map((h) => h.id));
    const hits = index.search(q.vector, 5);
    assert.ok(hits.every((h) => index.has(h.id) && Number(h.id.slice(1)) >= 100));
    for (const h of hits) if (truth.has(h.id)) found++;
  }
  assert.ok(found / 100 >= 0.9, `recall after removals was ${found / 100}`);
});

test('removing everything empties the index', () => {
  const index = new HnswIndex();
  for (const d of vectors(30, 4, 2)) index.add(d.id, d.vector);
  for (let i = 0; i < 30; i++) index.remove(`v${i}`);
  assert.equal(index.size, 0);
  assert.deepEqual(index.search([1, 0, 0, 0], 3), []);
  index.add('again', [0, 1, 0, 0]); // a different size is fine after a full clear
  assert.equal(index.search([0, 1, 0, 0], 1)[0].id, 'again');
});

test('dimension mismatches and bad options are refused', () => {
  const index = new HnswIndex();
  index.add('a', [1, 0, 0]);
  assert.throws(() => index.add('b', [1, 0]), /dimension mismatch/);
  assert.throws(() => index.search([1, 0], 1), /dimension mismatch/);
  assert.throws(() => index.add('c', []), /empty vector/);
  assert.throws(() => new HnswIndex({ m: 1 }), /m must be/);
  assert.throws(() => new HnswIndex({ efConstruction: 0 }), /efConstruction/);
});

test('a zero vector is indexed and scores 0', () => {
  const index = new HnswIndex();
  index.add('zero', [0, 0]);
  index.add('x', [1, 0]);
  assert.equal(index.search([1, 0], 2).find((h) => h.id === 'zero')?.score, 0);
});

// ---- file store

async function withStore(options: Partial<ConstructorParameters<typeof FileVectorStore>[0]>, run: (store: FileVectorStore) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-hnsw-test-'));
  try {
    await run(new FileVectorStore({ storagePath: path.join(dir, 'memory.json'), ...options }));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('the file store gives the same top results with hnsw as with the exact scan', async () => {
  const data = docs(120, 12, 41, (i) => (i % 2 ? 'odd' : 'even'));
  await withStore({ index: 'linear' }, async (linear) => {
    await withStore({ index: 'hnsw' }, async (hnsw) => {
      await linear.upsert(data);
      await hnsw.upsert(data);
      for (const q of vectors(10, 12, 77)) {
        const a = await linear.search(q.vector, { topK: 5 });
        const b = await hnsw.search(q.vector, { topK: 5 });
        assert.deepEqual(b.map((r) => r.document.id), a.map((r) => r.document.id));
        const ns = await hnsw.search(q.vector, { topK: 5, namespace: 'odd' });
        const nsExact = await linear.search(q.vector, { topK: 5, namespace: 'odd' });
        assert.deepEqual(ns.map((r) => r.document.id), nsExact.map((r) => r.document.id));
      }
    });
  });
});

test('hnsw mode follows upserts, deletes and clears', async () => {
  const data = docs(80, 6, 9, () => 'n');
  await withStore({ index: 'hnsw' }, async (store) => {
    await store.upsert(data);
    const q = data[3].vector;
    assert.equal((await store.search(q, { topK: 1 }))[0].document.id, 'v3');

    await store.delete(['v3']);
    assert.notEqual((await store.search(q, { topK: 1 }))[0].document.id, 'v3');

    await store.upsert([{ ...data[5], id: 'v3', text: 'moved' }]);
    assert.equal((await store.search(data[5].vector, { topK: 2 })).some((r) => r.document.id === 'v3'), true);

    await store.clear();
    assert.deepEqual(await store.search(q, { topK: 3 }), []);
    assert.equal(await store.count(), 0);
  });
});

test('auto mode stays exact below the threshold and uses the index above it', async () => {
  const data = docs(30, 6, 13);
  await withStore({ index: 'auto', hnswThreshold: 20 }, async (store) => {
    await store.upsert(data);
    const hits = await store.search(data[7].vector, { topK: 3 });
    assert.equal(hits[0].document.id, 'v7');
  });
  await withStore({ index: 'auto', hnswThreshold: 1000 }, async (store) => {
    await store.upsert(data);
    assert.equal((await store.search(data[7].vector, { topK: 1 }))[0].document.id, 'v7');
  });
});

test('concurrent upserts on a fresh store keep every document, in memory and on disk', async () => {
  const data = docs(6, 4, 21);
  await withStore({ index: 'linear' }, async (store) => {
    // The first calls start together, before the file was ever read.
    await Promise.all(data.map((d) => store.upsert([d])));
    assert.equal(await store.count(), 6);
    const onDisk = JSON.parse(await fs.readFile((store as unknown as { storagePath: string }).storagePath, 'utf-8'));
    assert.deepEqual(onDisk.map((d: { id: string }) => d.id).sort(), data.map((d) => d.id).sort());
  });
});
