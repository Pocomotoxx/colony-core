import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../cli/commands.js';
import { runHook } from '../hook/cli.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const launcher = path.join(repo, 'scripts', 'start.mjs');

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-start-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function folder(name: string) {
  const dir = path.join(root, name);
  await fs.mkdir(dir);
  return dir;
}

test('start boots the project and says how to work, with the project folder filled in', async () => {
  const dir = await folder('project');
  const r = await runCommand(['start', '--dir', dir], process.cwd());
  const out = r.output as any;
  assert.equal(r.code, 0);
  assert.equal(out.ok, true);
  assert.ok(['LOADED', 'UNVERIFIABLE'].includes(out.boot.status));
  assert.ok(out.rules.length >= 3, 'the rules are in the output');
  assert.equal(out.hooks.installed, false);
  assert.match(out.hooks.hint, /hook install --apply --dir/);
  const text = out.workflow.join('\n');
  assert.match(text, /task add/);
  assert.match(text, /next --as engineer/);
  assert.match(text, /done <task id>/);
  assert.ok(text.includes(`--dir "${dir}"`), 'every command carries the project folder');
  assert.match(text, /show it to the user before you start/);
  await fs.access(path.join(dir, '.colony', 'ledger.json')); // the state is in the project
});

test('start sees when the hooks are installed', async () => {
  const dir = await folder('with-hooks');
  assert.equal(((await runCommand(['start', '--dir', dir], process.cwd())).output as any).hooks.installed, false);
  await runHook('install', '', dir, dir, { apply: true });
  const after = (await runCommand(['start', '--dir', dir], process.cwd())).output as any;
  assert.equal(after.hooks.installed, true);
  assert.equal(after.hooks.hint, null);
});

test('start of a blocked project prints the problems and no workflow', async () => {
  const dir = await folder('blocked');
  await runCommand(['boot', '--dir', dir], process.cwd());
  await fs.writeFile(path.join(dir, '.colony', 'ledger.json'), '{ not json');
  const r = await runCommand(['start', '--dir', dir], process.cwd());
  const out = r.output as any;
  assert.equal(r.code, 2);
  assert.equal(out.boot.status, 'BLOCKED');
  assert.equal(out.workflow, undefined);
  assert.equal(out.rules, undefined);
});

// ---- the launcher (the build step itself needs pnpm and the network; --no-build skips it)

const launch = (...args: string[]) => spawnSync(process.execPath, [launcher, ...args], { cwd: repo, encoding: 'utf-8' });

test('the launcher refuses a missing folder, the colony-core folder itself, and a missing argument', async () => {
  const none = launch('--no-build');
  assert.equal(none.status, 2);
  assert.match(none.stderr, /usage: node scripts\/start\.mjs <project folder>/);

  const existed = await fs.access(path.join(repo, '.colony')).then(() => true, () => false);
  const self = launch('--no-build', repo);
  assert.equal(self.status, 2);
  assert.match(self.stderr, /colony-core folder itself/);
  assert.equal(await fs.access(path.join(repo, '.colony')).then(() => true, () => false), existed, 'no state was created in colony-core');

  const missing = launch('--no-build', path.join(root, 'nope'));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /does not exist/);

  assert.equal(launch('--no-build', path.join(root, 'a'), path.join(root, 'b')).status, 2);
});

test('the launcher starts the colony on a project folder and passes the JSON through', async () => {
  const dir = await folder('launched');
  const r = launch('--no-build', dir);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.ok(out.workflow.join('\n').includes(dir));
  await fs.access(path.join(dir, '.colony', 'ledger.json'));
});
