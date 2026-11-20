import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRedactSpans, redactText } from '../redact.js';

// The measuring script (audit C01, C02): a fixed baseline for the personal data comparison, and a count of real commands.

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repo, 'scripts', 'rulesets-measure.mjs');
let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-measure-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function measure(args: string[]): { json: any; rest: string } {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf-8', cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  const end = r.stdout.indexOf('\n}\n') + 2;
  return { json: JSON.parse(r.stdout.slice(0, end)), rest: r.stdout.slice(end) };
}

test('the built-in baseline does not change when the rule sets are used: a MAC address is found by the sets only (C01)', () => {
  const text = 'host aa:bb:cc:dd:ee:ff up';
  assert.deepEqual(findRedactSpans(text, { builtinOnly: true }), [], 'the own patterns do not know a MAC address');
  assert.equal(findRedactSpans(text).length, 1, 'with the rule sets it is found');
  assert.equal(redactText(text, { builtinOnly: true }).changed, false);
  assert.equal(redactText(text).changed, true);
  // an e-mail address is built in: the baseline still finds it
  assert.deepEqual(findRedactSpans('write to a@b.example now', { builtinOnly: true }).map((s) => s.kind), ['email']);
});

test('the personal data comparison reports the same characters, not just any overlap (C01)', async () => {
  const dir = path.join(root, 'pii');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'a.md'), 'mac aa:bb:cc:dd:ee:ff and mail a@b.example\n');
  const { json, rest } = measure(['--pii', dir]);
  assert.match(json.measurement, /pii-compare v2: baseline = the built-in patterns only/);
  assert.equal(json.byEntity.mac_address.onlyByRuleSet, 1, 'the baseline has no MAC rule, so it cannot have found it');
  assert.equal(json.byEntity.mac_address.sameByBuiltin, 0);
  assert.match(rest, /a\.md:1 {2}mac_address/);
});

test('only commands are counted as commands: a shell block, a CRLF workflow and package.json scripts; other code lines apart (C02)', async () => {
  const dir = path.join(root, 'cmd');
  await fs.mkdir(path.join(dir, '.github'), { recursive: true });
  await fs.writeFile(path.join(dir, 'a.md'), ['```bash', '$ pnpm test', '# a comment', 'git status', '```', '', '```', 'a → b   (a diagram, not a command)', 'c → d', '```', '', '```json', '{"a": 1}', '```', ''].join('\n'));
  await fs.writeFile(path.join(dir, '.github', 'ci.yml'), ['steps:', '  - name: Build', '    run: pnpm build', '  - run: pnpm lint', ''].join('\r\n'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const { json } = measure(['--commands', dir]);
  assert.match(json.measurement, /commands v2: only commands/);
  assert.deepEqual(json.sample.bySource, { 'md-shell': 2, workflow: 2, 'package-script': 1 });
  assert.equal(json.sample.commands, 5);
  assert.equal(json.sample.otherCodeLinesNotJudged, 3, 'the diagram and the json line are not commands');
  assert.equal(json.commandsForWhichAnEventWasBuilt.process, 5);
  assert.equal(json.matches.total, 0);

  // the same sample has the same id; a different one has another
  assert.equal(measure(['--commands', dir]).json.sample.id, json.sample.id);
  const withOther = measure(['--commands', '--all-code', dir]).json;
  assert.equal(withOther.sample.commands, 8, '--all-code judges the other lines too');
  assert.notEqual(withOther.sample.id, json.sample.id);
});

test('a match that nobody rated is counted as unrated, not as false or true; a rating is applied (C02)', async () => {
  const dir = path.join(root, 'rated');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'a.md'), ['```', 'x → y', '```', ''].join('\n'));
  const first = measure(['--commands', '--all-code', dir]).json;
  assert.ok(first.matches.total >= 1, 'an arrow in a command line is something the emoji rule reads');
  assert.equal(first.matches.unrated, first.matches.total);
  assert.equal(first.matches['false-positive'], 0);
  const title = Object.keys(first.byRule)[0];
  const ratings = path.join(root, 'ratings.json');
  await fs.writeFile(ratings, JSON.stringify([{ file: path.relative(repo, path.join(dir, 'a.md')).replace(/\\/g, '/'), line: 2, rule: title, verdict: 'false-positive' }]));
  const rated = measure(['--commands', '--all-code', '--ratings', ratings, dir]).json;
  assert.equal(rated.matches['false-positive'], 1);
  assert.equal(rated.matches.unrated, rated.matches.total - 1);
});
