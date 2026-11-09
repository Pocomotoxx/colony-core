import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeTask, executionWaves, inferKind, strategyOf, TASK_KINDS } from '../chief/analysis.js';
import type { PlannedStep } from '../chief/analysis.js';
import { ColonyHub } from '../colony-hub.js';
import { runCommand } from '../cli/commands.js';
import type { AgentRole, ColonyTask } from '../types.js';

const LONG = 'x'.repeat(200); // exactly the length where a task stops being "short"

const task = (over: Partial<ColonyTask> = {}): ColonyTask => ({
  id: 't1',
  title: 'Build the importer',
  description: LONG,
  priority: 'normal',
  status: 'pending',
  requiredRole: 'engineer',
  createdAt: 0,
  ...over,
});

const step = (key: string, dependsOn: string[] = [], role: AgentRole = 'engineer'): PlannedStep => ({ key, name: key, description: key, requiredRole: role, dependsOn, estimatedMs: 1000 });

// ---- kind

test('the required role decides the kind; the words decide only without one', () => {
  assert.equal(inferKind({ requiredRole: 'engineer', title: 'Implement parser', description: 'with tests' }), 'coding');
  assert.equal(inferKind({ title: 'Add tests', description: 'for the parser' }), 'testing');
  assert.equal(inferKind({ title: 'Compare vendors', description: 'a survey' }), 'research');
  assert.equal(inferKind({ title: 'Lunch', description: 'sandwiches' }), 'general');
  assert.equal(inferKind({ requiredRole: 'custom', title: 'Write the readme', description: 'x' }), 'documentation');
});

// ---- decomposition

test('short tasks, reviews and subtasks are not split', () => {
  for (const t of [task({ description: 'short' }), task({ requiredRole: 'reviewer' }), task({ parentId: 'p' })]) {
    const a = analyzeTask(t);
    assert.deepEqual(a.steps, []);
    assert.equal(a.strategy, 'single');
  }
  assert.equal(analyzeTask(task({ description: 'y'.repeat(199) })).steps.length, 0);
  assert.equal(analyzeTask(task()).steps.length, 3);
});

test('each kind has its template, roles, waves and strategy', () => {
  const cases: Array<[Partial<ColonyTask>, string[], string[], string]> = [
    [{ requiredRole: 'engineer' }, ['design', 'implement', 'test'], ['architect', 'engineer', 'tester'], 'pipeline'],
    [{ requiredRole: 'tester' }, ['analyze', 'execute'], ['tester', 'tester'], 'sequential'],
    [{ requiredRole: 'researcher' }, ['gather', 'analyze', 'synthesize', 'verify'], ['researcher', 'analyst', 'director', 'reviewer'], 'pipeline'],
    [{ requiredRole: 'director' }, ['plan', 'execute'], ['director', 'director'], 'sequential'],
    [{ requiredRole: 'writer' }, ['draft', 'write', 'review'], ['writer', 'writer', 'reviewer'], 'sequential'],
  ];
  for (const [over, keys, roles, strategy] of cases) {
    const a = analyzeTask(task(over));
    assert.deepEqual(a.steps.map((s) => s.key), keys, JSON.stringify(over));
    assert.deepEqual(a.steps.map((s) => s.requiredRole), roles);
    assert.equal(a.strategy, strategy);
    assert.deepEqual(a.waves, keys.map((k) => [k])); // every template is a chain
  }
  const general = analyzeTask(task({ requiredRole: undefined, title: 'Lunch', description: LONG }), { routerRole: 'analyst' });
  assert.deepEqual(general.steps.map((s) => s.requiredRole), ['analyst']);
  assert.equal(general.strategy, 'single');
});

test('--kind forces another template', () => {
  assert.deepEqual(analyzeTask(task(), { kind: 'research' }).steps.map((s) => s.key), ['gather', 'analyze', 'synthesize', 'verify']);
  assert.equal(TASK_KINDS.length, 7);
});

// ---- graph shape

