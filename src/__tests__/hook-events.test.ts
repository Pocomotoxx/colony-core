import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runHook } from '../hook/cli.js';
import { runCommand } from '../cli/commands.js';
import { readEvidence } from '../evidence/evidence.js';

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-events-'));
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
  return { dir, state: path.join(dir, '.colony'), run };
}

// The payload shapes below are what a live Claude Code 2.1.281 session sent (see the README).
const post = (dir: string, command: string, ok: boolean, session = 's-1', tool = 'Bash') =>
  JSON.stringify(ok
    ? { session_id: session, cwd: dir, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { command }, tool_response: { stdout: 'all good', stderr: '', interrupted: false, isImage: false }, duration_ms: 900 }
    : { session_id: session, cwd: dir, hook_event_name: 'PostToolUseFailure', tool_name: tool, tool_input: { command }, error: 'Exit code 3\nboom', is_interrupt: false, duration_ms: 400 });

// ---- evidence from the host's hook

test('posttool records a finished check, with its exit code, and nothing else', async () => {
  const { dir, state } = await project('evidence');
  assert.deepEqual(await runHook('posttool', post(dir, 'pnpm test', true), dir), { code: 0, stdout: '', stderr: '' });
  await runHook('posttool', post(dir, 'node --test dist/x.test.js', false), dir);
  await runHook('posttool', post(dir, 'ls -la', true), dir); // not a check
  await runHook('posttool', post(dir, 'pnpm test | tail -3', true), dir); // exit status of tail, not of the tests
  await runHook('posttool', post(dir, 'pytest || true', true), dir); // masked
  await runHook('posttool', post(dir, 'dotnet test', false, 's-1', 'PowerShell'), dir);

  const records = await readEvidence(state);
  assert.deepEqual(records.map((r) => [r.command, r.outcome, r.exitCode, r.tool]), [
    ['pnpm test', 'passed', 0, 'Bash'],
    ['node --test dist/x.test.js', 'failed', 3, 'Bash'],
    ['dotnet test', 'failed', 3, 'PowerShell'],
  ]);
  assert.ok(records.every((r) => r.session === 's-1' && r.outputHash.length === 16));
  assert.ok(!JSON.stringify(records).includes('boom'), 'the output is hashed, not stored');
});

test('posttool never blocks: no colony, junk input and other tools are quiet and exit 0', async () => {
  const bare = path.join(root, 'bare');
  await fs.mkdir(bare);
  assert.equal((await runHook('posttool', post(bare, 'pnpm test', true), bare)).code, 0);
  await assert.rejects(fs.access(path.join(bare, '.colony'))); // it did not create a state directory
  for (const junk of ['not json', '[]', '"x"', JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'a' }, tool_response: {} })]) {
    const r = await runHook('posttool', junk, bare);
    assert.equal(r.code, 0, junk);
    assert.equal(r.stdout, '');
  }
});

test('done takes the check the hook saw as the verification: a failed run overrides a "tests passed" label', async () => {
  const { dir, run } = await project('observed-fail');
  const id = (await run('task', 'add', 'Fix the parser', 'make it pass', '--role', 'engineer')).out.task.id;
  await run('next', '--as', 'engineer');
  await runHook('posttool', post(dir, 'pnpm test', false), dir);
  const done = await run('done', id, '--result', 'fixed', '--quality', '0.95', '--verified-by-test');
  assert.equal(done.code, 0, JSON.stringify(done.out));
  assert.equal(done.out.observedEvidence.passed, false);
  assert.equal(done.out.observedEvidence.contradiction, true);
  assert.deepEqual(done.out.observedEvidence.quality, { reported: 0.95, effective: 0.3, loweredByCheck: true });
  assert.equal((await run('audit', 'list', '--type', 'task.verified')).out.entries[0].payload.source, 'observed');
});

test('done: a passed check is noted, the latest run counts, and an unconfirmed label is flagged', async () => {
  const { dir, run } = await project('observed-pass');
  const a = (await run('task', 'add', 'A', 'first', '--role', 'engineer')).out.task.id;
  await run('next', '--as', 'engineer');
  await runHook('posttool', post(dir, 'pnpm test', false), dir); // red ...
  await new Promise((r) => setTimeout(r, 5));
  await runHook('posttool', post(dir, 'pnpm test', true), dir); // ... then green: the latest counts
  const done = await run('done', a, '--result', 'fixed', '--quality', '0.9', '--verified-by-test');
  assert.equal(done.out.observedEvidence.passed, true);
  assert.equal(done.out.observedEvidence.quality.effective, 0.9);

  // a second task, no run since it started, but the report claims a test run
  const b = (await run('task', 'add', 'B', 'second', '--role', 'engineer')).out.task.id;
  await new Promise((r) => setTimeout(r, 5));
  await run('next', '--as', 'engineer');
  const noRun = await run('done', b, '--result', 'done', '--quality', '0.9', '--verified-by-test');
  assert.equal(noRun.out.observedEvidence, undefined);
  assert.ok(noRun.out.warnings.some((w: string) => /saw no test or build run/.test(w)), JSON.stringify(noRun.out.warnings));
});

