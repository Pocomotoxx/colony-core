import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEvalSet } from '../eval/eval-core.js';

// The task set eval/hard-1 validates itself: on the starter code every hidden check must FAIL (the task is a real
// task) and with the reference solution it must PASS (the check is right and the task can be solved). A check that
// fails on a correct solution, or passes on the starter, would only add noise to a measurement.

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const setDir = path.join(repo, 'eval', 'hard-1');

let tmp: string;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-hard-'));
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const parsed = parseEvalSet(await fs.readFile(path.join(setDir, 'set.json'), 'utf-8'), { setDir });

function runCheck(argv: string[], cwd: string) {
  const [tool, ...args] = argv;
  return spawnSync(tool === 'node' ? process.execPath : tool, args, { cwd, encoding: 'utf-8', timeout: 60_000 });
}

test('the task set is valid, and every task has a fixture, a hidden check and a reference solution', async () => {
  assert.deepEqual(parsed.problems, []);
  const set = parsed.set!;
  assert.equal(set.set, 'hard-1');
  assert.equal(set.tasks.length, 5);
  for (const task of set.tasks) {
    await fs.access(path.join(setDir, 'fixtures', task.id, 'README.md'));
    await fs.access(path.join(setDir, 'fixtures', task.id, 'package.json'));
    await fs.access(path.join(setDir, 'checks', `${task.id}.mjs`));
    await fs.access(path.join(setDir, 'reference', task.id, 'src'));
    assert.ok(task.check.every((a) => !a.includes('{setDir}')), 'the token is replaced');
    assert.ok(task.check[1].startsWith(setDir), 'the hidden check is addressed through the set folder');
    assert.match(task.setup!, /fixtures/);
    assert.match(task.prompt, /Change only files under src\//);
  }
});

for (const task of parsed.set!.tasks) {
  test(`task ${task.id}: the check fails on the starter and passes with the reference solution`, async () => {
    const workspace = path.join(tmp, task.id);
    await fs.cp(path.join(setDir, 'fixtures', task.id), workspace, { recursive: true });

    const starter = runCheck(task.check, workspace);
    assert.equal(starter.status, 1, `the starter must fail the check, but it passed:\n${starter.stdout}${starter.stderr}`);
    assert.ok(starter.stderr.length > 0, 'a failing check says what is wrong');
    assert.ok(starter.stderr.length < 20_000, 'and does not flood the output');

    await fs.cp(path.join(setDir, 'reference', task.id), workspace, { recursive: true });
    const solved = runCheck(task.check, workspace);
    assert.equal(solved.status, 0, `the reference solution must pass the check:\n${solved.stderr}`);
  });
}

test('a check does not pass when the module is missing or broken', async () => {
  const workspace = path.join(tmp, 'missing');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  for (const task of parsed.set!.tasks) {
    const r = runCheck(task.check, workspace);
    assert.equal(r.status, 1, task.id);
    assert.match(r.stderr, /cannot load/);
  }
  const workspace2 = path.join(tmp, 'broken');
  await fs.mkdir(path.join(workspace2, 'src'), { recursive: true });
  const task = parsed.set!.tasks.find((t) => t.id === 'money-split')!;
  await fs.writeFile(path.join(workspace2, 'src', 'split.js'), 'export const splitCents = 5;');
  await fs.writeFile(path.join(workspace2, 'package.json'), '{"type":"module"}');
  const r = runCheck(task.check, workspace2);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must export a function/);
});

test('a checker cannot be fooled by the obvious shortcuts', async () => {
  // a function that returns the expected value of the first documented example is not enough
  const task = parsed.set!.tasks.find((t) => t.id === 'money-split')!;
  const workspace = path.join(tmp, 'shortcut');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(workspace, 'src', 'split.js'), 'export function splitCents(total, weights) { return [34, 33, 33]; }');
  assert.equal(runCheck(task.check, workspace).status, 1);
  // so is a function that never throws
  await fs.writeFile(path.join(workspace, 'src', 'split.js'), 'export function splitCents(total, weights) { return weights.map(() => 0); }');
  assert.equal(runCheck(task.check, workspace).status, 1);
});
