import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../cli/commands.js';

// The runner is tested with a fake host (a small script), never with a real agent.

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runner = path.join(repo, 'scripts', 'eval-run.mjs');

const FAKE_HOST = [
  "import fs from 'node:fs';",
  "const prompt = fs.readFileSync(0, 'utf-8');",
  "if (process.argv.includes('--grandchild')) {",
  "  const { spawn } = await import('node:child_process');",
  "  spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });",
  "  await new Promise((r) => setTimeout(r, 60000));",
  "}",
  "if (process.argv.includes('--sleep')) await new Promise((r) => setTimeout(r, 8000));",
  "if (prompt.includes('PASS')) fs.writeFileSync('out.txt', 'done');",
  "const body = process.argv.includes('--nocost') ? { result: 'ok' } : { result: 'ok', total_cost_usd: 0.3, num_turns: 2, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { 'fake-model-1': { inputTokens: 10 } } };",
  'console.log(JSON.stringify(body));',
].join('\n');
const CHECK = "import fs from 'node:fs';\nprocess.exit(fs.existsSync('out.txt') ? 0 : 1);\n";

let root: string;
let n = 0;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-evalrun-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function project() {
  const dir = path.join(root, `p${n++}`);
  await fs.mkdir(path.join(dir, 'fixtures', 'check'), { recursive: true });
  await fs.writeFile(path.join(dir, 'fixtures', 'check', 'check.mjs'), CHECK);
  await fs.writeFile(path.join(dir, 'fake-host.mjs'), FAKE_HOST);
  await fs.writeFile(path.join(dir, 'set.json'), JSON.stringify({
    set: 'pilot', split: 'tune',
    tasks: [
      { id: 't1', title: 'one', prompt: 'PASS this one', check: ['node', 'check.mjs'], setup: 'fixtures/check' },
      { id: 't2', title: 'two', prompt: 'leave this one', check: ['node', 'check.mjs'], setup: 'fixtures/check' },
    ],
  }));
  const host = (...extra: string[]) => ({ command: [process.execPath, path.join(dir, 'fake-host.mjs'), ...extra] });
  await fs.writeFile(path.join(dir, 'variants.json'), JSON.stringify({ variants: { A: host(), B: host(), C: host('--nocost'), S: host('--sleep'), G: host('--grandchild') } }));
  assert.equal((await runCommand(['boot', '--dir', dir], process.cwd())).code, 0);
  return dir;
}

const run = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, [runner, '--dir', dir, '--set', 'set.json', '--variants-file', 'variants.json', ...args], { encoding: 'utf-8', timeout: 120_000 });

async function stored(dir: string) {
  const text = await fs.readFile(path.join(dir, '.colony', 'eval', 'results.jsonl'), 'utf-8').catch(() => '');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('nothing starts without --yes, and a real run needs a budget', async () => {
  const dir = await project();
  const noYes = run(dir, '--repeats', '1', '--budget-usd', '5', '--variants', 'A');
  assert.equal(noYes.status, 2);
  assert.match(noYes.stderr, /--yes/);
  const noBudget = run(dir, '--repeats', '1', '--yes', '--variants', 'A');
  assert.equal(noBudget.status, 2);
  assert.match(noBudget.stderr, /--budget-usd/);
  assert.deepEqual(await stored(dir), []);
});

test('a dry run prints the plan and starts nothing', async () => {
  const dir = await project();
  const r = run(dir, '--repeats', '2', '--dry-run', '--variants', 'A,B');
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout).plan;
  assert.equal(plan.toRun, 8);
  assert.equal(plan.alreadyDone, 0);
  assert.deepEqual(plan.variants, ['A', 'B']);
  assert.match(r.stderr, /nothing was started/);
  assert.deepEqual(await stored(dir), []);
  await assert.rejects(fs.access(path.join(dir, 'eval-work')), 'no workspace was made');
});