test('done reads only the session it runs in when COLONY_SESSION is set', async () => {
  const { dir, run } = await project('session-filter');
  const id = (await run('task', 'add', 'S', 'scoped', '--role', 'engineer')).out.task.id;
  await run('next', '--as', 'engineer');
  await runHook('posttool', post(dir, 'pnpm test', false, 'other-session'), dir);
  const before = process.env.COLONY_SESSION;
  process.env.COLONY_SESSION = 'my-session';
  try {
    const done = await run('done', id, '--result', 'ok', '--quality', '0.8');
    assert.equal(done.out.observedEvidence, undefined, 'another session\'s failing run is not this task\'s evidence');
  } finally {
    if (before === undefined) delete process.env.COLONY_SESSION;
    else process.env.COLONY_SESSION = before;
  }
});

// ---- session start

test('session start exports the session id to later commands and tells the model what the colony is', async () => {
  const { dir, run } = await project('session');
  await run('profile', 'answer', 'explain_depth', 'short');
  const envFile = path.join(root, 'claude-env.sh');
  const r = await runHook('session', JSON.stringify({ session_id: 'abc-123_X', cwd: dir, hook_event_name: 'SessionStart', source: 'startup' }), dir, undefined, { envFile });
  assert.equal(r.code, 0);
  assert.equal(await fs.readFile(envFile, 'utf-8'), 'export COLONY_SESSION=abc-123_X\n');
  const ctx = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(ctx.hookEventName, 'SessionStart');
  assert.match(ctx.additionalContext, /do not edit \.colony\/ directly/);
  assert.match(ctx.additionalContext, /"explain_depth":"short"/);
});

test('a session id that could carry shell syntax is never written to the environment file', async () => {
  const { dir } = await project('session-evil');
  const envFile = path.join(root, 'evil-env.sh');
  for (const id of ['a; rm -rf ~', 'x`id`', '$(whoami)', 'a b', 'a"b', '']) {
    await runHook('session', JSON.stringify({ session_id: id, cwd: dir }), dir, undefined, { envFile });
  }
  await assert.rejects(fs.access(envFile), 'nothing was exported');
});

test('session start is quiet in a project without a colony', async () => {
  const bare = path.join(root, 'bare-session');
  await fs.mkdir(bare);
  const envFile = path.join(root, 'bare-env.sh');
  assert.deepEqual(await runHook('session', JSON.stringify({ session_id: 's', cwd: bare }), bare, undefined, { envFile }), { code: 0, stdout: '', stderr: '' });
  await assert.rejects(fs.access(envFile));
});

// ---- recall at the prompt

test('the prompt hook shows what the colony remembers, split into what worked and what to avoid, and logs only ids', async () => {
  const { dir, state, run } = await project('recall');
  const finish = async (title: string, desc: string, result: string, quality: string) => {
    const id = (await run('task', 'add', title, desc, '--role', 'engineer')).out.task.id;
    await run('next', '--as', 'engineer');
    await run('done', id, '--result', result, '--quality', quality);
  };
  await finish('Parse the invoice feed', 'read invoice rows from the csv feed', 'streamed the csv in chunks and validated each row', '0.9');
  await finish('Parse the invoice feed again', 'read invoice rows from the csv feed once more', 'loaded the whole csv into memory at once', '0.1');

  const r = await runHook('prompt', JSON.stringify({ session_id: 'p-1', cwd: dir, hook_event_name: 'UserPromptSubmit', prompt: 'Please parse the invoice csv feed from the new supplier' }), dir);
  assert.equal(r.code, 0);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(ctx.hookEventName, 'UserPromptSubmit');
  assert.match(ctx.additionalContext, /not instructions/);
  assert.match(ctx.additionalContext, /Worked before:\n- .*chunks.*rating 0\.9/);
  assert.match(ctx.additionalContext, /do not repeat:\n- .*whole csv.*rating 0\.1/);
  assert.match(ctx.additionalContext, /The user decides/);
  assert.ok(ctx.additionalContext.length <= 3000);

  const log = (await fs.readFile(path.join(state, 'recall.jsonl'), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].session, 'p-1');
  assert.ok(log[0].ids.length === 2 && log[0].ids.every((i: string) => i.startsWith('pattern_task_')));
  assert.ok(!JSON.stringify(log).includes('chunks'), 'the log keeps ids, not text');
});

