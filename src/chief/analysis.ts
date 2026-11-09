/**
 * Task analysis, decomposition and the execution plan.
 *
 * Rewritten from the Queen's `analyzeTask` (legacy `queen-coordinator`). A pure function of the
 * task and a small context the hub gathers (matching patterns, measured durations), so the same
 * input always gives the same plan. The colony only PROPOSES the plan; applying it is a separate,
 * explicit step (`plan --apply`).
 *
 * Everything numeric here is HEURISTIC: the complexity formula, the base durations and the
 * confidence formula are the legacy's hand-picked constants. They are marked as such in the
 * output. When the colony has measured durations for a role (3 or more completed tasks), the
 * estimate says so and uses them instead; note that a measured duration includes waiting time.
 *
 * Differences from the legacy code:
 * - The legacy task had a `type`; a Colony task has none, so a `kind` is inferred from the required
 *   role and the words of the task, or given by the caller.
 * - Each step names the ROLE that should do it (legacy: a "domain").
 * - The research template is longer (gather, analyze, synthesize, verify) and there is a text template
 *   (draft, write, review), as in the agent-system design.
 * - The execution strategy is derived from the dependency graph instead of being configured.
 * - Dropped: memory/CPU/network requirement guesses (the colony knows nothing about the host's machine).
 */

import type { AgentRole, ColonyTask, TaskPriority } from '../types.js';
import { HealthGroup, ROLE_GROUP } from './health.js';

export type TaskKind = 'coding' | 'testing' | 'research' | 'coordination' | 'documentation' | 'review' | 'general';
export const TASK_KINDS: readonly TaskKind[] = ['coding', 'testing', 'research', 'coordination', 'documentation', 'review', 'general'];

export type ExecutionStrategy = 'single' | 'sequential' | 'pipeline' | 'parallel' | 'fan-out-fan-in' | 'hybrid';

export interface PlannedStep {
  /** Local key, referenced by `dependsOn`. */
  key: string;
  name: string;
  description: string;
  requiredRole: AgentRole;
  dependsOn: string[];
  /** Heuristic, from the legacy templates. */
  estimatedMs: number;
}

export interface MatchedPattern {
  patternId: string;
  /** What the reasoning bank reported as the solution (shortened). */
  strategy: string;
  successScore: number;
  relevance: number;
}

export interface AnalysisContext {
  patterns?: readonly MatchedPattern[];
  /** Mean assigned-to-closed time per role and how many completed tasks it rests on. */
  measuredDurations?: Partial<Record<AgentRole, { meanMs: number; samples: number }>>;
  /** Forces the kind. */
  kind?: TaskKind;
  /** What the router would pick, used when the task names no role. */
  routerRole?: AgentRole;
}

export interface TaskAnalysis {
  heuristic: true;
  taskId: string;
  kind: TaskKind;
  /** 0..1, legacy formula. */
  complexity: number;
  estimate: { ms: number; basis: 'heuristic' | 'measured'; samples: number };
  topics: string[];
  recommendedRole: AgentRole;
  group: HealthGroup;
  steps: PlannedStep[];
  waves: string[][];
  strategy: ExecutionStrategy;
  matchedPatterns: MatchedPattern[];
  /** 0..0.95, legacy formula. Says how complete the analysis inputs were, not how likely success is. */
  confidence: number;
}

const ROLE_KIND: Partial<Record<AgentRole, TaskKind>> = {
  engineer: 'coding',
  architect: 'coding',
  tester: 'testing',
  researcher: 'research',
  analyst: 'research',
  director: 'coordination',
  writer: 'documentation',
  reviewer: 'review',
  security: 'review',
};

const KIND_WORDS: Array<[TaskKind, RegExp]> = [
  ['testing', /\b(test|tests|testing|qa|coverage|fuzz|benchmark)\b/i],
  ['review', /\b(review|audit|inspect|lint)\b/i],
  ['research', /\b(research|investigate|survey|compare|analy[sz]e|analysis)\b/i],
  ['documentation', /\b(document|documentation|readme|write up|report|article)\b/i],
  ['coordination', /\b(coordinate|plan|roadmap|schedule|organi[sz]e)\b/i],
  ['coding', /\b(implement|code|build|refactor|fix|bug|develop|add support)\b/i],
];

/** The role the task asks for decides; the words only decide when it names no role (or one with no kind of its own). */
export function inferKind(task: Pick<ColonyTask, 'requiredRole' | 'title' | 'description'>): TaskKind {
  if (task.requiredRole && ROLE_KIND[task.requiredRole]) return ROLE_KIND[task.requiredRole]!;
  const text = `${task.title} ${task.description}`;
  for (const [kind, re] of KIND_WORDS) if (re.test(text)) return kind;
  return 'general';
}

