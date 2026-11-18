#!/usr/bin/env node
// Summarise public texts with Groq, after a prompt-injection check.   See docs/PROVIDER-PLAN.md.
//
//   node scripts/groq-summarize.mjs --dir <project> --in <items.json> --dry-run
//   node scripts/groq-summarize.mjs --dir <project> --in <items.json> --yes
//
// The items file is a JSON list of { "id": "...", "source": "https://...", "text": "..." }.
//
// What goes out: ONLY the text of the items, after the colony's own scan and redaction. You confirm with --yes that
// the texts are public (feed items, abstracts, release notes): never project files or anything private.
// Per item:  local scan (hostile text is never sent) -> redaction -> Groq prompt guard (fails closed) -> summary
//            -> local scan and redaction of the summary.
// The key is read from GROQ_API_KEY and is never printed or stored. Nothing is stored by this script except the
// usage count (<project>/.colony/provider/groq-usage.json) that keeps the quotas.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chatWithRetry, chunkText, DEFAULT_LIMITS, estimateTokens, normalizeSummary, parseGuardScore, reserve, resolveApiBase, summaryMessages, tokensUsed, Usage } from './lib/groq.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

// ---- arguments

const FLAGS = new Set(['yes', 'dry-run', 'guard-only', 'debug-guard']);
const VALUES = new Set(['dir', 'in', 'out', 'limits', 'lang', 'guard-threshold', 'guard-chunk-chars', 'max-out', 'max-wait-sec', 'max-chars']);
const opts = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) fail(`unexpected argument '${a}'`);
    const name = a.slice(2);
    if (FLAGS.has(name)) opts[name] = true;
    else if (VALUES.has(name)) {
      if (i + 1 >= argv.length) fail(`--${name} needs a value`);
      opts[name] = argv[++i];
    } else fail(`unknown option '${a}'`);
  }
}

const USAGE = 'usage: node scripts/groq-summarize.mjs --dir <project> --in <items.json> [--dry-run | --yes] [--guard-only] [--lang hu|en|same] [--limits <file>] [--guard-threshold 0..1] [--guard-chunk-chars N] [--max-out N] [--max-wait-sec N] [--max-chars N] [--out <file>] [--debug-guard]';
for (const required of ['dir', 'in']) if (!opts[required]) fail(`--${required} is required\n${USAGE}`);

const project = resolve(opts.dir);
if (project === resolve(root)) fail('--dir is the colony-core folder itself: give the PROJECT folder.');
if (!existsSync(project) || !statSync(project).isDirectory()) fail(`the project folder does not exist: ${project}`);

const num = (value, name, min, max, integer = true) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) fail(`--${name} must be ${integer ? 'an integer' : 'a number'} ${min}-${max}`);
  return n;
};
const threshold = num(opts['guard-threshold'] ?? '0.5', 'guard-threshold', 0, 1, false);
const chunkChars = num(opts['guard-chunk-chars'] ?? '1500', 'guard-chunk-chars', 200, 20000);
const maxOut = num(opts['max-out'] ?? '600', 'max-out', 50, 4000);
const maxWaitMs = num(opts['max-wait-sec'] ?? '70', 'max-wait-sec', 0, 600) * 1000;
const maxChars = num(opts['max-chars'] ?? '12000', 'max-chars', 500, 100000);
const lang = opts.lang ?? 'same';
if (!['hu', 'en', 'same'].includes(lang)) fail('--lang must be hu, en or same');
const dryRun = Boolean(opts['dry-run']);
const guardOnly = Boolean(opts['guard-only']);
const MAX_GUARD_CHUNKS = 8;

function insideProject(input, label) {
  const abs = isAbsolute(input) ? resolve(input) : resolve(project, input);
  const rel = relative(project, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) fail(`${label} must be inside the project folder`);
  return abs;
}

const outPath = opts.out ? insideProject(opts.out, '--out') : null;

