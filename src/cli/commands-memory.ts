import path from 'node:path';
import { STATE_DIR } from './session.js';
import { runProfile } from './profile-command.js';
import { scanText } from '../injection-scan.js';
import { CliError, CommandContext, CommandResult, Handler } from './context.js';

// Commands: profile, memory

export const memoryHandlers: Record<string, Handler> = {};

async function handle_profile(ctx: CommandContext): Promise<CommandResult> {
  const { values, positionals, sub, dir, session, warnings, log, reply } = ctx;
  let result;
  try {
    result = await runProfile({ file: path.join(dir, STATE_DIR, 'profile.json'), sub, args: positionals.slice(2), section: values.section, skip: Boolean(values.skip), now: Date.now() });
  } catch (err) {
    throw err instanceof Error ? new CliError(err.message) : err;
  }
  warnings.push(...result.warnings);
  if (result.changed) {
    log(`profile.${result.changed.action}`, result.changed.id ?? 'profile');
    await session.save();
  }
  return reply(result.output);
}

memoryHandlers['profile'] = handle_profile;

async function handle_memory(ctx: CommandContext): Promise<CommandResult> {
  const { values, positionals, sub, session, hub, warnings, log, reply } = ctx;
  const text = positionals[2];
  if (sub === 'add') {
    if (!text?.trim()) throw new CliError('memory add needs non-empty text');
    const scan = scanText(text);
    if (scan.verdict === 'hostile' && !values['allow-risky']) {
      log('memory.refused', scan.inputHash, { verdict: scan.verdict, threats: scan.threats.map((t) => t.type) });
      await session.save();
      throw new CliError(`memory add refused: the text looks hostile (${scan.threats.map((t) => t.description).join('; ')}). Stored memory comes back as context later. Pass --allow-risky if you are sure.`);
    }
    if (scan.verdict !== 'clean') warnings.push(`memory text scan: ${scan.verdict} (${scan.threats.map((t) => t.type).join(', ') || 'personal data'})`);
    const [doc] = await hub.codex.storeDocuments([{ text, namespace: values.ns }]);
    return reply({ id: doc.id, namespace: doc.namespace ?? null });
  }
  if (sub === 'search') {
    if (!text?.trim()) throw new CliError('memory search needs a query');
    const k = values.k ? Number(values.k) : 5;
    if (!Number.isInteger(k) || k < 1) throw new CliError('--k must be a positive integer');
    const results = await hub.codex.search(text, { topK: k, namespace: values.ns });
    return reply({ results: results.map((r) => ({ id: r.document.id, namespace: r.document.namespace, text: r.document.text, score: r.score })) });
  }
  throw new CliError('usage: memory add <text> | memory search <query>');
}

memoryHandlers['memory'] = handle_memory;

