import fs from 'node:fs/promises';
import path from 'node:path';
import { scanText } from '../injection-scan.js';
import { redactText } from '../redact.js';
import { resolveInside, SafePathError } from '../safe-path.js';
import { DEFAULT_TTL_DAYS, listSignals, MAX_SIGNALS, parseSummaries, projectOfSource, purgeExpired, SIGNALS_NAMESPACE, SIGNAL_LABEL, tagOfSource } from '../radar/signals.js';
import { MAX_APPROVED, ApprovedSource, proposeSources, readApproved, REPO_NAME, writeApproved } from '../radar/sources.js';
import { STATE_DIR } from './session.js';
import { CliError, CommandContext, CommandResult, Handler } from './context.js';

// Commands: radar

export const radarHandlers: Record<string, Handler> = {};

const USAGE_LINE = 'usage: radar import <summaries.json> [--ttl-days N] [--project NAME] | radar list [--project NAME] [--k N] [--include-expired] | radar forget <id> | radar forget --expired | radar forget --all | radar sources | radar sources approve <owner/repo>... | radar sources approve --all | radar sources remove <owner/repo>...';
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

  if (sub === 'sources') return handleSources(ctx);

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

  // expired signals go first: a long-running colony must not keep old third-party text forever
  const expiredRemoved = await purgeExpired(hub.codex, now);
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
    expiredRemoved,
    redacted: redactedCount,
    expiresInDays: ttlDays,
    refused,
    skipped: parsed.skipped,
    note: `${SIGNAL_LABEL}. Only items with status ok and a source link are imported; the rest are listed under skipped.`,
  });
}

/**
 * `radar sources`: which GitHub repositories the radar may fetch. The proposal is read from the dependencies of the
 * project (package.json, and the package.json of each installed dependency); nothing is fetched and nothing is chosen
 * for you: you approve by name (`approve <owner/repo>` or `approve --all`), and `scripts/radar-fetch.mjs --from-sources`
 * reads only that list.
 */
async function handleSources(ctx: CommandContext): Promise<CommandResult> {
  const { values, positionals, dir, session, warnings, log, reply } = ctx;
  const action = positionals[2];
  const names = positionals.slice(3);
  const stateDir = path.join(dir, STATE_DIR);

  let proposal;
  try {
    proposal = await proposeSources(dir);
  } catch (err) {
    // a list can still be edited without a package.json: only the proposal needs it
    if (action === 'approve' && !values.all && names.length > 0) proposal = null;
    else if (action === 'remove') proposal = null;
    else throw new CliError(`${(err as Error).message}. The proposal is made from the dependencies of the project: run this in the folder that holds package.json (and run the install, so that node_modules has the packages).`);
  }
  let approved = await readApproved(stateDir);
  const has = (repo: string) => approved.some((a) => a.repo.toLowerCase() === repo.toLowerCase());

  if (action === undefined) {
    return reply({
      package: proposal!.packageName,
      considered: proposal!.considered,
      ...(proposal!.truncated ? { truncated: 'only the first 500 dependencies were looked at' } : {}),
      approved: approved.map((a) => ({ repo: a.repo, how: a.how, via: a.via })),
      proposed: proposal!.repos.map((r) => ({ repo: r.repo, via: r.via, approved: has(r.repo) })),
      unresolved: proposal!.unresolved,
      note: 'Nothing was fetched. The proposal comes from files on disk (the repository field of each installed dependency). Approve by name: `radar sources approve <owner/repo>` or `approve --all`; then `node scripts/radar-fetch.mjs --dir <project> --from-sources --dry-run`. A repository named in a package.json is data from the package author: check the name before you approve it.',
    });
  }

  if (action === 'remove') {
    if (names.length === 0) throw new CliError(USAGE_LINE);
    const gone = approved.filter((a) => names.some((n) => n.toLowerCase() === a.repo.toLowerCase())).map((a) => a.repo);
    if (gone.length === 0) throw new CliError('none of these is on the approved list');
    approved = approved.filter((a) => !gone.includes(a.repo));
    await writeApproved(stateDir, approved);
    log('radar.sources.removed', gone[0], { repos: gone });
    await session.save();
    return reply({ removed: gone, approved: approved.map((a) => a.repo) });
  }

  if (action !== 'approve') throw new CliError(USAGE_LINE);
  if (Boolean(values.all) === (names.length > 0)) throw new CliError('approve needs either one or more owner/repo names, or --all (the whole proposal)');

  const wanted: Array<{ repo: string; via: string[]; how: 'proposal' | 'manual' }> = [];
  if (values.all) {
    for (const r of proposal!.repos) wanted.push({ repo: r.repo, via: r.via, how: 'proposal' });
  } else {
    for (const n of names) {
      if (!REPO_NAME.test(n) || n.includes('..')) throw new CliError(`'${n}' is not an owner/repo name`);
      const known = proposal?.repos.find((r) => r.repo.toLowerCase() === n.toLowerCase());
      wanted.push({ repo: n, via: known?.via ?? [], how: known ? 'proposal' : 'manual' });
    }
  }
  const added: string[] = [];
  const already: string[] = [];
  const leftOut: string[] = [];
  const manual: string[] = [];
  for (const w of wanted) {
    if (has(w.repo)) {
      already.push(w.repo);
      continue;
    }
    if (approved.length >= MAX_APPROVED) {
      leftOut.push(w.repo);
      continue;
    }
    const entry: ApprovedSource = { repo: w.repo, via: w.via, approvedAt: Date.now(), how: w.how };
    approved.push(entry);
    added.push(w.repo);
    if (w.how === 'manual') manual.push(w.repo);
  }
  if (leftOut.length > 0) warnings.push(`the list holds at most ${MAX_APPROVED} repositories: ${leftOut.length} left out (${leftOut.join(', ')}); remove some first`);
  if (manual.length > 0) warnings.push(`not found among your dependencies, approved by name: ${manual.join(', ')}`);
  if (added.length > 0) {
    await writeApproved(stateDir, approved);
    log('radar.sources.approved', added[0], { repos: added, how: values.all ? 'all' : 'named' });
    await session.save();
  }
  return reply({ added, alreadyApproved: already, leftOut, approved: approved.map((a) => a.repo) });
}

radarHandlers['radar'] = handle_radar;
