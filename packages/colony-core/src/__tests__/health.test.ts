import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildHealthReport, HEALTH_GROUPS, ROLE_GROUP } from '../chief/health.js';
import { BUILTIN_AGENT_PROFILES } from '../agents/agent-profiles.js';
import { ColonyHub } from '../colony-hub.js';
import { runCommand } from '../cli/commands.js';
import type { AgentRole, ColonyMember, ColonyTask, ConsensusProposal } from '../types.js';

const NOW = 10_000_000;
const MIN = 60_000;

const member = (id: string, role: AgentRole = 'engineer', over: Partial<ColonyMember> = {}): ColonyMember => ({
  id,
  name: id,
  role,
  status: 'idle',
  capabilities: { tools: [], maxConcurrentTasks: 2 },
  currentTaskIds: [],
  createdAt: 0,
  lastActiveAt: 0,
  ...over,
});

const task = (id: string, over: Partial<ColonyTask> = {}): ColonyTask => ({
  id,
  title: id,
  description: 'd',
  priority: 'normal',
  status: 'pending',
  createdAt: NOW,
  ...over,
});

const report = (members: ColonyMember[], tasks: ColonyTask[] = [], extra: Partial<Parameters<typeof buildHealthReport>[0]> = {}) =>
  buildHealthReport({ members, tasks, claims: [], proposals: [], now: NOW, ...extra });

test('every role belongs to a group, and every group is reported', () => {
  for (const profile of Object.values(BUILTIN_AGENT_PROFILES)) assert.ok(ROLE_GROUP[profile.role], profile.role);
  assert.ok(ROLE_GROUP.custom);
  const r = report([member('a')]);
  assert.deepEqual(r.groups.map((g) => g.group), [...HEALTH_GROUPS]);
});

test('a quiet colony is healthy: idle capacity is not a problem', () => {
  const r = report([member('a'), member('b', 'tester'), member('c', 'analyst')]);
  assert.equal(r.overallHealth, 1);
  assert.deepEqual(r.bottlenecks, []);
  assert.deepEqual(r.alerts, []);
  assert.equal(r.heuristic, true);
});

test('an empty colony does not divide by zero', () => {
  const r = report([]);
  assert.equal(r.overallHealth, 1);
  assert.equal(r.metrics.throughputPerHour, 0);
  assert.equal(r.metrics.consensusSuccessRate, null);
});

test('a long queue is a bottleneck, critical past the second limit', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => task(`q${i}`, { requiredRole: 'engineer' }));
  const members = [member('e', 'engineer', { currentTaskIds: ['x', 'y'], status: 'busy' })];
  const high = report(members, many(12));
  assert.equal(high.groups.find((g) => g.group === 'delivery')!.queuedTasks, 12);
  assert.equal(high.bottlenecks.find((b) => b.type === 'group')!.severity, 'high');
  assert.equal(report(members, many(25)).bottlenecks.find((b) => b.type === 'group')!.severity, 'critical');
  assert.equal(report(members, many(10)).bottlenecks.some((b) => b.type === 'group'), false);
});

test('error rate and response time come from the tasks, not from a constant', () => {
  const members = [member('e'), member('t', 'tester')];
  const tasks = [
    task('1', { status: 'completed', assignedAgentId: 'e', startedAt: 1000, completedAt: 3000 }),
    task('2', { status: 'failed', assignedAgentId: 'e', startedAt: 1000, completedAt: 1500 }),
    task('3', { status: 'failed', assignedAgentId: 'e', startedAt: 1000, completedAt: 1500 }),
    task('4', { status: 'failed', assignedAgentId: 'e', startedAt: 1000, completedAt: 1500 }),
    task('5', { status: 'completed', assignedAgentId: 't', startedAt: 1000, completedAt: 1400 }),
  ];
  const r = report(members, tasks);
  const delivery = r.groups.find((g) => g.group === 'delivery')!;
  assert.equal(delivery.errorRate, 0.75);
  assert.equal(delivery.avgResponseMs, 2000);
  assert.ok(delivery.health < 1);
  assert.ok(r.bottlenecks.some((b) => b.type === 'group' && /failed/.test(b.description) && b.severity === 'high'));
  const quality = r.groups.find((g) => g.group === 'quality')!;
  assert.equal(quality.errorRate, 0);
  assert.equal(quality.avgResponseMs, 400);
  assert.equal(r.groups.find((g) => g.group === 'research')!.errorRate, null);
});

test('a high error rate on too few tasks is not yet a finding', () => {
  const r = report([member('e')], [task('1', { status: 'failed', assignedAgentId: 'e' })]);
  assert.equal(r.bottlenecks.length, 0);
});

test('members in error, stale claims and blocked claims are reported', () => {
  const claims = [
    { taskId: 'c1', holderId: 'e', status: 'stealable', stealableReason: 'stale', lastActivityAt: 0, claimedAt: 0, progress: 0, history: [] },
    { taskId: 'c2', holderId: 'e', status: 'blocked', blockedReason: 'waiting for review', lastActivityAt: 0, claimedAt: 0, progress: 0, history: [] },
    { taskId: 'c3', holderId: 'e', status: 'closed', lastActivityAt: 0, claimedAt: 0, progress: 0, history: [] },
  ] as never[];
  const members = [member('e'), member('x', 'tester', { status: 'error' })];
  const r = report(members, [], { claims });
  assert.equal(r.metrics.staleClaims, 1);
  assert.equal(r.metrics.blockedClaims, 1);
  assert.equal(r.metrics.inError, 1);
  assert.ok(r.bottlenecks.some((b) => b.type === 'member' && b.severity === 'medium'));
  assert.ok(r.bottlenecks.some((b) => b.type === 'claim' && b.location === 'c1'));
  assert.ok(r.bottlenecks.some((b) => b.type === 'claim' && b.location === 'c2' && b.severity === 'low'));
  assert.ok(!r.bottlenecks.some((b) => b.location === 'c3'));
  assert.ok(r.alerts.every((a) => !/waiting for review/.test(a.message))); // low findings are not alerts
  assert.equal(report([1, 2, 3, 4].map((i) => member(`bad${i}`, 'engineer', { status: 'error' }))).bottlenecks[0].severity, 'critical');
});