test('waves and strategies for graphs that are not chains', () => {
  const diamond = [step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])];
  assert.deepEqual(executionWaves(diamond), [['a'], ['b', 'c'], ['d']]);
  assert.equal(strategyOf(diamond, executionWaves(diamond)), 'fan-out-fan-in');

  const flat = [step('a'), step('b'), step('c')];
  assert.deepEqual(executionWaves(flat), [['a', 'b', 'c']]);
  assert.equal(strategyOf(flat, executionWaves(flat)), 'parallel');

  const mixed = [step('a'), step('b'), step('c', ['a']), step('d', ['a', 'b'])];
  assert.equal(strategyOf(mixed, executionWaves(mixed)), 'hybrid');
  assert.equal(strategyOf([], []), 'single');
  assert.equal(strategyOf([step('a')], [['a']]), 'single');
  assert.throws(() => executionWaves([step('a', ['b']), step('b', ['a'])]), /cycle/);
  assert.throws(() => executionWaves([step('a', ['ghost'])]), /unknown step/);
});

// ---- numbers

test('complexity: the legacy formula, with the priority factor and the cap', () => {
  // coding: 0.3 + 3 steps * 0.1 + 2 dependencies * 0.05 = 0.7; + 0.15 kind; + 200/2000 = 0.1
  assert.equal(analyzeTask(task()).complexity, 0.95);
  assert.equal(analyzeTask(task({ priority: 'low' })).complexity, 0.88); // 0.7 * 0.9 + 0.25
  assert.equal(analyzeTask(task({ priority: 'critical' })).complexity, 1); // capped
  assert.equal(analyzeTask(task({ description: 'z'.repeat(20) })).complexity, 0.46); // no steps: 0.3 + 0.15 kind + 20 / 2000
});

test('estimate: the legacy formula, marked heuristic; measured only with three samples or more', () => {
  const a = analyzeTask(task());
  assert.equal(a.heuristic, true);
  assert.deepEqual(a.estimate, { ms: 143000, basis: 'heuristic', samples: 0 }); // 60000 * (0.5 + 0.95 * 1.5) + 55000 * 0.5
  const two = analyzeTask(task(), { measuredDurations: { engineer: { meanMs: 5000, samples: 2 } } });
  assert.equal(two.estimate.basis, 'heuristic');
  const three = analyzeTask(task(), { measuredDurations: { engineer: { meanMs: 5000, samples: 3 } } });
  assert.deepEqual(three.estimate, { ms: 5000, basis: 'measured', samples: 3 });
});

test('topics come from the kind and from words in the task', () => {
  const a = analyzeTask(task({ title: 'Security hardening', description: `deploy with better performance ${LONG}` }));
  for (const topic of ['coding', 'security', 'deployment', 'performance']) assert.ok(a.topics.includes(topic), topic);
  assert.ok(!a.topics.includes('architecture'));
});

test('confidence: base, complexity, topics and matching patterns, capped at 0.95', () => {
  assert.equal(analyzeTask(task()).confidence, 0.66); // 0.5 + 0.05 * 0.2 + 0.15
  const patterns = Array.from({ length: 5 }, (_, i) => ({ patternId: `p${i}`, strategy: 's', successScore: 1, relevance: 0.9 }));
  const rich = analyzeTask(task(), { patterns });
  assert.ok(rich.confidence > 0.66);
  assert.equal(rich.confidence, 0.95);
  assert.equal(rich.matchedPatterns.length, 5);
});

test('the same input gives the same analysis', () => {
  assert.deepEqual(analyzeTask(task()), analyzeTask(task()));
});

// ---- splitting in the orchestrator

const hubWithTeam = () => {
  const hub = new ColonyHub();
  for (const role of ['architect', 'engineer', 'tester'] as AgentRole[]) hub.registry.register({ id: role, name: role, role });
  return hub;
};

const parts = (...specs: Array<[string, string[], AgentRole]>) => specs.map(([key, dependsOn, role]) => ({ key, dependsOn, options: { title: key, description: key, requiredRole: role } }));

