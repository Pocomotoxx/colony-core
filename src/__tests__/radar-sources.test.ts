import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../cli/commands.js';
import { parseRepositoryField, proposeSources } from '../radar/sources.js';

let root: string;
let n = 0;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-radar-sources-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const exec = async (dir: string, ...args: string[]) => runCommand([...args, '--dir', dir], process.cwd());
const ok = async (dir: string, ...args: string[]) => {
  const r = await exec(dir, ...args);
  assert.equal(r.code, 0, JSON.stringify(r.output));
  return r.output as any;
};
const bad = async (dir: string, ...args: string[]) => {
  const r = await exec(dir, ...args);
  assert.notEqual(r.code, 0, `expected failure: ${args.join(' ')}`);
  return String((r.output as any).error);
};

async function installed(dir: string, name: string, content: unknown) {
  const folder = path.join(dir, 'node_modules', ...name.split('/'));
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'package.json'), typeof content === 'string' ? content : JSON.stringify(content));
}

/** A project with a package.json and a small, hand-made node_modules. */
async function project() {
  const dir = path.join(root, `p${n++}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'my-app',
    dependencies: { a: '^1.0.0', b: '^2.0.0', '@scope/h': '^1.0.0', '@scope/i': '^1.0.0', e: '^1.0.0', f: '^1.0.0', g: '^1.0.0', '../evil': '^1.0.0' },
    optionalDependencies: { c: '^3.0.0' },
    devDependencies: { d: '^1.0.0', j: '^1.0.0', a: '^9.9.9' },
  }));
  await installed(dir, 'a', { name: 'a', repository: 'github:o1/a' });
  await installed(dir, 'b', { name: 'b', repository: { type: 'git', url: 'git+https://github.com/o2/b.git' } });
  await installed(dir, 'c', { name: 'c', repository: 'o3/c' });
  await installed(dir, 'd', { name: 'd', repository: { url: 'git@github.com:o4/d.git' } });
  await installed(dir, 'e', { name: 'e', repository: { url: 'https://gitlab.com/x/y.git' } });
  await installed(dir, 'f', { name: 'f' });
  await installed(dir, '@scope/h', { name: '@scope/h', repository: { url: 'https://github.com/o5/mono', directory: 'packages/h' } });
  await installed(dir, '@scope/i', { name: '@scope/i', repository: 'https://github.com/O5/Mono.git' });
  await installed(dir, 'j', '{ not json');
  assert.equal((await runCommand(['boot', '--dir', dir], process.cwd())).code, 0);
  return dir;
}

test('the repository field is read in every form npm allows, and other hosts are named', () => {
  const repo = (v: unknown) => (parseRepositoryField(v) as any).repo;
  const reason = (v: unknown) => (parseRepositoryField(v) as any).reason;
  assert.equal(repo('github:owner/repo'), 'owner/repo');
  assert.equal(repo('owner/repo'), 'owner/repo');
  assert.equal(repo('owner/repo#main'), 'owner/repo');
  assert.equal(repo('https://github.com/owner/repo'), 'owner/repo');
  assert.equal(repo('https://github.com/owner/repo.git'), 'owner/repo');
  assert.equal(repo('git+https://github.com/owner/repo.git'), 'owner/repo');
  assert.equal(repo('git://github.com/owner/repo.git'), 'owner/repo');
  assert.equal(repo('git+ssh://git@github.com/owner/repo.git'), 'owner/repo');
  assert.equal(repo('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(repo('https://github.com/owner/repo/tree/main/packages/x'), 'owner/repo');
  assert.equal(repo({ type: 'git', url: 'git+https://github.com/owner/repo.git', directory: 'packages/x' }), 'owner/repo');
  assert.match(reason('gitlab:owner/repo'), /not on GitHub \(gitlab\)/);
  assert.match(reason('https://gitlab.com/owner/repo.git'), /not on GitHub \(gitlab\.com\)/);
  assert.match(reason('bitbucket:owner/repo'), /bitbucket/);
  assert.match(reason('https://example.org/x/y'), /not on GitHub \(example\.org\)/);
  assert.match(reason(undefined), /no repository field/);
  assert.match(reason(''), /no repository field/);
  assert.match(reason({}), /no repository field/);
  assert.match(reason(42), /no repository field/);
  assert.match(reason('https://github.com/own er/repo'), /not understood|not a valid|not on GitHub/);
});

test('the proposal reads package.json and the repository field of each installed dependency, groups a monorepo, and says why the rest has none', async () => {
  const dir = await project();
  const p = await proposeSources(dir);
  assert.equal(p.packageName, 'my-app');
  assert.equal(p.truncated, false);
  const byRepo = Object.fromEntries(p.repos.map((r) => [r.repo.toLowerCase(), r.via]));
  assert.deepEqual(byRepo['o5/mono'], ['@scope/h', '@scope/i'], 'two packages of one repository come out once');
  assert.deepEqual(Object.keys(byRepo).sort(), ['o1/a', 'o2/b', 'o3/c', 'o4/d', 'o5/mono']);
  assert.equal(p.repos[0].via.length, 2, 'the repository with the most packages comes first');
  const why = Object.fromEntries(p.unresolved.map((u) => [u.name, u.reason]));
  assert.match(why.e, /not on GitHub \(gitlab\.com\)/);
  assert.match(why.f, /no repository field/);
  assert.match(why.g, /not installed/);
  assert.match(why['../evil'], /not a valid package name/);
  assert.match(why.j, /not valid JSON/);
  assert.equal(p.considered, 11, 'a dependency listed twice is counted once');
});

test('a dependency whose folder is a link that leaves the project is not read', async () => {
  const dir = await project();
  const outside = path.join(root, `outside${n++}`);
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'package.json'), JSON.stringify({ name: 's', repository: 'github:elsewhere/secret' }));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { s: '^1.0.0' } }));
  try {
    await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
    await fs.symlink(outside, path.join(dir, 'node_modules', 's'), 'junction');
  } catch {
    return; // this system does not let the test make a link: nothing to check
  }
  const p = await proposeSources(dir);
  assert.deepEqual(p.repos, []);
  assert.match(p.unresolved[0].reason, /resolves outside the project/);
});

test('radar sources shows the proposal and the approved list; nothing is fetched or chosen for you', async () => {
  const dir = await project();
  const r = await ok(dir, 'radar', 'sources');
  assert.equal(r.package, 'my-app');
  assert.equal(r.proposed.length, 5);
  assert.ok(r.proposed.every((x: any) => x.approved === false));
  assert.deepEqual(r.approved, []);
  assert.ok(r.unresolved.length >= 5);
  assert.match(r.note, /Nothing was fetched/);
  assert.match(r.note, /check the name before you approve/);
});

test('approve takes names or the whole proposal, keeps the list, and marks what was approved by name only', async () => {
  const dir = await project();
  const one = await ok(dir, 'radar', 'sources', 'approve', 'o1/a');
  assert.deepEqual(one.added, ['o1/a']);
  const manual = await ok(dir, 'radar', 'sources', 'approve', 'someone/else');
  assert.deepEqual(manual.added, ['someone/else']);
  assert.ok(manual.warnings.some((w: string) => /not found among your dependencies, approved by name: someone\/else/.test(w)));
  const all = await ok(dir, 'radar', 'sources', 'approve', '--all');
  assert.deepEqual(all.alreadyApproved, ['o1/a']);
  assert.equal(all.added.length, 4);
  assert.equal(all.approved.length, 6);
  const stored = JSON.parse(await fs.readFile(path.join(dir, '.colony', 'radar', 'sources.json'), 'utf-8')).repos;
  assert.equal(stored.find((s: any) => s.repo === 'o1/a').how, 'proposal');
  assert.deepEqual(stored.find((s: any) => s.repo === 'o1/a').via, ['a']);
  assert.equal(stored.find((s: any) => s.repo === 'someone/else').how, 'manual');
  const shown = await ok(dir, 'radar', 'sources');
  assert.ok(shown.proposed.every((x: any) => x.approved === true));
  assert.equal(shown.approved.length, 6);
  assert.equal((await ok(dir, 'audit', 'list', '--type', 'radar.sources.approved')).entries.length, 3);
  assert.equal((await ok(dir, 'audit', 'verify')).ok, true);
});

test('remove takes a repository off the list; a bad call or a bad name is refused', async () => {
  const dir = await project();
  await ok(dir, 'radar', 'sources', 'approve', '--all');
  const r = await ok(dir, 'radar', 'sources', 'remove', 'O5/MONO');
  assert.deepEqual(r.removed, ['o5/mono'], 'the name is matched without regard to case, and removed as it was stored');
  assert.equal(r.approved.length, 4);
  assert.match(await bad(dir, 'radar', 'sources', 'remove', 'not/there'), /none of these is on the approved list/);
  assert.match(await bad(dir, 'radar', 'sources', 'remove'), /usage: radar/);
  assert.match(await bad(dir, 'radar', 'sources', 'approve'), /either one or more owner\/repo names, or --all/);
  assert.match(await bad(dir, 'radar', 'sources', 'approve', 'o1/a', '--all'), /either one or more/);
  assert.match(await bad(dir, 'radar', 'sources', 'approve', 'not a repo'), /not an owner\/repo name/);
  assert.match(await bad(dir, 'radar', 'sources', 'approve', '../x'), /not an owner\/repo name/);
  assert.match(await bad(dir, 'radar', 'sources', 'banana'), /usage: radar/);
});

test('the list holds at most 20 repositories', async () => {
  const dir = await project();
  const names = Array.from({ length: 22 }, (_, i) => `owner/repo${i}`);
  const r = await ok(dir, 'radar', 'sources', 'approve', ...names);
  assert.equal(r.added.length, 20);
  assert.equal(r.leftOut.length, 2);
  assert.ok(r.warnings.some((w: string) => /at most 20 repositories: 2 left out/.test(w)));
});

test('without a package.json the proposal says what is needed, but the list can still be edited by name', async () => {
  const dir = path.join(root, `empty${n++}`);
  await fs.mkdir(dir, { recursive: true });
  await ok(dir, 'boot');
  assert.match(await bad(dir, 'radar', 'sources'), /package\.json: not found\. The proposal is made from the dependencies/);
  assert.match(await bad(dir, 'radar', 'sources', 'approve', '--all'), /package\.json/);
  assert.deepEqual((await ok(dir, 'radar', 'sources', 'approve', 'o/r')).added, ['o/r']);
  assert.deepEqual((await ok(dir, 'radar', 'sources', 'remove', 'o/r')).removed, ['o/r']);
  await fs.writeFile(path.join(dir, 'package.json'), '{ nope');
  assert.match(await bad(dir, 'radar', 'sources'), /not valid JSON/);
  await fs.writeFile(path.join(dir, 'package.json'), '[]');
  assert.match(await bad(dir, 'radar', 'sources'), /must hold a JSON object/);
});

test('the sources commands are in the usage text', async () => {
  const help = (await runCommand(['help'], process.cwd())).output as any;
  assert.match(help.usage, /radar sources approve --all/);
  assert.match(help.usage, /radar sources remove <owner\/repo>/);
});
