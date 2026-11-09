import type { AgentRole } from '../types.js';
import { buildTopology, isFullyConnected, shortestPath, TOPOLOGY_TYPES, TopologyType } from '../topology.js';
import { CliError, CommandContext, CommandResult, Handler, ROLES, serializeProposal, summarizeTask } from './context.js';

// Commands: status, topology, watch, health, member, route, audit

export const inspectHandlers: Record<string, Handler> = {};

async function handle_status(ctx: CommandContext): Promise<CommandResult> {
  const { hub, reply } = ctx;
  const tasks = hub.orchestrator.getAllTasks();
  return reply({
    colony: hub.getSnapshot(),
    members: hub.registry.getAllMembers().map((m) => ({ id: m.id, role: m.role, status: m.status, tasks: m.currentTaskIds })),
    tasks: tasks.map(summarizeTask),
    openProposals: hub.consensus.listProposals().filter((p) => p.status === 'open').map(serializeProposal),
  });
}

inspectHandlers['status'] = handle_status;

async function handle_topology(ctx: CommandContext): Promise<CommandResult> {
  const { values, hub, reply } = ctx;
  const type = (values.type ?? 'star') as TopologyType;
  if (!TOPOLOGY_TYPES.includes(type)) throw new CliError(`unknown topology '${values.type}' (use ${TOPOLOGY_TYPES.join(', ')})`);
  const fanout = values.fanout ? Number(values.fanout) : undefined;
  const degree = values.degree ? Number(values.degree) : undefined;
  if (fanout !== undefined && (!Number.isInteger(fanout) || fanout < 1)) throw new CliError('--fanout must be a positive integer');
  if (degree !== undefined && (!Number.isInteger(degree) || degree < 1)) throw new CliError('--degree must be a positive integer');

  const topology = buildTopology(hub.registry.getAllMembers(), type, { fanout, meshDegree: degree });
  if (values.from || values.to) {
    if (!values.from || !values.to) throw new CliError('--from and --to go together');
    return reply({ topology, path: shortestPath(topology, values.from, values.to) });
  }
  return reply({ topology, connected: isFullyConnected(topology) });
}

inspectHandlers['topology'] = handle_topology;

async function handle_watch(ctx: CommandContext): Promise<CommandResult> {
  const { values, boot, hub, reply } = ctx;
  if (values.task && !hub.orchestrator.getTask(values.task)) throw new CliError(`task '${values.task}' not found`);
  const report = hub.watch({ focusTaskId: values.task, anchor: boot.audit });
  return reply({
    report,
    note: 'Mechanical checks over the records, with heuristic thresholds. A clean report means these checks found nothing, not that the work is right.',
  });
}

inspectHandlers['watch'] = handle_watch;

async function handle_health(ctx: CommandContext): Promise<CommandResult> {
  const { values, hub, reply } = ctx;
  const numeric = (name: 'queue-depth' | 'long-wait-min', raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new CliError(`--${name} must be a non-negative number`);
    return n;
  };
  const report = hub.health(Date.now(), { queueDepth: numeric('queue-depth', values['queue-depth']), longWaitMinutes: numeric('long-wait-min', values['long-wait-min']) });
  return reply({
    report,
    note: 'Thresholds and the health formulas are heuristic. Error rates and response times come from the tasks and are what the host reported; response time includes waiting.',
  });
}

inspectHandlers['health'] = handle_health;

async function handle_member(ctx: CommandContext): Promise<CommandResult> {
  const { positionals, sub, session, hub, log, reply } = ctx;
  if (sub === 'list') {
    return reply({ members: hub.registry.getAllMembers().map((m) => ({ id: m.id, role: m.role, status: m.status, tasks: m.currentTaskIds, maxConcurrentTasks: m.capabilities.maxConcurrentTasks })) });
  }
  if (sub === 'preset') {
    if (positionals[2] !== 'standard') throw new CliError('usage: member preset standard');
    const added = session.addMissingBuiltinMembers();
    for (const id of added) log('member.added', id, { preset: 'standard' });
    await session.save();
    return reply({ added, total: hub.registry.getAllMembers().length });
  }
  throw new CliError('usage: member list | member preset standard');
}

inspectHandlers['member'] = handle_member;

async function handle_route(ctx: CommandContext): Promise<CommandResult> {
  const { values, positionals, sub, session, hub, log, reply } = ctx;
  if (sub === 'stats') return reply({ load: hub.router.getLoadBalance(), learning: hub.router.getStats() });
  const text = positionals[2];
  if (sub !== 'test' && sub !== 'teach') throw new CliError('usage: route test <text> | route teach <text> --role R [--reward -1..1] | route stats');
  if (!text?.trim()) throw new CliError(`route ${sub} needs a task text`);
  if (sub === 'test') return reply({ decision: hub.router.routeTask(text, { record: false }) });

  if (!values.role || !ROLES.includes(values.role as AgentRole)) throw new CliError(`--role must be one of ${ROLES.join(', ')}`);
  const reward = values.reward === undefined ? 1 : Number(values.reward);
  if (!Number.isFinite(reward) || reward < -1 || reward > 1) throw new CliError('--reward must be between -1 and 1');
  hub.router.recordOutcome(text, values.role as AgentRole, reward);
  log('router.taught', values.role, { reward, chars: text.length });
  await session.save();
  return reply({ taught: { role: values.role, reward }, decision: hub.router.routeTask(text, { record: false }), learning: hub.router.getStats() });
}

inspectHandlers['route'] = handle_route;

async function handle_audit(ctx: CommandContext): Promise<CommandResult> {
  const { values, sub, boot, hub, reply } = ctx;
  if (sub === 'verify') {
    const chain = hub.audit.verify();
    const anchor = boot.audit;
    const anchored = anchor ? hub.audit.contains(anchor) : null;
    const ok = chain.ok && anchored !== false;
    return {
      code: ok ? 0 : 2,
      output: {
        ok,
        chain,
        sinceBoot: anchor ? { anchoredEntries: anchor.entries, stillHeld: anchored } : null,
        note: 'The hash chain has no signature: it detects edits, not a rewrite that recomputes every hash. The boot anchor catches cuts and rewrites since the last boot.',
      },
    };
  }
  if (sub !== 'list') throw new CliError('usage: audit list [--task id] [--type t] [--k N] | audit verify');
  const k = values.k ? Number(values.k) : 20;
  if (!Number.isInteger(k) || k < 0) throw new CliError('--k must be a non-negative integer');
  return reply({ total: hub.audit.length, entries: hub.audit.list({ aggregateId: values.task, type: values.type, limit: k }) });
}

inspectHandlers['audit'] = handle_audit;

