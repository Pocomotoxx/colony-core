import { AgentRole } from '../types.js';

export interface RouteDecision {
  targetRole: AgentRole;
  confidence: number;
  reasoning: string;
  matchedKeywords: string[];
  /** What the learned word weights added to the winning role's score (0 when nothing was learned). */
  learnedAdjustment: number;
}

export interface RoutingRule {
  role: AgentRole;
  keywords: string[];
  patterns: RegExp[];
  baseWeight: number;
}

export interface RouterState {
  /** word -> role -> weight */
  weights: Record<string, Partial<Record<AgentRole, number>>>;
  routed: Partial<Record<AgentRole, number>>;
  outcomes: number;
  rewardSum: number;
}

export interface RouterLoad {
  totalRouted: number;
  counts: Partial<Record<AgentRole, number>>;
  utilization: Partial<Record<AgentRole, number>>;
  /** 0 = perfectly even over the roles, towards 1 = everything goes to one role. */
  gini: number;
}

export interface RouterLearningOptions {
  /** Step size of one outcome. Default 0.3. */
  learningRate?: number;
  /** Largest absolute weight of one word for one role. Default 1.5. */
  maxWeight?: number;
  /** Most distinct words kept; new words are ignored beyond it. Default 5000. */
  maxWords?: number;
}

const MAX_TOKENS_PER_TEXT = 64;

/** Unique lowercase words of 3+ letters/digits (any script), at most 64. */
export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return Array.from(new Set(words)).slice(0, MAX_TOKENS_PER_TEXT);
}

/**
 * Mixture of Experts (MoE) Task Router
 * Dynamically classifies input tasks and selects the best specialist agent.
 *
 * Keyword and pattern rules give the base score. On top of that the router learns from outcomes:
 * every `recordOutcome` nudges the weight of each word of the task towards or away from the role
 * that handled it. This replaces the legacy gating network, which needed a 384-dimension
 * embedding model and random initial weights; the update here is a plain, deterministic sum.
 *
 * What it learns from is what the host reports (a task done or failed, or a role the host taught),
 * not a verified judgement of quality.
 */
export class MoERouter {
  private rules: RoutingRule[] = [
    {
      role: 'security',
      keywords: ['vulnerability', 'cve', 'security', 'auth', 'sanitize', 'injection', 'permission', 'token', 'exploit'],
      patterns: [/secur(e|ity)/i, /vulnerab/i, /cve-\d+/i, /auth(enticat|oriz)/i],
      baseWeight: 1.2, // Higher sensitivity for security topics
    },
    {
      role: 'architect',
      keywords: ['architecture', 'design', 'spec', 'ddd', 'pattern', 'structure', 'boundary', 'modular', 'system'],
      patterns: [/architect/i, /system design/i, /spec(ification)?/i, /interfac(e|es)/i],
      baseWeight: 1.0,
    },
    {
      role: 'tester',
      keywords: ['test', 'qa', 'e2e', 'unit test', 'coverage', 'benchmark', 'assert', 'mock', 'fuzz'],
      patterns: [/test(ing|s)?/i, /qa/i, /benchmark/i, /assert/i],
      baseWeight: 1.0,
    },
    {
      role: 'reviewer',
      keywords: ['review', 'audit', 'evaluate', 'inspect', 'lint', 'pr', 'code review', 'check'],
      patterns: [/review/i, /audit/i, /inspect/i, /code review/i],
      baseWeight: 1.0,
    },
    {
      role: 'engineer',
      keywords: ['implement', 'code', 'build', 'create', 'refactor', 'fix', 'bug', 'typescript', 'esm', 'function', 'class'],
      patterns: [/implement/i, /code/i, /build/i, /refactor/i, /develop/i],
      baseWeight: 1.0,
    },
    {
      role: 'director',
      keywords: ['plan', 'roadmap', 'milestone', 'strategy', 'goal', 'supervise', 'coordinate', 'project'],
      patterns: [/plan/i, /roadmap/i, /strategy/i, /coordinat/i],
      baseWeight: 0.9,
    },
  ];

  private weights = new Map<string, Map<AgentRole, number>>();
  private routed = new Map<AgentRole, number>();
  private learnedRoles = new Set<AgentRole>();
  private outcomes = 0;
  private rewardSum = 0;
  private readonly learningRate: number;
  private readonly maxWeight: number;
  private readonly maxWords: number;

  constructor(options: RouterLearningOptions = {}) {
    this.learningRate = options.learningRate ?? 0.3;
    this.maxWeight = options.maxWeight ?? 1.5;
    this.maxWords = options.maxWords ?? 5000;
    if (!(this.learningRate > 0) || !(this.maxWeight > 0) || !Number.isInteger(this.maxWords) || this.maxWords < 1) {
      throw new Error('router learning options must be positive');
    }
  }

