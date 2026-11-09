import path from 'node:path';
import { BUILTIN_AGENT_PROFILES } from '../agents/agent-profiles.js';
import type { AgentRole, TaskPriority } from '../types.js';
import { STATE_DIR } from './session.js';
import { TASK_KINDS, TaskKind } from '../chief/analysis.js';
import { lastVerdict, maxRoundsOf, REVIEW_LIMIT_HOLDER, validateMaxRounds } from '../chief/review.js';
import { parseQuality, rateTask } from './rate.js';
import { buildBriefing } from './briefing.js';
import { parseTimeout, verifyTaskCommand } from './verify-command.js';
import { redactText } from '../redact.js';
import { CliError, CommandContext, CommandResult, Handler, OPEN_STATUSES, PRIORITIES, PRIORITY_RANK, ROLES, resolveMembers, summarizeTask } from './context.js';
import { errorMessage } from '../errors.js';

// Commands: task, next, done, fail, review, hold, plan, score, verify, rate

export const tasksHandlers: Record<string, Handler> = {};

async function handle_task(ctx: CommandContext): Promise<CommandResult> {
  const { values, positionals, sub, session, hub, log, reply } = ctx;
  if (sub !== 'add') throw new CliError('usage: task add <title> <description>');
  const [, , title, description] = positionals;
  if (!title || !description) throw new CliError('task add needs a title and a description');
  if (values.role && !ROLES.includes(values.role as AgentRole)) throw new CliError(`unknown role '${values.role}'`);
  if (values.priority && !PRIORITIES.includes(values.priority as TaskPriority)) throw new CliError(`unknown priority '${values.priority}'`);
  const dependencies = values.after ? values.after.split(',').map((s) => s.trim()).filter(Boolean) : [];
  for (const dep of dependencies) {
    if (!hub.orchestrator.getTask(dep)) throw new CliError(`unknown dependency '${dep}'`);
  }
  const quorum = values.consensus ? Number(values.consensus) : undefined;
  if (quorum !== undefined && (!Number.isInteger(quorum) || quorum < 1)) throw new CliError('--consensus must be a positive integer');

  let maxReviewRounds: number | undefined;
  if (values['max-review-rounds'] !== undefined) {
    try {
      maxReviewRounds = validateMaxRounds(Number(values['max-review-rounds']));
    } catch (err) {
      throw new CliError(`--max-review-rounds: ${errorMessage(err)}`);
    }
  }
  const { task, routeDecision } = await hub.submitAdaptiveTask({
    title,
    description,
    requiredRole: values.role as AgentRole | undefined,
    priority: values.priority as TaskPriority | undefined,
    dependencies,
    consensusRequired: quorum !== undefined,
    minConsensusQuorum: quorum,
    reviewRequired: Boolean(values.review),
    maxReviewRounds,
  });
  log('task.added', task.id, { title, requiredRole: task.requiredRole, priority: task.priority, dependencies });
  await session.save();
  return reply({ task: summarizeTask(task), requiredRole: task.requiredRole, routed: routeDecision ? true : false });
}

tasksHandlers['task'] = handle_task;

