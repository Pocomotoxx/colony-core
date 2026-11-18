import fs from 'node:fs/promises';
import { scanText } from '../injection-scan.js';
import { redactText } from '../redact.js';
import { resolveInside, SafePathError } from '../safe-path.js';
import { DEFAULT_TTL_DAYS, listSignals, MAX_SIGNALS, parseSummaries, projectOfSource, SIGNALS_NAMESPACE, SIGNAL_LABEL, tagOfSource } from '../radar/signals.js';
import { CliError, CommandContext, CommandResult, Handler } from './context.js';

// Commands: radar

export const radarHandlers: Record<string, Handler> = {};

const USAGE_LINE = 'usage: radar import <summaries.json> [--ttl-days N] [--project NAME] | radar list [--project NAME] [--k N] [--include-expired] | radar forget <id> | radar forget --expired | radar forget --all';
const DAY = 24 * 60 * 60 * 1000;

/**
 * `radar import|list|forget`: external signals (docs/RADAR-PLAN.md). The import takes the summaries that
 * `scripts/groq-summarize.mjs --out` wrote, keeps only the items that passed every check, and stores each with its source
 * link, the time, an expiry and the label "unverified". They live in their own namespace and never mix into ordinary
 * recall; `next` shows the few that are close to the task, with the label.
 */
async function handle_radar(ctx: CommandContext): Promise<CommandResult> {
  const { values, positionals, sub, dir, session, hub, warnings, log, reply } = ctx;
  const now = Date.now();

  if (sub === 'list') {
    const k = values.k ? Number(values.k) : 20;
    if (!Number.isInteger(k) || k < 1 || k > 500) throw new CliError('--k must be an integer 1-500');
    let signals = await listSignals(hub.codex, now);
    const total = signals.length;
    if (!values['include-expired']) signals = signals.filter((s) => !s.expired);
    if (values.project) signals = signals.filter((s) => s.project === values.project);
    return reply({ total, shown: Math.min(k, signals.length), signals: signals.slice(0, k), note: SIGNAL_LABEL });
  }

  if (sub === 'forget') {
    const target = positionals[2];
    const modes = [Boolean(target), Boolean(values.expired), Boolean(values.all)].filter(Boolean).length;
    if (modes !== 1) throw new CliError(`forget needs exactly one of an id, --expired or --all\n${USAGE_LINE}`);
    const signals = await listSignals(hub.codex, now);
    let gone: string[];
    if (values.all) {
      gone = signals.map((s) => s.id);
      await hub.codex.clear(SIGNALS_NAMESPACE);
    } else {
      gone = values.expired ? signals.filter((s) => s.expired).map((s) => s.id) : signals.filter((s) => s.id === target).map((s) => s.id);
      if (target && gone.length === 0) throw new CliError(`signal '${target}' not found`);
      if (gone.length > 0) await hub.codex.store.delete(gone.map((id) => `signal_${id}`));
    }
    log('radar.forgot', values.all ? 'all' : values.expired ? 'expired' : target!, { count: gone.length });
    await session.save();
    return reply({ forgotten: gone.length, ids: gone });
  }

  if (sub !== 'import') throw new CliError(USAGE_LINE);

  const file = positionals[2];
  if (!file) throw new CliError(USAGE_LINE);
  let abs: string;
  try {
    abs = (await resolveInside(dir, file)).resolved;
  } catch (err) {
    if (err instanceof SafePathError) throw new CliError(err.code === 'OUTSIDE' ? 'the file must be inside the project directory' : `file: ${err.message}`);
    throw err;
  }
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat?.isFile()) throw new CliError(`file '${file}' not found`);
  if (stat.size > 2_000_000) throw new CliError('the file is larger than 2 MB');
  let json: unknown;
  try {
    const text = await fs.readFile(abs, 'utf-8');
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new CliError(`the file is not valid JSON: ${(err as Error).message}`);
  }
  const ttlDays = values['ttl-days'] ? Number(values['ttl-days']) : DEFAULT_TTL_DAYS;
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365) throw new CliError('--ttl-days must be an integer 1-365');
  if (values.project !== undefined && !/^[A-Za-z0-9_./-]{1,100}$/.test(values.project)) throw new CliError('--project must be 1-100 characters of letters, digits and . _ / -');

  const parsed = parseSummaries(json);
  if (parsed.problem) throw new CliError(parsed.problem);

  const existing = new Set((await listSignals(hub.codex, now)).map((s) => s.id));
  const refused: Array<{ id: string; reason: string }> = [];
  const batch: Array<{ id: string; text: string; namespace: string; metadata: Record<string, unknown> }> = [];
  let updated = 0;
  let fresh = 0;
  let redactedCount = 0;
  for (const item of parsed.items) {
    // The summarizer already checked the text. It is checked again here: what enters memory comes back as context.
    const scan = scanText(item.summary);
    if (scan.verdict === 'hostile') {
      log('memory.refused', scan.inputHash, { verdict: scan.verdict, store: SIGNALS_NAMESPACE, threats: scan.threats.map((t) => t.type) });
      refused.push({ id: item.id, reason: `the summary looks hostile (${scan.threats.map((t) => t.type).join(', ')})` });
      continue;
    }
    const isNew = !existing.has(item.id);
    if (isNew && existing.size + fresh >= MAX_SIGNALS) {
      refused.push({ id: item.id, reason: `there are already ${MAX_SIGNALS} signals: forget some first` });
      continue;
    }
    // Version numbers (13.6.233.17) look like IP addresses; everything else personal is still redacted.
    const redacted = redactText(item.summary, { skip: ['ip_address'] });
    if (redacted.changed) redactedCount++;
    if (isNew) fresh++;
    else updated++;
    // The stored text starts with the project and the release tag, taken from the source link (not from the model): the
    // summaries often do not name the project, and the search reads this text.
    const project = values.project ?? projectOfSource(item.source);
    const tag = tagOfSource(item.source);
    batch.push({
      id: `signal_${item.id}`,
      text: `${project ?? 'external'}${tag ? ` ${tag}` : ''}: ${redacted.text}`,
      namespace: SIGNALS_NAMESPACE,
      metadata: {
        origin: 'radar',
        source: item.source,
        project,
        tag,
        summary: redacted.text,
        fetchedAt: now,
        expiresAt: now + ttlDays * DAY,
        guardScore: item.guardScore,
        scan: scan.verdict,
        unverified: true,
      },
    });
    if (scan.verdict !== 'clean') warnings.push(`signal '${item.id}': text scan ${scan.verdict} (${scan.threats.map((t) => t.type).join(', ') || 'personal data'})`);
  }
  if (batch.length > 0) await hub.codex.storeDocuments(batch);
  log('radar.imported', parsed.items.length > 0 ? parsed.items[0].id : 'none', { imported: fresh, updated, refused: refused.length, skipped: parsed.skipped.length, ttlDays });
  await session.save();
  return reply({
    imported: fresh,
    updated,
    redacted: redactedCount,
    expiresInDays: ttlDays,
    refused,
    skipped: parsed.skipped,
    note: `${SIGNAL_LABEL}. Only items with status ok and a source link are imported; the rest are listed under skipped.`,
  });
}

radarHandlers['radar'] = handle_radar;
