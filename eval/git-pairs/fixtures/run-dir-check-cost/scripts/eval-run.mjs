#!/usr/bin/env node
// Run an eval: for every task, variant and repeat, start the host (an agent command from a variants file) in a
// fresh workspace, then let the colony run the task's check and record the result.   See docs/EVAL-PLAN.md.
//
//   node scripts/eval-run.mjs --dir <project> --set <task set> --variants-file <file> --repeats N --dry-run
//   node scripts/eval-run.mjs --dir <project> --set <task set> --variants-file <file> --repeats N --budget-usd X --yes
//
// This script starts an agent, which costs money and can change files in the workspace it is given, so:
//   - nothing starts without --yes, and a real run needs --budget-usd (it stops when the reported cost reaches it);
//   - if the host does not report a cost, it stops after the first run (the budget cannot be enforced), unless --max-runs is given;
//   - the host runs in <work-dir>/<set>/<variant>/<task>/<run>, a fresh copy of the task's `setup` folder, never in the project itself;
//   - the pass or fail comes from `colony eval check` (the colony runs the check), not from the host's own claim.
//
// The variants file:  { "variants": { "A": { "command": ["claude", "-p", "--output-format", "json", "--max-turns", "15"], "promptVia": "stdin" } } }
// `promptVia` is "stdin" (default) or "arg" (the prompt is added as the last argument). Whether a given host reports
// cost, turns and tokens in its JSON output is not assumed: the script reads the common field names if they are there.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'cli.js');

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

// ---- arguments

const FLAGS = new Set(['yes', 'dry-run']);
const VALUES = new Set(['dir', 'set', 'variants-file', 'variants', 'repeats', 'budget-usd', 'work-dir', 'max-runs', 'host-timeout-sec']);
const opts = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) fail(`unexpected argument '${a}'`);
    const name = a.slice(2);
    if (FLAGS.has(name)) opts[name] = true;
    else if (VALUES.has(name)) {
      if (i + 1 >= argv.length) fail(`--${name} needs a value`);
      opts[name] = argv[++i];
    } else fail(`unknown option '${a}'`);
  }
}

const USAGE = 'usage: node scripts/eval-run.mjs --dir <project> --set <task set file> --variants-file <file> --repeats N [--variants A,B] [--budget-usd X --yes | --dry-run] [--max-runs N] [--work-dir <dir>] [--host-timeout-sec N]';
for (const required of ['dir', 'set', 'variants-file', 'repeats']) if (!opts[required]) fail(`--${required} is required\n${USAGE}`);

const project = resolve(opts.dir);
if (project === resolve(root)) fail('--dir is the colony-core folder itself: give the PROJECT folder (its state goes to <project>/.colony).');
if (!existsSync(project) || !statSync(project).isDirectory()) fail(`the project folder does not exist: ${project}`);
if (!existsSync(cli)) fail('dist/cli.js is missing: run `pnpm install && pnpm build` first.', 1);

