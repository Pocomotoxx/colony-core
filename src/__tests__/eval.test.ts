import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../cli/commands.js';
import { compareVariants, estimateRuns, EvalResult, EvalSet, normalCdf, parseEvalSet, summarize, fisherExactP, wilson } from '../eval/eval-core.js';

// ---- pure functions

const mkSet = (extra: Record<string, unknown> = {}) => JSON.stringify({
  set: 'tune-1', split: 'tune',
  tasks: [
    { id: 't1', title: 'first', prompt: 'do the first thing', check: ['node', '-e', 'process.exit(0)'] },
    { id: 't2', title: 'second', prompt: 'do the second thing', check: ['node', '-e', 'process.exit(1)'], timeoutSec: 30 },
  ],
  ...extra,
});

test('a valid task set parses, and every problem of an invalid one is named', () => {
  const ok = parseEvalSet(mkSet());
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.set!.tasks.length, 2);
  assert.equal(ok.set!.tasks[1].timeoutSec, 30);

  assert.match(parseEvalSet('{ nope').problems[0], /not valid JSON/);
  assert.match(parseEvalSet('[]').problems[0], /JSON object/);
  const bad = parseEvalSet(JSON.stringify({ set: 'Bad Name', split: 'x', tasks: [
    { id: 'a', title: '', prompt: 'p', check: 'node test' },
    { id: 'a', title: 't', prompt: 'p', check: ['node'], timeoutSec: 0 },
    { id: 'b', title: 't', prompt: 'p', check: ['rm', '-rf', '/'] },
  ] })).problems.join('\n');
  assert.match(bad, /`set` must be a name/);
  assert.match(bad, /`split` must be/);
  assert.match(bad, /tasks\[0\]: `title`/);
  assert.match(bad, /tasks\[0\]: `check` must be a non-empty list/);
  assert.match(bad, /duplicate id 'a'/);
  assert.match(bad, /timeoutSec/);
  assert.match(bad, /refused by the gates/);
  assert.equal(parseEvalSet(JSON.stringify({ set: 's', split: 'tune', tasks: [] })).set, undefined);
  assert.equal(parseEvalSet('﻿' + mkSet()).problems.length, 0, 'a BOM is tolerated');
});

test('normalCdf, wilson and the two-share test give known values', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-3);
  const w = wilson(5, 10);
  assert.ok(w.lo > 0.23 && w.lo < 0.24 && w.hi > 0.76 && w.hi < 0.77, JSON.stringify(w));
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 1 });
  assert.ok(wilson(10, 10).hi > 0.999999);
  assert.ok(wilson(0, 10).lo === 0);
  assert.equal(fisherExactP(5, 10, 5, 10), 1);
  assert.ok(fisherExactP(45, 90, 63, 90) < 0.01, 'the 50% vs 70% case at 90 runs is beyond noise');
  assert.ok(fisherExactP(5, 10, 7, 10) > 0.05, 'the same difference at 10 runs is not');
  assert.equal(fisherExactP(0, 0, 1, 1), 1);
  assert.ok(fisherExactP(10, 10, 0, 10) < 0.001);
  assert.ok(Math.abs(fisherExactP(3, 3, 0, 3) - 0.1) < 1e-9, '3 of 3 against 0 of 3 is p = 0.1, not significant');
});

const run = (variant: string, task: string, n: number, passed: boolean, extra: Partial<EvalResult> = {}): EvalResult =>
  ({ set: 'tune-1', variant, task, run: n, passed, source: 'colony', at: 1, ...extra });

const many = (variant: string, passed: number, total: number, extra: Partial<EvalResult> = {}) =>
  Array.from({ length: total }, (_, i) => run(variant, `t${i % 5}`, Math.floor(i / 5) + 1, i < passed, extra));

test('summarize counts runs, shares, cost and turns', () => {
  const s = summarize([...many('A', 6, 10, { costUsd: 0.5, turns: 4 }), ...many('B', 2, 5)], 'A');
  assert.equal(s.runs, 10);
  assert.equal(s.passed, 6);
  assert.equal(s.rate, 0.6);
  assert.equal(s.tasks, 5);
  assert.equal(s.cost.meanUsd, 0.5);
  assert.equal(s.cost.totalUsd, 5);
  assert.equal(s.meanTurns, 4);
  const empty = summarize([], 'Z');
  assert.equal(empty.rate, null);
  assert.equal(empty.cost.meanUsd, null);
});

