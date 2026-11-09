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

export type SerializedProposal = Omit<ConsensusProposal<any>, 'votes'> & { votes: ConsensusVote[] };

/**
 * Robust, model-agnostic consensus engine supporting quorum and confidence-weighted voting
 */
export class ConsensusEngine {
  private proposals = new Map<string, ConsensusProposal<any>>();
  private messageBus: MessageBus;

  constructor(messageBus: MessageBus) {
    this.messageBus = messageBus;
  }

  /**
   * Submit a new proposal for colony voting
   */
  public async submitProposal<T = unknown>(options: ProposalOptions<T>): Promise<ConsensusProposal<T>> {
    const id = `prop_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const timeoutMs = options.timeoutMs || 30000;

    if (options.strategy !== undefined) {
      if (options.quorum !== undefined) throw new Error('pass either a quorum or a strategy, not both');
      if (options.voters === undefined) throw new Error('a strategy needs the number of eligible voters');
    }
    const quorum = options.strategy ? requiredApprovals(options.strategy, options.voters!) : options.quorum || 2;

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
  ): Promise<ConsensusProposal<any>> {
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
      confidence: vote.confidence ?? 1.0,
      reason: vote.reason,
      timestamp: Date.now(),
    });

    await this.messageBus.publish('consensus:vote_cast', vote.voterId, {
      proposalId,
      approve: vote.approve,
      confidence: vote.confidence ?? 1.0,
    });

    this.evaluateProposal(proposal);
    return proposal;
  }

  private evaluateProposal(proposal: ConsensusProposal<any>): void {
    const votes = Array.from(proposal.votes.values());
    const approvals = votes.filter((v) => v.approve);
    const rejections = votes.filter((v) => !v.approve);

    // Calculate confidence-weighted approval
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

  public getProposal(proposalId: string): ConsensusProposal<any> | undefined {
    return this.proposals.get(proposalId);
  }

  public listProposals(): ConsensusProposal<any>[] {
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