async function handle_next(ctx: CommandContext): Promise<CommandResult> {
  const { values, dir, session, hub, warnings, log, reply } = ctx;
  const members = resolveMembers(session, values.as);
  const ids = new Set(members.map((m) => m.id));
  for (const t of hub.orchestrator.getAllTasks()) {
    if (t.status === 'pending') await hub.orchestrator.tryDispatchTask(t.id);
  }
  const mine = hub.orchestrator
    .getAllTasks()
    .filter((t) => (t.status === 'assigned' || t.status === 'in_progress') && !t.hold && t.assignedAgentId && ids.has(t.assignedAgentId))
    .sort(
      (a, b) =>
        Number(b.status === 'in_progress') - Number(a.status === 'in_progress') ||
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        a.createdAt - b.createdAt
    );
  const task = mine[0];
  if (!task) {
    await session.save();
    return reply({ task: null, reason: 'no task is assigned to this role right now' });
  }
  const member = hub.registry.getMember(task.assignedAgentId!)!;
  if (task.status === 'assigned') {
    await hub.orchestrator.updateTaskProgress(task.id, member.id, 'in_progress');
    log('task.started', task.id, { memberId: member.id });
  }
  const open = hub.claims.get(task.id);
  if (open && open.status !== 'closed' && open.holderId === member.id) hub.claims.heartbeat(task.id, member.id, Date.now());
  else if (!open || open.status === 'closed') hub.claims.claim(task.id, member.id, Date.now());
  const profile = Object.values(BUILTIN_AGENT_PROFILES).find((p) => p.id === member.metadata?.profileId);
  const memory = await hub.codex.search(`${task.title} ${task.description}`, { topK: 3, minScore: 0.1 });
  const { briefing, warnings: briefingWarnings } = await buildBriefing(hub, task, path.join(dir, STATE_DIR, 'profile.json'));
  warnings.push(...briefingWarnings);
  await session.save();
  return reply({
    task: hub.orchestrator.getTask(task.id),
    // Why the last review sent the work back, so the member knows what to change.
    reviewFeedback: lastVerdict(task) === 'reject' ? { ...task.reviews![task.reviews!.length - 1], round: task.reviewRounds ?? 0, maxRounds: maxRoundsOf(task) } : null,
    member: { id: member.id, role: member.role },
    instructions: profile?.systemPrompt ?? null,
    // Advice only: the colony cannot set sampling or check that the host followed it.
    samplingAdvice: profile?.sampling ?? null,
    profile: briefing.profile,
    recall: briefing.recall,
    memoryContext: memory.map((r) => ({ id: r.document.id, namespace: r.document.namespace, text: r.document.text, score: r.score })),
  });
}

tasksHandlers['next'] = handle_next;

async function handle_done(ctx: CommandContext): Promise<CommandResult> {
  const { values, command, sub, session, hub, log, reply, deputyNotes } = ctx;
  const taskId = sub;
  const task = taskId ? hub.orchestrator.getTask(taskId) : undefined;
  if (!task) throw new CliError(`task '${taskId ?? ''}' not found`);
  if (!OPEN_STATUSES.includes(task.status)) throw new CliError(`task '${task.id}' is ${task.status}, not open`);
  if (task.hold && command === 'done') throw new CliError(`task '${task.id}' is on hold (${task.hold.by}: ${task.hold.reason}); ask the user, then \`hold release\``);
  const agentId = task.assignedAgentId!;
  let quality: number | undefined;
  if (values.quality !== undefined) {
    quality = Number(values.quality);
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) throw new CliError('--quality must be a number between 0 and 1');
  }
  const report = { quality, verifiedByTest: Boolean(values['verified-by-test']) };
  if (command === 'fail' && report.verifiedByTest) throw new CliError('--verified-by-test only goes with `done`');
  const reported = { quality: quality ?? null, verifiedByTest: report.verifiedByTest, note: 'Quality and the test label are the host\'s statements; the colony does not measure or check them.' };

  if (command === 'fail') {
    if (!values.error?.trim()) throw new CliError('--error <text> is required');
    await hub.orchestrator.failTask(task.id, agentId, values.error, report);
    hub.claims.close(task.id, 'failed', agentId, Date.now());
    log('task.failed', task.id, { memberId: agentId, errorChars: values.error.length, reportedQuality: quality ?? null });
    const deputy = deputyNotes(task.id);
    await session.save();
    return reply({ task: summarizeTask(hub.orchestrator.getTask(task.id)!), reported, ...(deputy.length ? { deputy } : {}) });
  }

  if (!values.result?.trim()) throw new CliError('--result <text> is required and must not be empty');
  if (task.consensusRequired && !hub.consensus.listProposals().some((p) => p.taskId === task.id && p.status === 'approved')) {
    throw new CliError(`task '${task.id}' requires an approved consensus proposal first`);
  }
  const before = new Map(hub.orchestrator.getAllTasks().map((t) => [t.id, t.status]));
  await hub.orchestrator.completeTask(task.id, agentId, values.result, report);
  hub.claims.close(task.id, 'completed', agentId, Date.now());
  log('task.completed', task.id, { memberId: agentId, resultChars: values.result.length, reportedQuality: quality ?? null, reportedVerifiedByTest: report.verifiedByTest });
  const unblocked = hub.orchestrator.getAllTasks().filter((t) => before.get(t.id) === 'pending' && t.status === 'assigned');
  const deputy = deputyNotes(task.id);
  await session.save();
  return reply({ task: summarizeTask(hub.orchestrator.getTask(task.id)!), unblocked: unblocked.map(summarizeTask), reported, ...(deputy.length ? { deputy } : {}) });
}