test('a split creates the parts with their dependencies and sends the parent to the back of the line', async () => {
  const hub = hubWithTeam();
  const parent = await hub.orchestrator.createTask({ title: 'Parent', description: 'whole job', requiredRole: 'engineer' });
  assert.equal(parent.status, 'assigned');
  const engineerBusy = hub.registry.getMember('engineer')!.currentTaskIds.length;
  assert.equal(engineerBusy, 1);

  const children = await hub.orchestrator.splitTask(parent.id, parts(['design', [], 'architect'], ['build', ['design'], 'engineer'], ['check', ['build'], 'tester']));
  assert.equal(children.length, 3);
  assert.ok(children.every((c) => c.parentId === parent.id));
  assert.equal(children[0].status, 'assigned'); // no dependencies: dispatched at once
  assert.equal(children[1].status, 'pending');
  assert.deepEqual(children[1].dependencies, [children[0].id]);
  assert.deepEqual(children[2].dependencies, [children[1].id]);

  const p = hub.orchestrator.getTask(parent.id)!;
  assert.equal(p.status, 'pending');
  assert.equal(p.assignedAgentId, undefined);
  assert.deepEqual(p.subTaskIds, children.map((c) => c.id));
  assert.deepEqual(p.dependencies, [children[2].id]); // waits for the last part only
  assert.equal(hub.registry.getMember('engineer')!.currentTaskIds.includes(parent.id), false);
});

test('finishing the parts in order releases the next one, and the parent comes last', async () => {
  const hub = hubWithTeam();
  const parent = await hub.orchestrator.createTask({ title: 'Parent', description: 'whole job', requiredRole: 'engineer' });
  const [a, b, c] = await hub.orchestrator.splitTask(parent.id, parts(['a', [], 'architect'], ['b', ['a'], 'engineer'], ['c', ['b'], 'tester']));

  await hub.orchestrator.completeTask(a.id, 'architect', 'done');
  assert.equal(hub.orchestrator.getTask(b.id)!.status, 'assigned');
  assert.equal(hub.orchestrator.getTask(parent.id)!.status, 'pending');
  await hub.orchestrator.completeTask(b.id, 'engineer', 'done');
  await hub.orchestrator.completeTask(c.id, 'tester', 'done');
  const p = hub.orchestrator.getTask(parent.id)!;
  assert.equal(p.status, 'assigned');
  assert.equal(p.assignedAgentId, 'engineer');
});

test('parts that run side by side all wait for nothing, and the parent waits for every leaf', async () => {
  const hub = hubWithTeam();
  const parent = await hub.orchestrator.createTask({ title: 'Parent', description: 'whole job', requiredRole: 'engineer' });
  const kids = await hub.orchestrator.splitTask(parent.id, parts(['x', [], 'architect'], ['y', [], 'tester']));
  assert.ok(kids.every((k) => k.status === 'assigned'));
  assert.deepEqual(new Set(hub.orchestrator.getTask(parent.id)!.dependencies), new Set(kids.map((k) => k.id)));
});

test('an invalid split changes nothing', async () => {
  const hub = hubWithTeam();
  const parent = await hub.orchestrator.createTask({ title: 'Parent', description: 'whole job', requiredRole: 'engineer' });
  const before = JSON.stringify(hub.orchestrator.snapshot());

  await assert.rejects(() => hub.orchestrator.splitTask(parent.id, []), /at least one part/);
  await assert.rejects(() => hub.orchestrator.splitTask(parent.id, parts(['a', [], 'engineer'], ['a', [], 'engineer'])), /duplicate part key/);
  await assert.rejects(() => hub.orchestrator.splitTask(parent.id, parts(['a', ['ghost'], 'engineer'])), /unknown part/);
  await assert.rejects(() => hub.orchestrator.splitTask(parent.id, parts(['a', ['b'], 'engineer'], ['b', ['a'], 'engineer'])), /cycle/);
  await assert.rejects(() => hub.orchestrator.splitTask('nope', parts(['a', [], 'engineer'])), /not found/);
  assert.equal(JSON.stringify(hub.orchestrator.snapshot()), before);
  assert.equal(hub.orchestrator.getTask(parent.id)!.status, 'assigned');
});

test('a started, a finished or an already split task cannot be split', async () => {
  const hub = hubWithTeam();
  const started = await hub.orchestrator.createTask({ title: 'S', description: 'd', requiredRole: 'engineer' });
  await hub.orchestrator.updateTaskProgress(started.id, 'engineer', 'in_progress');
  await assert.rejects(() => hub.orchestrator.splitTask(started.id, parts(['a', [], 'engineer'])), /in_progress.*not been started/);

  const fresh = await hub.orchestrator.createTask({ title: 'F', description: 'd', requiredRole: 'architect' });
  await hub.orchestrator.splitTask(fresh.id, parts(['a', [], 'tester']));
  await assert.rejects(() => hub.orchestrator.splitTask(fresh.id, parts(['b', [], 'tester'])), /already split/);
});

