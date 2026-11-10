import { MessageBus } from './message-bus.js';
import { ColonyRegistry } from './coordination/colony-registry.js';
import { ColonyTaskOrchestrator, CreateTaskOptions } from './coordination/colony-task-orchestrator.js';
import { ConsensusEngine } from './consensus/consensus-engine.js';
import { ClaimLedger } from './coordination/claim-ledger.js';
import { AuditLog, AuditAnchor } from './audit-log.js';
import { runWatch, WatchReport, WatchThresholds } from './chief/watch.js';
import { computeMemberStats } from './chief/member-stats.js';
import { rankMembers, Ranking, RankOptions } from './chief/scoring.js';
import { buildHealthReport, HealthReport, HealthThresholds } from './chief/health.js';
import { outcomeReward } from './chief/outcome.js';
import { analyzeTask, AnalysisContext, MatchedPattern, TaskAnalysis, TaskKind } from './chief/analysis.js';
import { scanText } from './injection-scan.js';
import { VectorCodex } from './memory/vector-codex.js';
import { MoERouter, RouteDecision } from './neural/moe-router.js';
import { ReasoningBank } from './neural/reasoning-bank.js';
import { AgentRole, ColonyEvent, ColonyMember, ColonyTask } from './types.js';

export interface ColonyHubConfig {
  name: string;
  maxEventHistory?: number;
  codex?: VectorCodex;
}

/**
 * ColonyHub - Unified entry point, orchestrator, and neural intelligence engine
 */
export class ColonyHub {
  public readonly name: string;
  public readonly bus: MessageBus;
  public readonly registry: ColonyRegistry;
  public readonly orchestrator: ColonyTaskOrchestrator;
  public readonly consensus: ConsensusEngine;
  public readonly claims: ClaimLedger;
  public readonly audit: AuditLog;
  public readonly codex: VectorCodex;
  public readonly router: MoERouter;
  public readonly reasoningBank: ReasoningBank;

  constructor(config: ColonyHubConfig = { name: 'Colony' }) {
    this.name = config.name;
    this.bus = new MessageBus(config.maxEventHistory || 2000);
    this.registry = new ColonyRegistry();
    this.orchestrator = new ColonyTaskOrchestrator(this.registry, this.bus);
    this.consensus = new ConsensusEngine(this.bus);
    this.claims = new ClaimLedger();
    this.audit = new AuditLog();
    this.codex = config.codex || new VectorCodex();
    this.router = new MoERouter();
    this.reasoningBank = new ReasoningBank(this.codex);

    // Wire automatic task completion learning loop
    this.bus.subscribe('task:completed', async (event: ColonyEvent<unknown>) => {
      const task = this.orchestrator.getTask((event.payload as { taskId: string }).taskId);
      if (task) await this.guardLearning('reasoning-bank', task.id, () => this.learnPattern(task));
    });
    // A later rating replaces what was learned from the unrated report.
    this.bus.subscribe('task:rated', async (event: ColonyEvent<unknown>) => {
      const payload = event.payload as { taskId: string; success: boolean };
      const task = this.orchestrator.getTask(payload.taskId);
      if (!task) return;
      await this.guardLearning('reasoning-bank', task.id, () => this.learnPattern(task));
      await this.guardLearning('outcomes', task.id, () => this.recordOutcomeMemory(task, payload.success));
    });
    this.wireRouterLearning();

    // Dispatch picks by score instead of "least busy first".
    this.orchestrator.setRanker((task, candidates) => {
      const ranking = this.rankFor(task, candidates);
      const byId = new Map(candidates.map((m) => [m.id, m]));
      return ranking.ranked.map((s) => byId.get(s.memberId)!);
    });
  }

