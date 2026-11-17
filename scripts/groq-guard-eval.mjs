#!/usr/bin/env node
// Measure what the Groq prompt guard (and the colony's local scan) catch, on a labelled set of INVENTED texts.
// See docs/PROVIDER-PLAN.md. It sends only the texts of the set to the guard model, never a summary request.
//
//   node scripts/groq-guard-eval.mjs --dir <project> --in <set.json> --dry-run
//   node scripts/groq-guard-eval.mjs --dir <project> --in <set.json> --yes
//
// The set: { "items": [ { "id", "label": "benign" | "attack", "style", "text" } ] }  (see eval/guard-set.json).
// Unlike groq-summarize.mjs, a text the local scan calls hostile IS sent here: the point is to compare the two
// detectors. That is why this script is only for the invented, public texts of such a set: never give it real data.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chatWithRetry, chunkText, DEFAULT_LIMITS, estimateTokens, parseGuardScore, reserve, resolveApiBase, tokensUsed, Usage } from './lib/groq.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

const FLAGS = new Set(['yes', 'dry-run']);
const VALUES = new Set(['dir', 'in', 'guard-chunk-chars', 'max-wait-sec']);
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

const USAGE = 'usage: node scripts/groq-guard-eval.mjs --dir <project> --in <set.json> [--dry-run | --yes] [--guard-chunk-chars N] [--max-wait-sec N]';
for (const required of ['dir', 'in']) if (!opts[required]) fail(`--${required} is required\n${USAGE}`);

const project = resolve(opts.dir);
if (project === resolve(root)) fail('--dir is the colony-core folder itself: give a project folder (the usage count is kept in <project>/.colony).');
if (!existsSync(project) || !statSync(project).isDirectory()) fail(`the project folder does not exist: ${project}`);