test('compare names no winner with too few runs, or within noise; only beyond noise with enough runs', () => {
  const few = compareVariants([...many('A', 9, 10), ...many('B', 1, 10)], 'A', 'B', 20);
  assert.equal(few.verdict, 'too-few-runs');
  assert.match(few.statement, /no claim/);
  assert.equal(few.p, null);

  const noise = compareVariants([...many('A', 11, 20), ...many('B', 9, 20)], 'A', 'B', 20);
  assert.equal(noise.verdict, 'within-noise');
  assert.match(noise.statement, /within noise/);

  const clear = compareVariants([...many('A', 18, 20), ...many('B', 6, 20)], 'A', 'B', 20);
  assert.equal(clear.verdict, 'a-higher');
  assert.match(clear.statement, /A passes more often than B/);
  const reverse = compareVariants([...many('A', 6, 20), ...many('B', 18, 20)], 'A', 'B', 20);
  assert.equal(reverse.verdict, 'b-higher');
  assert.ok(clear.caveats.some((c) => /optimistic/.test(c)), 'the limits are always stated');
  assert.ok(clear.caveats.some((c) => /this host and model/.test(c)));
});

test('estimate counts runs still needed, uses a given or measured cost, and checks a budget', () => {
  const set = parseEvalSet(mkSet()).set as EvalSet;
  const none = estimateRuns(set, ['A', 'B'], 3, [], undefined, undefined);
  assert.equal(none.plannedRuns, 12);
  assert.equal(none.remainingRuns, 12);
  assert.equal(none.costSource, 'unknown');
  assert.equal(none.estimatedCostUsd, null);
  assert.match(none.notes.join(' '), /Nothing should start without an estimate/);
  assert.match(none.notes.join(' '), /90 runs per variant/);

  const given = estimateRuns(set, ['A', 'B'], 3, [], 0.2, 2);
  assert.equal(given.costSource, 'given');
  assert.ok(Math.abs(given.estimatedCostUsd! - 2.4) < 1e-9);
  assert.equal(given.withinBudget, false);
  assert.equal(estimateRuns(set, ['A', 'B'], 3, [], 0.2, 5).withinBudget, true);

  const existing = [run('A', 't1', 1, true, { costUsd: 0.1 }), run('A', 't1', 2, true, { costUsd: 0.3 }), run('A', 't2', 1, false)];
  const measured = estimateRuns(set, ['A', 'B'], 3, existing, undefined, undefined);
  assert.equal(measured.alreadyDone, 3);
  assert.equal(measured.remainingRuns, 9);
  assert.equal(measured.costSource, 'measured');
  assert.ok(Math.abs(measured.costPerRunUsd! - 0.2) < 1e-9);
  // runs beyond the repeats do not count twice
  const extra = estimateRuns(set, ['A'], 1, existing, 0.1, undefined);
  assert.equal(extra.alreadyDone, 2, 'one per task is enough for repeats = 1');
});

// ---- the commands

let root: string;
let n = 0;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-eval-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const exec = async (dir: string, ...args: string[]) => runCommand([...args, '--dir', dir], process.cwd());
const ok = async (dir: string, ...args: string[]) => {
  const r = await exec(dir, ...args);
  assert.equal(r.code, 0, JSON.stringify(r.output));
  return r.output as any;
};
const bad = async (dir: string, ...args: string[]) => {
  const r = await exec(dir, ...args);
  assert.notEqual(r.code, 0, `expected failure: ${args.join(' ')}`);
  return String((r.output as any).error);
};

async function project() {
  const dir = path.join(root, `p${n++}`);
  await fs.mkdir(path.join(dir, 'work', 'pass'), { recursive: true });
  await fs.mkdir(path.join(dir, 'work', 'fail'), { recursive: true });
  await fs.writeFile(path.join(dir, 'set.json'), mkSet());
  await ok(dir, 'boot');
  return dir;
}

test('validate reads a set inside the project, refuses a bad one, and refuses a path outside', async () => {
  const dir = await project();
  const v = await ok(dir, 'eval', 'validate', '--set', 'set.json');
  assert.equal(v.valid, true);
  assert.equal(v.tasks, 2);
  await fs.writeFile(path.join(dir, 'broken.json'), JSON.stringify({ set: 'x', split: 'nope', tasks: [] }));
  assert.match(await bad(dir, 'eval', 'validate', '--set', 'broken.json'), /the task set is invalid/);
  assert.match(await bad(dir, 'eval', 'validate', '--set', '../outside.json'), /inside the project/);
  assert.match(await bad(dir, 'eval', 'validate', '--set', 'missing.json'), /not found/);
  assert.match(await bad(dir, 'eval', 'validate'), /--set/);
  assert.match(await bad(dir, 'eval'), /usage: eval/);
  assert.match(await bad(dir, 'eval', 'banana'), /usage: eval/);
});

