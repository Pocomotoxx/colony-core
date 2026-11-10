import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeMemberStats } from '../chief/member-stats.js';
import { DEFAULT_SCORE_WEIGHTS, rankMembers } from '../chief/scoring.js';
import { ineligibleReason } from '../coordination/colony-registry.js';
import { ColonyHub } from '../colony-hub.js';
import { ColonyRegistry } from '../coordination/colony-registry.js';
import { BUILTIN_AGENT_PROFILES } from '../agents/agent-profiles.js';
import { runCommand } from '../cli/commands.js';
import type { AgentRole, ColonyMember, ColonyTask } from '../types.js';

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

const task = (over: Partial<ColonyTask> = {}): ColonyTask => ({
  id: 't1',
  title: 'T',
  description: 'D',
  priority: 'normal',
  status: 'pending',
  createdAt: 0,
  ...over,
});

const finished = (id: string, by: string, status: 'completed' | 'failed', ms = 1000): ColonyTask =>
  task({ id, status, assignedAgentId: by, startedAt: 100, completedAt: 100 + ms });

// ---- stats

test('stats: counts, smoothed success rate, mean duration, open tasks', () => {
  const members = [member('a'), member('b'), member('idle')];
  const tasks = [
    finished('1', 'a', 'completed', 1000),
    finished('2', 'a', 'completed', 3000),
    finished('3', 'a', 'failed'),
    task({ id: '4', status: 'in_progress', assignedAgentId: 'a' }),
    finished('5', 'b', 'failed'),
    task({ id: '6', status: 'pending' }),
  ];
  const stats = computeMemberStats(members, tasks, []);
  const a = stats.get('a')!;
  assert.deepEqual([a.completed, a.failed, a.open], [2, 1, 1]);
  assert.equal(a.successRate, 3 / 5); // (2 + 1) / (3 + 2)
  assert.equal(a.avgDurationMs, 2000);
  assert.equal(stats.get('b')!.successRate, 1 / 3); // one failure: (0 + 1) / (1 + 2)
  assert.equal(stats.get('idle')!.successRate, 0.5); // no history: neither 0 nor 1
  assert.equal(stats.get('idle')!.avgDurationMs, null);
});

test('stats: stale claims and last activity come from the claims; unknown assignees are ignored', () => {
  const claim = { taskId: 't', holderId: 'a', status: 'stealable', lastActivityAt: 900, claimedAt: 0, progress: 0, history: [] } as never;
  const stats = computeMemberStats([member('a', 'engineer', { lastActiveAt: 500 })], [finished('x', 'ghost', 'completed')], [claim]);
  assert.equal(stats.get('a')!.staleClaims, 1);
  assert.equal(stats.get('a')!.lastActivityAt, 900);
  assert.equal(stats.has('ghost'), false);
});

// ---- eligibility

test('eligibility reasons, and agreement with the registry', () => {
  const t = task({ requiredRole: 'engineer', requiredCapabilities: ['code'] });
  assert.match(ineligibleReason(t, member('x', 'tester'))!, /needs engineer/);
  assert.match(ineligibleReason(t, member('x', 'engineer', { status: 'offline' }))!, /offline/);
  assert.match(ineligibleReason(t, member('x', 'engineer', { currentTaskIds: ['a', 'b'] }))!, /capacity/);
  assert.match(ineligibleReason(t, member('x'))!, /missing capabilities: code/);
  assert.equal(ineligibleReason(t, member('x', 'engineer', { capabilities: { tools: ['code'], maxConcurrentTasks: 1 } })), null);

  const registry = new ColonyRegistry();
  for (const role of ['engineer', 'auditor', 'exobiologist', 'tester'] as AgentRole[]) registry.register({ id: role, name: role, role });
  for (const req of [{}, { role: 'auditor' as AgentRole }, { role: 'engineer' as AgentRole }]) {
    const fromRegistry = registry.findCandidates(req).map((m) => m.id).sort();
    const fromScoring = registry.getAllMembers().filter((m) => ineligibleReason(task({ requiredRole: req.role }), m) === null).map((m) => m.id).sort();
    assert.deepEqual(fromScoring, fromRegistry, JSON.stringify(req));
  }
});

