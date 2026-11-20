import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../cli/commands.js';
import { findSecretSpans } from '../gates.js';
import { runHook } from '../hook/cli.js';
import { evaluatePreToolUse } from '../hook/pretool.js';
import { useRulesetsDir } from '../rulesets/active.js';
import { WARNINGS_FILE } from '../rulesets/gate.js';

// The vendored rule sets in the guard: they only warn, and every warning is recorded for counting.

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let root: string;
let n = 0;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-wire-'));
});
after(async () => {
  useRulesetsDir(undefined);
  await fs.rm(root, { recursive: true, force: true });
});

function fake(length: number, seed: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = seed;
  let out = '';
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out += alphabet[Math.floor((s / 2147483648) * alphabet.length)];
  }
  return out;
}
// made up, and never written as one literal: a payment-provider key shape that the own patterns do not know
const STRIPE = 'sk_' + 'live_' + fake(24, 21);
const GITHUB = 'ghp_' + fake(36, 22);

async function project(withState = true) {
  const d = path.join(root, `p${n++}`);
  await fs.mkdir(d, { recursive: true });
  if (withState) await fs.mkdir(path.join(d, '.colony'));
  return d;
}
const bash = (command: string, dir: string) => evaluatePreToolUse({ tool_name: 'Bash', tool_input: { command } }, dir);

test('a secret that only the rule set knows is a warning: the call is allowed, the note names the rule, the value is not in it', async () => {
  assert.equal(findSecretSpans(STRIPE).length, 0, 'the own patterns do not see this shape');
  const dir = await project();
  const v = await bash(`curl -H "Authorization: Bearer ${STRIPE}" https://api.example.test/v1/charges`, dir);
  assert.equal(v.decision, 'allow');
  assert.ok(v.gates.includes('secret-rulesets'));
  assert.equal(v.notes.length, 1);
  assert.match(v.notes[0], /gitleaks v8\.30\.1 flags 1 possible secret\(s\) \(rule: [^)]*stripe-access-token/, 'two rules on the same secret are one possible secret');
  assert.match(v.notes[0], /does not block/);
  assert.ok(!JSON.stringify(v).includes(STRIPE), 'no value anywhere in the verdict');
});

test('through the hook: allowed means no output on stdout, and the note goes to stderr', async () => {
  const dir = await project();
  const r = await runHook('pretool', JSON.stringify({ cwd: dir, tool_name: 'Bash', tool_input: { command: `curl -H "Authorization: Bearer ${STRIPE}" https://api.example.test/` } }), dir);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Colony guard notes: .*stripe-access-token/);
  assert.ok(!r.stderr.includes(STRIPE));
});

test('a file write is checked too; ordinary commands and writes carry no note', async () => {
  const dir = await project();
  const w = await evaluatePreToolUse({ tool_name: 'Write', tool_input: { file_path: 'config.txt', content: `key=${STRIPE}\n` } }, dir);
  assert.equal(w.decision, 'allow');
  assert.ok(w.gates.includes('secret-rulesets'));
  const plain = await bash('git status && pnpm test', dir);
  assert.equal(plain.decision, 'allow');
  assert.deepEqual(plain.notes, []);
  const write = await evaluatePreToolUse({ tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'hello world\n' } }, dir);
  assert.deepEqual(write.notes, []);
});

test('where the own patterns block, the rule set adds its warning to the block', async () => {
  const dir = await project();
  const v = await bash(`echo ${GITHUB}`, dir);
  assert.equal(v.decision, 'deny');
  assert.ok(v.gates.includes('secrets'), 'the own pattern');
  assert.ok(v.gates.includes('secret-rulesets'), 'the rule set');
  assert.ok(!JSON.stringify(v).includes(GITHUB));
});

