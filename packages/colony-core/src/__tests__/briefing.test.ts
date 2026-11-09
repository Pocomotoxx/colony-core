import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../cli/commands.js';

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-briefing-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function project(name: string) {
  const dir = path.join(root, name);
  await fs.mkdir(dir);
  const run = async (...args: string[]) => {
    const { code, output } = await runCommand(args, dir);
    return { code, out: output as any };
  };
  await run('boot');
  return { dir, run };
}

test('next shows the profile and what the colony remembers, split into what worked and what to avoid', async () => {
  const { run } = await project('recall');
  await run('profile', 'answer', 'explain_depth', 'short');
  await run('profile', 'answer', 'comments', '--skip');

  const good = (await run('task', 'add', 'Parse the invoice feed', 'read invoice rows from the csv feed', '--role', 'engineer')).out.task.id;
  await run('next', '--as', 'engineer');
  await run('done', good, '--result', 'streamed the csv in chunks and validated each row', '--quality', '0.9');

  const bad = (await run('task', 'add', 'Parse the invoice feed again', 'read invoice rows from the csv feed once more', '--role', 'engineer')).out.task.id;
  await run('next', '--as', 'engineer');
  await run('done', bad, '--result', 'loaded the whole csv into memory at once', '--quality', '0.1');

  await run('task', 'add', 'Parse the invoice feed from the supplier', 'read invoice rows from the supplier csv feed', '--role', 'engineer');
  const next = await run('next', '--as', 'engineer');

  assert.deepEqual(next.out.profile, { explain_depth: 'short' }); // the skipped question is absent
  const { worked, caution, ask } = next.out.recall;
  assert.ok(worked.some((w: any) => /chunks/.test(w.approach) && w.rating === 0.9));
  assert.ok(caution.some((c: any) => /whole csv/.test(c.approach) && c.rating === 0.1));
  assert.ok(worked.every((w: any) => w.similarity > 0 && w.similarity <= 1));
  assert.match(ask, /user decides/);
});

test('next with an empty memory and no profile says nothing to recall, and a damaged profile only warns', async () => {
  const { dir, run } = await project('empty');
  await run('task', 'add', 'Brand new work', 'nothing like it before', '--role', 'engineer');
  const first = await run('next', '--as', 'engineer');
  assert.deepEqual(first.out.profile, {});
  assert.deepEqual(first.out.recall, { worked: [], caution: [], ask: null });

  await fs.writeFile(path.join(dir, '.colony', 'profile.json'), '{ broken');
  await run('task', 'add', 'Second', 'another one', '--role', 'engineer');
  const second = await run('next', '--as', 'engineer');
  assert.equal(second.code, 0);
  assert.match(second.out.warnings.join(' '), /profile not used/);
});