  /**
   * Route a task to the most appropriate agent role.
   * `record: false` previews the decision without counting it in the load statistics.
   */
  public routeTask(taskDescription: string, options: { record?: boolean } = {}): RouteDecision {
    const text = taskDescription.toLowerCase();
    const tokens = tokenize(taskDescription);
    let bestRole: AgentRole = 'engineer'; // Default fallback
    let bestScore = 0;
    let bestLearned = 0;
    let bestMatchedKeywords: string[] = [];
    let bestReason = 'Default fallback assignment';

    for (const rule of this.candidateRules()) {
      let score = 0;
      const matchedKeywords: string[] = [];

      for (const kw of rule.keywords) {
        if (text.includes(kw)) {
          score += 1.0;
          matchedKeywords.push(kw);
        }
      }

      for (const pat of rule.patterns) {
        if (pat.test(text)) {
          score += 1.5;
        }
      }

      score *= rule.baseWeight;

      let learned = 0;
      for (const token of tokens) learned += this.weights.get(token)?.get(rule.role) ?? 0;
      score = Math.max(0, score + learned);

      if (score > bestScore) {
        bestScore = score;
        bestRole = rule.role;
        bestLearned = learned;
        bestMatchedKeywords = matchedKeywords;
        bestReason = `Matched ${matchedKeywords.length} keywords (${matchedKeywords.join(', ')}) with weight ${rule.baseWeight}`;
        if (learned !== 0) bestReason += `; learned adjustment ${learned > 0 ? '+' : ''}${learned.toFixed(2)}`;
      }
    }

    const confidence = bestScore > 0 ? Math.min(1.0, 0.4 + bestScore * 0.15) : 0.5;

    if (options.record !== false) this.routed.set(bestRole, (this.routed.get(bestRole) ?? 0) + 1);

    return {
      targetRole: bestRole,
      confidence,
      reasoning: bestScore > 0 ? bestReason : 'No strong keyword affinity detected, routing to general engineer',
      matchedKeywords: bestMatchedKeywords,
      learnedAdjustment: bestScore > 0 ? bestLearned : 0,
    };
  }

  /** The built-in rules, plus a rule-less entry for every role the router has learned about (e.g. `analyst`). */
  private candidateRules(): RoutingRule[] {
    const known = new Set(this.rules.map((r) => r.role));
    const extra: RoutingRule[] = [];
    for (const role of this.learnedRoles) {
      if (!known.has(role)) extra.push({ role, keywords: [], patterns: [], baseWeight: 1 });
    }
    return extra.length === 0 ? this.rules : [...this.rules, ...extra.sort((a, b) => (a.role < b.role ? -1 : 1))];
  }

  /**
   * Learn from an outcome: move the weight of each word of the task towards (positive reward)
   * or away from (negative) the role. `reward` is clamped to -1..1.
   */
  public recordOutcome(taskDescription: string, role: AgentRole, reward: number): void {
    if (!Number.isFinite(reward)) throw new Error('reward must be a finite number');
    const clamped = Math.max(-1, Math.min(1, reward));
    for (const token of tokenize(taskDescription)) {
      let perRole = this.weights.get(token);
      if (!perRole) {
        if (this.weights.size >= this.maxWords) continue;
        perRole = new Map();
        this.weights.set(token, perRole);
      }
      const next = (perRole.get(role) ?? 0) + this.learningRate * clamped;
      perRole.set(role, Math.max(-this.maxWeight, Math.min(this.maxWeight, next)));
      this.learnedRoles.add(role);
    }
    this.outcomes++;
    this.rewardSum += clamped;
  }

  /** How the routed tasks spread over roles. */
  public getLoadBalance(): RouterLoad {
    const total = Array.from(this.routed.values()).reduce((a, b) => a + b, 0);
    const counts: RouterLoad['counts'] = {};
    const utilization: RouterLoad['utilization'] = {};
    const roles = this.candidateRules();
    for (const rule of roles) {
      const n = this.routed.get(rule.role) ?? 0;
      counts[rule.role] = n;
      utilization[rule.role] = total === 0 ? 0 : n / total;
    }
    // Gini over the routable roles: G = (2 * sum(i * x_i) - (n + 1) * sum) / (n * sum), x sorted ascending.
    const sorted = roles.map((r) => this.routed.get(r.role) ?? 0).sort((a, b) => a - b);
    const n = sorted.length;
    const weighted = sorted.reduce((acc, x, i) => acc + (i + 1) * x, 0);
    const gini = total === 0 ? 0 : Math.max(0, (2 * weighted - (n + 1) * total) / (n * total));
    return { totalRouted: total, counts, utilization, gini };
  }

  public getStats(): { outcomes: number; averageReward: number; learnedWords: number } {
    return { outcomes: this.outcomes, averageReward: this.outcomes === 0 ? 0 : this.rewardSum / this.outcomes, learnedWords: this.weights.size };
  }

  public snapshot(): RouterState {
    const weights: RouterState['weights'] = {};
    for (const [token, perRole] of this.weights) weights[token] = Object.fromEntries(perRole);
    return { weights, routed: Object.fromEntries(this.routed), outcomes: this.outcomes, rewardSum: this.rewardSum };
  }

  public restore(state: RouterState): void {
    this.weights.clear();
    this.routed.clear();
    this.learnedRoles.clear();
    for (const [token, perRole] of Object.entries(state.weights)) {
      this.weights.set(token, new Map(Object.entries(perRole) as Array<[AgentRole, number]>));
      for (const role of Object.keys(perRole)) this.learnedRoles.add(role as AgentRole);
    }
    for (const [role, n] of Object.entries(state.routed)) this.routed.set(role as AgentRole, n as number);
    this.outcomes = state.outcomes;
    this.rewardSum = state.rewardSum;
  }
}
