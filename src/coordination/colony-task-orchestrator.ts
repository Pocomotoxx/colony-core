import { ColonyMember, ColonyTask, ReviewRecord, TaskPriority, AgentRole, TaskVerification } from '../types.js';
import { MAX_KEPT_REVIEWS, maxRoundsOf, REVIEW_LIMIT_HOLDER, reviewBlocksCompletion, validateMaxRounds } from '../chief/review.js';
import { ColonyRegistry } from './colony-registry.js';
import { checkResultSize, OutcomeReport, validateQuality } from '../chief/outcome.js';
import { MessageBus } from '../message-bus.js';

export interface CreateTaskOptions {
  title: string;
  description: string;
  priority?: TaskPriority;
  requiredRole?: AgentRole;
  requiredCapabilities?: string[];
  dependencies?: string[];
  inputData?: Record<string, unknown>;
  consensusRequired?: boolean;
  minConsensusQuorum?: number;
  /** Set when the task is a part of a split task. */
  parentId?: string;
  /** The task cannot be completed before a reviewer approves it. */
  reviewRequired?: boolean;
  /** Rejections after which the task goes on hold for the user. Default 3. */
  maxReviewRounds?: number;
}

/** One part of a split: a local key, the keys it waits for, and the task to create. */
export interface SplitPart {
  key: string;
  dependsOn: string[];
  options: CreateTaskOptions;
}

/**
 * Orchestrator responsible for managing, scheduling, and delegating Colony tasks
 */
/** A failed colony check lowers a reported quality to at most this. */
export const VERIFY_FAIL_QUALITY_CAP = 0.3;

/** The states in which a task is being worked on: only these can be progressed, completed, failed or reassigned. */
const OPEN: readonly string[] = ['assigned', 'in_progress', 'review', 'consensus'];

export class ColonyTaskOrchestrator {
  private tasks = new Map<string, ColonyTask>();
  private registry: ColonyRegistry;
  private messageBus: MessageBus;
  /** Orders the eligible candidates, best first. Without one, the least busy member goes first. */
  private ranker?: (task: ColonyTask, candidates: ColonyMember[]) => ColonyMember[];

  constructor(registry: ColonyRegistry, messageBus: MessageBus) {
    this.registry = registry;
    this.messageBus = messageBus;
  }

  public setRanker(ranker: ((task: ColonyTask, candidates: ColonyMember[]) => ColonyMember[]) | undefined): void {
    this.ranker = ranker;
  }

