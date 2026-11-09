import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageBus } from '../message-bus.js';
import { ConsensusEngine } from '../consensus/consensus-engine.js';
import { InMemoryVectorStore, cosineSimilarity } from '../memory/vector-store.js';

const newEngine = () => new ConsensusEngine(new MessageBus());
const base = { taskId: 't', proposerId: 'p', topic: 'x', data: {} };

test('Consensus approves once approvals reach the quorum', async () => {
  const engine = newEngine();
  const p = await engine.submitProposal({ ...base, quorum: 2 });

  await engine.castVote(p.id, { voterId: 'a', approve: true });
  assert.equal(engine.getProposal(p.id)?.status, 'open');
  await engine.castVote(p.id, { voterId: 'b', approve: true });
  assert.equal(engine.getProposal(p.id)?.status, 'approved');
});

test('Consensus rejects when a majority rejects and enough votes are in', async () => {
  const engine = newEngine();
  const p = await engine.submitProposal({ ...base, quorum: 2 });

  await engine.castVote(p.id, { voterId: 'a', approve: false });
  assert.equal(engine.getProposal(p.id)?.status, 'open');
  await engine.castVote(p.id, { voterId: 'b', approve: false });
  assert.equal(engine.getProposal(p.id)?.status, 'rejected');
});

test('Consensus: a voter counts once and votes after finalization throw', async () => {
  const engine = newEngine();
  const p = await engine.submitProposal({ ...base, quorum: 2 });

  await engine.castVote(p.id, { voterId: 'a', approve: true });
  await engine.castVote(p.id, { voterId: 'a', approve: true });
  assert.equal(engine.getProposal(p.id)?.status, 'open');

  await engine.castVote(p.id, { voterId: 'b', approve: true });
  await assert.rejects(() => engine.castVote(p.id, { voterId: 'c', approve: true }), /already finalized/);
  await assert.rejects(() => engine.castVote('missing', { voterId: 'a', approve: true }), /not found/);
});

test('Consensus marks an expired proposal as timeout', async () => {
  const engine = newEngine();
  const p = await engine.submitProposal({ ...base, timeoutMs: 1 });
  await new Promise((r) => setTimeout(r, 15));

  await engine.castVote(p.id, { voterId: 'a', approve: true });
  assert.equal(engine.getProposal(p.id)?.status, 'timeout');
});

test('cosineSimilarity: identical, orthogonal, zero vector, dimension mismatch', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.throws(() => cosineSimilarity([1], [1, 2]), /dimension mismatch/);
});

test('InMemoryVectorStore ranks by similarity, honours topK, minScore and namespace', async () => {
  const store = new InMemoryVectorStore();
  await store.upsert([
    { id: 'near', text: 'near', vector: [1, 0], namespace: 'n1', createdAt: 1 },
    { id: 'mid', text: 'mid', vector: [1, 1], namespace: 'n1', createdAt: 1 },
    { id: 'far', text: 'far', vector: [0, 1], namespace: 'n2', createdAt: 1 },
    { id: 'novec', text: 'no vector', namespace: 'n1', createdAt: 1 },
  ]);

  const all = await store.search([1, 0], { topK: 10 });
  assert.deepEqual(all.map((r) => r.document.id), ['near', 'mid', 'far']);

  assert.deepEqual((await store.search([1, 0], { topK: 1 })).map((r) => r.document.id), ['near']);
  assert.deepEqual((await store.search([1, 0], { namespace: 'n2' })).map((r) => r.document.id), ['far']);
  assert.deepEqual((await store.search([1, 0], { minScore: 0.9 })).map((r) => r.document.id), ['near']);
});

test('InMemoryVectorStore count, delete and clear by namespace', async () => {
  const store = new InMemoryVectorStore();
  await store.upsert([
    { id: 'a', text: '', vector: [1], namespace: 'n1', createdAt: 1 },
    { id: 'b', text: '', vector: [1], namespace: 'n2', createdAt: 1 },
    { id: 'c', text: '', vector: [1], namespace: 'n2', createdAt: 1 },
  ]);
  assert.equal(await store.count(), 3);
  assert.equal(await store.count('n2'), 2);

  await store.delete(['a']);
  assert.equal(await store.count(), 2);

  await store.clear('n2');
  assert.equal(await store.count(), 0);
});
