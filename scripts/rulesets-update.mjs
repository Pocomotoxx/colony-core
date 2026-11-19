// Update a vendored rule set to another release tag of its upstream repository (see docs/RULESETS-PLAN.md, section 4).
//
//   node scripts/rulesets-update.mjs --set gitleaks --tag v8.31.0 [--dry-run] [--yes]
//
// This is the one script that uses the network, which is why it is separate from the core and does nothing without --yes.
// It never updates by itself and never commits: it leaves the changed files in the working tree for a reviewed change.
//
// What it does, in this order, and stops at the first problem with the vendored set untouched:
//   1. reads rulesets/sources.json (what may be fetched: repository, paths, license, converter);
//   2. checks that the upstream repository still has the license the set was adopted under (a different one is refused);
//   3. checks that the tag is a TAG (not a branch that can move), and reads the commit it points to;
//   4. downloads every file at that tag and proves each one: its git blob hash must equal the one the repository reports;
//   5. replaces the set's source files and license, runs the converter, loads the result with the loader's own checks;
//      if any of that fails, the previous files are put back;
//   6. prints what changed: rules added, removed and changed.
//
// Only https://api.github.com is contacted (a loopback address for the tests), without credentials, without redirects.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONVERTERS = new Set(['rulesets-convert.mjs', 'rulesets-convert-presidio.mjs']);
const MAX_FILE_BYTES = 1_000_000;
const MAX_JSON_BYTES = 3_000_000;
const TIMEOUT_MS = 30_000;
const DEFAULT_API = 'https://api.github.com';

/** A reason to stop, with an exit code. It is thrown and handled at the end: process.exit() after a fetch can crash Node on Windows. */
class Stop extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}
const fail = (message, code = 1) => {
  throw new Stop(message, code);
};

