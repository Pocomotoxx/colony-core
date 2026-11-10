import { ConsensusProposal, ConsensusVote } from '../types.js';
import { MessageBus } from '../message-bus.js';
import { canStillReach, QuorumStrategy, requiredApprovals } from './strategies.js';

export interface ProposalOptions<T = unknown> {
  taskId: string;
  proposerId: string;
  topic: string;
  data: T;
  quorum?: number; // Minimum number of approving votes
  /** Derive the quorum from the number of eligible voters. Needs `voters`; excludes `quorum`. */
  strategy?: QuorumStrategy;
  voters?: number;
  timeoutMs?: number;
}

export type SerializedProposal = Omit<ConsensusProposal<unknown>, 'votes'> & { votes: ConsensusVote[] };

/**
 * Model-agnostic quorum engine. The decision counts approvals against the quorum. A vote's
 * `confidence` (0..1) is validated, stored and reported, but it does not change the count: a
 * self-reported weight would let any voter outweigh the others, and the Byzantine quorum is defined
 * on counts.
 */
export class ConsensusEngine {
  private proposals = new Map<string, ConsensusProposal<unknown>>();
  private messageBus: MessageBus;

  constructor(messageBus: MessageBus) {
    this.messageBus = messageBus;
  }

  /**
   * Submit a new proposal for colony voting
   */
  public async submitProposal<T = unknown>(options: ProposalOptions<T>): Promise<ConsensusProposal<T>> {
    const id = `prop_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    if (options.timeoutMs !== undefined && !(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0)) throw new Error('timeoutMs must be a positive number of milliseconds');
    if (options.quorum !== undefined && !(Number.isInteger(options.quorum) && options.quorum >= 1)) throw new Error('quorum must be a positive integer');
    const timeoutMs = options.timeoutMs ?? 30000;

    if (options.strategy !== undefined) {
      if (options.quorum !== undefined) throw new Error('pass either a quorum or a strategy, not both');
      if (options.voters === undefined) throw new Error('a strategy needs the number of eligible voters');
    }
    const quorum = options.strategy ? requiredApprovals(options.strategy, options.voters!) : options.quorum ?? 2;

    const proposal: ConsensusProposal<T> = {
      id,
      taskId: options.taskId,
      proposerId: options.proposerId,
      topic: options.topic,
      data: options.data,
      votes: new Map<string, ConsensusVote>(),
      status: 'open',
      quorum,
      ...(options.strategy ? { strategy: options.strategy, voters: options.voters } : {}),
      createdAt: Date.now(),
      expiresAt: Date.now() + timeoutMs,
    };

    this.proposals.set(id, proposal);

    await this.messageBus.publish('consensus:proposal_created', options.proposerId, {
      proposalId: id,
      taskId: options.taskId,
      topic: options.topic,
      quorum: proposal.quorum,
      expiresAt: proposal.expiresAt,
    });

    return proposal;
  }

  /**
   * Cast a vote for an active proposal
   */
  public async castVote(
    proposalId: string,
    vote: { voterId: string; approve: boolean; confidence?: number; reason?: string }
  ): Promise<ConsensusProposal<unknown>> {
    const confidence = vote.confidence ?? 1.0;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('confidence must be a finite number between 0 and 1');
    }
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposal '${proposalId}' not found`);
    }

    if (proposal.status !== 'open') {
      throw new Error(`Proposal '${proposalId}' is already finalized (${proposal.status})`);
    }

    if (Date.now() > proposal.expiresAt) {
      proposal.status = 'timeout';
      await this.messageBus.publish('consensus:proposal_timeout', 'consensus_engine', { proposalId });
      return proposal;
    }

    if (proposal.voters !== undefined && !proposal.votes.has(vote.voterId) && proposal.votes.size >= proposal.voters) {
      throw new Error(`Proposal '${proposalId}' already has votes from all ${proposal.voters} eligible voters`);
    }

    proposal.votes.set(vote.voterId, {
      voterId: vote.voterId,
      approve: vote.approve,
      confidence,
      reason: vote.reason,
      timestamp: Date.now(),
    });

    await this.messageBus.publish('consensus:vote_cast', vote.voterId, {
      proposalId,
      approve: vote.approve,
      confidence,
    });

    this.evaluateProposal(proposal);
    return proposal;
  }

  /**
   * Close every open proposal that is past its deadline. Without this a proposal nobody votes on
   * stays `open` for ever; the deadline was only noticed when someone happened to vote.
   */
  public async expireDue(now: number = Date.now()): Promise<number> {
    let closed = 0;
    for (const proposal of this.proposals.values()) {
      if (proposal.status === 'open' && now > proposal.expiresAt) {
        proposal.status = 'timeout';
        closed++;
        await this.messageBus.publish('consensus:proposal_timeout', 'consensus_engine', { proposalId: proposal.id });
      }
    }
    return closed;
  }

  private evaluateProposal(proposal: ConsensusProposal<unknown>): void {
    const votes = Array.from(proposal.votes.values());
    const approvals = votes.filter((v) => v.approve);
    const rejections = votes.filter((v) => !v.approve);

    // Informational only (reported in the event): the decision below counts approvals, not weights.
    const totalWeightedApproval = approvals.reduce((sum, v) => sum + v.confidence, 0);

    if (approvals.length >= proposal.quorum) {
      proposal.status = 'approved';
      this.messageBus.publish('consensus:proposal_approved', 'consensus_engine', {
        proposalId: proposal.id,
        taskId: proposal.taskId,
        approvals: approvals.length,
        weightedApproval: totalWeightedApproval,
      });
    } else if (
      proposal.voters !== undefined
        ? !canStillReach(approvals.length, rejections.length, proposal.voters, proposal.quorum)
        : rejections.length > votes.length / 2 && votes.length >= proposal.quorum
    ) {
      proposal.status = 'rejected';
      this.messageBus.publish('consensus:proposal_rejected', 'consensus_engine', {
        proposalId: proposal.id,
        taskId: proposal.taskId,
        rejections: rejections.length,
      });
    }
  }

  public getProposal(proposalId: string): ConsensusProposal<unknown> | undefined {
    return this.proposals.get(proposalId);
  }

  public listProposals(): ConsensusProposal<unknown>[] {
    return Array.from(this.proposals.values());
  }

  public snapshot(): SerializedProposal[] {
    return this.listProposals().map(({ votes, ...rest }) => ({
      ...structuredClone(rest),
      votes: Array.from(votes.values()).map((v) => ({ ...v })),
    }));
  }

  public restore(proposals: SerializedProposal[]): void {
    this.proposals.clear();
    for (const { votes, ...rest } of proposals) {
      const voteMap = new Map<string, ConsensusVote>();
      for (const v of votes) voteMap.set(v.voterId, { ...v });
      this.proposals.set(rest.id, { ...structuredClone(rest), votes: voteMap });
    }
  }
}