test('check runs the task check itself and stores the result once; a second try is refused', async () => {
  const dir = await project();
  const pass = await ok(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '1', '--workspace', 'work/pass', '--cost-usd', '0.25', '--turns', '4', '--duration-ms', '4200');
  assert.equal(pass.result.passed, true);
  assert.equal(pass.result.source, 'colony');
  assert.equal(pass.result.costUsd, 0.25);
  assert.equal(pass.result.turns, 4);
  assert.equal(pass.result.durationMs, 4200, 'the duration the runner measured is the run duration');
  assert.equal(typeof pass.result.checkDurationMs, 'number', 'the check own time is kept apart');
  const noDuration = await ok(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'B', '--task', 't1', '--run', '1', '--workspace', 'work/pass');
  assert.equal(noDuration.result.durationMs, undefined, 'without a measured duration none is invented from the check time');
  const fail = await ok(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'A', '--task', 't2', '--run', '1', '--workspace', 'work/fail');
  assert.equal(fail.result.passed, false, 'the check of t2 exits 1');
  assert.match(await bad(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '1', '--workspace', 'work/pass'), /already recorded/);
  assert.match(await bad(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'A', '--task', 'nope', '--run', '1', '--workspace', 'work/pass'), /not in the set/);
  assert.match(await bad(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '1'), /--workspace/);
  assert.match(await bad(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '2', '--workspace', '../x'), /inside the project/);
  assert.match(await bad(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '2', '--workspace', 'set.json'), /not a folder/);
  assert.match(await bad(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'bad name', '--task', 't1', '--run', '2', '--workspace', 'work/pass'), /--variant/);
  assert.match(await bad(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '0', '--workspace', 'work/pass'), /--run/);
});

test('record keeps a runner report apart as reported, and compare leaves it out unless asked', async () => {
  const dir = await project();
  const r = await ok(dir, 'eval', 'record', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '1', '--passed', '--duration-ms', '1500', '--input-tokens', '1000', '--output-tokens', '200');
  assert.equal(r.result.source, 'reported');
  assert.equal(r.result.inputTokens, 1000);
  assert.ok(r.warnings.some((w: string) => /recorded as `reported`/.test(w)));
  assert.match(await bad(dir, 'eval', 'record', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '2'), /exactly one of --passed or --failed/);
  assert.match(await bad(dir, 'eval', 'record', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '2', '--passed', '--failed'), /exactly one/);
  assert.match(await bad(dir, 'eval', 'record', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '2', '--passed', '--cost-usd', '-1'), /--cost-usd/);

  const without = await ok(dir, 'eval', 'compare', '--set', 'set.json', '--variants', 'A,B');
  assert.deepEqual(without.countedSources, ['colony']);
  assert.equal(without.comparison.a.runs, 0);
  assert.ok(without.warnings.some((w: string) => /reported run\(s\) left out/.test(w)));
  const withIt = await ok(dir, 'eval', 'compare', '--set', 'set.json', '--variants', 'A,B', '--include-reported');
  assert.equal(withIt.comparison.a.runs, 1);
});