test('advisory roles are never an implicit candidate, but a task can ask for them', () => {
  const registry = new ColonyRegistry();
  registry.register({ id: 'a', name: 'a', role: 'auditor' });
  registry.register({ id: 'x', name: 'x', role: 'exobiologist' });
  assert.deepEqual(registry.findCandidates({}), []);
  assert.deepEqual(registry.findCandidates({ role: 'exobiologist' }).map((m) => m.id), ['x']);
});

// ---- scoring

test('the default weights sum to one', () => {
  const sum = Object.values(DEFAULT_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
});

test('a better track record wins, and the breakdown explains the total', () => {
  const members = [member('steady'), member('shaky')];
  const stats = computeMemberStats(members, [finished('1', 'steady', 'completed'), finished('2', 'steady', 'completed'), finished('3', 'shaky', 'failed')], []);
  const r = rankMembers(task({ requiredRole: 'engineer' }), members, stats);
  assert.equal(r.primary?.memberId, 'steady');
  assert.equal(r.heuristic, true);
  const s = r.ranked[0];
  const w = DEFAULT_SCORE_WEIGHTS;
  const c = s.components;
  assert.ok(Math.abs(s.total - (c.capability * w.capability + c.load * w.load + c.performance * w.performance + c.health * w.health + c.availability * w.availability)) < 1e-3);
});

test('a free member beats a loaded one, and a stale claim lowers health', () => {
  const members = [member('loaded', 'engineer', { currentTaskIds: ['x'] }), member('free'), member('hurt')];
  const claim = { taskId: 'c', holderId: 'hurt', status: 'stealable', lastActivityAt: 0, claimedAt: 0, progress: 0, history: [] } as never;
  const stats = computeMemberStats(members, [], [claim]);
  const r = rankMembers(task({ requiredRole: 'engineer' }), members, stats);
  assert.equal(r.primary?.memberId, 'free');
  assert.ok(r.ranked.find((s) => s.memberId === 'hurt')!.components.health < 1);
  assert.ok(r.ranked.findIndex((s) => s.memberId === 'free') < r.ranked.findIndex((s) => s.memberId === 'loaded'));
});

test('ties are broken by member id, whatever the input order', () => {
  const ids = ['m3', 'm1', 'm2'];
  const forward = rankMembers(task({ requiredRole: 'engineer' }), ids.map((i) => member(i)), new Map());
  const backward = rankMembers(task({ requiredRole: 'engineer' }), [...ids].reverse().map((i) => member(i)), new Map());
  assert.deepEqual(forward.ranked.map((s) => s.memberId), ['m1', 'm2', 'm3']);
  assert.deepEqual(forward, backward);
});

test('backups: at most two, above the minimum score, never the primary', () => {
  const members = Array.from({ length: 5 }, (_, i) => member(`m${i}`));
  const r = rankMembers(task({ requiredRole: 'engineer' }), members, new Map());
  assert.equal(r.backups.length, 2);
  assert.ok(r.backups.every((b) => b.memberId !== r.primary?.memberId));
  assert.equal(rankMembers(task({ requiredRole: 'engineer' }), members, new Map(), { minBackupScore: 0.99 }).backups.length, 0);
  assert.equal(rankMembers(task({ requiredRole: 'engineer' }), members, new Map(), { backups: 1 }).backups.length, 1);
});

test('exclude, ineligible reasons and bad weights', () => {
  const members = [member('a'), member('b', 'tester'), member('c', 'engineer', { status: 'error' })];
  const r = rankMembers(task({ requiredRole: 'engineer' }), members, new Map(), { exclude: ['a'] });
  assert.equal(r.primary, null);
  assert.deepEqual(r.ineligible.map((i) => i.memberId), ['b', 'c']);
  assert.throws(() => rankMembers(task(), members, new Map(), { weights: { load: -1 } }), /non-negative/);
});

// ---- dispatch uses the score

test('dispatch gives the task to the member with the better record, not just the least busy', async () => {
  const hub = new ColonyHub();
  hub.registry.register({ id: 'veteran', name: 'veteran', role: 'engineer', capabilities: { maxConcurrentTasks: 3 } });
  hub.registry.register({ id: 'rookie', name: 'rookie', role: 'engineer', capabilities: { maxConcurrentTasks: 3 } });
  for (let i = 0; i < 3; i++) {
    const t = await hub.orchestrator.createTask({ title: `h${i}`, description: 'd', requiredRole: 'engineer' });
    await hub.orchestrator.completeTask(t.id, t.assignedAgentId!, 'ok');
  }
  // After three completions by whoever took them, the one with the better record keeps being preferred.
  const record = computeMemberStats(hub.registry.getAllMembers(), hub.orchestrator.getAllTasks(), []);
  const best = [...record.values()].sort((a, b) => b.successRate - a.successRate || (a.memberId < b.memberId ? -1 : 1))[0].memberId;
  const next = await hub.orchestrator.createTask({ title: 'next', description: 'd', requiredRole: 'engineer' });
  assert.equal(next.assignedAgentId, best);
});

test('an auditor never gets an unrouted task', async () => {
  const hub = new ColonyHub();
  hub.registry.register({ id: 'aud', name: 'aud', role: 'auditor' });
  const t = await hub.orchestrator.createTask({ title: 'x', description: 'd' });
  assert.equal(t.status, 'pending');
  const asked = await hub.orchestrator.createTask({ title: 'y', description: 'd', requiredRole: 'auditor' });
  assert.equal(asked.assignedAgentId, 'aud');
});

// ---- profiles

test('the new profiles exist, are advisory where they should be, and carry sampling advice', () => {
  const roles = Object.values(BUILTIN_AGENT_PROFILES).map((p) => p.role).sort();
  assert.deepEqual(roles, ['analyst', 'architect', 'auditor', 'director', 'engineer', 'exobiologist', 'researcher', 'reviewer', 'security', 'tester', 'writer']);
  const exo = BUILTIN_AGENT_PROFILES.exobiologist;
  assert.ok(exo.sampling!.temperature >= 0.8);
  assert.ok(BUILTIN_AGENT_PROFILES.analyst.sampling!.temperature <= 0.2);
  assert.match(exo.systemPrompt, /prediction that could prove it wrong/);
  assert.match(BUILTIN_AGENT_PROFILES.researcher.systemPrompt, /untrusted data/);
});

// ---- CLI

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-chief-test-'));
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
  await run('boot');
  return { dir, run };
}

