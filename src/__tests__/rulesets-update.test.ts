import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBlobSha1, loadRuleset } from '../rulesets/loader.js';

// The update script is tested against a fake GitHub API on a loopback port: no real request is made.

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repo, 'scripts', 'rulesets-update.mjs');
const vendored = path.join(repo, 'rulesets');

interface Upstream {
  license: string | null;
  tags: Set<string>;
  commit: string;
  files: Record<string, Buffer>;
  /** A blob hash the server reports in place of the true one, per path. */
  lie: Record<string, string>;
  redirect: boolean;
}

let server: http.Server;
let base = '';
let requests: Array<{ url: string; auth: string | undefined; agent: string | undefined }> = [];
let upstream: Record<string, Upstream> = {};

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

before(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', auth: req.headers.authorization, agent: req.headers['user-agent'] });
    const url = new URL(req.url ?? '', 'http://x');
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
    const up = m ? upstream[m[1]] : undefined;
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (!m || !up) return send(404);
    if (up.redirect) {
      res.writeHead(302, { Location: 'http://example.invalid/elsewhere' });
      return void res.end();
    }
    const rest = m[2] ?? '';
    if (rest === '') return send(200, { license: up.license === null ? null : { spdx_id: up.license } });
    const tagRef = /^\/git\/ref\/tags\/(.+)$/.exec(rest);
    if (tagRef) return up.tags.has(tagRef[1]) ? send(200, { ref: `refs/tags/${tagRef[1]}` }) : send(404);
    if (/^\/commits\/.+$/.test(rest)) return send(200, { sha: up.commit });
    const contents = /^\/contents\/(.+)$/.exec(rest);
    if (contents) {
      const file = up.files[decodeURIComponent(contents[1])];
      if (!file) return send(404);
      const b64 = file.toString('base64').replace(/(.{60})/g, '$1\n');
      return send(200, { type: 'file', encoding: 'base64', size: file.length, sha: up.lie[contents[1]] ?? gitBlobSha1(file), content: b64 });
    }
    return send(404);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
});

let root: string;
let n = 0;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-rsupdate-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const sourcesFile = JSON.parse(await fs.readFile(path.join(vendored, 'sources.json'), 'utf-8'));
const gitleaksTomlPath = Object.keys(sourcesFile.sets.gitleaks.files)[0];

async function read(rel: string): Promise<Buffer> {
  return fs.readFile(path.join(vendored, rel));
}

/** A new upstream release of the gitleaks set: one rule added, one removed, one changed. */
async function gitleaksRelease(): Promise<Buffer> {
  let toml = (await read('gitleaks/source/gitleaks.toml')).toString('utf-8');
  const block = /\[\[rules\]\]\r?\nid = "zendesk-secret-key"[\s\S]*?(?=\[\[rules\]\]|$)/;
  assert.ok(block.test(toml), 'the rule that the test removes exists');
  toml = toml.replace(block, '');
  toml = toml.replace('entropy = 3.5', 'entropy = 3.6'); // some rule changes
  toml += '\n[[rules]]\nid = "test-new-rule"\ndescription = "a rule that is new in this release"\nregex = \'\'\'zz_[a-z]{10}\'\'\'\nkeywords = ["zz_"]\n';
  return Buffer.from(toml, 'utf-8');
}

async function freshUpstream(): Promise<void> {
  const files: Record<string, Buffer> = {};
  files[gitleaksTomlPath] = await read('gitleaks/source/gitleaks.toml');
  files['LICENSE'] = await read('gitleaks/LICENSE');
  upstream = {
    'gitleaks/gitleaks': { license: 'MIT', tags: new Set(['v9.9.9']), commit: COMMIT, files, lie: {}, redirect: false },
    'data-privacy-stack/presidio': { license: 'MIT', tags: new Set(['v9.9.9']), commit: COMMIT, files: {}, lie: {}, redirect: false },
  };
  for (const remote of Object.keys(sourcesFile.sets.presidio.files)) {
    upstream['data-privacy-stack/presidio'].files[remote] = await read(`presidio/${sourcesFile.sets.presidio.files[remote]}`);
  }
  upstream['data-privacy-stack/presidio'].files['LICENSE'] = await read('presidio/LICENSE');
}
beforeEach(async () => {
  requests = [];
  await freshUpstream();
});