const gitBlobSha1 = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safePath = (p) => typeof p === 'string' && p.length > 0 && p.length < 300 && !p.startsWith('/') && !p.split('/').some((s) => s === '..' || s === '' || s === '.') && !p.includes('\\');

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const setName = opt('set');
  const tag = opt('tag');
  const rulesetsDir = resolve(opt('rulesets-dir') ?? join(root, 'rulesets'));
  const yes = flag('yes');
  const dryRun = flag('dry-run');

  if (!setName || !tag) fail('usage: node scripts/rulesets-update.mjs --set <name> --tag <release tag> [--dry-run] [--yes]', 2);
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(setName)) fail('--set is not a valid rule set name', 2);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag)) fail('--tag is not a valid release tag name', 2);

  // ---- what may be fetched

  let entry;
  try {
    const sources = JSON.parse(readFileSync(join(rulesetsDir, 'sources.json'), 'utf-8'));
    entry = sources.sets?.[setName];
  } catch (err) {
    fail(`cannot read rulesets/sources.json: ${err.message}`);
  }
  if (!entry) fail(`'${setName}' is not in rulesets/sources.json`, 2);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repo ?? '')) fail('sources.json: the repository name is not valid');
  if (!CONVERTERS.has(entry.converter)) fail('sources.json: the converter is not one of the known ones');
  if (typeof entry.license !== 'string' || !/^[A-Za-z0-9.+-]{1,40}$/.test(entry.license)) fail('sources.json: the license is not an SPDX identifier');
  if (!safePath(entry.licenseFile)) fail('sources.json: the license file path is not valid');
  if (typeof entry.sourceUrl !== 'string' || !entry.sourceUrl.startsWith('https://github.com/')) fail('sources.json: the source URL is not a github.com address');
  const files = Object.entries(entry.files ?? {});
  if (files.length === 0) fail('sources.json: the set lists no files');
  for (const [remote, local] of files) {
    if (!safePath(remote) || !safePath(local) || !local.startsWith('source/')) fail('sources.json: a file path is not valid');
  }

  const apiBase = (() => {
    const v = process.env.COLONY_RULESETS_API_BASE;
    if (v === undefined) return DEFAULT_API;
    const u = new URL(v);
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
    if (!loopback) fail('COLONY_RULESETS_API_BASE must be a loopback address (it exists for the tests)', 2);
    return v.replace(/\/+$/, '');
  })();

  const setDir = join(rulesetsDir, setName);
  if (!(setDir + sep).startsWith(rulesetsDir + sep)) fail('the rule set folder is outside the rule sets folder', 2);
  if (!existsSync(join(setDir, 'PROVENANCE.json'))) fail(`'${setName}' has no PROVENANCE.json: it is not an adopted rule set yet`, 2);
  const before = JSON.parse(readFileSync(join(setDir, 'PROVENANCE.json'), 'utf-8'));

  const plan = {
    set: setName,
    from: before.version,
    to: tag,
    repository: entry.repo,
    api: apiBase,
    requests: [
      `GET /repos/${entry.repo}`,
      `GET /repos/${entry.repo}/git/ref/tags/${tag}`,
      `GET /repos/${entry.repo}/commits/${tag}`,
      ...[...files.map(([r]) => r), entry.licenseFile].map((p) => `GET /repos/${entry.repo}/contents/${p}?ref=${tag}`),
    ],
  };
  if (dryRun || !yes) {
    console.log(JSON.stringify({ plan, note: 'Nothing was fetched or changed.' }, null, 2));
    if (!dryRun) fail('this contacts the network and replaces the files of the rule set. Look at the plan above, then add --yes.', 2);
    return;
  }

  // ---- the network, with nothing but the known host

  async function getJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${apiBase}${path}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'colony-rulesets-update/1.0' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (res.status === 404) return { status: 404, body: null };
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_JSON_BYTES) {
          await reader.cancel();
          throw new Error(`the answer for ${path} is larger than ${MAX_JSON_BYTES} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
      return { status: res.status, body: JSON.parse(Buffer.concat(chunks).toString('utf-8')) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function download(remotePath) {
    const { status, body } = await getJson(`/repos/${entry.repo}/contents/${remotePath}?ref=${encodeURIComponent(tag)}`);
    if (status === 404) fail(`${remotePath} does not exist at the tag ${tag}: the upstream may have moved or renamed it. Nothing was changed.`);
    if (body.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string') fail(`${remotePath} is not a plain file the API can hand over (too large, or not a file). Nothing was changed.`);
    if (typeof body.size !== 'number' || body.size > MAX_FILE_BYTES) fail(`${remotePath} is larger than ${MAX_FILE_BYTES} bytes. Nothing was changed.`);
    const bytes = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
    if (bytes.length !== body.size) fail(`${remotePath}: the downloaded size ${bytes.length} differs from the size the repository reports (${body.size}). Nothing was changed.`);
    const blob = gitBlobSha1(bytes);
    if (blob !== body.sha) fail(`${remotePath}: the git blob hash of the downloaded bytes (${blob}) is not the one the repository reports for this tag (${body.sha}). Nothing was changed.`);
    return bytes;
  }

  let commit;
  const fetched = new Map();
  let licenseBytes;
  try {
    const meta = await getJson(`/repos/${entry.repo}`);
    if (meta.status === 404) fail(`the repository ${entry.repo} was not found. Nothing was changed.`);
    const spdx = meta.body?.license?.spdx_id ?? null;
    if (spdx !== entry.license) fail(`the license of ${entry.repo} is now ${spdx ?? 'unknown'}, not ${entry.license} (what the set was adopted under). This needs a decision, not an update. Nothing was changed.`);

    const ref = await getJson(`/repos/${entry.repo}/git/ref/tags/${tag}`);
    if (ref.status === 404) fail(`${tag} is not a tag of ${entry.repo}. A branch can move under you; only a release tag is accepted. Nothing was changed.`);
    const commitInfo = await getJson(`/repos/${entry.repo}/commits/${tag}`);
    commit = commitInfo.body?.sha;
    if (!/^[0-9a-f]{40}$/.test(commit ?? '')) fail('the repository did not give a commit hash for the tag. Nothing was changed.');

    for (const [remote] of files) fetched.set(remote, await download(remote));
    licenseBytes = await download(entry.licenseFile);
  } catch (err) {
    if (err instanceof Stop) throw err;
    const cause = err.cause?.code ?? err.cause?.message;
    fail(`the download failed (${err.name === 'AbortError' ? 'timeout' : [err.message, cause].filter(Boolean).join(': ')}). Nothing was changed.`);
  }

  // ---- replace, convert, check; put everything back on any failure

  const oldRules = (() => {
    try {
      return JSON.parse(readFileSync(join(setDir, before.normalized.file), 'utf-8')).rules ?? [];
    } catch {
      return [];
    }
  })();
  const backup = mkdtempSync(join(tmpdir(), 'colony-rulesets-backup-'));
  cpSync(setDir, join(backup, 'set'), { recursive: true });
  const restore = (why) => {
    rmSync(setDir, { recursive: true, force: true });
    cpSync(join(backup, 'set'), setDir, { recursive: true });
    rmSync(backup, { recursive: true, force: true });
    fail(`${why}\nThe previous rule set was put back; nothing was changed.`);
  };

  rmSync(join(setDir, 'source'), { recursive: true, force: true });
  for (const [remote, local] of files) {
    mkdirSync(dirname(join(setDir, local)), { recursive: true });
    writeFileSync(join(setDir, local), fetched.get(remote));
  }
  writeFileSync(join(setDir, 'LICENSE'), licenseBytes);

  const today = new Date().toISOString().slice(0, 10);
  const converted = spawnSync(
    process.execPath,
    [join(root, 'scripts', entry.converter), '--dir', setDir, '--name', setName, '--version', tag, '--commit', commit, '--source-url', entry.sourceUrl.split('{tag}').join(tag), '--license', entry.license, '--retrieved', today],
    { encoding: 'utf-8' },
  );
  if (converted.status !== 0) restore(`the converter failed (the new release may use something this version of the converter does not know):\n${(converted.stderr || converted.stdout).slice(0, 600)}`);

  let loaded;
  try {
    const { loadRulesetSync } = await import(pathToFileURL(join(root, 'dist', 'rulesets', 'loader.js')).href);
    loaded = loadRulesetSync(setDir);
  } catch (err) {
    restore(`the converted set does not pass the loader's checks (${err.message})`);
  }

  // ---- what changed

  const keyed = (rules) => new Map(rules.map((r) => [r.id, JSON.stringify(r)]));
  const newRules = JSON.parse(readFileSync(join(setDir, 'ruleset.json'), 'utf-8')).rules;
  const a = keyed(oldRules);
  const b = keyed(newRules);
  const added = [...b.keys()].filter((id) => !a.has(id));
  const removed = [...a.keys()].filter((id) => !b.has(id));
  const changed = [...b.keys()].filter((id) => a.has(id) && a.get(id) !== b.get(id));
  const after = JSON.parse(readFileSync(join(setDir, 'PROVENANCE.json'), 'utf-8'));
  const list = (ids) => ({ count: ids.length, ids: ids.slice(0, 30), ...(ids.length > 30 ? { more: ids.length - 30 } : {}) });
  const licenseChanged = sha256(licenseBytes) !== before.licenseFile?.sha256;

  rmSync(backup, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        set: setName,
        from: before.version,
        to: tag,
        commit,
        files: [...fetched.entries()].map(([remote, bytes]) => ({ file: remote, bytes: bytes.length, gitBlobSha1: gitBlobSha1(bytes) })),
        license: { spdx: entry.license, textChanged: licenseChanged },
        rules: { before: oldRules.length, after: newRules.length, added: list(added), removed: list(removed), changed: list(changed) },
        skipped: { before: before.report?.skipped?.length ?? 0, after: after.report.skipped.length, now: after.report.skipped.map((s) => `${s.id}: ${s.reason}`).slice(0, 10) },
        verified: `${loaded.name} ${loaded.version} passes the loader's hash checks`,
        next: [
          licenseChanged ? 'THE LICENSE TEXT CHANGED: read it before you accept this update.' : null,
          `Review: git diff --stat rulesets/${setName}`,
          'Run: pnpm test, then pnpm rulesets:verify',
          `Commit it as a change of its own and open a pull request. To go back: git checkout -- rulesets/${setName}`,
        ].filter(Boolean),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  if (err instanceof Stop) {
    console.error(err.message);
    process.exitCode = err.code;
  } else {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
});
