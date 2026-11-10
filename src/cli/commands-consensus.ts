import { QUORUM_STRATEGIES, QuorumStrategy } from '../consensus/strategies.js';
import { CliError, CommandContext, CommandResult, Handler, OPEN_STATUSES, resolveMembers, serializeProposal } from './context.js';

// Commands: propose, vote

export const consensusHandlers: Record<string, Handler> = {};

async function handle_propose(ctx: CommandContext): Promise<CommandResult> {
  const { values, positionals, sub, session, hub, log, reply } = ctx;
  const [, , topic] = positionals;
  const task = sub ? hub.orchestrator.getTask(sub) : undefined;
  if (!task) throw new CliError(`task '${sub ?? ''}' not found`);
  if (!topic) throw new CliError('propose needs a topic');
  if (!OPEN_STATUSES.includes(task.status)) throw new CliError(`task '${task.id}' is ${task.status}: only a task that is being worked on can go to a vote`);
  const [proposer] = resolveMembers(session, values.as);
  const strategy = values.strategy as QuorumStrategy | undefined;
  if (strategy !== undefined && !QUORUM_STRATEGIES.includes(strategy)) {
    throw new CliError(`unknown strategy '${strategy}' (use ${QUORUM_STRATEGIES.join(', ')})`);
  }
  if (strategy && values.quorum) throw new CliError('pass either --quorum or --strategy, not both');
  const quorum = values.quorum ? Number(values.quorum) : strategy ? undefined : task.minConsensusQuorum;
  const timeoutMin = values['timeout-min'] ? Number(values['timeout-min']) : 60;
  if (quorum !== undefined && (!Number.isInteger(quorum) || quorum < 1)) throw new CliError('--quorum must be a positive integer');
  if (!(timeoutMin > 0)) throw new CliError('--timeout-min must be positive');
  // Eligible voters: every member that is neither offline nor in error.
  const voters = hub.registry.getAllMembers().filter((m) => m.status !== 'offline' && m.status !== 'error' && m.role !== 'exobiologist' && m.role !== 'dissenter').length;

  const proposal = await hub.consensus.submitProposal({
    taskId: task.id,
    proposerId: proposer.id,
    topic,
    data: values.data ?? null,
    quorum,
    strategy,
    voters: strategy ? voters : undefined,
    timeoutMs: timeoutMin * 60_000,
  });
  await hub.orchestrator.updateTaskProgress(task.id, proposer.id, 'consensus');
  log('proposal.created', proposal.id, { taskId: task.id, proposerId: proposer.id, quorum: proposal.quorum, strategy: strategy ?? null });
  await session.save();
  return reply({ proposal: serializeProposal(proposal) });
}

consensusHandlers['propose'] = handle_propose;

/**
 * The colony cannot tell members apart: every vote is cast by whoever runs `vote --as <member>`, so
 * one host can cast them all. It cannot be prevented here, but two telltale signs can be named:
 * several voters giving the same reason word for word, and several votes in a few seconds.
 */
function independenceWarnings(votes: Array<{ voterId: string; reason?: string; timestamp: number }>): string[] {
  const out: string[] = [];
  if (votes.length < 2) return out;
  const byReason = new Map<string, string[]>();
  for (const v of votes) {
    const key = (v.reason ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (key) byReason.set(key, [...(byReason.get(key) ?? []), v.voterId]);
  }
  for (const voters of byReason.values()) {
    if (voters.length >= 2) out.push(`${voters.length} voters gave exactly the same reason (${voters.join(', ')}): were they independent reviews?`);
  }
  if (votes.length >= 3) {
    const times = votes.map((v) => v.timestamp);
    const span = Math.max(...times) - Math.min(...times);
    if (span < 30_000) out.push(`${votes.length} votes came within ${Math.max(1, Math.round(span / 1000))} s: the colony cannot tell whether that many separate reviewers voted or one host cast them all`);
  }
  return out;
}

async function handle_vote(ctx: CommandContext): Promise<CommandResult> {
  const { values, sub, session, hub, warnings, log, reply } = ctx;
  if (values.approve === values.reject) throw new CliError('pass exactly one of --approve or --reject');
  if (!values.reason?.trim()) throw new CliError('--reason <text> is required');
  const confidence = values.confidence === undefined ? 1 : Number(values.confidence);
  if (!(confidence >= 0 && confidence <= 1)) throw new CliError('--confidence must be between 0 and 1');
  if (!sub) throw new CliError('usage: vote <proposalId> --as <member> ...');
  const [voter] = resolveMembers(session, values.as);
  if (voter.role === 'exobiologist') throw new CliError('the exobiologist is an advisory role and does not vote; its hypotheses go through `anomaly`');
  if (voter.role === 'dissenter') throw new CliError('the dissenter does not vote; its objection goes through `debate ... dissent`');
  const proposal = await hub.consensus.castVote(sub, { voterId: voter.id, approve: Boolean(values.approve), confidence, reason: values.reason });
  log('proposal.vote', proposal.id, { voterId: voter.id, approve: Boolean(values.approve), confidence, status: proposal.status });
  if (proposal.status !== 'open') warnings.push(...independenceWarnings(Array.from(proposal.votes.values())));
  await session.save();
  return reply({ proposal: serializeProposal(proposal) });
}

consensusHandlers['vote'] = handle_vote;