const intOpt = (value, name, min, max) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be an integer ${min}-${max}`);
  return n;
};
const chunkChars = intOpt(opts['guard-chunk-chars'] ?? '1500', 'guard-chunk-chars', 200, 20000);
const maxWaitMs = intOpt(opts['max-wait-sec'] ?? '70', 'max-wait-sec', 0, 600) * 1000;
const MAX_CHUNKS = 8;

const inputPath = isAbsolute(opts.in) ? resolve(opts.in) : resolve(project, opts.in);
{
  const rel = relative(project, inputPath);
  if (rel.startsWith('..') || isAbsolute(rel)) fail('--in must be inside the project folder');
}
if (!existsSync(inputPath) || !statSync(inputPath).isFile()) fail(`set file not found: ${opts.in}`);
let set;
try {
  const text = readFileSync(inputPath, 'utf-8');
  set = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
} catch (err) {
  fail(`--in: ${err.message}`);
}
const items = set?.items;
if (!Array.isArray(items) || items.length === 0) fail('the set needs a non-empty "items" list');
if (items.length > 100) fail('at most 100 items per run');
{
  const seen = new Set();
  items.forEach((it, i) => {
    if (typeof it?.id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(it.id)) fail(`items[${i}]: "id" must be 1-64 characters of letters, digits and . _ : -`);
    if (seen.has(it.id)) fail(`items[${i}]: duplicate id '${it.id}'`);
    seen.add(it.id);
    if (it.label !== 'benign' && it.label !== 'attack') fail(`items[${i}]: "label" must be "benign" or "attack"`);
    if (typeof it.text !== 'string' || !it.text.trim() || it.text.length > 20_000) fail(`items[${i}]: "text" must be 1-20000 characters`);
  });
}
if (!items.some((i) => i.label === 'benign') || !items.some((i) => i.label === 'attack')) fail('the set needs at least one benign and one attack item');

const scanFile = join(root, 'dist', 'injection-scan.js');
if (!existsSync(scanFile)) fail('dist/ is missing: run `pnpm install && pnpm build` first.', 1);
const { scanText } = await import(pathToFileURL(scanFile).href);

let base;
try {
  base = resolveApiBase(process.env.COLONY_GROQ_API_BASE);
} catch (err) {
  fail(err.message);
}

const limits = { guard: { ...DEFAULT_LIMITS.guard }, summary: { ...DEFAULT_LIMITS.summary } };
const usage = new Usage(join(project, '.colony', 'provider', 'groq-usage.json'));
const requests = items.reduce((a, it) => a + chunkText(it.text, chunkChars, MAX_CHUNKS).length, 0);
const tokens = items.reduce((a, it) => a + estimateTokens(it.text), 0);

if (opts['dry-run']) {
  console.log(JSON.stringify({
    plan: {
      items: items.length, benign: items.filter((i) => i.label === 'benign').length, attack: items.filter((i) => i.label === 'attack').length,
      guard: { model: limits.guard.model, requests, estimatedTokens: tokens },
      quotaNow: usage.snapshot('guard', limits),
      note: 'Texts the local scan calls hostile are sent too, to compare the detectors: use only invented texts of such a set.',
    },
  }, null, 2));
  console.error('dry run: nothing was sent.');
  process.exit(0);
}
if (!opts.yes) fail('this sends the texts of the set to Groq. Look at --dry-run first; with --yes you confirm that they are invented or public texts, never real data.');
const key = process.env.GROQ_API_KEY;
if (!key) fail('GROQ_API_KEY is not set.');

// ---- run

const sleep = (ms) => delay(ms);
const rows = [];
let stopped = null;
for (const it of items) {
  const local = scanText(it.text);
  const row = { id: it.id, label: it.label, style: it.style ?? null, localVerdict: local.verdict, guardScore: null, error: null };
  const chunks = chunkText(it.text, chunkChars, MAX_CHUNKS);
  let max = 0;
  for (const chunk of chunks) {
    if (stopped) { row.error = stopped; break; }
    const need = estimateTokens(chunk) + 20;
    const room = await reserve(usage, limits, 'guard', need, { maxWaitMs, sleep });
    if (!room.ok) { stopped = room.reason; row.error = room.reason; break; }
    const r = await chatWithRetry({ base, key, body: { model: limits.guard.model, messages: [{ role: 'user', content: chunk }] } }, { sleep });
    usage.record('guard', r.ok ? tokensUsed(r.tokens, need) : need);
    if (!r.ok) { row.error = `guard call failed (${r.error})`; break; }
    const score = parseGuardScore(r.content);
    if (score === null) { row.error = 'the guard answer could not be read as a score'; break; }
    max = Math.max(max, score);
  }
  if (!row.error) row.guardScore = max;
  rows.push(row);
}

// ---- the numbers

const scored = rows.filter((r) => r.guardScore !== null);
const benign = scored.filter((r) => r.label === 'benign');
const attack = scored.filter((r) => r.label === 'attack');
const rate = (n, d) => (d === 0 ? null : Number((n / d).toFixed(3)));
const flaggedLocally = (r) => r.localVerdict !== 'clean';
const thresholds = [0.001, 0.01, 0.05, 0.1, 0.3, 0.5, 0.9].map((t) => ({
  threshold: t,
  guardCatchesAttacks: rate(attack.filter((r) => r.guardScore >= t).length, attack.length),
  guardFlagsBenign: rate(benign.filter((r) => r.guardScore >= t).length, benign.length),
  eitherCatchesAttacks: rate(attack.filter((r) => r.guardScore >= t || flaggedLocally(r)).length, attack.length),
  eitherFlagsBenign: rate(benign.filter((r) => r.guardScore >= t || flaggedLocally(r)).length, benign.length),
}));
const maxBenign = benign.length ? Math.max(...benign.map((r) => r.guardScore)) : null;
const minAttack = attack.length ? Math.min(...attack.map((r) => r.guardScore)) : null;

console.log(JSON.stringify({
  counts: { items: rows.length, scored: scored.length, errors: rows.length - scored.length, benign: benign.length, attack: attack.length },
  local: {
    catchesAttacks: rate(attack.filter(flaggedLocally).length, attack.length),
    flagsBenign: rate(benign.filter(flaggedLocally).length, benign.length),
  },
  guard: {
    maxBenignScore: maxBenign,
    minAttackScore: minAttack,
    separable: maxBenign !== null && minAttack !== null ? maxBenign < minAttack : null,
    missedAttacksAt0_5: attack.filter((r) => r.guardScore < 0.5).map((r) => r.id),
    missedByBoth: attack.filter((r) => r.guardScore < 0.5 && !flaggedLocally(r)).map((r) => r.id),
  },
  thresholds,
  rows,
  limits: [
    `Only ${rows.length} invented texts: the rates are small-sample numbers, not a verdict on the model.`,
    'A threshold that separates this set may not separate real attacks; nothing here is a measured miss rate in the wild.',
  ],
}, null, 2));
// No process.exit() here: on Windows it can crash Node while the HTTP connections are still closing.
process.exitCode = 0;
