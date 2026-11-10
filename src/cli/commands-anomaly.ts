import { scanText } from '../injection-scan.js';
import { redactText } from '../redact.js';
import { CliError, CommandContext, CommandResult, Handler, resolveMembers } from './context.js';

// Commands: anomaly

export const anomalyHandlers: Record<string, Handler> = {};

const NAMESPACE = 'anomalies';
const MAX_TEXT = 2000;

/**
 * `anomaly add|list`: record something that was set aside as noise instead of dropping it, and hand
 * it to the exobiologist. The Analyst's prompt says "record it as an anomaly" and the Exobiologist
 * "works only on anomalies someone recorded"; this is the record.
 */
async function handle_anomaly(ctx: CommandContext): Promise<CommandResult> {
  const { values, positionals, sub, session, hub, warnings, log, reply } = ctx;

  if (sub === 'list') {
    const k = values.k ? Number(values.k) : 20;
    if (!Number.isInteger(k) || k < 1) throw new CliError('--k must be a positive integer');
    const docs = ((await hub.codex.store.list?.()) ?? []).filter((d) => d.namespace === NAMESPACE).sort((a, b) => b.createdAt - a.createdAt);
    return reply({
      total: docs.length,
      anomalies: docs.slice(0, k).map((d) => ({ id: d.id, text: d.text, recordedBy: (d.metadata as { by?: string }).by ?? null, fromTask: (d.metadata as { fromTask?: string }).fromTask ?? null, taskId: (d.metadata as { taskId?: string }).taskId ?? null, at: d.createdAt })),
    });
  }

  if (sub !== 'add') throw new CliError('usage: anomaly add <text> --as <member> [--task <fromTaskId>] | anomaly list [--k N]');
  const text = positionals[2]?.trim();
  if (!text) throw new CliError('anomaly add needs the text of the anomaly');
  if (text.length > MAX_TEXT) throw new CliError(`the anomaly text is limited to ${MAX_TEXT} characters`);
  const [by] = resolveMembers(session, values.as);
  if (values.task && !hub.orchestrator.getTask(values.task)) throw new CliError(`task '${values.task}' not found`);

  const scan = scanText(text);
  if (scan.verdict === 'hostile') {
    log('memory.refused', scan.inputHash, { verdict: scan.verdict, store: 'anomalies', threats: scan.threats.map((t) => t.type) });
    await session.save();
    throw new CliError(`anomaly refused: the text looks hostile (${scan.threats.map((t) => t.description).join('; ')}). It is stored and handed to a model later.`);
  }
  if (scan.verdict !== 'clean') warnings.push(`anomaly text scan: ${scan.verdict} (${scan.threats.map((t) => t.type).join(', ') || 'personal data'})`);
  const redacted = redactText(text);
  if (redacted.changed) warnings.push(`personal data or a secret was replaced before storing (${redacted.findings.map((f) => f.kind).join(', ')})`);

  const task = await hub.orchestrator.createTask({
    title: `Anomaly: ${redacted.text.slice(0, 60)}`,
    description: redacted.text,
    requiredRole: 'exobiologist',
    priority: 'low',
    inputData: values.task ? { fromTask: values.task } : {},
  });
  const [doc] = await hub.codex.storeDocuments([
    { text: redacted.text, namespace: NAMESPACE, metadata: { by: by.id, taskId: task.id, ...(values.task ? { fromTask: values.task } : {}) } },
  ]);
  log('anomaly.recorded', doc.id, { by: by.id, taskId: task.id, chars: text.length });
  await session.save();
  return reply({ anomaly: { id: doc.id, taskId: task.id, assignedTo: task.assignedAgentId ?? null }, note: 'The exobiologist takes it with `next --as exobiologist`; it proposes explanations that contradict the usual pattern, and the result is a hypothesis, not a finding.' });
}

anomalyHandlers['anomaly'] = handle_anomaly;
