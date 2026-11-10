import { scanText } from '../injection-scan.js';
import { redactText } from '../redact.js';
import { debateModesForRole, debateStats, DEBATE_MODES, isDebateMode } from '../debate/debate-modes.js';
import type { DiscussionEntryKind } from '../types.js';
import { CliError, CommandContext, CommandResult, Handler, resolveMembers } from './context.js';

// Commands: debate

export const debateHandlers: Record<string, Handler> = {};

const KINDS: readonly DiscussionEntryKind[] = ['position', 'reply', 'hypothesis', 'dissent'];

const USAGE_LINE = 'usage: debate <proposalId> position|reply|hypothesis|dissent --as <member> --text <text> [--mode M] [--to <entryId>] [--prediction P --test T] | debate <proposalId> judge <entryId> --as <member> --outcome supported|refuted [--verified-by-test] | debate <proposalId> show | debate stats';

/**
 * `debate`: the arguments, hypotheses and dissent around a proposal. It is a record, not a vote: the
 * count stays with `vote`. The colony enforces which modes a role may use and what a hypothesis must
 * contain; it cannot check that the host really argued in the mode it named.
 */
async function handle_debate(ctx: CommandContext): Promise<CommandResult> {
  const { values, positionals, sub, session, hub, warnings, log, reply } = ctx;

  if (sub === 'stats') {
    return reply({ stats: debateStats(hub.consensus.listProposals()), note: 'Counts only. Whether debate helps is measured on rated tasks, with and without it.' });
  }
  if (!sub) throw new CliError(USAGE_LINE);
  const proposal = hub.consensus.getProposal(sub);
  if (!proposal) throw new CliError(`proposal '${sub}' not found`);
  const action = positionals[2];

  if (action === 'show') {
    return reply({ proposalId: proposal.id, status: proposal.status, discussion: proposal.discussion ?? [] });
  }

  if (action === 'judge') {
    const entryId = positionals[3];
    if (!entryId) throw new CliError(USAGE_LINE);
    const [judge] = resolveMembers(session, values.as);
    if (values.outcome !== 'supported' && values.outcome !== 'refuted') throw new CliError('--outcome must be supported or refuted');
    const entry = hub.consensus.judgeDiscussionEntry(proposal.id, entryId, judge.id, values.outcome, Boolean(values['verified-by-test']));
    log('debate.judged', entry.id, { proposalId: proposal.id, kind: entry.kind, outcome: entry.outcome, verifiedByTest: Boolean(entry.verifiedByTest) });
    await session.save();
    return reply({ entry });
  }

  if (!action || !KINDS.includes(action as DiscussionEntryKind)) throw new CliError(USAGE_LINE);
  const kind = action as DiscussionEntryKind;
  const [author] = resolveMembers(session, values.as);
  const text = values.text?.trim();
  if (!text) throw new CliError('--text <text> is required');
  const pair = debateModesForRole(author.role);
  if (values.mode !== undefined && !isDebateMode(values.mode)) throw new CliError(`unknown mode '${values.mode}' (use ${DEBATE_MODES.join(', ')})`);
  const mode = values.mode === undefined ? pair.default : (values.mode as typeof pair.default);

  // What is stored is later handed to a model, so it gets the same checks as memory.
  const scan = scanText(text);
  if (scan.verdict === 'hostile') {
    log('memory.refused', scan.inputHash, { verdict: scan.verdict, store: 'debate', threats: scan.threats.map((t) => t.type) });
    await session.save();
    throw new CliError(`debate entry refused: the text looks hostile (${scan.threats.map((t) => t.description).join('; ')})`);
  }
  if (scan.verdict !== 'clean') warnings.push(`debate text scan: ${scan.verdict} (${scan.threats.map((t) => t.type).join(', ') || 'personal data'})`);
  const redacted = redactText(text);
  if (redacted.changed) warnings.push(`personal data or a secret was replaced before storing (${redacted.findings.map((f) => f.kind).join(', ')})`);

  const entry = hub.consensus.addDiscussionEntry(proposal.id, {
    authorId: author.id,
    role: author.role,
    kind,
    mode,
    text: redacted.text,
    replyTo: values.to,
    prediction: values.prediction,
    test: values.test,
  });
  log('debate.entry', entry.id, { proposalId: proposal.id, kind, mode, authorId: author.id, switched: Boolean(entry.switched) });
  await session.save();
  const note = kind === 'dissent'
    ? 'Recorded as a dissent. It is not a vote and does not change the count. Judge it later with `debate ... judge`.'
    : kind === 'hypothesis'
      ? 'Recorded as a hypothesis, not a finding. Run the test, then `debate ... judge --outcome supported --verified-by-test` (or refuted).'
      : 'Recorded. Arguments do not change the count: the vote stays with `vote`.';
  return reply({ entry, note });
}

debateHandlers['debate'] = handle_debate;