const intOf = (value, name, min, max) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be an integer ${min}-${max}`);
  return n;
};
const repeats = intOf(opts.repeats, 'repeats', 1, 100);
const hostTimeoutMs = intOf(opts['host-timeout-sec'] ?? '600', 'host-timeout-sec', 1, 7200) * 1000;
const maxRuns = opts['max-runs'] === undefined ? Infinity : intOf(opts['max-runs'], 'max-runs', 1, 100000);
const dryRun = Boolean(opts['dry-run']);
let budget = null;
if (opts['budget-usd'] !== undefined) {
  budget = Number(opts['budget-usd']);
  if (!Number.isFinite(budget) || budget <= 0) fail('--budget-usd must be a number greater than 0');
}
if (!dryRun) {
  if (!opts.yes) fail('this starts an agent (it costs money and changes files in its workspace). Look at --dry-run first, then add --yes to run.');
  if (budget === null) fail('a real run needs --budget-usd: the run stops when the reported cost reaches it.');
}

function insideProject(input, label) {
  const abs = isAbsolute(input) ? resolve(input) : resolve(project, input);
  const rel = relative(project, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) fail(`${label} must be inside the project folder`);
  return abs;
}

const readJson = (file, label) => {
  try {
    const text = readFileSync(file, 'utf-8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    return fail(`${label}: ${err.message}`);
  }
};

// ---- the task set (the colony validates it) and the variants

const setPath = insideProject(opts.set, '--set');
const validation = spawnSync(process.execPath, [cli, 'eval', 'validate', '--set', setPath, '--dir', project], { encoding: 'utf-8' });
if (validation.status !== 0) fail(`the task set is not valid:\n${validation.stdout || validation.stderr}`, 1);
const taskSet = readJson(setPath, '--set');

const variantsPath = insideProject(opts['variants-file'], '--variants-file');
const variantDefs = readJson(variantsPath, '--variants-file').variants;
if (!variantDefs || typeof variantDefs !== 'object') fail('--variants-file needs a "variants" object');
const names = (opts.variants ? opts.variants.split(',').map((v) => v.trim()).filter(Boolean) : Object.keys(variantDefs));
if (names.length === 0) fail('no variants to run');
for (const name of names) {
  const def = variantDefs[name];
  if (!def) fail(`variant '${name}' is not in the variants file`);
  if (!Array.isArray(def.command) || def.command.length === 0 || def.command.some((c) => typeof c !== 'string' || !c)) fail(`variant '${name}': "command" must be a non-empty list of strings`);
  if (def.promptVia !== undefined && def.promptVia !== 'stdin' && def.promptVia !== 'arg') fail(`variant '${name}': "promptVia" must be "stdin" or "arg"`);
}

const workRoot = insideProject(opts['work-dir'] ?? 'eval-work', '--work-dir');
if (relative(project, workRoot).split(/[\\/]/)[0] === '.colony') fail('--work-dir must not be inside .colony: the host guard protects that folder.');

// ---- what is still to run

const resultsFile = join(project, '.colony', 'eval', 'results.jsonl');
const done = new Set();
if (existsSync(resultsFile)) {
  for (const line of readFileSync(resultsFile, 'utf-8').split('\n')) {
    try {
      const r = JSON.parse(line);
      if (r.set === taskSet.set) done.add(`${r.variant}\u0000${r.task}\u0000${r.run}`);
    } catch { /* a damaged line is the colony's to report */ }
  }
}

// run-major order, so that a run stopped early still has the variants balanced
const queue = [];
for (let run = 1; run <= repeats; run++) {
  for (const task of taskSet.tasks) {
    for (const variant of names) {
      if (!done.has(`${variant}\u0000${task.id}\u0000${run}`)) queue.push({ variant, task, run });
    }
  }
}
const planned = Math.min(queue.length, maxRuns);

const plan = {
  set: taskSet.set, variants: names, repeats, tasks: taskSet.tasks.length,
  alreadyDone: names.length * taskSet.tasks.length * repeats - queue.length,
  toRun: planned, budgetUsd: budget, hostTimeoutSec: hostTimeoutMs / 1000, workDir: workRoot,
};
// A dry run prints the plan as its result; a real run prints it to stderr so that stdout is one JSON: the summary.
(dryRun ? console.log : console.error)(JSON.stringify({ plan }, null, 2));
if (dryRun) {
  console.error('dry run: nothing was started.');
  process.exit(0);
}
if (planned === 0) {
  console.error('nothing left to run.');
  process.exit(0);
}

// ---- running the host

const WIN = process.platform === 'win32';
const PLAIN_ARG = /^[A-Za-z0-9@._/:=+\\-]+$/;

function killTree(child) {
  if (!child.pid) return;
  if (WIN) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGKILL');
}

function startHost(command, cwd) {
  const [tool, ...args] = command;
  const options = { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
  return new Promise((resolveStart) => {
    const first = spawn(tool, args, options);
    first.once('error', (err) => {
      // On Windows a command installed as a .cmd file needs cmd.exe; only plain arguments may go through it.
      if (WIN && err.code === 'ENOENT' && command.every((c) => PLAIN_ARG.test(c))) {
        resolveStart(spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command.join(' ')], options));
      } else resolveStart({ failed: err });
    });
    first.once('spawn', () => resolveStart(first));
  });
}

async function runHost(def, prompt, cwd) {
  const command = def.promptVia === 'arg' ? [...def.command, prompt] : def.command;
  const child = await startHost(command, cwd);
  if (child.failed) return { ok: false, error: `could not start '${def.command[0]}': ${child.failed.message}`, stdout: '', timedOut: false };
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { if (stdout.length < 4_000_000) stdout += d.toString('utf-8'); });
  child.stderr.on('data', (d) => { if (stderr.length < 100_000) stderr += d.toString('utf-8'); });
  child.stdin.on('error', () => undefined);
  if (def.promptVia === 'arg') child.stdin.end();
  else child.stdin.end(prompt);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, hostTimeoutMs);
  const code = await new Promise((resolveExit) => child.once('close', resolveExit));
  clearTimeout(timer);
  return { ok: code === 0 && !timedOut, code, stdout, stderr: stderr.slice(-500), timedOut };
}

/** The numbers a host's JSON output reports, if it reports any. Nothing is assumed to be there. */
function readReport(stdout) {
  let obj = null;
  const text = stdout.trim();
  try {
    obj = JSON.parse(text);
  } catch {
    for (const line of text.split('\n').reverse()) {
      try { obj = JSON.parse(line); break; } catch { /* not a JSON line */ }
    }
  }
  if (!obj || typeof obj !== 'object') return { keys: [] };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  return {
    keys: Object.keys(obj),
    costUsd: num(obj.total_cost_usd) ?? num(obj.cost_usd),
    turns: num(obj.num_turns),
    inputTokens: num(obj.usage?.input_tokens),
    outputTokens: num(obj.usage?.output_tokens),
  };
}

let spent = 0;
let started = 0;
let stopped = null;
const outcomes = [];

for (const item of queue.slice(0, planned)) {
  if (budget !== null && spent >= budget) { stopped = `the budget (${budget} USD) is reached`; break; }
  const { variant, task, run } = item;
  const workspace = join(workRoot, taskSet.set, variant, task.id, String(run));
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  if (task.setup) {
    const source = insideProject(task.setup, `the setup of task '${task.id}'`);
    if (!existsSync(source)) fail(`the setup folder of task '${task.id}' does not exist: ${task.setup}`, 1);
    cpSync(source, workspace, { recursive: true });
  }

  started++;
  const host = await runHost(variantDefs[variant], task.prompt, workspace);
  const report = readReport(host.stdout);
  if (started === 1) console.error(`the host's JSON output has these fields: ${report.keys.length ? report.keys.join(', ') : '(none: it is not JSON)'}`);
  if (report.costUsd !== undefined) spent += report.costUsd;

  const args = [cli, 'eval', 'check', '--set', setPath, '--variant', variant, '--task', task.id, '--run', String(run), '--workspace', workspace, '--dir', project];
  if (report.costUsd !== undefined) args.push('--cost-usd', String(report.costUsd));
  if (report.turns !== undefined) args.push('--turns', String(report.turns));
  if (report.inputTokens !== undefined) args.push('--input-tokens', String(report.inputTokens));
  if (report.outputTokens !== undefined) args.push('--output-tokens', String(report.outputTokens));
  const check = spawnSync(process.execPath, args, { encoding: 'utf-8' });
  let passed = null;
  try { passed = JSON.parse(check.stdout).result.passed; } catch { /* reported below */ }
  outcomes.push({ variant, task: task.id, run, hostOk: host.ok, timedOut: host.timedOut, passed, costUsd: report.costUsd ?? null, error: host.error ?? (check.status !== 0 ? (check.stdout || check.stderr).slice(0, 300) : null) });
  console.error(`[${started}/${planned}] ${variant} ${task.id} run ${run}: ${passed === null ? 'not recorded' : passed ? 'passed' : 'failed'}${host.timedOut ? ' (host timed out)' : ''}${report.costUsd !== undefined ? ` cost ${report.costUsd}` : ''}`);

  if (budget !== null && report.costUsd === undefined && !Number.isFinite(maxRuns)) {
    stopped = 'the host did not report a cost, so the budget cannot be enforced: rerun with --max-runs to limit the number of runs';
    break;
  }
}

console.log(JSON.stringify({ started, spentUsd: spent, budgetUsd: budget, stopped, outcomes }, null, 2));
process.exit(stopped && started === 0 ? 1 : 0);