const readJson = (file, label) => {
  try {
    const text = readFileSync(file, 'utf-8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    return fail(`${label}: ${err.message}`);
  }
};

// limits: the defaults, with any number overridden from a file
const limits = { guard: { ...DEFAULT_LIMITS.guard }, summary: { ...DEFAULT_LIMITS.summary } };
if (opts.limits) {
  const override = readJson(insideProject(opts.limits, '--limits'), '--limits');
  for (const role of ['guard', 'summary']) {
    for (const [key, value] of Object.entries(override?.[role] ?? {})) {
      if (!(key in limits[role])) fail(`--limits: unknown field '${role}.${key}'`);
      if (key === 'model') {
        if (typeof value !== 'string' || !/^[A-Za-z0-9._/-]{1,100}$/.test(value)) fail(`--limits: ${role}.model is not a valid model name`);
      } else if (!Number.isInteger(value) || value < 1) fail(`--limits: ${role}.${key} must be a positive integer`);
      limits[role][key] = value;
    }
  }
}

// items
const itemsPath = insideProject(opts.in, '--in');
if (!existsSync(itemsPath) || !statSync(itemsPath).isFile()) fail(`items file not found: ${opts.in}`);
if (statSync(itemsPath).size > 2_000_000) fail('the items file is larger than 2 MB');
const items = readJson(itemsPath, '--in');
if (!Array.isArray(items) || items.length === 0) fail('--in must hold a non-empty JSON list');
if (items.length > 200) fail('at most 200 items per run');
{
  const seen = new Set();
  items.forEach((it, i) => {
    if (typeof it !== 'object' || it === null) fail(`items[${i}] must be an object`);
    if (typeof it.id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(it.id)) fail(`items[${i}]: "id" must be 1-64 characters of letters, digits and . _ : -`);
    if (seen.has(it.id)) fail(`items[${i}]: duplicate id '${it.id}'`);
    seen.add(it.id);
    if (typeof it.text !== 'string' || !it.text.trim() || it.text.length > 200_000) fail(`items[${i}]: "text" must be 1-200000 characters`);
    // The only redaction an item may ask to skip is the IPv4 rule (version numbers look like addresses). Never a secret.
    if (it.redactSkip !== undefined && !(Array.isArray(it.redactSkip) && it.redactSkip.every((k) => k === 'ip_address'))) fail(`items[${i}]: "redactSkip" may only hold "ip_address"`);
  });
}

// the colony's own scan and redaction (needs the build)
const scanFile = join(root, 'dist', 'injection-scan.js');
const redactFile = join(root, 'dist', 'redact.js');
if (!existsSync(scanFile) || !existsSync(redactFile)) fail('dist/ is missing: run `pnpm install && pnpm build` first.', 1);
const { scanText } = await import(pathToFileURL(scanFile).href);
const { redactText } = await import(pathToFileURL(redactFile).href);

let base;
try {
  base = resolveApiBase(process.env.COLONY_GROQ_API_BASE);
} catch (err) {
  fail(err.message);
}

const usage = new Usage(join(project, '.colony', 'provider', 'groq-usage.json'));

// ---- prepare: what would go out

const prepared = items.map((it) => {
  const scan = scanText(it.text);
  if (scan.verdict === 'hostile') {
    return { id: it.id, status: 'quarantined', reason: `local scan: hostile (${scan.threats.map((t) => t.type).join(', ')})`, sent: false };
  }
  const skip = it.redactSkip ?? [];
  const redacted = redactText(it.text, { skip });
  const truncated = redacted.text.length > maxChars;
  const text = truncated ? redacted.text.slice(0, maxChars) : redacted.text;
  return {
    id: it.id, source: typeof it.source === 'string' && /^https?:\/\/\S{1,490}$/.test(it.source) ? it.source : undefined, text, truncated, redacted: redacted.changed ? redacted.findings.map((f) => f.kind) : [], skip,
    suspicious: scan.verdict === 'suspicious',
  };
});
const sendable = prepared.filter((p) => p.text !== undefined);

const guardChunks = sendable.reduce((a, p) => a + chunkText(p.text, chunkChars, MAX_GUARD_CHUNKS).length, 0);
const guardTokens = sendable.reduce((a, p) => a + estimateTokens(p.text), 0);
const summaryTokens = guardOnly ? 0 : sendable.reduce((a, p) => a + estimateTokens(p.text) + 300 + maxOut, 0);

const plan = {
  items: items.length,
  sendable: sendable.length,
  quarantinedLocally: prepared.length - sendable.length,
  truncated: sendable.filter((p) => p.truncated).length,
  redacted: sendable.filter((p) => p.redacted.length > 0).length,
  guard: { model: limits.guard.model, requests: guardChunks, estimatedTokens: guardTokens, threshold, chunkChars },
  summary: guardOnly ? null : { model: limits.summary.model, requests: sendable.length, estimatedTokens: summaryTokens, maxOut },
  quotaNow: [usage.snapshot('guard', limits), usage.snapshot('summary', limits)],
  fitsToday: {
    guard: usage.window('guard', 86_400_000).tokens + guardTokens <= limits.guard.tpd && usage.window('guard', 86_400_000).requests + guardChunks <= limits.guard.rpd,
    summary: guardOnly ? null : usage.window('summary', 86_400_000).tokens + summaryTokens <= limits.summary.tpd && usage.window('summary', 86_400_000).requests + sendable.length <= limits.summary.rpd,
  },
  note: 'Token numbers are rough estimates (about 3 characters per token). The limits are the values you gave, not verified.',
};

if (dryRun) {
  console.log(JSON.stringify({ plan }, null, 2));
  console.error('dry run: nothing was sent.');
  process.exit(0);
}

if (!opts.yes) fail('this sends text to Groq. Look at --dry-run first; with --yes you confirm that every text is public (feed items, abstracts, release notes), never project files or anything private.');
const key = process.env.GROQ_API_KEY;
if (!key) fail('GROQ_API_KEY is not set. In PowerShell: $k = Read-Host "Groq API key" -AsSecureString; $env:GROQ_API_KEY = [System.Net.NetworkCredential]::new("", $k).Password');

// ---- run

const sleep = (ms) => delay(ms);
const retry = { sleep };
const results = [];
let guardStopped = null;
let summaryStopped = null;

// The guard model has a small context. Text that splits into many tokens (commit hashes, code) can make a piece too
// long even at 1500 characters, and the API then says so with an HTTP 400. A piece that is too long is cut in half and
// tried again, down to MIN_PIECE characters; later pieces of the run start from the size that worked.
const LENGTH_ERROR = /reduce the length|context length|too long|maximum context/i;
const MIN_PIECE = 300;
const MAX_SPLIT_DEPTH = 6;
const MAX_GUARD_PIECES = 60;
let pieceChars = chunkChars;
let splits = 0;

function splitInHalf(text) {
  let mid = Math.floor(text.length / 2);
  for (let d = 0; d < 60 && mid + d < text.length; d++) {
    if (/\s/.test(text[mid + d])) { mid += d; break; }
  }
  return [text.slice(0, mid), text.slice(mid)];
}

/** One piece: { score, pieces, raw } or { deferred } or { failedClosed }. */
async function guardPiece(piece, depth, raw) {
  if (guardStopped) return { deferred: guardStopped };
  const need = estimateTokens(piece) + 20;
  const room = await reserve(usage, limits, 'guard', need, { maxWaitMs, sleep });
  if (!room.ok) {
    guardStopped = room.reason;
    return { deferred: room.reason };
  }
  const r = await chatWithRetry({ base, key, body: { model: limits.guard.model, messages: [{ role: 'user', content: piece }] } }, retry);
  usage.record('guard', r.ok ? tokensUsed(r.tokens, need) : need);
  if (!r.ok) {
    if (r.status === 400 && LENGTH_ERROR.test(r.error) && piece.length > MIN_PIECE && depth < MAX_SPLIT_DEPTH) {
      splits++;
      pieceChars = Math.max(MIN_PIECE, Math.floor(piece.length / 2));
      const [a, b] = splitInHalf(piece);
      const left = await guardPiece(a, depth + 1, raw);
      if (left.deferred || left.failedClosed) return left;
      const right = await guardPiece(b, depth + 1, raw);
      if (right.deferred || right.failedClosed) return right;
      return { score: Math.max(left.score, right.score), pieces: left.pieces + right.pieces };
    }
    return { failedClosed: `the guard could not be reached (${r.error})` };
  }
  if (opts['debug-guard']) raw.push(r.content.slice(0, 80));
  const score = parseGuardScore(r.content);
  if (score === null) return { failedClosed: 'the guard answer could not be read as a score' };
  return { score, pieces: 1 };
}

async function guardItem(p) {
  let max = 0;
  let pieces = 0;
  const raw = [];
  const splitsBefore = splits;
  for (let i = 0; i < p.text.length;) {
    if (pieces >= MAX_GUARD_PIECES) return { failedClosed: `the text needs more than ${MAX_GUARD_PIECES} guard calls` };
    const piece = p.text.slice(i, i + pieceChars);
    i += piece.length;
    const g = await guardPiece(piece, 0, raw);
    if (g.deferred || g.failedClosed) return { ...g, ...(g.failedClosed && raw.length ? { raw } : {}) };
    max = Math.max(max, g.score);
    pieces += g.pieces;
  }
  return { score: max, chunks: pieces, splits: splits - splitsBefore, raw };
}

for (const p of prepared) {
  if (p.text === undefined) {
    results.push(p);
    continue;
  }
  const out = { id: p.id, ...(p.source ? { source: p.source } : {}), truncated: p.truncated, redacted: p.redacted, ...(p.suspicious ? { localScan: 'suspicious' } : {}) };

  const g = await guardItem(p);
  if (g.deferred) {
    results.push({ ...out, status: 'deferred', reason: g.deferred });
    continue;
  }
  if (g.failedClosed) {
    results.push({ ...out, status: 'quarantined', reason: g.failedClosed, ...(g.raw?.length ? { guardRaw: g.raw } : {}) });
    continue;
  }
  out.guard = { score: g.score, chunks: g.chunks, ...(g.splits > 0 ? { splits: g.splits, note: 'a piece was too long for the guard model and was cut in half' } : {}), ...(g.raw?.length ? { raw: g.raw } : {}) };
  if (g.score >= threshold) {
    results.push({ ...out, status: 'quarantined', reason: `the guard flagged it (score ${g.score} >= ${threshold})` });
    continue;
  }
  if (guardOnly) {
    results.push({ ...out, status: 'ok' });
    continue;
  }
  if (summaryStopped) {
    results.push({ ...out, status: 'deferred', reason: summaryStopped });
    continue;
  }

  const messages = summaryMessages(p.text, lang);
  const need = estimateTokens(messages.map((m) => m.content).join('')) + maxOut;
  const room = await reserve(usage, limits, 'summary', need, { maxWaitMs, sleep });
  if (!room.ok) {
    summaryStopped = room.reason;
    results.push({ ...out, status: 'deferred', reason: room.reason });
    continue;
  }
  const r = await chatWithRetry({ base, key, body: { model: limits.summary.model, messages, temperature: 0.2, max_completion_tokens: maxOut } }, retry);
  usage.record('summary', r.ok ? tokensUsed(r.tokens, need) : need);
  if (!r.ok) {
    results.push({ ...out, status: r.status === 429 ? 'deferred' : 'failed', reason: `the summary call failed (${r.error})` });
    continue;
  }
  const summary = normalizeSummary(r.content).trim();
  if (!summary) {
    results.push({ ...out, status: 'failed', reason: `empty answer (finish reason: ${r.finishReason ?? 'unknown'}); the reply may have used its tokens before writing` });
    continue;
  }
  const outScan = scanText(summary);
  if (outScan.verdict === 'hostile') {
    results.push({ ...out, status: 'quarantined', reason: `the summary looks hostile (${outScan.threats.map((t) => t.type).join(', ')})` });
    continue;
  }
  const cleaned = redactText(summary, { skip: p.skip });
  results.push({ ...out, status: 'ok', summary: cleaned.text, ...(outScan.verdict !== 'clean' ? { summaryScan: outScan.verdict } : {}) });
}

const count = (s) => results.filter((r) => r.status === s).length;
const report = JSON.stringify({
  totals: { items: results.length, ok: count('ok'), quarantined: count('quarantined'), deferred: count('deferred'), failed: count('failed') },
  results,
  quota: [usage.snapshot('guard', limits), usage.snapshot('summary', limits)],
  note: 'A summary is unverified: keep the link to the source next to it. A quarantined or deferred item is not to be used.',
}, null, 2);
console.log(report);
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.${process.pid}.tmp`;
  writeFileSync(tmp, report, 'utf-8');
  renameSync(tmp, outPath);
}
// No process.exit() here: on Windows it can crash Node while the HTTP connections are still closing.
process.exitCode = 0;