// ---- templates (steps and durations from the legacy decomposition)

type Template = Array<Omit<PlannedStep, 'description'> & { description: string }>;

function template(kind: TaskKind, fallbackRole: AgentRole): Template {
  switch (kind) {
    case 'coding':
      return [
        { key: 'design', name: 'Design & Planning', description: 'Design the solution architecture', requiredRole: 'architect', dependsOn: [], estimatedMs: 10000 },
        { key: 'implement', name: 'Implementation', description: 'Implement the designed solution', requiredRole: 'engineer', dependsOn: ['design'], estimatedMs: 30000 },
        { key: 'test', name: 'Testing', description: 'Test the implementation', requiredRole: 'tester', dependsOn: ['implement'], estimatedMs: 15000 },
      ];
    case 'testing':
      return [
        { key: 'analyze', name: 'Test Analysis', description: 'Analyze what needs to be tested', requiredRole: 'tester', dependsOn: [], estimatedMs: 5000 },
        { key: 'execute', name: 'Test Execution', description: 'Execute the tests', requiredRole: 'tester', dependsOn: ['analyze'], estimatedMs: 20000 },
      ];
    case 'research':
      return [
        { key: 'gather', name: 'Information Gathering', description: 'Gather relevant information and mark where each piece came from', requiredRole: 'researcher', dependsOn: [], estimatedMs: 15000 },
        { key: 'analyze', name: 'Analysis', description: 'Analyze what was gathered; record anything set aside as an anomaly', requiredRole: 'analyst', dependsOn: ['gather'], estimatedMs: 10000 },
        { key: 'synthesize', name: 'Synthesis', description: 'Merge the findings into one account and resolve contradictions', requiredRole: 'director', dependsOn: ['analyze'], estimatedMs: 8000 },
        { key: 'verify', name: 'Verification', description: 'Check the account against the sources', requiredRole: 'reviewer', dependsOn: ['synthesize'], estimatedMs: 8000 },
      ];
    case 'coordination':
      return [
        { key: 'plan', name: 'Planning', description: 'Create the coordination plan', requiredRole: 'director', dependsOn: [], estimatedMs: 5000 },
        { key: 'execute', name: 'Execution', description: 'Execute the coordination plan', requiredRole: 'director', dependsOn: ['plan'], estimatedMs: 10000 },
      ];
    case 'documentation':
      return [
        { key: 'draft', name: 'Outline', description: 'Outline the text for its audience', requiredRole: 'writer', dependsOn: [], estimatedMs: 6000 },
        { key: 'write', name: 'Writing', description: 'Write the text from the outline', requiredRole: 'writer', dependsOn: ['draft'], estimatedMs: 14000 },
        { key: 'review', name: 'Review', description: 'Check the text for errors and unsupported claims', requiredRole: 'reviewer', dependsOn: ['write'], estimatedMs: 8000 },
      ];
    default:
      return [{ key: 'execute', name: 'Task Execution', description: 'Carry out the task', requiredRole: fallbackRole, dependsOn: [], estimatedMs: 20000 }];
  }
}

const BASE_MS: Record<TaskKind, number> = { research: 30000, coding: 60000, testing: 30000, review: 15000, documentation: 20000, coordination: 10000, general: 30000 };
const KIND_COMPLEXITY: Record<TaskKind, number> = { coordination: 0.2, coding: 0.15, testing: 0.1, research: 0.1, review: 0.05, documentation: 0.05, general: 0.1 };
const PRIORITY_FACTOR: Record<TaskPriority, number> = { critical: 1.3, high: 1.15, normal: 1.0, low: 0.9 };

const KIND_TOPICS: Record<TaskKind, string[]> = {
  research: ['research', 'analysis', 'synthesis'],
  coding: ['coding', 'implementation', 'debugging'],
  testing: ['testing', 'validation', 'quality'],
  review: ['review', 'analysis', 'feedback'],
  documentation: ['documentation', 'writing', 'clarity'],
  coordination: ['coordination', 'planning', 'oversight'],
  general: ['general', 'execution'],
};

const TOPIC_WORDS: Array<[string, string]> = [
  ['security', 'security'],
  ['performance', 'performance'],
  ['architecture', 'architecture'],
  ['integration', 'integration'],
  ['deploy', 'deployment'],
];