test('a real run records what the colony checked, with the cost the host reported, and a rerun does nothing', async () => {
  const dir = await project();
  const r = run(dir, '--repeats', '1', '--budget-usd', '5', '--yes', '--variants', 'A');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.started, 2);
  assert.ok(Math.abs(out.spentUsd - 0.6) < 1e-9);
  assert.equal(out.stopped, null);
  const rows = await stored(dir);
  assert.equal(rows.length, 2);
  const t1 = rows.find((x) => x.task === 't1');
  const t2 = rows.find((x) => x.task === 't2');
  assert.equal(t1.passed, true, 'the host wrote the file the check wants');
  assert.equal(t2.passed, false, 'the host left it out: the colony check says failed');
  assert.equal(t1.source, 'colony');
  assert.equal(t1.costUsd, 0.3);
  assert.equal(t1.turns, 2);
  assert.equal(t1.inputTokens, 10);
  assert.equal(t1.model, 'fake-model-1', 'the model the host reported is stored');
  assert.equal(typeof t1.durationMs, 'number', 'the runner measured the host duration');
  assert.equal(typeof t1.checkDurationMs, 'number');
  assert.match(r.stderr, /the host's JSON output has these fields: result, total_cost_usd/);
  // a fresh workspace per run, outside .colony
  await fs.access(path.join(dir, 'eval-work', 'pilot', 'A', 't1', '1', 'out.txt'));

  const again = run(dir, '--repeats', '1', '--budget-usd', '5', '--yes', '--variants', 'A');
  assert.equal(again.status, 0);
  assert.match(again.stderr, /nothing left to run/);
  assert.equal((await stored(dir)).length, 2, 'no second run was paid for');
  const plan = JSON.parse(run(dir, '--repeats', '2', '--dry-run', '--variants', 'A').stdout).plan;
  assert.equal(plan.alreadyDone, 2);
  assert.equal(plan.toRun, 2);
});

test('the run stops when the reported cost reaches the budget', async () => {
  const dir = await project();
  const r = run(dir, '--repeats', '3', '--budget-usd', '0.5', '--yes', '--variants', 'A');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.started, 2, 'two runs of 0.3 reach 0.5');
  assert.match(out.stopped, /budget \(0\.5 USD\) is reached/);
  assert.equal((await stored(dir)).length, 2);
});

test('a host that reports no cost stops after one run, unless the number of runs is limited', async () => {
  const dir = await project();
  const stopped = JSON.parse(run(dir, '--repeats', '2', '--budget-usd', '5', '--yes', '--variants', 'C').stdout);
  assert.equal(stopped.started, 1);
  assert.match(stopped.stopped, /did not report a cost/);
  assert.equal(stopped.outcomes[0].costUsd, null);

  const limited = JSON.parse(run(dir, '--repeats', '2', '--budget-usd', '5', '--yes', '--variants', 'C', '--max-runs', '3').stdout);
  assert.equal(limited.started, 3, 'one was done already; three more were allowed');
  assert.equal(limited.stopped, null);
  assert.equal((await stored(dir)).length, 4);
});

test('a host that started a process of its own is stopped with that process, and the run does not wait for it', async () => {
  const dir = await project();
  const started = Date.now();
  const r = run(dir, '--repeats', '1', '--budget-usd', '5', '--yes', '--variants', 'G', '--host-timeout-sec', '2', '--max-runs', '1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).outcomes[0].timedOut, true);
  assert.ok(Date.now() - started < 30_000, 'the runner did not wait for the grandchild');
});

test('a host that runs too long is stopped and the run counts as failed', async () => {
  const dir = await project();
  const r = run(dir, '--repeats', '1', '--budget-usd', '5', '--yes', '--variants', 'S', '--host-timeout-sec', '1', '--max-runs', '1');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.outcomes[0].timedOut, true);
  assert.equal(out.outcomes[0].hostOk, false);
  assert.equal(out.outcomes[0].passed, false);
  assert.match(r.stderr, /host timed out/);
});