tasksHandlers['done'] = handle_done;
tasksHandlers['fail'] = handle_done;

async function handle_review(ctx: CommandContext): Promise<CommandResult> {
  const { values, sub, session, hub, log, reply } = ctx;
  const task = sub ? hub.orchestrator.getTask(sub) : undefined;
  if (!task) throw new CliError(`task '${sub ?? ''}' not found`);
  if (values.approve === values.reject) throw new CliError('pass exactly one of --approve or --reject');
  const [reviewer] = resolveMembers(session, values.as);
  if (reviewer.role !== 'reviewer') throw new CliError('only a reviewer can review (--as a reviewer member)');
  const reason = values.reason ?? '';
  if (!reason.trim()) throw new CliError('--reason <text> is required');

  const verdict = values.approve ? 'approve' : 'reject';
  // The reason travels back to the member as feedback; it is stored redacted and shortened.
  const result = await hub.orchestrator.recordReview(task.id, reviewer.id, verdict, redactText(reason).text.slice(0, 300));
  log('task.reviewed', task.id, { by: reviewer.id, verdict, round: result.rounds, reasonChars: reason.length });
  if (result.escalated) log('task.held', task.id, { by: REVIEW_LIMIT_HOLDER, cause: 'review limit', rounds: result.rounds });
  await session.save();
  return reply({
    task: summarizeTask(result.task),
    review: { verdict, rounds: result.rounds, maxRounds: result.maxRounds, escalated: result.escalated },
    note: result.escalated
      ? `Rejected ${result.rounds} times: the task is on hold and the user has to decide (\`hold release\` with a note gives it a fresh set of rounds).`
      : verdict === 'reject'
        ? 'The task went back to in_progress; the member sees the reason in `next`.'
        : 'An approval is the reviewer\'s statement, not a test result; the colony does not check it.',
  });
}

tasksHandlers['review'] = handle_review;

async function handle_hold(ctx: CommandContext): Promise<CommandResult> {
  const { values, positionals, sub, session, hub, log, reply } = ctx;
  const releasing = sub === 'release';
  const taskId = releasing ? positionals[2] : sub;
  const task = taskId ? hub.orchestrator.getTask(taskId) : undefined;
  if (!task) throw new CliError(`task '${taskId ?? ''}' not found`);
  const [who] = resolveMembers(session, values.as);

  if (!releasing) {
    if (who.role !== 'auditor') throw new CliError('only the auditor can put a task on hold (--as an auditor member)');
    const reason = values.reason ?? '';
    if (!reason.trim()) throw new CliError('--reason <text> is required');
    await hub.orchestrator.holdTask(task.id, who.id, redactText(reason).text);
    log('task.held', task.id, { by: who.id, reasonChars: reason.length });
    await session.save();
    return reply({ task: summarizeTask(task), note: 'The task cannot be completed or dispatched until the hold is released. Ask the user.' });
  }

  const note = values.note ?? '';
  if (!note.trim()) throw new CliError('--note <text> is required: what did the user decide?');
  if (!task.hold) throw new CliError(`task '${task.id}' is not on hold`);
  const heldBy = task.hold.by;
  await hub.orchestrator.releaseHold(task.id, who.id);
  // The note is kept, redacted and shortened, as the trace of the decision.
  log('task.hold_released', task.id, { heldBy, releasedBy: who.id, note: redactText(note).text.slice(0, 200) });
  await session.save();
  return reply({
    task: summarizeTask(hub.orchestrator.getTask(task.id)!),
    selfReleased: heldBy === who.id,
    ...(heldBy === REVIEW_LIMIT_HOLDER ? { reviewRoundsReset: true } : {}),
    note: 'The note is the host\'s report of the user\'s decision; the colony cannot check that a person made it.' + (heldBy === who.id ? ' The hold was released by the member who placed it: the Deputy\'s watch will flag this.' : ''),
  });
}

tasksHandlers['hold'] = handle_hold;