  /**
   * Analyze a task: kind, complexity, an estimate, the steps it would split into, their waves and
   * strategy. Read-only. Uses the reasoning bank for similar past work and the colony's own
   * completed tasks for measured durations.
   */
  public async analyze(task: ColonyTask, kind?: TaskKind): Promise<TaskAnalysis> {
    const text = `${task.title} ${task.description}`;
    const recalled = await this.reasoningBank.recallPatterns(text, { topK: 5, minScore: 0.4 });
    const patterns: MatchedPattern[] = recalled.map((p) => ({ patternId: p.id, strategy: p.solution.slice(0, 160), successScore: p.successScore, relevance: Math.round((p.relevance ?? 0) * 1000) / 1000 }));

    const sums = new Map<AgentRole, { total: number; samples: number }>();
    for (const t of this.orchestrator.getAllTasks()) {
      if (t.status !== 'completed' || !t.requiredRole || t.startedAt === undefined || t.completedAt === undefined || t.completedAt < t.startedAt) continue;
      const acc = sums.get(t.requiredRole) ?? { total: 0, samples: 0 };
      acc.total += t.completedAt - t.startedAt;
      acc.samples++;
      sums.set(t.requiredRole, acc);
    }
    const measuredDurations: AnalysisContext['measuredDurations'] = {};
    for (const [role, acc] of sums) measuredDurations[role] = { meanMs: acc.total / acc.samples, samples: acc.samples };

    return analyzeTask(task, { patterns, measuredDurations, kind, routerRole: this.router.routeTask(text, { record: false }).targetRole });
  }

  /**
   * The Deputy's watch: mechanical findings over the tasks and the audit log. Read-only.
   * `anchor` is the audit head remembered at the last boot.
   */
  public watch(options: { now?: number; thresholds?: Partial<WatchThresholds>; focusTaskId?: string; anchor?: AuditAnchor } = {}): WatchReport {
    const chain = this.audit.verify();
    return runWatch({
      tasks: this.orchestrator.getAllTasks(),
      audit: this.audit.snapshot(),
      chainOk: chain.ok,
      anchorHeld: options.anchor ? this.audit.contains(options.anchor) : null,
      now: options.now ?? Date.now(),
      thresholds: options.thresholds,
      focusTaskId: options.focusTaskId,
    });
  }

  /** Health of the colony at `now`: groups, bottlenecks, alerts, recommendations. Read-only. */
  public health(now: number = Date.now(), thresholds?: Partial<HealthThresholds>): HealthReport {
    return buildHealthReport({
      members: this.registry.getAllMembers(),
      tasks: this.orchestrator.getAllTasks(),
      claims: this.claims.list(),
      proposals: this.consensus.listProposals(),
      now,
      thresholds,
    });
  }

  /** Score the members for a task. `members` defaults to everyone in the colony. */
  public rankFor(task: ColonyTask, members: ColonyMember[] = this.registry.getAllMembers(), options?: RankOptions): Ranking {
    const stats = computeMemberStats(this.registry.getAllMembers(), this.orchestrator.getAllTasks(), this.claims.list());
    return rankMembers(task, members, stats, options);
  }

  /**
   * Outcome learning for the router. A completed task counts as +0.5 because "done" is what the host
   * reported, not a verified result; a failed task counts as -1.
   */
  private wireRouterLearning(): void {
    const learn = async (taskId: string, success: boolean) => {
      const task = this.orchestrator.getTask(taskId);
      if (!task) return;
      if (task.requiredRole) this.router.recordOutcome(`${task.title} ${task.description}`, task.requiredRole, outcomeReward(success, task.quality));
      await this.guardLearning('outcomes', task.id, () => this.recordOutcomeMemory(task, success));
    };
    this.bus.subscribe('task:completed', (event: ColonyEvent<unknown>) => learn((event.payload as { taskId: string }).taskId, true));
    this.bus.subscribe('task:failed', (event: ColonyEvent<unknown>) => learn((event.payload as { taskId: string }).taskId, false));
  }