test('score shows the ranking, the backups and why the others are out', async () => {
  const { run } = await project('score');
  const id = (await run('task', 'add', 'Build', 'Write the thing', '--role', 'engineer')).out.task.id;
  const r = await run('score', id);
  assert.equal(r.code, 0);
  assert.equal(r.out.ranking.heuristic, true);
  assert.ok(r.out.ranking.ineligible.some((i: any) => i.memberId === 'member_auditor'));
  assert.match(r.out.note, /heuristic/);
  assert.match((await run('score', 'task_nope')).out.error, /not found/);
});

test('member preset standard adds the missing roles to an older colony, once', async () => {
  const { dir, run } = await project('preset');
  const file = path.join(dir, '.colony', 'ledger.json');
  const ledger = JSON.parse(await fs.readFile(file, 'utf-8'));
  const old = ['director', 'architect', 'coder', 'reviewer', 'tester', 'security'].map((k) => `member_${k}`);
  ledger.members = ledger.members.filter((m: any) => old.includes(m.id));
  await fs.writeFile(file, JSON.stringify(ledger), 'utf-8');
  // a hand-edited ledger stands for a state from before the integrity record: drop it
  await fs.rm(path.join(path.dirname(file), 'integrity.json'), { force: true });
  assert.equal((await run('member', 'list')).out.members.length, 6);

  const first = await run('member', 'preset', 'standard');
  assert.deepEqual(first.out.added.sort(), ['member_analyst', 'member_auditor', 'member_exobiologist', 'member_researcher', 'member_writer']);
  assert.equal(first.out.total, 11);
  assert.deepEqual((await run('member', 'preset', 'standard')).out.added, []);
  assert.equal((await run('audit', 'list', '--type', 'member.added')).out.entries.length, 5);
  assert.match((await run('member', 'preset', 'legacy-15')).out.error, /usage/);
});

