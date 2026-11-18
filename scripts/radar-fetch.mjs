#!/usr/bin/env node
// Radar, first slice: fetch the release notes of the GitHub repositories you list, turn them into plain text and run
// them through the colony's own scan, so you can see how many REAL, ordinary texts the filters would put in quarantine.
// See docs/RADAR-PLAN.md.
//
//   node scripts/radar-fetch.mjs --dir <project> --repos owner/repo,owner2/repo2 --dry-run
//   node scripts/radar-fetch.mjs --dir <project> --repos owner/repo,owner2/repo2 --yes
//
// It writes the items that passed (a list of { id, source, text }) to <project>/.colony/radar/items.json, the format
// scripts/groq-summarize.mjs reads. Nothing here goes to Groq. What it does:
//   - only https://github.com/<owner>/<repo>/releases.atom for the repositories you name: no other host, no redirects,
//     no login, a generic User-Agent, a size limit and a time limit per feed;
//   - a text is scanned twice, as received (HTML comments and hidden text show up there) and as plain text; hostile text
//     is quarantined (reported, not written), personal data is redacted before anything is written;
//   - an item already seen is skipped (unless --all), so a rerun does not repeat work.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

// ---- arguments

const FLAGS = new Set(['yes', 'dry-run', 'all']);
const VALUES = new Set(['dir', 'repos', 'per-feed', 'out', 'max-chars']);
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

const USAGE = 'usage: node scripts/radar-fetch.mjs --dir <project> --repos owner/repo[,owner/repo...] [--dry-run | --yes] [--per-feed N] [--out <file>] [--max-chars N] [--all]';
for (const required of ['dir', 'repos']) if (!opts[required]) fail(`--${required} is required\n${USAGE}`);

const project = resolve(opts.dir);
if (project === resolve(root)) fail('--dir is the colony-core folder itself: give the PROJECT folder (the radar state goes to <project>/.colony/radar).');
if (!existsSync(project) || !statSync(project).isDirectory()) fail(`the project folder does not exist: ${project}`);