  /**
   * Keep a structured note of how a task ended in the `outcomes` namespace, failures too.
   * The free-text result and error are NOT stored here; the reasoning bank keeps a completed task's
   * result, behind the same hostile-text check.
   */
  private async recordOutcomeMemory(task: ColonyTask, success: boolean): Promise<void> {
    const text = [
      `Task: ${task.title}`,
      `Role: ${task.requiredRole ?? 'unspecified'}`,
      `Outcome: ${success ? 'completed' : 'failed'} (as reported by the host)`,
      `Reported quality: ${task.quality ?? 'not reported'}`,
      `Backed by a test run (the host's statement): ${task.verifiedByTest ? 'yes' : 'no'}`,
      `Description: ${task.description}`,
    ].join('\n');
    if (this.refuseHostile('outcomes', task.id, text)) return;
    await this.codex.storeDocuments([
      {
        id: `outcome_${task.id}`,
        text,
        namespace: 'outcomes',
        metadata: {
          taskId: task.id,
          success,
          quality: task.quality ?? null,
          verifiedByTest: Boolean(task.verifiedByTest),
          role: task.requiredRole ?? null,
          memberId: task.assignedAgentId ?? null,
          durationMs: task.startedAt !== undefined && task.completedAt !== undefined ? task.completedAt - task.startedAt : null,
        },
      },
    ]);
  }

  /**
   * Record a completed, rated result in the reasoning bank. An unrated result is not a verified
   * success: it stays out until a quality is reported. The id is stable per task, so a rating replaces it.
   */
  private async learnPattern(task: ColonyTask): Promise<void> {
    if (task.status !== 'completed' || !task.outputResult || task.quality === undefined) return;
    const problem = `${task.title}: ${task.description}`;
    const solution = typeof task.outputResult === 'string' ? task.outputResult : JSON.stringify(task.outputResult);
    // What a host reports as its result comes back later as context: hostile text is not stored.
    if (this.refuseHostile('reasoning-bank', task.id, `${problem}\n${solution}`)) return;
    await this.reasoningBank.recordPattern({
      id: `pattern_task_${task.id}`,
      problem,
      solution,
      role: task.requiredRole || 'engineer',
      successScore: task.quality,
      verified: task.verification?.passed === true,
    });
  }

  /** Run a learning step; a failure is written to the audit log instead of vanishing in the bus. */
  private async guardLearning(store: string, taskId: string, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (err) {
      const e = err as { name?: string; code?: string };
      this.audit.append({ type: 'learning.failed', aggregateId: taskId, actor: 'hub', payload: { store, error: e?.name ?? 'Error', code: e?.code ?? null } }, Date.now());
    }
  }

  /** True (and an audit entry) when `text` looks hostile; the caller then stores nothing. */
  private refuseHostile(store: string, taskId: string, text: string): boolean {
    const scan = scanText(text);
    if (scan.verdict !== 'hostile') return false;
    this.audit.append({ type: 'memory.refused', aggregateId: taskId, actor: 'hub', payload: { store, verdict: scan.verdict, threats: scan.threats.map((t) => t.type) } }, Date.now());
    return true;
  }

  /**
   * Submit a task with automatic Neural MoE Routing if requiredRole is not explicitly provided
   */
  public async submitAdaptiveTask(options: CreateTaskOptions): Promise<{
    task: ColonyTask;
    routeDecision?: RouteDecision;
  }> {
    let routeDecision: RouteDecision | undefined;
    const taskOptions = { ...options }; // the caller's object is not changed

    if (!taskOptions.requiredRole) {
      routeDecision = this.router.routeTask(`${taskOptions.title} ${taskOptions.description}`);
      taskOptions.requiredRole = routeDecision.targetRole;
    }

    const task = await this.orchestrator.createTask(taskOptions);
    return { task, routeDecision };
  }

  /**
   * Get an aggregated status snapshot of the colony
   */
  public getSnapshot(): {
    name: string;
    totalMembers: number;
    idleMembers: number;
    busyMembers: number;
    totalTasks: number;
    pendingTasks: number;
    activeTasks: number;
    completedTasks: number;
  } {
    const members = this.registry.getAllMembers();
    const tasks = this.orchestrator.getAllTasks();

    return {
      name: this.name,
      totalMembers: members.length,
      idleMembers: members.filter((m: ColonyMember) => m.status === 'idle').length,
      busyMembers: members.filter((m: ColonyMember) => m.status === 'busy').length,
      totalTasks: tasks.length,
      pendingTasks: tasks.filter((t: ColonyTask) => t.status === 'pending').length,
      activeTasks: tasks.filter((t: ColonyTask) => t.status === 'assigned' || t.status === 'in_progress').length,
      completedTasks: tasks.filter((t: ColonyTask) => t.status === 'completed').length,
    };
  }
}
