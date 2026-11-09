import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoERouter, tokenize } from '../neural/moe-router.js';
import { ColonyHub } from '../colony-hub.js';
import { runCommand } from '../cli/commands.js';

// No rule keyword occurs in it, not even as a substring (the keyword match is a plain substring test).
const TEXT = 'quarterly invoice ledger sums';

test('tokenize: unique lowercase words of 3+ characters, any script', () => {
  assert.deepEqual(tokenize('Fix the Bug, fix THE bug!'), ['fix', 'the', 'bug']);
  assert.deepEqual(tokenize('a b cd'), []);
  assert.deepEqual(tokenize('Számla egyeztetés 2026'), ['számla', 'egyeztetés', '2026']);
  assert.equal(tokenize(Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')).length, 64);
});

test('without learning the router behaves as before', () => {
  const router = new MoERouter();
  const d = router.routeTask('review the code and audit it');
  assert.equal(d.targetRole, 'reviewer');
  assert.equal(d.learnedAdjustment, 0);
  assert.equal(router.routeTask(TEXT).targetRole, 'engineer'); // no keyword: fallback
});

test('teaching moves a text to the taught role, and the decision says how much was learned', () => {
  const router = new MoERouter();
  router.recordOutcome(TEXT, 'director', 1);
  router.recordOutcome(TEXT, 'director', 1);
  const d = router.routeTask(TEXT);
  assert.equal(d.targetRole, 'director');
  assert.ok(d.learnedAdjustment > 0);
  assert.match(d.reasoning, /learned adjustment/);
});

test('a negative outcome pushes a role down, and a weight stays within its cap', () => {
  const router = new MoERouter();
  const base = router.routeTask('implement the parser');
  assert.equal(base.targetRole, 'engineer');
  for (let i = 0; i < 20; i++) router.recordOutcome('implement the parser', 'engineer', -1);
  const after = router.routeTask('implement the parser');
  assert.ok(after.learnedAdjustment <= 0);
  assert.match(after.reasoning, /No strong keyword/); // the rule score was cancelled out, only the fallback is left

  const capped = new MoERouter({ maxWeight: 1 });
  for (let i = 0; i < 50; i++) capped.recordOutcome('zebra', 'tester', 1);
  assert.ok(capped.routeTask('zebra').learnedAdjustment <= 1 + 1e-9);
});

test('learning is specific to the words of the task', () => {
  const router = new MoERouter();
  router.recordOutcome(TEXT, 'director', 1);
  router.recordOutcome(TEXT, 'director', 1);
  assert.equal(router.routeTask('implement a parser').targetRole, 'engineer');
  assert.equal(router.routeTask('implement a parser').learnedAdjustment, 0);
});

test('rewards are clamped, a non-finite reward is refused, and options are validated', () => {
  const a = new MoERouter();
  const b = new MoERouter();
  a.recordOutcome(TEXT, 'tester', 1);
  b.recordOutcome(TEXT, 'tester', 50);
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.throws(() => a.recordOutcome(TEXT, 'tester', Number.NaN), /finite/);
  assert.throws(() => new MoERouter({ learningRate: 0 }), /positive/);
});

test('the word table is bounded', () => {
  const router = new MoERouter({ maxWords: 3 });
  router.recordOutcome('alpha beta gamma delta epsilon', 'tester', 1);
  assert.equal(router.getStats().learnedWords, 3);
});

test('load balance counts routed tasks, ignores previews, and reports the Gini coefficient', () => {
  const router = new MoERouter();
  assert.equal(router.getLoadBalance().gini, 0);
  router.routeTask('review the change', { record: false });
  assert.equal(router.getLoadBalance().totalRouted, 0);

  for (let i = 0; i < 6; i++) router.routeTask('review the change');
  const one = router.getLoadBalance();
  assert.equal(one.totalRouted, 6);
  assert.equal(one.counts.reviewer, 6);
  assert.equal(one.utilization.reviewer, 1);
  assert.ok(one.gini > 0.8); // everything on one of six roles: 5/6

  for (const text of ['review it', 'secure auth', 'architecture design', 'run the test', 'implement code', 'project plan']) {
    for (let i = 0; i < 5; i++) router.routeTask(text);
  }
  assert.ok(router.getLoadBalance().gini < one.gini);
});

test('snapshot and restore keep what was learned and counted', () => {
  const router = new MoERouter();
  router.recordOutcome(TEXT, 'director', 1);
  router.routeTask('review the change');
  const copy = new MoERouter();
  copy.restore(JSON.parse(JSON.stringify(router.snapshot())));
  assert.deepEqual(copy.snapshot(), router.snapshot());
  assert.equal(copy.routeTask(TEXT, { record: false }).targetRole, router.routeTask(TEXT, { record: false }).targetRole);
});

test('the hub learns from outcomes: failure counts against the role, a reported success counts a little for it', async () => {
  const hub = new ColonyHub();
  hub.registry.register({ id: 'e1', name: 'e1', role: 'engineer' });
  const { task } = await hub.submitAdaptiveTask({ title: 'Implement', description: 'quarterly invoice parser', requiredRole: 'engineer' });
  await hub.orchestrator.completeTask(task.id, 'e1', 'done');
  assert.equal(hub.router.getStats().outcomes, 1);
  assert.equal(hub.router.getStats().averageReward, 0.5);

  hub.registry.register({ id: 'e2', name: 'e2', role: 'engineer' });
  const second = await hub.submitAdaptiveTask({ title: 'Implement', description: 'other thing', requiredRole: 'engineer' });
  await hub.orchestrator.failTask(second.task.id, second.task.assignedAgentId!, 'broke');
  assert.equal(hub.router.getStats().outcomes, 2);
  assert.equal(hub.router.getStats().averageReward, -0.25);
});

// ---- CLI

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-router-test-'));
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
  return run;
}

test('route test previews, route teach learns and persists, route stats reports', async () => {
  const run = await project('cli');
  const before = await run('route', 'test', TEXT);
  assert.equal(before.out.decision.targetRole, 'engineer');
  assert.equal((await run('route', 'stats')).out.load.totalRouted, 0); // a preview does not count

  const taught = await run('route', 'teach', TEXT, '--role', 'analyst');
  assert.equal(taught.out.decision.targetRole, 'analyst');
  assert.equal(taught.out.learning.outcomes, 1);

  // a fresh command (new process state) still routes by what was learned
  assert.equal((await run('route', 'test', TEXT)).out.decision.targetRole, 'analyst');
  const added = await run('task', 'add', 'Invoices', TEXT);
  assert.equal(added.out.requiredRole, 'analyst');
  assert.equal((await run('route', 'stats')).out.load.counts.analyst, 1); // a taught role without a rule is routable and counted
  assert.equal((await run('audit', 'list', '--type', 'router.taught')).out.entries.length, 1);
});

test('route rejects bad input', async () => {
  const run = await project('cli-bad');
  assert.match((await run('route', 'wipe')).out.error, /usage: route/);
  assert.match((await run('route', 'test')).out.error, /needs a task text/);
  assert.match((await run('route', 'teach', TEXT)).out.error, /--role/);
  assert.match((await run('route', 'teach', TEXT, '--role', 'wizard')).out.error, /--role/);
  assert.match((await run('route', 'teach', TEXT, '--role', 'tester', '--reward', '3')).out.error, /--reward/);
});

test('a ledger written before the router learned still loads', async () => {
  const run = await project('cli-old');
  const file = path.join(root, 'cli-old', '.colony', 'ledger.json');
  const ledger = JSON.parse(await fs.readFile(file, 'utf-8'));
  delete ledger.router;
  await fs.writeFile(file, JSON.stringify(ledger), 'utf-8');
  assert.equal((await run('route', 'stats')).out.learning.outcomes, 0);
});