async function workCopy(): Promise<string> {
  const dest = path.join(root, `rulesets${n++}`);
  await fs.cp(vendored, dest, { recursive: true });
  return dest;
}

async function snapshot(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (d: string): Promise<void> => {
    for (const e of (await fs.readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else hash.update(path.relative(dir, p)).update(await fs.readFile(p));
    }
  };
  await walk(dir);
  return hash.digest('hex');
}

function run(rulesetsDir: string, args: string[], env: Record<string, string | undefined> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [script, '--rulesets-dir', rulesetsDir, ...args], { env: { ...process.env, COLONY_RULESETS_API_BASE: base, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('nothing is fetched or changed without --yes, and a dry run only prints the plan', async () => {
  const dir = await workCopy();
  const before = await snapshot(dir);
  const noYes = await run(dir, ['--set', 'gitleaks', '--tag', 'v9.9.9']);
  assert.equal(noYes.code, 2);
  assert.match(noYes.stderr, /--yes/);
  const plan = JSON.parse(noYes.stdout).plan;
  assert.equal(plan.from, 'v8.30.1');
  assert.equal(plan.to, 'v9.9.9');
  assert.ok(plan.requests.some((r: string) => r.includes('contents/config/gitleaks.toml?ref=v9.9.9')));
  const dry = await run(dir, ['--set', 'gitleaks', '--tag', 'v9.9.9', '--dry-run']);
  assert.equal(dry.code, 0);
  assert.equal(requests.length, 0, 'no request was made');
  assert.equal(await snapshot(dir), before);
});

test('an update downloads the tag, proves the files, converts, checks the result, and says what changed', async () => {
  const dir = await workCopy();
  const release = await gitleaksRelease();
  upstream['gitleaks/gitleaks'].files[gitleaksTomlPath] = release;
  const before = await loadRuleset(path.join(dir, 'gitleaks'));

  const r = await run(dir, ['--set', 'gitleaks', '--tag', 'v9.9.9', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.from, 'v8.30.1');
  assert.equal(out.to, 'v9.9.9');
  assert.equal(out.commit, COMMIT);
  assert.deepEqual(out.rules.added.ids, ['test-new-rule']);
  assert.deepEqual(out.rules.removed.ids, ['zendesk-secret-key']);
  assert.ok(out.rules.changed.count >= 1, 'a rule whose entropy changed');
  assert.equal(out.rules.after, out.rules.before, 'one added, one removed');
  assert.equal(out.license.textChanged, false);
  assert.match(out.verified, /gitleaks v9\.9\.9 passes/);
  assert.ok(out.next.some((s: string) => /git diff --stat rulesets\/gitleaks/.test(s)));

  const set = await loadRuleset(path.join(dir, 'gitleaks'));
  assert.equal(set.version, 'v9.9.9');
  assert.equal(set.provenance.commit, COMMIT);
  assert.equal(set.rules.length, before.rules.length);
  assert.deepEqual(await fs.readFile(path.join(dir, 'gitleaks', 'source', 'gitleaks.toml')), release, 'the bytes of the release, unchanged');
  assert.equal(set.provenance.sourceUrl, 'https://github.com/gitleaks/gitleaks/blob/v9.9.9/config/gitleaks.toml');

  // only the known host's known paths were asked for, without credentials
  assert.ok(requests.every((q) => q.auth === undefined), 'no credentials are sent');
  assert.ok(requests.every((q) => q.agent === 'colony-rulesets-update/1.0'));
  assert.deepEqual(requests.map((q) => q.url.split('?')[0]), [
    '/repos/gitleaks/gitleaks',
    '/repos/gitleaks/gitleaks/git/ref/tags/v9.9.9',
    '/repos/gitleaks/gitleaks/commits/v9.9.9',
    `/repos/gitleaks/gitleaks/contents/${gitleaksTomlPath}`,
    '/repos/gitleaks/gitleaks/contents/LICENSE',
  ]);
});

test('a set with several files (presidio) updates the same way; identical content changes no rule', async () => {
  const dir = await workCopy();
  const r = await run(dir, ['--set', 'presidio', '--tag', 'v9.9.9', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.rules.added.count, out.rules.removed.count, out.rules.changed.count], [0, 0, 0]);
  assert.equal(out.files.length, 4);
  const set = await loadRuleset(path.join(dir, 'presidio'));
  assert.equal(set.version, 'v9.9.9');
  assert.equal(set.pii.length, 83);
});

test('a changed license text is reported loudly', async () => {
  const dir = await workCopy();
  upstream['gitleaks/gitleaks'].files['LICENSE'] = Buffer.from('MIT License\n\nCopyright (c) someone else\n');
  const r = await run(dir, ['--set', 'gitleaks', '--tag', 'v9.9.9', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.license.textChanged, true);
  assert.ok(out.next.some((s: string) => /THE LICENSE TEXT CHANGED/.test(s)));
});

async function refused(args: string[], expect: RegExp, setup?: () => void, code = 1): Promise<string> {
  await freshUpstream();
  requests = [];
  const dir = await workCopy();
  const before = await snapshot(dir);
  setup?.();
  const r = await run(dir, args);
  assert.equal(r.code, code, r.stdout + r.stderr);
  assert.match(r.stderr, expect);
  assert.equal(await snapshot(dir), before, 'the vendored files are exactly as they were');
  return dir;
}
const update = ['--set', 'gitleaks', '--tag', 'v9.9.9', '--yes'];

test('a file whose bytes do not match the hash the repository reports is refused', async () => {
  await refused(update, /git blob hash of the downloaded bytes/, () => {
    upstream['gitleaks/gitleaks'].lie[gitleaksTomlPath] = '0'.repeat(40);
  });
});

test('a branch or an unknown name is not a tag; a changed license; a missing file; a redirect: all refused, nothing changed', async () => {
  await refused(['--set', 'gitleaks', '--tag', 'main', '--yes'], /not a tag/);
  await refused(update, /license of gitleaks\/gitleaks is now AGPL-3\.0, not MIT/, () => {
    upstream['gitleaks/gitleaks'].license = 'AGPL-3.0';
  });
  await refused(update, /does not exist at the tag v9\.9\.9/, () => {
    delete upstream['gitleaks/gitleaks'].files[gitleaksTomlPath];
  });
  await refused(update, /download failed/, () => {
    upstream['gitleaks/gitleaks'].redirect = true;
  });
  await refused(update, /larger than 1000000 bytes/, () => {
    upstream['gitleaks/gitleaks'].files[gitleaksTomlPath] = Buffer.alloc(1_200_000, 'a');
  });
});

test('when the converter cannot read the new release, the previous rule set is put back', async () => {
  const dir = await refused(update, /converter failed[\s\S]*previous rule set was put back/, () => {
    upstream['gitleaks/gitleaks'].files[gitleaksTomlPath] = Buffer.from('title = "x"\nrules.a = 1\n');
  });
  assert.equal((await loadRuleset(path.join(dir, 'gitleaks'))).version, 'v8.30.1', 'and it still loads');
});

test('bad names, an unknown set, a non-loopback API base and a path that leaves the folder are refused before anything happens', async () => {
  const dir = await workCopy();
  assert.equal((await run(dir, ['--set', 'nope', '--tag', 'v1', '--yes'])).code, 2);
  assert.equal((await run(dir, ['--set', 'gitleaks', '--tag', '../evil', '--yes'])).code, 2);
  assert.equal((await run(dir, ['--set', '../gitleaks', '--tag', 'v1', '--yes'])).code, 2);
  const remote = await run(dir, update, { COLONY_RULESETS_API_BASE: 'https://example.com' });
  assert.equal(remote.code, 2);
  assert.match(remote.stderr, /loopback/);

  const bad = JSON.parse(await fs.readFile(path.join(dir, 'sources.json'), 'utf-8'));
  bad.sets.gitleaks.files = { '../../etc/passwd': 'source/gitleaks.toml' };
  await fs.writeFile(path.join(dir, 'sources.json'), JSON.stringify(bad));
  const trav = await run(dir, update);
  assert.equal(trav.code, 1);
  assert.match(trav.stderr, /file path is not valid/);
  assert.equal(requests.length, 0, 'none of these reached the network');
});