async function handle_plan(ctx: CommandContext): Promise<CommandResult> {
  const { values, sub, session, hub, log, reply } = ctx;
  const task = sub ? hub.orchestrator.getTask(sub) : undefined;
  if (!task) throw new CliError(`task '${sub ?? ''}' not found`);
  if (values.kind !== undefined && !TASK_KINDS.includes(values.kind as TaskKind)) throw new CliError(`unknown kind '${values.kind}' (use ${TASK_KINDS.join(', ')})`);
  const analysis = await hub.analyze(task, values.kind as TaskKind | undefined);

  // Which of the roles the steps need exist in the colony at all?
  const roles = Array.from(new Set(analysis.steps.map((s) => s.requiredRole)));
  const coverage = roles.map((role) => ({ role, members: hub.registry.getAllMembers().filter((m) => m.role === role && m.status !== 'offline' && m.status !== 'error').length }));
  const uncovered = coverage.filter((c) => c.members === 0).map((c) => `no member with the role '${c.role}' is online: its step would wait unassigned`);

  if (!values.apply) {
    return reply({ applied: false, analysis, coverage, ...(uncovered.length ? { planWarnings: uncovered } : {}), note: 'Complexity, estimates and confidence are heuristic. Nothing was changed; add --apply to create the steps as tasks.' });
  }
  if (analysis.steps.length === 0) throw new CliError('nothing to split: the task is short, a review, or already a subtask (use --kind to force another template)');

  const children = await hub.orchestrator.splitTask(
    task.id,
    analysis.steps.map((s) => ({
      key: s.key,
      dependsOn: s.dependsOn,
      options: {
        title: `${task.title} - ${s.name}`,
        description: `${s.description}\n\nContext (part of ${task.id}): ${task.description}`,
        requiredRole: s.requiredRole,
        priority: task.priority,
      },
    }))
  );
  log('task.split', task.id, { kind: analysis.kind, strategy: analysis.strategy, children: children.map((c) => c.id) });
  for (const c of children) log('task.added', c.id, { title: c.title, requiredRole: c.requiredRole, priority: c.priority, dependencies: c.dependencies ?? [], parentId: task.id });
  await session.save();
  return reply({
    applied: true,
    parent: summarizeTask(hub.orchestrator.getTask(task.id)!),
    children: children.map((c) => ({ ...summarizeTask(c), requiredRole: c.requiredRole })),
    waves: analysis.waves,
    strategy: analysis.strategy,
    ...(uncovered.length ? { planWarnings: uncovered } : {}),
    note: 'The parent waits for its last step and is completed last, as the sign-off.',
  });
}

tasksHandlers['plan'] = handle_plan;

async function handle_score(ctx: CommandContext): Promise<CommandResult> {
  const { sub, hub, reply } = ctx;
  const task = sub ? hub.orchestrator.getTask(sub) : undefined;
  if (!task) throw new CliError(`task '${sub ?? ''}' not found`);
  return reply({
    task: summarizeTask(task),
    ranking: hub.rankFor(task),
    note: 'The weights and component formulas are heuristic (carried over from the legacy Queen), not fitted to data. Performance is the smoothed share of finished tasks the host reported as completed; it is not a verified quality measure.',
  });
}

tasksHandlers['score'] = handle_score;

async function handle_verify(ctx: CommandContext): Promise<CommandResult> {
  const { values, positionals, sub, dir, session, hub, log, reply } = ctx;
  let result;
  try {
    result = await verifyTaskCommand(hub, sub, positionals.slice(2), dir, parseTimeout(values['timeout-sec']));
  } catch (err) {
    throw err instanceof Error ? new CliError(errorMessage(err)) : err;
  }
  log('task.verified', sub!, result.audit);
  await session.save();
  return reply({ task: summarizeTask(hub.orchestrator.getTask(sub!)!), ...result.output });
}

tasksHandlers['verify'] = handle_verify;

async function handle_rate(ctx: CommandContext): Promise<CommandResult> {
  const { values, sub, session, hub, log, reply } = ctx;
  let rated;
  try {
    rated = await rateTask(hub, sub, parseQuality(values.quality));
  } catch (err) {
    throw err instanceof Error ? new CliError(errorMessage(err)) : err;
  }
  log('task.rated', rated.id, { quality: rated.quality, status: rated.status });
  await session.save();
  return reply({ task: summarizeTask(rated), rated: { quality: rated.quality, note: 'Your rating replaces the one reported at completion in the colony memory.' } });
}

tasksHandlers['rate'] = handle_rate;

