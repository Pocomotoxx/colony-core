import type { ColonyMember } from '../types.js';
import { ClaimError } from '../coordination/claim-ledger.js';
import { CliError, CommandContext, CommandResult, Handler, resolveMembers } from './context.js';

// Commands: claim

export const claimsHandlers: Record<string, Handler> = {};

async function handle_claim(ctx: CommandContext): Promise<CommandResult> {
  const { values, positionals, sub, session, hub, log, reply } = ctx;
  const now = Date.now();
  const taskId = positionals[2] ?? '';
  const needTask = () => {
    const task = taskId ? hub.orchestrator.getTask(taskId) : undefined;
    if (!task) throw new CliError(`task '${taskId}' not found`);
    return task;
  };
  const capacityOf = (m: ColonyMember) => ({ open: hub.claims.heldBy(m.id).length, max: m.capabilities.maxConcurrentTasks });
  try {
    switch (sub) {
      case 'list':
        return reply({ policy: hub.claims.policy, claims: hub.claims.open() });

      case 'sweep': {
        const changed = hub.claims.sweep(now);
        for (const c of changed) log('claim.stealable', c.taskId, { holderId: c.holderId, reason: c.stealableReason });
        await session.save();
        return reply({
          markedStealable: changed.map((c) => {
            const task = hub.orchestrator.getTask(c.taskId);
            // The best other member who could take it over, by the same score as dispatch.
            const next = task ? hub.rankFor(task, undefined, { exclude: [c.holderId] }).primary : null;
            return { taskId: c.taskId, holderId: c.holderId, reason: c.stealableReason, graceEndsAt: c.graceEndsAt, suggestedTakeover: next ? { memberId: next.memberId, score: next.total } : null };
          }),
        });
      }

      case 'heartbeat': {
        needTask();
        const [member] = resolveMembers(session, values.as);
        const progress = values.progress === undefined ? undefined : Number(values.progress);
        const claim = hub.claims.heartbeat(taskId, member.id, now, progress);
        log('claim.heartbeat', taskId, { memberId: member.id, progress: claim.progress, status: claim.status });
        await session.save();
        return reply({ claim });
      }

      case 'block': {
        needTask();
        const [member] = resolveMembers(session, values.as);
        const claim = hub.claims.block(taskId, member.id, values.reason ?? '', now);
        log('claim.blocked', taskId, { memberId: member.id });
        await session.save();
        return reply({ claim });
      }

      case 'unblock': {
        needTask();
        const [member] = resolveMembers(session, values.as);
        const claim = hub.claims.unblock(taskId, member.id, now);
        log('claim.unblocked', taskId, { memberId: member.id });
        await session.save();
        return reply({ claim });
      }

      case 'release': {
        needTask();
        const [member] = resolveMembers(session, values.as);
        const claim = hub.claims.release(taskId, member.id, now);
        log('claim.released', taskId, { memberId: member.id });
        await session.save();
        return reply({ claim });
      }

      case 'steal': {
        needTask();
        const [member] = resolveMembers(session, values.as);
        const { claim, previousHolderId, previousProgress } = hub.claims.steal(taskId, member.id, now, {
          challengerOpenClaims: capacityOf(member).open,
          maxClaims: capacityOf(member).max,
        });
        await hub.orchestrator.reassignTask(taskId, member.id);
        log('claim.stolen', taskId, { from: previousHolderId, to: member.id, previousProgress });
        await session.save();
        return reply({ claim, previousHolderId, previousProgress });
      }

      case 'handoff': {
        needTask();
        const [from] = resolveMembers(session, values.as);
        const target = values.to ? hub.registry.getMember(values.to) : undefined;
        if (!target) throw new CliError(`--to must be a member id (got '${values.to ?? ''}')`);
        const claim = hub.claims.requestHandoff(taskId, from.id, target.id, values.reason ?? '', now, {
          targetOpenClaims: capacityOf(target).open,
          maxClaims: capacityOf(target).max,
        });
        log('claim.handoff_requested', taskId, { from: from.id, to: target.id });
        await session.save();
        return reply({ claim });
      }

      case 'accept': {
        needTask();
        const [member] = resolveMembers(session, values.as);
        const claim = hub.claims.acceptHandoff(taskId, member.id, now);
        await hub.orchestrator.reassignTask(taskId, member.id);
        log('claim.handoff_accepted', taskId, { memberId: member.id });
        await session.save();
        return reply({ claim });
      }

      case 'reject': {
        needTask();
        const [member] = resolveMembers(session, values.as);
        const claim = hub.claims.rejectHandoff(taskId, member.id, now);
        log('claim.handoff_rejected', taskId, { memberId: member.id });
        await session.save();
        return reply({ claim });
      }

      default:
        throw new CliError('usage: claim list|sweep|heartbeat|block|unblock|release|steal|handoff|accept|reject');
    }
  } catch (err) {
    if (err instanceof ClaimError) throw new CliError(`${err.code}: ${err.message}`);
    throw err;
  }
}

claimsHandlers['claim'] = handle_claim;

