import fs from 'node:fs/promises';
import path from 'node:path';
import { compareVariants, estimateRuns, EvalResult, EvalSet, parseEvalSet, summarize, VARIANT_NAME } from '../eval/eval-core.js';
import { resolveInside, SafePathError } from '../safe-path.js';
import { runVerification, VerifyError } from '../verify/run.js';
import { CliError, CommandContext, CommandResult, Handler } from './context.js';
import { STATE_DIR } from './session.js';

const stateDirOf = (dir: string): string => path.join(dir, STATE_DIR);

// Commands: eval

export const evalHandlers: Record<string, Handler> = {};

const EVAL_DIR = 'eval';
const RESULTS_FILE = 'results.jsonl';
const MAX_SET_BYTES = 1_000_000;
const DEFAULT_MIN_RUNS = 20;

const USAGE_LINE =
  'usage: eval validate --set <file> | eval estimate --set <file> --variants A,B --repeats N [--cost-per-run USD] [--budget-usd USD] | ' +
  'eval check --set <file> --variant V --task T --run N --workspace <dir> | ' +
  'eval record --set <file> --variant V --task T --run N (--passed|--failed) [--cost-usd X] [--input-tokens N] [--output-tokens N] [--duration-ms N] [--turns N] | ' +
  'eval compare --set <file> --variants A,B [--min-runs N] [--include-reported] | eval report --set <file>';

async function inside(dir: string, input: string, label: string): Promise<string> {
  try {
    return (await resolveInside(dir, input)).resolved;
  } catch (err) {
    if (err instanceof SafePathError) throw new CliError(err.code === 'OUTSIDE' ? `${label} must be inside the project directory` : `${label}: ${err.message}`);
    throw err;
  }
}

async function loadSet(dir: string, file: string | undefined): Promise<EvalSet> {
  if (!file) throw new CliError('--set <file> is required');
  const abs = await inside(dir, file, '--set');
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat?.isFile()) throw new CliError(`task set '${file}' not found`);
  if (stat.size > MAX_SET_BYTES) throw new CliError('the task set is larger than 1 MB');
  const parsed = parseEvalSet(await fs.readFile(abs, 'utf-8'));
  if (!parsed.set) throw new CliError(`the task set is invalid:\n- ${parsed.problems.join('\n- ')}`);
  return parsed.set;
}

async function readResults(stateDir: string): Promise<{ results: EvalResult[]; skipped: number }> {
  const text = await fs.readFile(path.join(stateDir, EVAL_DIR, RESULTS_FILE), 'utf-8').catch(() => '');
  const results: EvalResult[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as EvalResult;
      if (typeof r.set === 'string' && typeof r.variant === 'string' && typeof r.task === 'string' && typeof r.passed === 'boolean') results.push(r);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { results, skipped };
}

function intOpt(value: string | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new CliError(`${name} must be an integer ${min}–${max}`);
  return n;
}

function numOpt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new CliError(`${name} must be a number >= 0`);
  return n;
}

function variantList(value: string | undefined): string[] {
  const list = (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (list.length === 0) throw new CliError('--variants A,B is required');
  if (new Set(list).size !== list.length) throw new CliError('--variants has a name twice');
  for (const v of list) if (!VARIANT_NAME.test(v)) throw new CliError(`variant name '${v}' is not valid (letters, digits, . _ -, at most 64 characters)`);
  return list;
}

/** Store one run. One (set, variant, task, run) is stored once; a second try is refused. */
async function storeResult(ctx: CommandContext, set: EvalSet, result: EvalResult): Promise<void> {
  const { session, log } = ctx;
  const { results } = await readResults(stateDirOf(ctx.dir));
  if (results.some((r) => r.set === result.set && r.variant === result.variant && r.task === result.task && r.run === result.run)) {
    throw new CliError(`run ${result.run} of task '${result.task}' for variant '${result.variant}' is already recorded`);
  }
  const dir = path.join(stateDirOf(ctx.dir), EVAL_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, RESULTS_FILE), JSON.stringify(result) + '\n', 'utf-8');
  log('eval.recorded', `${set.set}:${result.variant}:${result.task}:${result.run}`, { set: set.set, variant: result.variant, task: result.task, run: result.run, passed: result.passed, source: result.source });
  await session.save();
}

function requireRunTarget(ctx: CommandContext, set: EvalSet) {
  const { values } = ctx;
  const variant = values.variant;
  if (!variant || !VARIANT_NAME.test(variant)) throw new CliError('--variant <name> is required (letters, digits, . _ -)');
  const task = set.tasks.find((t) => t.id === values.task);
  if (!task) throw new CliError(`task '${values.task ?? ''}' is not in the set '${set.set}'`);
  const run = intOpt(values.run, '--run', 1, 10_000);
  if (run === undefined) throw new CliError('--run <number> is required');
  return { variant, task, run };
}