test('every warning is recorded with the rule and a count, never the value; no state folder, no file', async () => {
  const dir = await project();
  await bash(`curl -H "Authorization: Bearer ${STRIPE}" https://api.example.test/`, dir);
  await bash('git status', dir);
  const text = await fs.readFile(path.join(dir, '.colony', WARNINGS_FILE), 'utf-8');
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1, 'only the call with a finding is recorded');
  assert.ok(lines[0].rules.includes('stripe-access-token'));
  assert.equal(lines[0].count, 1);
  assert.equal(lines[0].tool, 'shell');
  assert.ok(!text.includes(STRIPE));

  const bare = await project(false);
  await bash(`curl -H "Authorization: Bearer ${STRIPE}" https://api.example.test/`, bare);
  await assert.rejects(fs.access(path.join(bare, '.colony')), 'the hook does not create a state folder');
});

test('a rule set that fails its checks is reported on every call, and the own patterns still work', async () => {
  const sets = path.join(root, `sets${n++}`);
  await fs.mkdir(sets);
  await fs.cp(path.join(repo, 'rulesets', 'gitleaks'), path.join(sets, 'gitleaks'), { recursive: true });
  await fs.appendFile(path.join(sets, 'gitleaks', 'ruleset.json'), ' ');
  useRulesetsDir(sets);
  try {
    const dir = await project();
    const v = await bash('git status', dir);
    assert.equal(v.decision, 'allow');
    assert.equal(v.notes.length, 1);
    assert.match(v.notes[0], /rule set 'gitleaks' failed its checks and is NOT used/);
    const blocked = await bash(`echo ${GITHUB}`, dir);
    assert.equal(blocked.decision, 'deny', 'the own patterns do not depend on the rule set');
  } finally {
    useRulesetsDir(undefined);
  }
});

test('a rule set that sources.json lists but that is gone is reported like a failed one; so is a folder that cannot be read', async () => {
  const sets = path.join(root, `sets${n++}`);
  await fs.mkdir(sets);
  await fs.cp(path.join(repo, 'rulesets', 'gitleaks'), path.join(sets, 'gitleaks'), { recursive: true });
  await fs.writeFile(path.join(sets, 'sources.json'), JSON.stringify({ sets: { gitleaks: {}, presidio: {} } }));
  useRulesetsDir(sets);
  try {
    const v = await bash('git status', await project());
    assert.equal(v.notes.length, 1);
    assert.match(v.notes[0], /rule set 'presidio' failed its checks and is NOT used \(the rule set is listed in sources\.json but its folder or its PROVENANCE\.json is missing\)/);
  } finally {
    useRulesetsDir(undefined);
  }
  useRulesetsDir(path.join(root, 'no-such-rule-set-folder'));
  try {
    const v = await bash('git status', await project());
    assert.match(v.notes.join('\n'), /rule set '\(rule set folder\)' failed its checks and is NOT used \(the folder cannot be read/);
  } finally {
    useRulesetsDir(undefined);
  }
});

test('a text longer than the scan limit is said to be cut even when nothing was found', async () => {
  const dir = await project();
  const harmless = 'lorem ipsum dolor sit amet '.repeat(8500); // 229 500 characters, no secret
  const v = await bash(`echo ${harmless}`, dir);
  assert.equal(v.decision, 'allow');
  assert.match(v.notes.join('\n'), /longer than 200000 characters: only the first 200000 were checked for secrets/);
  const short = await bash('echo hello', dir);
  assert.deepEqual(short.notes, []);
});

test('the check command shows the warning and does not fail on it', async () => {
  const dir = await project(false);
  assert.equal((await runCommand(['boot', '--dir', dir], process.cwd())).code, 0);
  const r = await runCommand(['check', '--text', `key=${STRIPE}`, '--dir', dir], process.cwd());
  assert.equal(r.code, 0);
  const out = r.output as any;
  assert.equal(out.decision, 'warn');
  assert.ok(out.results.some((x: any) => x.gate === 'secret-rulesets' && x.details.rules.includes('stripe-access-token')));
  assert.ok(!JSON.stringify(out).includes(STRIPE));
});
