import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageBus } from '../message-bus.js';
import { ConsensusEngine } from '../consensus/consensus-engine.js';
import { canStillReach, requiredApprovals } from '../consensus/strategies.js';
import { buildTopology, electionOrder, isFullyConnected, neighbors, shortestPath, TOPOLOGY_TYPES } from '../topology.js';
import type { AgentRole, AgentStatus, ColonyMember } from '../types.js';

const member = (id: string, role: AgentRole = 'engineer', status: AgentStatus = 'idle'): ColonyMember => ({
  id,
  name: id,
  role,
  status,
  capabilities: { tools: [], maxConcurrentTasks: 1 },
  currentTaskIds: [],
  createdAt: 0,
  lastActiveAt: 0,
});

const fleet = (n: number): ColonyMember[] =>
  Array.from({ length: n }, (_, i) => member(`m${String(i).padStart(2, '0')}`));

// ---- quorum strategies

test('requiredApprovals: majority, supermajority, byzantine and unanimous', () => {
  const table = (strategy: Parameters<typeof requiredApprovals>[0], voters: number[]) => voters.map((n) => requiredApprovals(strategy, n));
  assert.deepEqual(table('majority', [1, 2, 3, 4, 5]), [1, 2, 2, 3, 3]);
  assert.deepEqual(table('supermajority', [1, 3, 4, 6, 9]), [1, 2, 3, 4, 6]);
  assert.deepEqual(table('byzantine', [1, 3, 4, 7, 10]), [1, 2, 3, 5, 7]);
  assert.deepEqual(table('unanimous', [1, 4, 7]), [1, 4, 7]);
});

test('requiredApprovals rejects a non-positive or fractional voter count', () => {
  assert.throws(() => requiredApprovals('majority', 0), /positive integer/);
  assert.throws(() => requiredApprovals('majority', 2.5), /positive integer/);
});

test('a Byzantine quorum always exceeds half of the voters and fits within them', () => {
  for (let n = 1; n <= 40; n++) {
    const q = requiredApprovals('byzantine', n);
    assert.ok(q > n / 2 && q <= n, `n=${n} q=${q}`);
  }
});

test('canStillReach counts only the votes still outstanding', () => {
  assert.equal(canStillReach(1, 2, 4, 3), false); // 1 approval + 1 pending < 3
  assert.equal(canStillReach(1, 1, 4, 3), true); // 1 + 2 pending = 3
  assert.equal(canStillReach(3, 0, 4, 3), true);
});

// ---- consensus engine with a strategy

const base = { taskId: 't', proposerId: 'p', topic: 'x', data: null };

test('a strategy derives the quorum and a majority approves at that count', async () => {
  const engine = new ConsensusEngine(new MessageBus());
  const p = await engine.submitProposal({ ...base, strategy: 'majority', voters: 4 });
  assert.equal(p.quorum, 3);
  assert.equal(p.voters, 4);

  await engine.castVote(p.id, { voterId: 'a', approve: true });
  await engine.castVote(p.id, { voterId: 'b', approve: true });
  assert.equal(engine.getProposal(p.id)?.status, 'open');
  await engine.castVote(p.id, { voterId: 'c', approve: true });
  assert.equal(engine.getProposal(p.id)?.status, 'approved');
});

test('with known voters a proposal is rejected as soon as the quorum is out of reach', async () => {
  const engine = new ConsensusEngine(new MessageBus());
  const p = await engine.submitProposal({ ...base, strategy: 'majority', voters: 4 });

  await engine.castVote(p.id, { voterId: 'a', approve: false });
  assert.equal(engine.getProposal(p.id)?.status, 'open');
  await engine.castVote(p.id, { voterId: 'b', approve: false });
  assert.equal(engine.getProposal(p.id)?.status, 'rejected');
});

test('a strategy needs the voter count and excludes an explicit quorum', async () => {
  const engine = new ConsensusEngine(new MessageBus());
  await assert.rejects(() => engine.submitProposal({ ...base, strategy: 'majority' }), /eligible voters/);
  await assert.rejects(() => engine.submitProposal({ ...base, strategy: 'majority', voters: 3, quorum: 2 }), /not both/);

  const p = await engine.submitProposal({ ...base, strategy: 'unanimous', voters: 2 });
  await engine.castVote(p.id, { voterId: 'a', approve: true });
  await engine.castVote(p.id, { voterId: 'b', approve: true });
  assert.equal(engine.getProposal(p.id)?.status, 'approved');
  await assert.rejects(() => engine.castVote(p.id, { voterId: 'c', approve: true }), /already finalized/);
});

