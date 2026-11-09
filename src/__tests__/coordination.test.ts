import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageBus } from '../message-bus.js';
import { ColonyRegistry } from '../coordination/colony-registry.js';
import { ColonyTaskOrchestrator } from '../coordination/colony-task-orchestrator.js';

test('MessageBus delivers to topic and wildcard subscribers, unsubscribe stops delivery', async () => {
  const bus = new MessageBus();
  const topicHits: string[] = [];
  const wildcardHits: string[] = [];

  const off = bus.subscribe('a', (e) => void topicHits.push(e.topic));
  bus.subscribe('*', (e) => void wildcardHits.push(e.topic));

  await bus.publish('a', 'x', {});
  await bus.publish('b', 'x', {});
  off();
  await bus.publish('a', 'x', {});

  assert.deepEqual(topicHits, ['a']);
  assert.deepEqual(wildcardHits, ['a', 'b', 'a']);
});

test('ColonyRegistry rejects duplicate ids and tracks capacity', () => {
  const registry = new ColonyRegistry();
  const m = registry.register({ id: 'w1', name: 'W1', role: 'engineer' });
  assert.throws(() => registry.register({ id: 'w1', name: 'dup', role: 'engineer' }), /already registered/);

  registry.assignTask(m.id, 't1');
  assert.equal(registry.getMember('w1')?.status, 'busy');
  assert.equal(registry.findCandidates({ role: 'engineer' }).length, 0);

  registry.completeTask(m.id, 't1');
  assert.equal(registry.getMember('w1')?.status, 'idle');
  assert.equal(registry.findCandidates({ role: 'engineer' }).length, 1);
});

test('ColonyRegistry.findCandidates filters by role, capability and status, least busy first', () => {
  const registry = new ColonyRegistry();
  registry.register({ id: 'a', name: 'A', role: 'engineer', capabilities: { tools: ['lint'], maxConcurrentTasks: 3 } });
  registry.register({ id: 'b', name: 'B', role: 'engineer', capabilities: { tools: ['lint'], maxConcurrentTasks: 3 } });
  registry.register({ id: 'c', name: 'C', role: 'tester', capabilities: { tools: ['lint'], maxConcurrentTasks: 3 } });
  registry.register({ id: 'd', name: 'D', role: 'engineer', capabilities: { tools: [], maxConcurrentTasks: 3 } });
  registry.assignTask('a', 't1');
  registry.updateStatus('c', 'offline');

  const ids = registry.findCandidates({ role: 'engineer', requiredCapabilities: ['lint'] }).map((m) => m.id);
  assert.deepEqual(ids, ['b', 'a']);
  assert.equal(registry.findCandidates({ role: 'tester' }).length, 0);
});

test('Orchestrator assigns a task to a matching member', async () => {
  const bus = new MessageBus();
  const registry = new ColonyRegistry();
  registry.register({ id: 'w1', name: 'W1', role: 'engineer' });
  const orch = new ColonyTaskOrchestrator(registry, bus);

  const task = await orch.createTask({ title: 't', description: 'd', requiredRole: 'engineer' });
  assert.equal(task.status, 'assigned');
  assert.equal(task.assignedAgentId, 'w1');
});

test('Orchestrator leaves a task pending when no member matches', async () => {
  const orch = new ColonyTaskOrchestrator(new ColonyRegistry(), new MessageBus());
  const task = await orch.createTask({ title: 't', description: 'd', requiredRole: 'security' });
  assert.equal(task.status, 'pending');
});

test('Orchestrator dispatches a dependent task only after its dependency completes', async () => {
  const registry = new ColonyRegistry();
  registry.register({ id: 'w1', name: 'W1', role: 'engineer', capabilities: { tools: [], maxConcurrentTasks: 2 } });
  const orch = new ColonyTaskOrchestrator(registry, new MessageBus());

  const first = await orch.createTask({ title: 'first', description: '' });
  const second = await orch.createTask({ title: 'second', description: '', dependencies: [first.id] });
  assert.equal(second.status, 'pending');

  await orch.completeTask(first.id, 'w1', { ok: true });
  assert.equal(orch.getTask(first.id)?.status, 'completed');
  assert.equal(orch.getTask(second.id)?.status, 'assigned');
});

test('Orchestrator.failTask records the error and frees the member', async () => {
  const registry = new ColonyRegistry();
  registry.register({ id: 'w1', name: 'W1', role: 'engineer' });
  const orch = new ColonyTaskOrchestrator(registry, new MessageBus());

  const task = await orch.createTask({ title: 't', description: '' });
  await orch.failTask(task.id, 'w1', 'boom');

  assert.equal(orch.getTask(task.id)?.status, 'failed');
  assert.equal(orch.getTask(task.id)?.error, 'boom');
  assert.equal(registry.getMember('w1')?.status, 'idle');
});

test('Orchestrator throws for unknown task ids', async () => {
  const orch = new ColonyTaskOrchestrator(new ColonyRegistry(), new MessageBus());
  await assert.rejects(() => orch.completeTask('nope', 'w1'), /not found/);
  await assert.rejects(() => orch.failTask('nope', 'w1', 'x'), /not found/);
});