  public async createTask(options: CreateTaskOptions): Promise<ColonyTask> {
    const id = `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const task: ColonyTask = {
      id,
      title: options.title,
      description: options.description,
      priority: options.priority || 'normal',
      status: 'pending',
      requiredRole: options.requiredRole,
      requiredCapabilities: options.requiredCapabilities || [],
      dependencies: options.dependencies || [],
      inputData: options.inputData || {},
      consensusRequired: options.consensusRequired ?? false,
      minConsensusQuorum: options.minConsensusQuorum ?? 2,
      createdAt: Date.now(),
    };
    if (options.parentId !== undefined) task.parentId = options.parentId;
    if (options.reviewRequired) task.reviewRequired = true;
    if (options.maxReviewRounds !== undefined) task.maxReviewRounds = validateMaxRounds(options.maxReviewRounds);

    this.tasks.set(id, task);

    await this.messageBus.publish('task:created', 'orchestrator', { task });

    // Attempt immediate assignment if dependencies are met
    await this.tryDispatchTask(id);

    return task;
  }

  /**
   * Split a task that has not been started into parts. The parts become real tasks (with `parentId`
   * and the dependencies between them), and the parent waits for the last of them: it is completed
   * last, as the sign-off. A parent that was assigned but not started goes back to the queue.
   * Nothing is changed unless the whole split is valid.
   */
  public async splitTask(parentId: string, parts: readonly SplitPart[]): Promise<ColonyTask[]> {
    const parent = this.tasks.get(parentId);
    if (!parent) throw new Error(`Task '${parentId}' not found`);
    if (parent.status !== 'pending' && parent.status !== 'assigned') throw new Error(`Task '${parentId}' is ${parent.status}: only a task that has not been started can be split`);
    if (parent.subTaskIds && parent.subTaskIds.length > 0) throw new Error(`Task '${parentId}' is already split`);
    if (parts.length === 0) throw new Error('a split needs at least one part');

    // Validate and order the parts before touching anything.
    const keys = new Set<string>();
    for (const p of parts) {
      if (keys.has(p.key)) throw new Error(`duplicate part key '${p.key}'`);
      keys.add(p.key);
    }
    for (const p of parts) {
      for (const d of p.dependsOn) if (!keys.has(d)) throw new Error(`part '${p.key}' depends on unknown part '${d}'`);
    }
    const ordered: SplitPart[] = [];
    const placed = new Set<string>();
    while (ordered.length < parts.length) {
      const next = parts.filter((p) => !placed.has(p.key) && p.dependsOn.every((d) => placed.has(d)));
      if (next.length === 0) throw new Error('the parts depend on each other in a cycle');
      for (const p of next) {
        ordered.push(p);
        placed.add(p.key);
      }
    }

    if (parent.status === 'assigned') {
      if (parent.assignedAgentId) this.registry.completeTask(parent.assignedAgentId, parent.id);
      parent.status = 'pending';
      parent.assignedAgentId = undefined;
      parent.startedAt = undefined;
    }

    const idOf = new Map<string, string>();
    const children: ColonyTask[] = [];
    for (const p of ordered) {
      const child = await this.createTask({ ...p.options, parentId: parent.id, dependencies: [...(p.options.dependencies ?? []), ...p.dependsOn.map((d) => idOf.get(d)!)] });
      idOf.set(p.key, child.id);
      children.push(child);
    }

    const needed = new Set(parts.flatMap((p) => p.dependsOn));
    const leaves = parts.filter((p) => !needed.has(p.key)).map((p) => idOf.get(p.key)!);
    parent.subTaskIds = children.map((c) => c.id);
    parent.dependencies = Array.from(new Set([...(parent.dependencies ?? []), ...leaves]));

    await this.messageBus.publish('task:split', 'orchestrator', { taskId: parent.id, subTaskIds: parent.subTaskIds });
    return children;
  }

  /**
   * Record a reviewer's verdict on a task that is being worked on.
   * A rejection sends the task back to `in_progress` and counts a round; when the rounds reach the
   * task's limit the task goes on hold so the user decides. The reviewer cannot be the member who holds the task.
   */
  public async recordReview(
    taskId: string,
    reviewerId: string,
    verdict: ReviewRecord['verdict'],
    reason: string,
    now: number = Date.now()
  ): Promise<{ task: ColonyTask; rounds: number; maxRounds: number; escalated: boolean }> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);
    if (task.status !== 'in_progress' && task.status !== 'review') throw new Error(`Task '${taskId}' is ${task.status}: only work in progress can be reviewed`);
    if (task.assignedAgentId === reviewerId) throw new Error('a member cannot review the task it holds');
    if (!reason.trim()) throw new Error('a review needs a reason');

    task.reviews = [...(task.reviews ?? []), { by: reviewerId, verdict, reason, at: now }].slice(-MAX_KEPT_REVIEWS);
    const maxRounds = maxRoundsOf(task);
    let escalated = false;
    if (verdict === 'reject') {
      task.reviewRounds = (task.reviewRounds ?? 0) + 1;
      task.status = 'in_progress';
      if (task.reviewRounds >= maxRounds && !task.hold) {
        task.hold = { by: REVIEW_LIMIT_HOLDER, reason: `rejected ${task.reviewRounds} times: the user has to decide how to go on`, at: now };
        escalated = true;
      }
    }
    await this.messageBus.publish('task:reviewed', reviewerId, { taskId, verdict, rounds: task.reviewRounds ?? 0 });
    return { task, rounds: task.reviewRounds ?? 0, maxRounds, escalated };
  }

  /** Put a hold on an open task. Completing and dispatching are refused until it is released; failing is not. */
  public async holdTask(taskId: string, by: string, reason: string, now: number = Date.now()): Promise<ColonyTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);
    if (task.hold) throw new Error(`Task '${taskId}' is already on hold (${task.hold.by})`);
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') throw new Error(`Task '${taskId}' is ${task.status}: nothing to hold`);
    if (!reason.trim()) throw new Error('a hold needs a reason');
    task.hold = { by, reason, at: now };
    await this.messageBus.publish('task:held', by, { taskId });
    return task;
  }

  public async releaseHold(taskId: string, by: string): Promise<ColonyTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);
    if (!task.hold) throw new Error(`Task '${taskId}' is not on hold`);
    // The user looked at a task the review limit stopped and said go on: it gets a fresh set of rounds.
    if (task.hold.by === REVIEW_LIMIT_HOLDER) task.reviewRounds = 0;
    task.hold = undefined;
    await this.messageBus.publish('task:hold_released', by, { taskId });
    // A pending task that was only waiting for the release can go out now.
    await this.tryDispatchTask(taskId);
    return task;
  }

  public getTask(taskId: string): ColonyTask | undefined {
    return this.tasks.get(taskId);
  }

  public getAllTasks(): ColonyTask[] {
    return Array.from(this.tasks.values());
  }

  public snapshot(): ColonyTask[] {
    return structuredClone(this.getAllTasks());
  }

  public restore(tasks: ColonyTask[]): void {
    this.tasks.clear();
    for (const task of structuredClone(tasks)) {
      this.tasks.set(task.id, task);
    }
  }

  /**
   * Attempt to match a pending task with an available candidate in the Colony
   */
  public async tryDispatchTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'pending') {
      return false;
    }
    if (task.hold) {
      return false; // a task on hold is not handed to anyone
    }

    // Check if dependencies are fulfilled
    if (task.dependencies && task.dependencies.length > 0) {
      const allCompleted = task.dependencies.every((depId) => {
        const dep = this.tasks.get(depId);
        return dep && dep.status === 'completed';
      });
      if (!allCompleted) {
        return false;
      }
    }

    const candidates = this.registry.findCandidates({
      role: task.requiredRole,
      requiredCapabilities: task.requiredCapabilities,
    });

    if (candidates.length === 0) {
      return false;
    }

    const selectedAgent = (this.ranker ? this.ranker(task, candidates) : candidates)[0];
    if (!selectedAgent) {
      return false;
    }

    // Assign
    task.status = 'assigned';
    task.assignedAgentId = selectedAgent.id;
    task.startedAt = Date.now();

    this.registry.assignTask(selectedAgent.id, task.id);

    await this.messageBus.publish('task:assigned', 'orchestrator', {
      taskId: task.id,
      agentId: selectedAgent.id,
      role: selectedAgent.role,
    });

    return true;
  }

  /** Move an open task to another member (steal or handoff). The task keeps its status. */
  public async reassignTask(taskId: string, newAgentId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);
    if (!OPEN.includes(task.status)) {
      throw new Error(`Task '${taskId}' is ${task.status}, not open`);
    }
    const target = this.registry.getMember(newAgentId);
    if (!target) throw new Error(`Member '${newAgentId}' not found`);
    if (target.status === 'offline' || target.status === 'error') throw new Error(`Member '${newAgentId}' is ${target.status}: it cannot take over a task`);
    if (!target.currentTaskIds.includes(taskId) && target.currentTaskIds.length >= target.capabilities.maxConcurrentTasks) {
      throw new Error(`Member '${newAgentId}' is at capacity`);
    }
    const previous = task.assignedAgentId;
    if (previous) this.registry.completeTask(previous, taskId);
    task.assignedAgentId = newAgentId;
    this.registry.assignTask(newAgentId, taskId);
    await this.messageBus.publish('task:reassigned', 'orchestrator', { taskId, from: previous, to: newAgentId });
  }

  public async updateTaskProgress(
    taskId: string,
    agentId: string,
    status: 'in_progress' | 'review' | 'consensus'
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);
    if (!OPEN.includes(task.status)) throw new Error(`Task '${taskId}' is ${task.status}: only an open task can change its progress`);

    task.status = status;
    await this.messageBus.publish(`task:${status}`, agentId, { taskId });
  }

  public async completeTask(taskId: string, agentId: string, outputResult?: unknown, report: OutcomeReport = {}): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);
    if (report.quality !== undefined) validateQuality(report.quality);
    checkResultSize(outputResult, 'the result');
    this.requireHolder(task, taskId, agentId, 'completed');
    if (task.hold) throw new Error(`Task '${taskId}' is on hold (${task.hold.by}): it cannot be completed until the hold is released`);
    const reviewBlock = reviewBlocksCompletion(task);
    if (reviewBlock) throw new Error(`Task '${taskId}' cannot be completed: ${reviewBlock}`);

    task.status = 'completed';
    task.outputResult = outputResult;
    task.completedAt = Date.now();
    if (report.quality !== undefined) task.quality = report.quality;
    if (report.verifiedByTest) task.verifiedByTest = true;

    this.registry.completeTask(agentId, taskId);

    await this.messageBus.publish('task:completed', agentId, {
      taskId,
      outputResult,
    });

    // Check if any dependent tasks can now be dispatched
    for (const pendingTask of this.tasks.values()) {
      if (pendingTask.status === 'pending' && pendingTask.dependencies?.includes(taskId)) {
        await this.tryDispatchTask(pendingTask.id);
      }
    }
  }

  /**
   * Record the result of a check the colony ran itself. Independent evidence outranks the host's
   * word: a failed check caps the quality at VERIFY_FAIL_QUALITY_CAP (the reported value is kept),
   * and the hub relearns from the lowered rating. A passed check marks the work verified.
   */
  public async verifyTask(taskId: string, verification: TaskVerification): Promise<{ contradiction: boolean; capped: boolean }> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);
    if (task.status !== 'completed') throw new Error(`Task '${taskId}' is ${task.status}: only a completed task can be verified`);
    task.verification = verification;
    const contradiction = !verification.passed && Boolean(task.verifiedByTest);
    const capped = !verification.passed && task.quality !== undefined && task.quality > VERIFY_FAIL_QUALITY_CAP;
    if (capped) {
      task.reportedQuality = task.quality;
      task.quality = VERIFY_FAIL_QUALITY_CAP;
    }
    await this.messageBus.publish('task:verified', 'orchestrator', { taskId, passed: verification.passed });
    // Either way the memory of this work changes (lowered rating, or now marked verified): relearn it.
    if (capped || verification.passed) await this.messageBus.publish('task:rated', 'orchestrator', { taskId, success: true });
    return { contradiction, capped };
  }

  /** Set the quality of a finished task after the fact; the hub relearns from it. */
  public async rateTask(taskId: string, quality: number): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);
    validateQuality(quality);
    if (task.status !== 'completed' && task.status !== 'failed') throw new Error(`Task '${taskId}' is ${task.status}: only a completed or failed task can be rated`);
    task.quality = quality;
    await this.messageBus.publish('task:rated', 'orchestrator', { taskId, success: task.status === 'completed' });
  }

  /** A task is closed once, by the member that holds it, while it is being worked on. */
  private requireHolder(task: ColonyTask, taskId: string, agentId: string, verb: string): void {
    if (!OPEN.includes(task.status)) throw new Error(`Task '${taskId}' is ${task.status}: only an open task can be ${verb}`);
    if (task.assignedAgentId !== undefined && task.assignedAgentId !== agentId) {
      throw new Error(`Task '${taskId}' is held by '${task.assignedAgentId}', not '${agentId}'`);
    }
  }

  public async failTask(taskId: string, agentId: string, error: string, report: OutcomeReport = {}): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);
    if (report.quality !== undefined) validateQuality(report.quality);
    checkResultSize(error, 'the error text');
    this.requireHolder(task, taskId, agentId, 'failed');

    task.status = 'failed';
    task.error = error;
    task.completedAt = Date.now();
    if (report.quality !== undefined) task.quality = report.quality;
    if (report.verifiedByTest) task.verifiedByTest = true;

    this.registry.completeTask(agentId, taskId);

    await this.messageBus.publish('task:failed', agentId, { taskId, error });
  }
}