test('the runner refuses the colony-core folder, an unknown variant, a work folder in .colony and files outside the project', async () => {
  const dir = await project();
  const self = spawnSync(process.execPath, [runner, '--dir', repo, '--set', 'set.json', '--variants-file', 'variants.json', '--repeats', '1', '--dry-run'], { encoding: 'utf-8' });
  assert.equal(self.status, 2);
  assert.match(self.stderr, /colony-core folder itself/);
  assert.match(run(dir, '--repeats', '1', '--dry-run', '--variants', 'Z').stderr, /not in the variants file/);
  assert.match(run(dir, '--repeats', '1', '--dry-run', '--work-dir', '.colony/work').stderr, /must not be inside \.colony/);
  const outside = spawnSync(process.execPath, [runner, '--dir', dir, '--set', '../x.json', '--variants-file', 'variants.json', '--repeats', '1', '--dry-run'], { encoding: 'utf-8' });
  assert.match(outside.stderr, /must be inside the project/);
  assert.match(run(dir, '--repeats', '0', '--dry-run').stderr, /--repeats must be an integer/);
  assert.match(run(dir, '--repeats', '1', '--bogus').stderr, /unknown option/);
  assert.equal(spawnSync(process.execPath, [runner], { encoding: 'utf-8' }).status, 2);
});

test('an invalid task set or variants file is refused before anything starts', async () => {
  const dir = await project();
  await fs.writeFile(path.join(dir, 'bad-set.json'), JSON.stringify({ set: 'x', split: 'nope', tasks: [] }));
  const badSet = spawnSync(process.execPath, [runner, '--dir', dir, '--set', 'bad-set.json', '--variants-file', 'variants.json', '--repeats', '1', '--dry-run'], { encoding: 'utf-8' });
  assert.equal(badSet.status, 1);
  assert.match(badSet.stderr, /the task set is not valid/);
  await fs.writeFile(path.join(dir, 'bad-variants.json'), JSON.stringify({ variants: { A: { command: [] }, B: { command: ['x'], promptVia: 'telepathy' } } }));
  const noCommand = spawnSync(process.execPath, [runner, '--dir', dir, '--set', 'set.json', '--variants-file', 'bad-variants.json', '--repeats', '1', '--dry-run', '--variants', 'A'], { encoding: 'utf-8' });
  assert.match(noCommand.stderr, /"command" must be a non-empty list/);
  const badVia = spawnSync(process.execPath, [runner, '--dir', dir, '--set', 'set.json', '--variants-file', 'bad-variants.json', '--repeats', '1', '--dry-run', '--variants', 'B'], { encoding: 'utf-8' });
  assert.match(badVia.stderr, /"promptVia" must be/);
});

test('the runner resolves {setDir} in the setup folder, and the hidden check next to the set judges the host work', async () => {
  const dir = await project();
  const set = path.join(dir, 'sets', 'h');
  await fs.mkdir(path.join(set, 'fixtures', 'start'), { recursive: true });
  await fs.writeFile(path.join(set, 'fixtures', 'start', 'seed.txt'), 'seed');
  await fs.writeFile(path.join(set, 'check.mjs'), "import fs from 'node:fs';\nprocess.exit(fs.existsSync('seed.txt') && fs.existsSync('out.txt') ? 0 : 1);\n");
  await fs.writeFile(path.join(set, 'set.json'), JSON.stringify({
    set: 'h', split: 'tune',
    tasks: [{ id: 't1', title: 'one', prompt: 'PASS this one', check: ['node', '{setDir}/check.mjs'], setup: '{setDir}/fixtures/start' }],
  }));
  const r = spawnSync(process.execPath, [runner, '--dir', dir, '--set', 'sets/h/set.json', '--variants-file', 'variants.json', '--repeats', '1', '--budget-usd', '5', '--yes', '--variants', 'A'], { encoding: 'utf-8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  const rows = await stored(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].passed, true, 'the workspace had the seed from the set folder, and the host wrote the file the hidden check wants');
  await fs.access(path.join(dir, 'eval-work', 'h', 'A', 't1', '1', 'seed.txt'));
});