test('tasks that cannot be routed are one finding per role, not one per task', () => {
  const tasks = [task('a', { requiredRole: 'security' }), task('b', { requiredRole: 'security' }), task('c', { requiredRole: 'writer' })];
  const r = report([member('e')], tasks);
  const stuck = r.bottlenecks.filter((b) => b.type === 'task');
  assert.deepEqual(stuck.map((b) => b.location), ['needs security', 'needs writer']);
  assert.match(stuck[0].description, /2 ready task\(s\).*a, b/);
});

test('a task behind a failed dependency is reported, one behind a live dependency is not', () => {
  const tasks = [
    task('bad', { status: 'failed' }),
    task('live', { status: 'in_progress', assignedAgentId: 'e' }),
    task('after-bad', { dependencies: ['bad'], requiredRole: 'engineer' }),
    task('after-live', { dependencies: ['live'], requiredRole: 'engineer' }),
  ];
  const r = report([member('e')], tasks);
  const findings = r.bottlenecks.filter((b) => b.type === 'task');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].location, 'after-bad');
  assert.match(findings[0].description, /will never complete/);
});

test('a task that waited too long but could be routed is a finding', () => {
  const old = task('old', { requiredRole: 'engineer', createdAt: NOW - 90 * MIN });
  const fresh = task('fresh', { requiredRole: 'engineer', createdAt: NOW - 5 * MIN });
  const r = report([member('e')], [old, fresh]);
  const waiting = r.bottlenecks.find((b) => b.location === 'long wait')!;
  assert.match(waiting.description, /1 task\(s\).*old/);
  assert.equal(report([member('e')], [old, fresh], { thresholds: { longWaitMinutes: 200 } }).bottlenecks.length, 0);
});

test('throughput counts only completions inside the window; consensus rate counts decided proposals', () => {
  const tasks = [
    task('1', { status: 'completed', assignedAgentId: 'e', completedAt: NOW - 10 * MIN }),
    task('2', { status: 'completed', assignedAgentId: 'e', completedAt: NOW - 20 * MIN }),
    task('3', { status: 'completed', assignedAgentId: 'e', completedAt: NOW - 120 * MIN }),
  ];
  const proposals = ['approved', 'approved', 'rejected', 'open'].map((status) => ({ status })) as unknown as ConsensusProposal[];
  const r = report([member('e')], tasks, { proposals });
  assert.equal(r.metrics.completed, 3);
  assert.equal(r.metrics.completedInWindow, 2);
  assert.equal(r.metrics.throughputPerHour, 2);
  assert.equal(r.metrics.consensusSuccessRate, 0.667);
});

test('findings lower the overall health, the report is deterministic, and recommendations are not repeated', () => {
  const tasks = [task('a', { requiredRole: 'security' }), task('b', { requiredRole: 'security' })];
  const members = [member('e'), member('x', 'tester', { status: 'error' })];
  const clean = report(members.slice(0, 1));
  const r = report(members, tasks);
  assert.ok(r.overallHealth < clean.overallHealth);
  assert.deepEqual(report(members, tasks), r);
  assert.equal(new Set(r.recommendations).size, r.recommendations.length);
  assert.deepEqual(r.bottlenecks.map((b) => b.severity), ['high', 'medium']);
});

test('thresholds are validated', () => {
  assert.throws(() => report([member('a')], [], { thresholds: { queueDepth: -1 } }), /queueDepth/);
  assert.throws(() => report([member('a')], [], { thresholds: { errorRate: Number.NaN } }), /errorRate/);
});

test('the hub reports its own state', async () => {
  const hub = new ColonyHub();
  hub.registry.register({ id: 'e', name: 'e', role: 'engineer' });
  const t = await hub.orchestrator.createTask({ title: 'x', description: 'd', requiredRole: 'engineer' });
  await hub.orchestrator.completeTask(t.id, 'e', 'ok');
  const r = hub.health();
  assert.equal(r.metrics.completed, 1);
  assert.equal(r.metrics.members, 1);
});

// ---- CLI

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-health-test-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('health: runs after boot, reports, and validates its options', async () => {
  const dir = path.join(root, 'cli');
  await fs.mkdir(dir, { recursive: true });
  const run = async (...args: string[]) => {
    const { code, output } = await runCommand(args, dir);
    return { code, out: output as any };
  };
  assert.equal((await run('health')).code, 2); // not booted
  await run('boot');
  await run('task', 'add', 'Check the thing', 'Review it', '--role', 'reviewer');

  const r = await run('health');
  assert.equal(r.code, 0);
  assert.equal(r.out.report.heuristic, true);
  assert.equal(r.out.report.metrics.members, 11);
  assert.equal(r.out.report.groups.length, 5);
  assert.match(r.out.note, /heuristic/);

  assert.match((await run('health', '--queue-depth=-2')).out.error, /non-negative/);
  assert.match((await run('health', '--long-wait-min', 'abc')).out.error, /non-negative/);
  const tight = await run('health', '--queue-depth', '0');
  assert.equal(tight.code, 0);
});