const intOpt = (value, name, min, max) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be an integer ${min}-${max}`);
  return n;
};
const perFeed = intOpt(opts['per-feed'] ?? '5', 'per-feed', 1, 30);
const maxChars = intOpt(opts['max-chars'] ?? '4000', 'max-chars', 200, 20000);
const dryRun = Boolean(opts['dry-run']);

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const repos = opts.repos.split(',').map((r) => r.trim()).filter(Boolean);
if (repos.length === 0) fail('--repos needs at least one owner/repo');
if (repos.length > 20) fail('at most 20 repositories per run');
if (new Set(repos).size !== repos.length) fail('--repos names a repository twice');
for (const r of repos) if (!REPO.test(r) || r.includes('..')) fail(`'${r}' is not an owner/repo name`);

// the feed host: GitHub, or a loopback address (the tests start a fake server there). Nothing else.
function feedBase(value) {
  const base = (value ?? 'https://github.com').replace(/\/+$/, '');
  if (base === 'https://github.com') return base;
  let url;
  try {
    url = new URL(base);
  } catch {
    return fail('the feed base is not a valid URL');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (loopback && (url.protocol === 'http:' || url.protocol === 'https:')) return base;
  return fail('the feed base must be https://github.com or a loopback address');
}
const base = feedBase(process.env.COLONY_RADAR_BASE);

function insideProject(input, label) {
  const abs = isAbsolute(input) ? resolve(input) : resolve(project, input);
  const rel = relative(project, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) fail(`${label} must be inside the project folder`);
  return abs;
}
const outPath = insideProject(opts.out ?? join('.colony', 'radar', 'items.json'), '--out');
const seenPath = join(project, '.colony', 'radar', 'seen.json');

const seen = new Set();
if (existsSync(seenPath)) {
  try {
    const parsed = JSON.parse(readFileSync(seenPath, 'utf-8'));
    for (const id of Array.isArray(parsed.ids) ? parsed.ids : []) if (typeof id === 'string') seen.add(id);
  } catch { /* a damaged file starts a fresh list */ }
}

if (dryRun) {
  console.log(JSON.stringify({
    plan: { feeds: repos.map((r) => `${base}/${r}/releases.atom`), perFeed, alreadySeen: seen.size, out: outPath, note: 'Nothing was fetched. A real run needs --yes and reads only these URLs.' },
  }, null, 2));
  console.error('dry run: nothing was fetched.');
  process.exit(0);
}
if (!opts.yes) fail('this fetches the feeds listed by --dry-run from the network. Look at --dry-run first, then add --yes.');

const scanFile = join(root, 'dist', 'injection-scan.js');
const redactFile = join(root, 'dist', 'redact.js');
if (!existsSync(scanFile) || !existsSync(redactFile)) fail('dist/ is missing: run `pnpm install && pnpm build` first.', 1);
const { scanText } = await import(pathToFileURL(scanFile).href);
const { redactText } = await import(pathToFileURL(redactFile).href);

// ---- fetching

const MAX_FEED_BYTES = 1_000_000;
const FEED_TIMEOUT_MS = 20_000;

async function fetchFeed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'colony-radar/1.0', Accept: 'application/atom+xml, application/xml;q=0.9' }, signal: controller.signal });
    if (res.status >= 300 && res.status < 400) return { error: `redirect (HTTP ${res.status}) not followed` };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) return { error: 'the feed is larger than 1 MB' };
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_FEED_BYTES) {
        await reader.cancel();
        return { error: 'the feed is larger than 1 MB' };
      }
      chunks.push(value);
    }
    return { text: Buffer.concat(chunks).toString('utf-8') };
  } catch (err) {
    return { error: err?.name === 'AbortError' ? 'timeout' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

// ---- reading the Atom feed (no XML library: a small, forgiving reader for the few fields needed)

const NAMED = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', nbsp: ' ' };
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d{1,7});/g, (m, d) => safeChar(Number(d), m))
    .replace(/&(lt|gt|quot|apos|nbsp);/g, (m, n) => NAMED[n])
    .replace(/&amp;/g, '&');
}
function safeChar(code, fallback) {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : fallback;
}

function field(block, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block);
  return m ? m[1] : '';
}

function parseEntries(xml, limit) {
  const entries = [];
  const re = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) !== null && entries.length < limit) {
    const block = m[1];
    const link = /<link\b[^>]*\brel="alternate"[^>]*\bhref="([^"]+)"/.exec(block) ?? /<link\b[^>]*\bhref="([^"]+)"/.exec(block);
    entries.push({
      atomId: decodeEntities(field(block, 'id')).trim(),
      title: decodeEntities(field(block, 'title')).trim(),
      updated: field(block, 'updated').trim(),
      link: link ? decodeEntities(link[1]) : '',
      html: decodeEntities(field(block, 'content')),
    });
  }
  return entries;
}

/** The HTML of a release note as plain text, with the contents of HTML comments handed back separately. */
function toText(html) {
  const comments = [];
  const withoutComments = html.replace(/<!--([\s\S]*?)-->/g, (_m, c) => {
    comments.push(c);
    return ' ';
  });
  const text = decodeEntities(
    withoutComments
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      // block tags end a line; inline tags vanish, so the text reads as a person would see it (also "ign<b>ore</b>")
      .replace(/<\/?(?:br|p|div|li|ul|ol|h[1-6]|tr|table|blockquote|pre)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, comments };
}

const RANK = { clean: 0, suspicious: 1, hostile: 2 };
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);

// ---- run

const feeds = [];
const items = [];
const quarantined = [];
const processed = [];
const counts = { entries: 0, new: 0, clean: 0, suspicious: 0, hostile: 0, withComments: 0, redacted: 0 };

for (const repo of repos) {
  const url = `${base}/${repo}/releases.atom`;
  const got = await fetchFeed(url);
  if (got.error) {
    feeds.push({ repo, status: 'error', error: got.error });
    continue;
  }
  const entries = parseEntries(got.text, perFeed);
  let fresh = 0;
  for (const e of entries) {
    counts.entries++;
    const id = `gh-${repo.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)}-${createHash('sha1').update(`${repo}\n${e.atomId || e.link || e.title}`).digest('hex').slice(0, 12)}`.slice(0, 64);
    if (!opts.all && seen.has(id)) continue;
    fresh++;
    counts.new++;
    const { text: body, comments } = toText(e.html);
    if (comments.length > 0) counts.withComments++;
    const text = `${e.title}\n\n${body}`.trim().slice(0, maxChars);
    // scanned as received (the HTML, with its comments) and as the plain text that would be read
    const raw = scanText(`${e.title}\n${e.html}`);
    const plain = scanText(text);
    const commentScan = comments.length > 0 ? scanText(comments.join('\n')) : { verdict: 'clean', threats: [] };
    const verdict = worst(worst(raw.verdict, plain.verdict), commentScan.verdict);
    counts[verdict]++;
    processed.push(id);
    const threats = [...raw.threats, ...plain.threats, ...commentScan.threats];
    if (verdict === 'hostile') {
      const top = threats.find((t) => t.severity === 'critical' || t.severity === 'high') ?? threats[0];
      quarantined.push({
        id, repo, source: e.link, why: [...new Set(threats.map((t) => `${t.type}/${t.severity}`))],
        inComment: commentScan.verdict === 'hostile',
        excerpt: top?.excerpt ?? '', // untrusted text, shown as data
      });
      continue;
    }
    // A four-part version number (13.6.233.17) is a valid IPv4 address, so the IP rule would erase the versions a release note is about.
    const redacted = redactText(text, { skip: ['ip_address'] });
    if (redacted.changed) counts.redacted++;
    items.push({ id, source: e.link || url, text: redacted.text, redactSkip: ['ip_address'], ...(verdict === 'suspicious' ? { localScan: 'suspicious' } : {}) });
  }
  feeds.push({ repo, status: 'ok', entries: entries.length, new: fresh });
}

// ---- write: the items that passed, and the list of what was seen

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, file);
}
let written = false;
if (items.length > 0) {
  writeAtomic(outPath, JSON.stringify(items, null, 2));
  written = true;
}
if (processed.length > 0) {
  for (const id of processed) seen.add(id);
  writeAtomic(seenPath, JSON.stringify({ ids: [...seen].slice(-5000) }));
}

console.log(JSON.stringify({
  feeds,
  totals: { ...counts, written: items.length, quarantined: quarantined.length },
  out: written ? outPath : null,
  quarantined,
  note: 'Quarantined items are not written. The excerpts are untrusted text: read them as data. Release notes are ordinary text, so every quarantined item is worth a look: it may be a false alarm. The items file goes to scripts/groq-summarize.mjs for the guard and the summary.',
}, null, 2));
// No process.exit() here: on Windows it can crash Node while the HTTP connections are still closing.
process.exitCode = feeds.every((f) => f.status === 'error') ? 3 : 0;