/** Layers of the dependency graph: wave 0 has no dependencies, wave n depends on something in wave n-1. */
export function executionWaves(steps: readonly Pick<PlannedStep, 'key' | 'dependsOn'>[]): string[][] {
  const level = new Map<string, number>();
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const levelOf = (key: string, trail: Set<string>): number => {
    const known = level.get(key);
    if (known !== undefined) return known;
    if (trail.has(key)) throw new Error(`dependency cycle through step '${key}'`);
    const step = byKey.get(key);
    if (!step) throw new Error(`unknown step '${key}'`);
    trail.add(key);
    const l = step.dependsOn.length === 0 ? 0 : 1 + Math.max(...step.dependsOn.map((d) => levelOf(d, trail)));
    trail.delete(key);
    level.set(key, l);
    return l;
  };
  for (const s of steps) levelOf(s.key, new Set());
  const waves: string[][] = [];
  for (const s of steps) (waves[level.get(s.key)!] ??= []).push(s.key);
  return waves.map((w) => w ?? []);
}

/**
 * Name the shape of a plan. `pipeline` is a chain of three or more steps handed between three or
 * more different roles; a plain chain is `sequential`.
 */
export function strategyOf(steps: readonly PlannedStep[], waves: readonly string[][]): ExecutionStrategy {
  if (steps.length <= 1) return 'single';
  const widths = waves.map((w) => w.length);
  if (waves.length === 1) return 'parallel';
  if (widths.every((w) => w === 1)) return steps.length >= 3 && new Set(steps.map((s) => s.requiredRole)).size >= 3 ? 'pipeline' : 'sequential';
  if (steps.length >= 4 && widths[0] === 1 && widths[widths.length - 1] === 1 && widths.slice(1, -1).some((w) => w > 1)) return 'fan-out-fan-in';
  return 'hybrid';
}

function complexityOf(task: ColonyTask, kind: TaskKind, steps: readonly PlannedStep[]): number {
  let c = 0.3 + steps.length * 0.1 + steps.reduce((sum, s) => sum + s.dependsOn.length, 0) * 0.05;
  c *= PRIORITY_FACTOR[task.priority] ?? 1;
  c += KIND_COMPLEXITY[kind];
  c += Math.min((task.description?.length ?? 0) / 2000, 0.2);
  return Math.min(Math.round(c * 1000) / 1000, 1);
}

export function analyzeTask(task: ColonyTask, context: AnalysisContext = {}): TaskAnalysis {
  const kind = context.kind ?? inferKind(task);
  const recommendedRole: AgentRole = task.requiredRole ?? context.routerRole ?? 'engineer';

  // Legacy rule: short tasks and reviews are not decomposed. A subtask is not split again.
  const simple = (task.description?.length ?? 0) < 200 || kind === 'review' || task.parentId !== undefined;
  const steps: PlannedStep[] = simple ? [] : template(kind, recommendedRole).map((s) => ({ ...s }));
  const waves = executionWaves(steps);
  const complexity = complexityOf(task, kind, steps);

  const topics = new Set(KIND_TOPICS[kind]);
  const text = `${task.title} ${task.description}`.toLowerCase();
  for (const [word, topic] of TOPIC_WORDS) if (text.includes(word)) topics.add(topic);

  // Estimate: measured when there is enough of it, otherwise the legacy formula.
  const measured = context.measuredDurations?.[recommendedRole];
  const stepMs = steps.reduce((sum, s) => sum + s.estimatedMs, 0);
  const heuristicMs = Math.round(BASE_MS[kind] * (0.5 + complexity * 1.5) + stepMs * 0.5);
  const estimate =
    measured && measured.samples >= 3
      ? { ms: Math.round(measured.meanMs), basis: 'measured' as const, samples: measured.samples }
      : { ms: heuristicMs, basis: 'heuristic' as const, samples: 0 };

  const matchedPatterns = [...(context.patterns ?? [])];
  const avgPatternSuccess = matchedPatterns.length === 0 ? 0 : matchedPatterns.reduce((s, p) => s + p.successScore, 0) / matchedPatterns.length;
  const confidence = Math.min(0.5 + matchedPatterns.length * 0.1 + (1 - complexity) * 0.2 + Math.min(topics.size * 0.05, 0.15) + avgPatternSuccess * 0.1, 0.95);

  return {
    heuristic: true,
    taskId: task.id,
    kind,
    complexity,
    estimate,
    topics: [...topics],
    recommendedRole,
    group: ROLE_GROUP[recommendedRole],
    steps,
    waves,
    strategy: strategyOf(steps, waves),
    matchedPatterns,
    confidence: Math.round(confidence * 1000) / 1000,
  };
}