// ---- hub.analyze

test('the hub brings in similar past work and measured durations', async () => {
  const hub = hubWithTeam();
  for (let i = 0; i < 3; i++) {
    const t = await hub.orchestrator.createTask({ title: 'Importer', description: 'import the ledger rows', requiredRole: 'engineer' });
    await hub.orchestrator.completeTask(t.id, 'engineer', 'streamed the rows', { quality: 0.9 });
  }
  const target = await hub.orchestrator.createTask({ title: 'Importer', description: `import the ledger rows ${LONG}`, requiredRole: 'engineer' });
  const a = await hub.analyze(target);
  assert.ok(a.matchedPatterns.length > 0);
  assert.ok(a.matchedPatterns.every((p) => p.relevance >= 0.4));
  assert.equal(a.estimate.basis, 'measured');
  assert.equal(a.estimate.samples, 3);
  assert.ok(a.confidence > analyzeTask(target).confidence);
});

// ---- CLI

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-plan-test-'));
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

test('plan previews without changing anything, then --apply creates the steps', async () => {
  const { run } = await project('apply');
  const id = (await run('task', 'add', 'Build the importer', LONG, '--role', 'engineer')).out.task.id;

  const preview = await run('plan', id);
  assert.equal(preview.code, 0);
  assert.equal(preview.out.applied, false);
  assert.equal(preview.out.analysis.heuristic, true);
  assert.deepEqual(preview.out.analysis.steps.map((s: any) => s.key), ['design', 'implement', 'test']);
  assert.equal(preview.out.analysis.strategy, 'pipeline');
  assert.match(preview.out.note, /Nothing was changed/);
  assert.equal((await run('status')).out.tasks.length, 1);

  const applied = await run('plan', id, '--apply');
  assert.equal(applied.code, 0);
  assert.equal(applied.out.children.length, 3);
  assert.deepEqual(applied.out.children.map((c: any) => c.requiredRole), ['architect', 'engineer', 'tester']);
  assert.equal(applied.out.parent.status, 'pending');
  assert.equal((await run('status')).out.tasks.length, 4);

  const split = (await run('audit', 'list', '--type', 'task.split')).out.entries;
  assert.equal(split.length, 1);
  assert.equal(split[0].payload.children.length, 3);
  assert.equal((await run('audit', 'list', '--type', 'task.added', '--k', '10')).out.entries.length, 4);

  assert.match((await run('plan', id, '--apply')).out.error, /already split/);

  // The whole chain can be worked through `next` and `done`.
  for (const role of ['architect', 'engineer', 'tester']) {
    const next = await run('next', '--as', role);
    assert.ok(next.out.task, role);
    assert.equal((await run('done', next.out.task.id, '--result', `${role} finished`)).code, 0);
  }
  const last = await run('next', '--as', 'engineer');
  assert.equal(last.out.task.id, id); // the parent, as the sign-off
});

test('plan: nothing to split, unknown kind, unknown task, forced kind', async () => {
  const { run } = await project('edge');
  const short = (await run('task', 'add', 'Quick', 'tiny', '--role', 'engineer')).out.task.id;
  const preview = await run('plan', short);
  assert.deepEqual(preview.out.analysis.steps, []);
  assert.match((await run('plan', short, '--apply')).out.error, /nothing to split/);
  assert.match((await run('plan', short, '--kind', 'poetry')).out.error, /unknown kind/);
  assert.match((await run('plan', 'task_nope')).out.error, /not found/);

  const forced = await run('plan', short, '--kind', 'research');
  assert.equal(forced.out.analysis.kind, 'research'); // still no steps: the task is short
});

test('plan warns when no member holds a role a step needs', async () => {
  const { dir, run } = await project('coverage');
  const id = (await run('task', 'add', 'Study the market', LONG, '--role', 'researcher')).out.task.id;
  assert.equal((await run('plan', id)).out.planWarnings, undefined);

  const file = path.join(dir, '.colony', 'ledger.json');
  const ledger = JSON.parse(await fs.readFile(file, 'utf-8'));
  ledger.members.find((m: any) => m.id === 'member_researcher').status = 'offline';
  await fs.writeFile(file, JSON.stringify(ledger), 'utf-8');
  const warned = await run('plan', id);
  assert.ok(warned.out.planWarnings.some((w: string) => /researcher/.test(w)));
});