test('compare and report summarise stored runs and never name a winner on a handful of runs', async () => {
  const dir = await project();
  for (let i = 1; i <= 3; i++) {
    await ok(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', String(i), '--workspace', 'work/pass');
    await ok(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'B', '--task', 't2', '--run', String(i), '--workspace', 'work/fail');
  }
  const c = await ok(dir, 'eval', 'compare', '--set', 'set.json', '--variants', 'A,B');
  assert.equal(c.comparison.verdict, 'too-few-runs');
  assert.equal(c.comparison.a.passed, 3);
  assert.equal(c.comparison.b.passed, 0);
  const lowBar = await ok(dir, 'eval', 'compare', '--set', 'set.json', '--variants', 'A,B', '--min-runs', '3');
  assert.equal(lowBar.comparison.verdict, 'within-noise', 'with 3 runs each, even 3 of 3 against 0 of 3 is not beyond noise');
  assert.match(await bad(dir, 'eval', 'compare', '--set', 'set.json', '--variants', 'A'), /exactly two/);
  assert.match(await bad(dir, 'eval', 'compare', '--set', 'set.json', '--variants', 'A,A'), /twice/);
  const report = await ok(dir, 'eval', 'report', '--set', 'set.json');
  assert.equal(report.runs, 6);
  assert.deepEqual(report.bySource, { colony: 6, reported: 0 });
  assert.equal(report.variants.length, 2);
  assert.match(report.note, /Only runs the colony checked itself/);
});

test('estimate through the command uses measured cost from stored runs and warns over budget', async () => {
  const dir = await project();
  const unknown = await ok(dir, 'eval', 'estimate', '--set', 'set.json', '--variants', 'A,B', '--repeats', '2');
  assert.equal(unknown.estimate.costSource, 'unknown');
  assert.equal(unknown.estimate.plannedRuns, 8);
  await ok(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '1', '--workspace', 'work/pass', '--cost-usd', '0.5');
  const measured = await ok(dir, 'eval', 'estimate', '--set', 'set.json', '--variants', 'A,B', '--repeats', '2', '--budget-usd', '1');
  assert.equal(measured.estimate.costSource, 'measured');
  assert.equal(measured.estimate.remainingRuns, 7);
  assert.equal(measured.estimate.withinBudget, false);
  assert.ok(measured.warnings.some((w: string) => /over the budget/.test(w)));
  assert.match(await bad(dir, 'eval', 'estimate', '--set', 'set.json', '--variants', 'A,B'), /--repeats/);
  assert.match(await bad(dir, 'eval', 'estimate', '--set', 'set.json', '--repeats', '2'), /--variants/);
});

test('a damaged line in the results file is skipped and reported, not fatal', async () => {
  const dir = await project();
  await ok(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '1', '--workspace', 'work/pass');
  await fs.appendFile(path.join(dir, '.colony', 'eval', 'results.jsonl'), 'not json\n{"a":1}\n');
  const r = await ok(dir, 'eval', 'report', '--set', 'set.json');
  assert.equal(r.runs, 1);
  assert.ok(r.warnings.some((w: string) => /2 line\(s\)/.test(w)));
});

test('every stored run is in the audit log', async () => {
  const dir = await project();
  await ok(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '1', '--workspace', 'work/pass');
  const audit = await ok(dir, 'audit', 'list', '--type', 'eval.recorded');
  assert.equal(audit.entries.length, 1);
  assert.equal((await ok(dir, 'audit', 'verify')).ok, true);
});

test('the eval commands are in the usage text', async () => {
  const help = (await runCommand(['help'], process.cwd())).output as any;
  assert.match(help.usage, /eval compare --set <file> --variants A,B/);
});

test('{setDir} in a check stands for the folder of the task set file, so a set can carry its own hidden checks', async () => {
  const dir = await project();
  await fs.mkdir(path.join(dir, 'sets', 'x', 'fixtures'), { recursive: true });
  await fs.writeFile(path.join(dir, 'sets', 'x', 'c.mjs'), "import fs from 'node:fs';\nprocess.exit(fs.existsSync('out.txt') ? 0 : 1);\n");
  await fs.writeFile(path.join(dir, 'sets', 'x', 'set.json'), JSON.stringify({
    set: 'x', split: 'tune',
    tasks: [{ id: 't', title: 'one', prompt: 'p', check: ['node', '{setDir}/c.mjs'], setup: '{setDir}/fixtures' }],
  }));
  await fs.mkdir(path.join(dir, 'work', 'with'), { recursive: true });
  await fs.writeFile(path.join(dir, 'work', 'with', 'out.txt'), 'x');
  const yes = await ok(dir, 'eval', 'check', '--set', 'sets/x/set.json', '--variant', 'A', '--task', 't', '--run', '1', '--workspace', 'work/with');
  assert.equal(yes.result.passed, true, 'the check in the set folder ran in the workspace');
  const no = await ok(dir, 'eval', 'check', '--set', 'sets/x/set.json', '--variant', 'A', '--task', 't', '--run', '2', '--workspace', 'work/pass');
  assert.equal(no.result.passed, false);
});

test('the model the host says it used is stored with the run and shown per variant; a bad name is refused', async () => {
  const dir = await project();
  const r = await ok(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '1', '--workspace', 'work/pass', '--model', 'claude-model-a');
  assert.equal(r.result.model, 'claude-model-a');
  await ok(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '2', '--workspace', 'work/pass', '--model', 'claude-model-a,claude-sub-b');
  await ok(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'B', '--task', 't1', '--run', '1', '--workspace', 'work/pass');
  await ok(dir, 'eval', 'record', '--set', 'set.json', '--variant', 'B', '--task', 't1', '--run', '2', '--passed', '--model', 'other-model');
  const report = await ok(dir, 'eval', 'report', '--set', 'set.json');
  const a = report.variants.find((v: any) => v.variant === 'A');
  assert.deepEqual(a.models, ['claude-model-a', 'claude-sub-b']);
  const b = report.variants.find((v: any) => v.variant === 'B');
  assert.deepEqual(b.models, [], 'a run without a reported model adds none (the reported record is not in the report)');
  assert.match(await bad(dir, 'eval', 'check', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '3', '--workspace', 'work/pass', '--model', 'bad name'), /--model must be/);
  assert.match(await bad(dir, 'eval', 'record', '--set', 'set.json', '--variant', 'A', '--task', 't1', '--run', '4', '--passed', '--model', 'x;rm -rf'), /--model must be/);
});