async function handle_eval(ctx: CommandContext): Promise<CommandResult> {
  const { values, sub, dir, warnings, reply } = ctx;
  if (!sub) throw new CliError(USAGE_LINE);

  if (sub === 'validate') {
    const set = await loadSet(dir, values.set);
    return reply({ valid: true, set: set.set, split: set.split, tasks: set.tasks.length });
  }

  if (sub === 'estimate') {
    const set = await loadSet(dir, values.set);
    const variants = variantList(values.variants);
    const repeats = intOpt(values.repeats, '--repeats', 1, 100);
    if (repeats === undefined) throw new CliError('--repeats <N> is required');
    const { results } = await readResults(stateDirOf(dir));
    const estimate = estimateRuns(set, variants, repeats, results, numOpt(values['cost-per-run'], '--cost-per-run'), numOpt(values['budget-usd'], '--budget-usd'));
    if (estimate.withinBudget === false) warnings.push(`the estimate (${estimate.estimatedCostUsd!.toFixed(2)} USD) is over the budget (${estimate.budgetUsd} USD): do not start`);
    return reply({ estimate });
  }

  if (sub === 'check') {
    const set = await loadSet(dir, values.set);
    const { variant, task, run } = requireRunTarget(ctx, set);
    if (!values.workspace) throw new CliError('--workspace <dir> is required: the folder where the run left its work');
    const workspace = await inside(dir, values.workspace, '--workspace');
    if (!(await fs.stat(workspace).catch(() => null))?.isDirectory()) throw new CliError(`workspace '${values.workspace}' is not a folder`);
    let run_;
    try {
      run_ = await runVerification(task.check, workspace, (task.timeoutSec ?? 120) * 1000);
    } catch (err) {
      if (err instanceof VerifyError) throw new CliError(err.message);
      throw err;
    }
    const result: EvalResult = {
      set: set.set, variant, task: task.id, run, passed: run_.passed, source: 'colony',
      checkDurationMs: run_.durationMs, at: Date.now(),
      ...(intOpt(values['duration-ms'], '--duration-ms', 0, 1e9) !== undefined ? { durationMs: intOpt(values['duration-ms'], '--duration-ms', 0, 1e9) } : {}),
      ...(numOpt(values['cost-usd'], '--cost-usd') !== undefined ? { costUsd: numOpt(values['cost-usd'], '--cost-usd') } : {}),
      ...(intOpt(values['input-tokens'], '--input-tokens', 0, 1e9) !== undefined ? { inputTokens: intOpt(values['input-tokens'], '--input-tokens', 0, 1e9) } : {}),
      ...(intOpt(values['output-tokens'], '--output-tokens', 0, 1e9) !== undefined ? { outputTokens: intOpt(values['output-tokens'], '--output-tokens', 0, 1e9) } : {}),
      ...(intOpt(values.turns, '--turns', 0, 10_000) !== undefined ? { turns: intOpt(values.turns, '--turns', 0, 10_000) } : {}),
    };
    await storeResult(ctx, set, result);
    return reply({ result: { ...result, timedOut: run_.timedOut, exitCode: run_.exitCode } });
  }

  if (sub === 'record') {
    const set = await loadSet(dir, values.set);
    const { variant, task, run } = requireRunTarget(ctx, set);
    if (Boolean(values.passed) === Boolean(values.failed)) throw new CliError('pass exactly one of --passed or --failed');
    const costUsd = numOpt(values['cost-usd'], '--cost-usd');
    const inputTokens = intOpt(values['input-tokens'], '--input-tokens', 0, 1e9);
    const outputTokens = intOpt(values['output-tokens'], '--output-tokens', 0, 1e9);
    const durationMs = intOpt(values['duration-ms'], '--duration-ms', 0, 1e9);
    const turns = intOpt(values.turns, '--turns', 0, 10_000);
    const result: EvalResult = {
      set: set.set, variant, task: task.id, run, passed: Boolean(values.passed), source: 'reported', at: Date.now(),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(turns !== undefined ? { turns } : {}),
    };
    await storeResult(ctx, set, result);
    warnings.push('recorded as `reported`: the colony did not run the check, so a comparison leaves it out unless --include-reported is given');
    return reply({ result });
  }

  if (sub === 'compare') {
    const set = await loadSet(dir, values.set);
    const variants = variantList(values.variants);
    if (variants.length !== 2) throw new CliError('--variants needs exactly two names to compare');
    const minRuns = intOpt(values['min-runs'], '--min-runs', 1, 100_000) ?? DEFAULT_MIN_RUNS;
    const { results, skipped } = await readResults(stateDirOf(dir));
    if (skipped > 0) warnings.push(`${skipped} line(s) of the results file could not be read and were left out`);
    const forSet = results.filter((r) => r.set === set.set);
    const used = values['include-reported'] ? forSet : forSet.filter((r) => r.source === 'colony');
    const reportedLeftOut = forSet.length - used.length;
    if (reportedLeftOut > 0) warnings.push(`${reportedLeftOut} reported run(s) left out; add --include-reported to count them`);
    const comparison = compareVariants(used, variants[0], variants[1], minRuns);
    return reply({ set: set.set, split: set.split, countedSources: values['include-reported'] ? ['colony', 'reported'] : ['colony'], comparison });
  }

  if (sub === 'report') {
    const set = await loadSet(dir, values.set);
    const { results, skipped } = await readResults(stateDirOf(dir));
    if (skipped > 0) warnings.push(`${skipped} line(s) of the results file could not be read and were left out`);
    const forSet = results.filter((r) => r.set === set.set);
    const names = [...new Set(forSet.map((r) => r.variant))].sort();
    return reply({
      set: set.set,
      split: set.split,
      tasks: set.tasks.length,
      runs: forSet.length,
      bySource: { colony: forSet.filter((r) => r.source === 'colony').length, reported: forSet.filter((r) => r.source === 'reported').length },
      variants: names.map((v) => summarize(forSet.filter((r) => r.source === 'colony'), v)),
      note: 'Only runs the colony checked itself are summarised. Use `eval compare` to compare two variants; it names a winner only beyond noise and with enough runs.',
    });
  }

  throw new CliError(USAGE_LINE);
}

evalHandlers['eval'] = handle_eval;
