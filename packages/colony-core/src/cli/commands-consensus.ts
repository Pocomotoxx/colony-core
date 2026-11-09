import { QUORUM_STRATEGIES, QuorumStrategy } from '../consensus/strategies.js';
import { CliError, CommandContext, CommandResult, Handler, resolveMembers, serializeProposal } from './context.js';

// Commands: propose, vote

export const consensusHandlers: Record<string, Handler> = {};

async function handle_propose(ctx: CommandContext): Promise<CommandResult> {
  const { values, positionals, command, sub, dir, boot, session, hub, warnings, log, reply, deputyNotes } = ctx;
  const [, , topic] = positionals;
  const task = sub ? hub.orchestrator.getTask(sub) : undefined;
  if (!task) throw new CliError(`task '${sub ?? ''}' not found`);
  if (!topic) throw new CliError('propose needs a topic');
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
  const voters = hub.registry.getAllMembers().filter((m) => m.status !== 'offline' && m.status !== 'error' && m.role !== 'exobiologist').length;

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

async function handle_vote(ctx: CommandContext): Promise<CommandResult> {
  const { values, positionals, command, sub, dir, boot, session, hub, warnings, log, reply, deputyNotes } = ctx;
  if (values.approve === values.reject) throw new CliError('pass exactly one of --approve or --reject');
  if (!values.reason?.trim()) throw new CliError('--reason <text> is required');
  const confidence = values.confidence === undefined ? 1 : Number(values.confidence);
  if (!(confidence >= 0 && confidence <= 1)) throw new CliError('--confidence must be between 0 and 1');
  if (!sub) throw new CliError('usage: vote <proposalId> --as <member> ...');
  const [voter] = resolveMembers(session, values.as);
  if (voter.role === 'exobiologist') throw new CliError('the exobiologist is an advisory role and does not vote; its hypotheses go through `anomaly`');
  const proposal = await hub.consensus.castVote(sub, { voterId: voter.id, approve: Boolean(values.approve), confidence, reason: values.reason });
  log('proposal.vote', proposal.id, { voterId: voter.id, approve: Boolean(values.approve), confidence, status: proposal.status });
  await session.save();
  return reply({ proposal: serializeProposal(proposal) });
}

consensusHandlers['vote'] = handle_vote;