test('strategy and voters survive snapshot and restore', async () => {
  const engine = new ConsensusEngine(new MessageBus());
  const p = await engine.submitProposal({ ...base, strategy: 'byzantine', voters: 7 });
  const copy = new ConsensusEngine(new MessageBus());
  copy.restore(JSON.parse(JSON.stringify(engine.snapshot())));
  const restored = copy.getProposal(p.id);
  assert.equal(restored?.quorum, 5);
  assert.equal(restored?.voters, 7);
  assert.equal(restored?.strategy, 'byzantine');
});

// ---- topology

test('election order: preferred leader, then director, architect, the rest by id; inactive members are skipped', () => {
  const members = [
    member('z', 'engineer'),
    member('b', 'engineer'),
    member('a', 'architect'),
    member('d', 'director'),
    member('off', 'director', 'offline'),
    member('err', 'architect', 'error'),
  ];
  assert.deepEqual(electionOrder(members).map((m) => m.id), ['d', 'a', 'b', 'z']);
  assert.deepEqual(electionOrder(members, 'z').map((m) => m.id), ['z', 'd', 'a', 'b']);
  assert.equal(electionOrder(members, 'off')[0].id, 'd'); // an offline preferred leader is ignored
});

test('empty and single-member colonies have no edges', () => {
  for (const type of TOPOLOGY_TYPES) {
    assert.deepEqual(buildTopology([], type), { type, leader: undefined, nodes: [], edges: [] });
    const one = buildTopology([member('solo')], type);
    assert.equal(one.leader, 'solo');
    assert.equal(one.edges.length, 0);
    assert.ok(isFullyConnected(one));
  }
});

test('star connects every member to the leader only', () => {
  const t = buildTopology([member('d', 'director'), ...fleet(4)], 'star');
  assert.equal(t.leader, 'd');
  assert.equal(t.edges.length, 4);
  assert.ok(t.edges.every(([a, b]) => a === 'd' || b === 'd'));
});

test('tree builds a balanced tree with the given fanout', () => {
  const t = buildTopology(fleet(7), 'tree', { fanout: 2 });
  assert.equal(t.edges.length, 6);
  assert.deepEqual(neighbors(t, 'm00'), ['m01', 'm02']);
  assert.deepEqual(neighbors(t, 'm01'), ['m00', 'm03', 'm04']);
  assert.deepEqual(shortestPath(t, 'm03', 'm06'), ['m03', 'm01', 'm00', 'm02', 'm06']);
});

test('mesh is a ring lattice with the requested degree, and a full mesh when small', () => {
  const six = buildTopology(fleet(6), 'mesh', { meshDegree: 4 });
  assert.equal(six.edges.length, 12);
  for (const id of six.nodes) assert.equal(neighbors(six, id).length, 4);

  const three = buildTopology(fleet(3), 'mesh');
  assert.equal(three.edges.length, 3);
});

test('hybrid is a star around the leader plus a ring among the others', () => {
  const t = buildTopology(fleet(5), 'hybrid');
  assert.equal(t.edges.length, 4 + 4);
  assert.deepEqual(neighbors(t, 'm00'), ['m01', 'm02', 'm03', 'm04']);
  assert.equal(neighbors(t, 'm02').length, 3); // leader + two ring neighbours
});

test('every topology of a larger colony is fully connected', () => {
  for (const type of TOPOLOGY_TYPES) {
    assert.ok(isFullyConnected(buildTopology(fleet(12), type)), type);
  }
});

test('the topology does not depend on the order of the input members', () => {
  const members = fleet(9);
  const shuffled = [...members].reverse();
  for (const type of TOPOLOGY_TYPES) {
    assert.deepEqual(buildTopology(members, type), buildTopology(shuffled, type), type);
  }
});

test('shortestPath: same node, unknown node, inactive node', () => {
  const members = [...fleet(4), member('gone', 'engineer', 'offline')];
  const t = buildTopology(members, 'star');
  assert.deepEqual(shortestPath(t, 'm01', 'm01'), ['m01']);
  assert.deepEqual(shortestPath(t, 'm01', 'nope'), []);
  assert.deepEqual(shortestPath(t, 'm01', 'gone'), []);
  assert.deepEqual(shortestPath(t, 'm01', 'm02'), ['m01', 'm00', 'm02']);
});
