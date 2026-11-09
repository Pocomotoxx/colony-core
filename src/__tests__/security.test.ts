import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalize, isWithin, resolveInside, SafePathError } from '../safe-path.js';
import { safeGitArgv } from '../safe-git.js';
import { resolveRevision } from '../cli/session.js';
import { runCommand } from '../cli/commands.js';

let root: string;
let outside: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-sec-test-'));
  outside = path.join(root, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.md'), 'not for the colony\n', 'utf-8');
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const code = async (fn: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await fn();
  } catch (err) {
    return err instanceof SafePathError ? err.code : String(err);
  }
  return undefined;
};

/** A directory link that needs no privilege on Windows (a junction) and is a plain symlink elsewhere. */
const linkDir = (target: string, link: string) => fs.symlink(target, link, 'junction');

// ---- safe-path

test('isWithin anchors at a path boundary', () => {
  const base = path.resolve('/srv/app');
  assert.equal(isWithin(base, base), true);
  assert.equal(isWithin(base, path.join(base, 'src', 'a.ts')), true);
  assert.equal(isWithin(base, path.resolve('/srv/app-secrets/a')), false);
  assert.equal(isWithin(base, path.resolve('/srv')), false);
});

test('resolveInside accepts existing and not-yet-existing paths inside the root', async () => {
  const project = path.join(root, 'proj-ok');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  const existing = await resolveInside(project, 'src');
  assert.equal(existing.relative, 'src');
  const future = await resolveInside(project, path.join('src', 'new', 'file.ts'));
  assert.equal(future.relative, path.join('src', 'new', 'file.ts'));
  assert.equal((await resolveInside(project, '.')).relative, '');
  assert.equal((await resolveInside(project, 'a..b')).relative, 'a..b'); // an honest name is not a traversal
});

test('resolveInside refuses traversal, absolute escapes, empty and NUL input', async () => {
  const project = path.join(root, 'proj-bad');
  await fs.mkdir(project, { recursive: true });
  assert.equal(await code(() => resolveInside(project, '../outside/secret.md')), 'OUTSIDE');
  assert.equal(await code(() => resolveInside(project, path.join(outside, 'secret.md'))), 'OUTSIDE');
  assert.equal(await code(() => resolveInside(project, 'a/../../x')), 'OUTSIDE');
  assert.equal(await code(() => resolveInside(project, '   ')), 'EMPTY');
  assert.equal(await code(() => resolveInside(project, 'a\0b')), 'NUL');
  assert.equal(await code(() => resolveInside(project, 'x'.repeat(5000))), 'TOO_LONG');
});

test('a link inside the root that points outside is refused, even for a file that does not exist yet', async () => {
  const project = path.join(root, 'proj-link');
  await fs.mkdir(project, { recursive: true });
  await linkDir(outside, path.join(project, 'link'));
  assert.equal(await code(() => resolveInside(project, 'link/secret.md')), 'OUTSIDE');
  assert.equal(await code(() => resolveInside(project, 'link/not-yet/new.md')), 'OUTSIDE');
});

test('a root reached through a link still contains its own files', async () => {
  const real = path.join(root, 'real-root');
  await fs.mkdir(path.join(real, 'src'), { recursive: true });
  const alias = path.join(root, 'alias-root');
  await linkDir(real, alias);
  const result = await resolveInside(alias, 'src');
  assert.equal(result.relative, 'src');
  assert.equal(result.resolved, await canonicalize(path.join(real, 'src')));
});

// ---- safe-git

test('safeGitArgv puts the fsmonitor override before everything else and rejects NUL bytes', () => {
  assert.deepEqual(safeGitArgv('/repo', ['status']), ['-c', 'core.fsmonitor=false', '-C', '/repo', 'status']);
  assert.throws(() => safeGitArgv('', ['status']), /invalid/);
  assert.throws(() => safeGitArgv('/repo', ['a\0b']), /NUL/);
});

test('a repository cannot run its own command through core.fsmonitor while the revision is read', async (t) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    return t.diagnostic('git is not available: nothing to check'); // reported, not a failure
  }
  const repo = path.join(root, 'hostile-repo');
  await fs.mkdir(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  await fs.writeFile(path.join(repo, 'dirty.txt'), 'x', 'utf-8');

  const marker = path.join(root, 'fsmonitor-ran');
  const hook = path.join(root, 'hook.mjs');
  await fs.writeFile(hook, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');`, 'utf-8');
  git('config', 'core.fsmonitor', `node ${JSON.stringify(hook.replace(/\\/g, '/'))}`);

  const revision = resolveRevision(repo);
  assert.match(revision.sha, /^[0-9a-f]{40}$/);
  assert.equal(revision.dirty, true);
  assert.equal(await fs.access(marker).then(() => true, () => false), false);
});

// ---- CLI

async function project(name: string) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const run = async (...args: string[]) => {
    const { code: exit, output } = await runCommand(args, dir);
    return { code: exit, out: output as any };
  };
  return { dir, run };
}

test('a rule file reached through a link that leaves the rules directory blocks boot', async () => {
  const { dir, run } = await project('rules-link');
  assert.equal((await run('boot')).code, 0);
  const rulesDir = path.join(dir, '.colony', 'rules');
  await linkDir(outside, path.join(rulesDir, 'escape'));
  await fs.writeFile(path.join(rulesDir, 'manifest.json'), JSON.stringify({ mandatory: ['escape/secret.md'] }), 'utf-8');

  const boot = await run('boot');
  assert.equal(boot.code, 2);
  assert.equal(boot.out.boot.status, 'BLOCKED');
  assert.ok(boot.out.boot.problems.some((p: string) => /outside the rules directory/.test(p)));
  assert.ok(!JSON.stringify(boot.out).includes('not for the colony'));
});

test('check --file refuses a link that leaves the project, and does not read the target', async () => {
  const { dir, run } = await project('check-link');
  assert.equal((await run('boot')).code, 0);
  await linkDir(outside, path.join(dir, 'link'));
  const r = await run('check', '--file', 'link/secret.md');
  assert.equal(r.code, 1);
  assert.match(r.out.error, /inside the project/);
});