test('the exobiologist does not vote and is not counted as a voter', async () => {
  const { run } = await project('exo');
  const id = (await run('task', 'add', 'Risky', 'needs review', '--role', 'engineer', '--consensus', '2')).out.task.id;
  await run('next', '--as', 'engineer');
  const p = (await run('propose', id, 'ship?', '--as', 'engineer', '--strategy', 'majority')).out.proposal;
  assert.equal(p.voters, 10);
  const vote = await run('vote', p.id, '--as', 'exobiologist', '--approve', '--reason', 'why not');
  assert.match(vote.out.error, /does not vote/);
});

test('next carries the sampling advice of the role', async () => {
  const { run } = await project('sampling');
  await run('task', 'add', 'Build', 'Write the thing', '--role', 'engineer');
  const next = await run('next', '--as', 'engineer');
  assert.equal(next.out.samplingAdvice, null); // the engineer profile gives none
  await run('task', 'add', 'Odd readings', 'Why does it look like this', '--role', 'exobiologist');
  const exo = await run('next', '--as', 'exobiologist');
  assert.equal(exo.out.samplingAdvice.temperature, 0.9);
});

test('a stale claim names the best other member as the takeover', async () => {
  const { dir, run } = await project('takeover');
  const id = (await run('task', 'add', 'Build', 'Write the thing', '--role', 'engineer')).out.task.id;
  await run('next', '--as', 'engineer');
  const file = path.join(dir, '.colony', 'ledger.json');
  const ledger = JSON.parse(await fs.readFile(file, 'utf-8'));
  for (const c of ledger.claims) c.lastActivityAt -= 60 * 60_000;
  await fs.writeFile(file, JSON.stringify(ledger), 'utf-8');
  // a hand-edited ledger stands for a state from before the integrity record: drop it
  await fs.rm(path.join(path.dirname(file), 'integrity.json'), { force: true });

  // Only one engineer exists, so nobody else can take it over: the suggestion is empty, not invented.
  const swept = await run('claim', 'sweep');
  assert.equal(swept.out.markedStealable[0].taskId, id);
  assert.equal(swept.out.markedStealable[0].suggestedTakeover, null);
});

test('stats: a completed task whose check the colony saw fail counts against the member, one that passed does not', () => {
  const member = { id: 'm1', name: 'm1', role: 'engineer', status: 'idle', capabilities: { tools: [], maxConcurrentTasks: 3, languages: [], specializations: [], contextWindowLimit: 1 }, currentTaskIds: [], metadata: {}, createdAt: 0, lastActiveAt: 0 } as unknown as Parameters<typeof computeMemberStats>[0][number];
  const done = (id: string, verification?: { passed: boolean }) => ({
    id, title: id, description: id, priority: 'normal', status: 'completed', assignedAgentId: 'm1', dependencies: [], requiredCapabilities: [], inputData: {}, consensusRequired: false, minConsensusQuorum: 2, createdAt: 0, startedAt: 0, completedAt: 1,
    ...(verification ? { verification: { command: 'x', exitCode: verification.passed ? 0 : 1, timedOut: false, durationMs: 1, at: 0, outputHash: 'h', outputBytes: 0, ...verification } } : {}),
  }) as unknown as Parameters<typeof computeMemberStats>[1][number];
  const plain = computeMemberStats([member], [done('a'), done('b')], []).get('m1')!;
  const failing = computeMemberStats([member], [done('a', { passed: false }), done('b', { passed: false })], []).get('m1')!;
  const passing = computeMemberStats([member], [done('a', { passed: true }), done('b', { passed: true })], []).get('m1')!;
  assert.equal(plain.successRate, 0.75); // (2 + 1) / (2 + 2)
  assert.equal(failing.checkFailed, 2);
  assert.equal(failing.successRate, 0.25); // (2 - 2 + 1) / (2 + 2): "done" that the colony's own run contradicted
  assert.equal(passing.checkPassed, 2);
  assert.equal(passing.successRate, 0.75);
});