test('the prompt hook says nothing when nothing similar was rated, and never blocks the prompt', async () => {
  const { dir, state } = await project('recall-quiet');
  const quiet = await runHook('prompt', JSON.stringify({ session_id: 'p', cwd: dir, prompt: 'Design a schema for sensor telemetry' }), dir);
  assert.deepEqual(quiet, { code: 0, stdout: '', stderr: '' });
  await assert.rejects(fs.access(path.join(state, 'recall.jsonl')));
  assert.equal((await runHook('prompt', JSON.stringify({ cwd: dir, prompt: '   ' }), dir)).stdout, '');
  const broken = await runHook('prompt', 'not json', dir);
  assert.equal(broken.code, 0, 'exit 2 on UserPromptSubmit would swallow the user\'s prompt');
  await fs.writeFile(path.join(state, 'memory.json'), '{ not json');
  const damaged = await runHook('prompt', JSON.stringify({ cwd: dir, prompt: 'anything about invoices' }), dir);
  assert.equal(damaged.code, 0);
});

// ---- install

test('hook install prints all five events; --apply merges them into the settings and keeps everything else', async () => {
  const dir = path.join(root, 'install');
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  const file = path.join(dir, '.claude', 'settings.json');
  const mine = { permissions: { allow: ['Bash(git status)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }], Notification: [{ hooks: [{ type: 'command', command: 'echo n' }] }] } };
  await fs.writeFile(file, JSON.stringify(mine));

  const shown = JSON.parse((await runHook('install', '', dir, dir)).stdout);
  assert.equal(shown.applied, false);
  assert.deepEqual(Object.keys(shown.settings.hooks).sort(), ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionStart', 'UserPromptSubmit']);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf-8')), mine, 'showing the settings writes nothing');

  const applied = JSON.parse((await runHook('install', '', dir, dir, { apply: true })).stdout);
  assert.equal(applied.applied, true);
  assert.equal(applied.added.length, 5);
  const written = JSON.parse(await fs.readFile(file, 'utf-8'));
  assert.deepEqual(written.permissions, mine.permissions);
  assert.deepEqual(written.hooks.Notification, mine.hooks.Notification);
  assert.equal(written.hooks.PreToolUse.length, 2);
  assert.equal(written.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
  assert.match(written.hooks.PreToolUse[1].hooks[0].command, /^node ".*cli\.js" hook pretool$/);
  assert.ok(!written.hooks.PreToolUse[1].hooks[0].command.includes('\\'), 'forward slashes: the host runs the command through a shell');
  assert.deepEqual(JSON.parse(await fs.readFile(`${file}.bak`, 'utf-8')), mine, 'the old file is kept');

  const again = JSON.parse((await runHook('install', '', dir, dir, { apply: true })).stdout);
  assert.equal(again.applied, false);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf-8')), written, 'a second apply changes nothing');
});

test('hook install --apply creates the settings when there are none, and refuses a settings file it cannot read', async () => {
  const fresh = path.join(root, 'install-fresh');
  await fs.mkdir(fresh);
  assert.equal(JSON.parse((await runHook('install', '', fresh, fresh, { apply: true })).stdout).backup, null);
  assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(fresh, '.claude', 'settings.json'), 'utf-8')).hooks).length, 5);

  const broken = path.join(root, 'install-broken');
  await fs.mkdir(path.join(broken, '.claude'), { recursive: true });
  await fs.writeFile(path.join(broken, '.claude', 'settings.json'), '{ not json');
  const r = await runHook('install', '', broken, broken, { apply: true });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.equal(await fs.readFile(path.join(broken, '.claude', 'settings.json'), 'utf-8'), '{ not json');
});

test('an unknown hook subcommand is a usage error', async () => {
  const r = await runHook('nope', '', root);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: colony hook/);
});

test('input with a byte order mark (Windows PowerShell 5.1 pipes one) is read, not refused', async () => {
  const { dir, state } = await project('bom');
  const bom = '\uFEFF';
  const denied = await runHook('pretool', bom + JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo x > .colony/ledger.json' }, cwd: dir }), dir);
  assert.equal(denied.code, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await runHook('pretool', bom + JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: dir }), dir)).stdout, '');
  await runHook('posttool', bom + post(dir, 'pnpm test', true), dir);
  assert.equal((await readEvidence(state)).length, 1);
});
