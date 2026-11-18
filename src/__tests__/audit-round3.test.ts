import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCommand } from '../cli/commands.js';
import { compareVariants, type EvalResult } from '../eval/eval-core.js';

// Findings D-2, C-2, C-3, C-4 and E-4 of the external audit.

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadGroq = async (): Promise<any> => import(pathToFileURL(path.join(repo, 'scripts', 'lib', 'groq.mjs')).href);

let root: string;
let n = 0;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-round3-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function dir(name: string) {
  const d = path.join(root, `${name}${n++}`);
  await fs.mkdir(d, { recursive: true });
  return d;
}
const cli = (d: string, ...args: string[]) => runCommand([...args, '--dir', d], process.cwd());

// ---- D-2

async function savedProject() {
  const d = await dir('proj');
  assert.equal((await cli(d, 'boot')).code, 0);
  assert.equal((await cli(d, 'task', 'add', 'T1', 'first', '--role', 'engineer')).code, 0);
  assert.equal((await cli(d, 'task', 'add', 'T2', 'second', '--role', 'engineer')).code, 0);
  return d;
}

test('a damaged integrity record blocks boot, and --accept-changes records a new baseline', async () => {
  const d = await savedProject();
  const file = path.join(d, '.colony', 'integrity.json');
  await fs.writeFile(file, '{ not json');
  const blocked = await cli(d, 'boot');
  assert.equal(blocked.code, 2);
  assert.match(JSON.stringify(blocked.output), /integrity\.json is damaged/);
  assert.equal((await cli(d, 'boot', '--accept-changes')).code, 0);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf-8')).v, 1, 'a valid record was written');
  assert.equal((await cli(d, 'boot')).code, 0);
});

test('a missing integrity record does not block (an older state is supported), but boot says so, and the next save writes a record', async () => {
  const d = await savedProject();
  const file = path.join(d, '.colony', 'integrity.json');
  await fs.rm(file);
  const first = await cli(d, 'boot');
  assert.equal(first.code, 0);
  assert.match(JSON.stringify((first.output as any).boot.notes), /integrity\.json is missing/);
  await fs.access(file); // the save of this boot wrote a new record
  const second = await cli(d, 'boot');
  assert.equal(second.code, 0);
  assert.equal((second.output as any).boot.notes, undefined, 'the note is gone once the record exists');
});

// ---- C-2, C-3: the Groq client

const answer = (content: string) => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { total_tokens: 3 } });

test('the Groq client does not follow a redirect, and reads no more than the cap from any answer', async () => {
  const groq = await loadGroq();
  const base = 'http://127.0.0.1:1';
  let init: any;
  const ok = await groq.chat({ base, key: 'k', body: {}, fetchImpl: async (_url: string, i: unknown) => { init = i; return new Response(answer('hi')); } });
  assert.equal(ok.ok, true);
  assert.equal(init.redirect, 'error', 'the key goes only to the host that was checked');

  const big = await groq.chat({ base, key: 'k', body: {}, fetchImpl: async () => new Response('x'.repeat(3 * 1024 * 1024)) });
  assert.equal(big.ok, false);
  assert.match(big.error, /larger than/);

  const notJson = await groq.chat({ base, key: 'k', body: {}, fetchImpl: async () => new Response('<html>oops</html>') });
  assert.equal(notJson.ok, false);
  assert.match(notJson.error, /not JSON/);

  const err = await groq.chat({ base, key: 'k', body: {}, fetchImpl: async () => new Response('y'.repeat(300_000), { status: 500 }) });
  assert.equal(err.ok, false);
  assert.match(err.error, /^HTTP 500/);
});

// ---- C-4

test('two processes that record to one quota file keep each other\'s entries', async () => {
  const groq = await loadGroq();
  const file = path.join(await dir('quota'), 'usage.json');
  const a = new groq.Usage(file);
  const b = new groq.Usage(file); // read the file before a recorded anything
  a.record('guard', 10);
  b.record('summary', 20);
  assert.equal(new groq.Usage(file).entries.length, 2, 'b did not overwrite a');
  assert.equal(b.entries.length, 2, 'and b now knows about a\'s call');
});

test('every HTTP attempt of a retried call is booked, not only the last one', async () => {
  const groq = await loadGroq();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls < 3 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : new Response(answer('ok'));
  };
  const booked: boolean[] = [];
  const r = await groq.chatWithRetry(
    { base: 'http://127.0.0.1:1', key: 'k', body: {}, fetchImpl },
    { sleep: async () => undefined, record: (a: { ok: boolean }) => booked.push(a.ok) },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(booked, [false, false, true]);
});

// ---- E-4

test('a comparison says how many of the counted runs ended with a host failure or a time-out', () => {
  const run = (variant: string, task: string, hostStatus?: EvalResult['hostStatus']): EvalResult => ({
    set: 's', variant, task, run: 1, passed: true, source: 'colony', at: 1, ...(hostStatus ? { hostStatus } : {}),
  });
  const results = [run('A', 't1'), run('A', 't2', 'timed_out'), run('B', 't1'), run('B', 't2', 'ok')];
  const withProblem = compareVariants(results, 'A', 'B', 1);
  assert.ok(withProblem.caveats.some((c) => /1 counted run\(s\) ended with a host failure or a time-out/.test(c)));
  const clean = compareVariants(results.filter((r) => r.hostStatus !== 'timed_out'), 'A', 'B', 1);
  assert.ok(!clean.caveats.some((c) => /host failure/.test(c)));
});
