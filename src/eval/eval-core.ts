/**
 * The measuring part of the eval plan (docs/EVAL-PLAN.md): a task set with an objective check per
 * task, one stored line per run, and honest statistics. It calls no model and runs nothing itself;
 * a run's result comes from a check the colony ran (`eval check`) or is reported by a runner.
 */

import { checkDestructive, checkSecrets } from '../gates.js';

export type EvalSplit = 'tune' | 'holdout';

export interface EvalTask {
  id: string;
  title: string;
  prompt: string;
  /** The check as an argument list (no shell), run in the workspace of one run. */
  check: string[];
  /** A folder (inside the project) copied fresh for every run. Informational for the runner. */
  setup?: string;
  timeoutSec?: number;
}

export interface EvalSet {
  set: string;
  split: EvalSplit;
  tasks: EvalTask[];
}

export interface EvalResult {
  set: string;
  variant: string;
  task: string;
  run: number;
  passed: boolean;
  /** `colony`: the colony ran the check. `reported`: a runner said so; the colony cannot verify it. */
  source: 'colony' | 'reported';
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** How long the run took (the host), as the runner measured it. Absent when nobody said. */
  durationMs?: number;
  /** How long the colony's own check took. Not the run's duration. */
  checkDurationMs?: number;
  turns?: number;
  at: number;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const VARIANT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TASKS = 200;

/** Parse and validate a task set. Never throws: the problems come back as a list. */
export function parseEvalSet(text: string): { set?: EvalSet; problems: string[] } {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    return { problems: [`not valid JSON: ${(err as Error).message}`] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { problems: ['the file must hold a JSON object'] };
  const o = raw as Record<string, unknown>;
  if (typeof o.set !== 'string' || !NAME.test(o.set)) problems.push('`set` must be a name of lowercase letters, digits, - and _ (at most 64 characters)');
  if (o.split !== 'tune' && o.split !== 'holdout') problems.push('`split` must be "tune" or "holdout"');
  if (!Array.isArray(o.tasks) || o.tasks.length === 0) problems.push('`tasks` must be a non-empty list');
  else if (o.tasks.length > MAX_TASKS) problems.push(`at most ${MAX_TASKS} tasks per set`);
  const tasks: EvalTask[] = [];
  const seen = new Set<string>();
  if (Array.isArray(o.tasks) && o.tasks.length <= MAX_TASKS) {
    o.tasks.forEach((t, i) => {
      const where = `tasks[${i}]`;
      if (typeof t !== 'object' || t === null || Array.isArray(t)) return void problems.push(`${where} must be an object`);
      const x = t as Record<string, unknown>;
      let ok = true;
      const bad = (msg: string) => { problems.push(`${where}: ${msg}`); ok = false; };
      if (typeof x.id !== 'string' || !TASK_ID.test(x.id)) bad('`id` must be letters, digits, . _ - (at most 64 characters)');
      else if (seen.has(x.id)) bad(`duplicate id '${x.id}'`);
      else seen.add(x.id);
      if (typeof x.title !== 'string' || !x.title.trim() || x.title.length > 200) bad('`title` must be 1–200 characters');
      if (typeof x.prompt !== 'string' || !x.prompt.trim() || x.prompt.length > 8000) bad('`prompt` must be 1–8000 characters');
      if (!Array.isArray(x.check) || x.check.length === 0 || x.check.some((a) => typeof a !== 'string' || !a || a.length > 500)) {
        bad('`check` must be a non-empty list of argument strings (no shell string)');
      } else {
        const joined = (x.check as string[]).join(' ');
        const refused = [checkDestructive(joined), checkSecrets(joined)].filter((r) => r !== null);
        if (refused.length > 0) bad(`the check is refused by the gates: ${refused.map((r) => r!.reason).join('; ')}`);
      }
      if (x.timeoutSec !== undefined && !(Number.isInteger(x.timeoutSec) && (x.timeoutSec as number) >= 1 && (x.timeoutSec as number) <= 3600)) bad('`timeoutSec` must be an integer 1–3600');
      if (x.setup !== undefined && (typeof x.setup !== 'string' || !x.setup.trim())) bad('`setup` must be a folder path');
      if (ok) {
        tasks.push({
          id: x.id as string,
          title: (x.title as string).trim(),
          prompt: x.prompt as string,
          check: x.check as string[],
          ...(x.setup !== undefined ? { setup: x.setup as string } : {}),
          ...(x.timeoutSec !== undefined ? { timeoutSec: x.timeoutSec as number } : {}),
        });
      }
    });
  }
  if (problems.length > 0) return { problems };
  return { set: { set: o.set as string, split: o.split as EvalSplit, tasks }, problems };
}

// ---- statistics

/** Standard normal cumulative distribution (Abramowitz and Stegun 7.1.26 for erf; error below 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly = ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592;
  const erf = 1 - poly * t * Math.exp(-(z * z) / 2);
  return 0.5 * (1 + (z >= 0 ? erf : -erf));
}

/** Wilson score interval for a share (95% by default). Sound for small n and for 0 or n successes. */
export function wilson(successes: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * Two-sided p of the difference of two shares, by Fisher's exact test: valid at any sample size
 * (a normal approximation calls 3 of 3 against 0 of 3 significant, which it is not). 1 when a group is empty.
 */
export function fisherExactP(s1: number, n1: number, s2: number, n2: number): number {
  if (n1 === 0 || n2 === 0) return 1;
  const total = n1 + n2;
  const successes = s1 + s2;
  const logFact = new Float64Array(total + 1);
  for (let i = 2; i <= total; i++) logFact[i] = logFact[i - 1] + Math.log(i);
  const logC = (n: number, k: number) => logFact[n] - logFact[k] - logFact[n - k];
  const denom = logC(total, successes);
  const prob = (x: number) => Math.exp(logC(n1, x) + logC(n2, successes - x) - denom);
  const observed = prob(s1);
  let p = 0;
  for (let x = Math.max(0, successes - n2); x <= Math.min(n1, successes); x++) {
    const px = prob(x);
    if (px <= observed * (1 + 1e-7)) p += px;
  }
  return Math.min(1, p);
}

export interface VariantSummary {
  variant: string;
  runs: number;
  passed: number;
  rate: number | null;
  ci95: { lo: number; hi: number } | null;
  tasks: number;
  cost: { samples: number; meanUsd: number | null; totalUsd: number };
  meanTurns: number | null;
}

const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

export function summarize(results: EvalResult[], variant: string): VariantSummary {
  const mine = results.filter((r) => r.variant === variant);
  const passed = mine.filter((r) => r.passed).length;
  const costs = mine.map((r) => r.costUsd).filter((c): c is number => c !== undefined);
  const turns = mine.map((r) => r.turns).filter((t): t is number => t !== undefined);
  return {
    variant,
    runs: mine.length,
    passed,
    rate: mine.length === 0 ? null : passed / mine.length,
    ci95: mine.length === 0 ? null : wilson(passed, mine.length),
    tasks: new Set(mine.map((r) => r.task)).size,
    cost: { samples: costs.length, meanUsd: mean(costs), totalUsd: costs.reduce((a, b) => a + b, 0) },
    meanTurns: mean(turns),
  };
}

export type Verdict = 'too-few-runs' | 'within-noise' | 'a-higher' | 'b-higher';

export interface Comparison {
  a: VariantSummary;
  b: VariantSummary;
  minRuns: number;
  p: number | null;
  verdict: Verdict;
  statement: string;
  caveats: string[];
}

/**
 * Compare two variants. It names a winner only when both have at least `minRuns` runs AND the
 * difference is beyond noise (p < 0.05). The test treats runs as independent; repeated runs on the
 * same tasks are correlated, so the p value is optimistic, and the caveats say so.
 */
export function compareVariants(results: EvalResult[], a: string, b: string, minRuns: number): Comparison {
  const sa = summarize(results, a);
  const sb = summarize(results, b);
  const caveats = [
    'Runs are treated as independent, but repeated runs on the same tasks are correlated: the p value is optimistic.',
    'The result holds for this host and model, and for this task set only.',
  ];
  if (sa.runs < minRuns || sb.runs < minRuns) {
    return { a: sa, b: sb, minRuns, p: null, verdict: 'too-few-runs', statement: `no claim: needs at least ${minRuns} runs per variant (has ${sa.runs} and ${sb.runs})`, caveats };
  }
  const p = fisherExactP(sa.passed, sa.runs, sb.passed, sb.runs);
  if (p >= 0.05) return { a: sa, b: sb, minRuns, p, verdict: 'within-noise', statement: 'no claim: the difference is within noise', caveats };
  const aHigher = sa.passed / sa.runs > sb.passed / sb.runs;
  return {
    a: sa, b: sb, minRuns, p,
    verdict: aHigher ? 'a-higher' : 'b-higher',
    statement: `${aHigher ? a : b} passes more often than ${aHigher ? b : a} on this set (p ${p < 0.001 ? '< 0.001' : p.toFixed(3)})`,
    caveats,
  };
}

// ---- estimate

export interface Estimate {
  tasks: number;
  variants: string[];
  repeats: number;
  plannedRuns: number;
  alreadyDone: number;
  remainingRuns: number;
  costPerRunUsd: number | null;
  costSource: 'given' | 'measured' | 'unknown';
  estimatedCostUsd: number | null;
  budgetUsd: number | null;
  withinBudget: boolean | null;
  notes: string[];
}

/** Runs still needed (a (variant, task) pair with enough runs is not repeated) and what they would cost. */
export function estimateRuns(set: EvalSet, variants: string[], repeats: number, existing: EvalResult[], costPerRun: number | undefined, budgetUsd: number | undefined): Estimate {
  const planned = set.tasks.length * variants.length * repeats;
  let done = 0;
  for (const v of variants) {
    for (const t of set.tasks) {
      const have = new Set(existing.filter((r) => r.set === set.set && r.variant === v && r.task === t.id).map((r) => r.run)).size;
      done += Math.min(have, repeats);
    }
  }
  const remaining = planned - done;
  const measured = mean(existing.filter((r) => r.set === set.set && variants.includes(r.variant)).map((r) => r.costUsd).filter((c): c is number => c !== undefined));
  const cost = costPerRun ?? measured;
  const costSource: Estimate['costSource'] = costPerRun !== undefined ? 'given' : measured !== null ? 'measured' : 'unknown';
  const estimated = cost === null ? null : cost * remaining;
  const notes: string[] = [];
  if (cost === null) notes.push('No cost per run is known: pass --cost-per-run, or record a pilot run with --cost-usd first. Nothing should start without an estimate.');
  if (costSource === 'given') notes.push('The cost per run is the value you gave; it is not measured.');
  notes.push('A reliable difference of about 20 percentage points needs roughly 90 runs per variant; a smaller difference needs more. Fewer runs show only large differences.');
  return {
    tasks: set.tasks.length, variants, repeats, plannedRuns: planned, alreadyDone: done, remainingRuns: remaining,
    costPerRunUsd: cost, costSource, estimatedCostUsd: estimated,
    budgetUsd: budgetUsd ?? null,
    withinBudget: estimated === null || budgetUsd === undefined ? null : estimated <= budgetUsd,
    notes,
  };
}
