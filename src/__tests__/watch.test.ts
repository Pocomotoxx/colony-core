import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../audit-log.js';
import type { AuditEntry } from '../audit-log.js';
import { runWatch } from '../chief/watch.js';
import { buildHealthReport } from '../chief/health.js';
import { ColonyHub } from '../colony-hub.js';
import { runCommand } from '../cli/commands.js';
import type { ColonyTask } from '../types.js';

const NOW = 50_000_000;
const MIN = 60_000;

const task = (id: string, over: Partial<ColonyTask> = {}): ColonyTask => ({
  id,
  title: `Title ${id}`,
  description: 'd',
  priority: 'normal',
  status: 'pending',
  createdAt: NOW - MIN,
  ...over,
});

const log = (...entries: Array<[string, string, string?, Record<string, unknown>?]>): AuditEntry[] => {
  const l = new AuditLog();
  entries.forEach(([type, aggregateId, actor, payload], i) => l.append({ type, aggregateId, actor: actor ?? 'a', payload }, NOW - (entries.length - i) * MIN));
  return l.snapshot();
};

const watch = (tasks: ColonyTask[], audit: AuditEntry[] = [], extra: Partial<Parameters<typeof runWatch>[0]> = {}) =>
  runWatch({ tasks, audit, chainOk: true, anchorHeld: null, now: NOW, ...extra });

const kinds = (r: ReturnType<typeof runWatch>) => r.findings.map((f) => f.kind);

// ---- the pure checks

test('quiet records give no findings, and the limits are always stated', () => {
  const r = watch([task('a'), task('b', { status: 'completed' })], log(['task.added', 'a'], ['task.added', 'b']));
  assert.deepEqual(r.findings, []);
  assert.equal(r.heuristic, true);
  assert.equal(r.checked.auditEntries, 2);
  assert.ok(r.limits.some((l) => /original user request/.test(l)));
  assert.ok(r.limits.some((l) => /same model/.test(l)));
});

test('a broken chain or a lost anchor is critical', () => {
  assert.equal(watch([], [], { chainOk: false }).findings[0].severity, 'critical');
  const lost = watch([], [], { anchorHeld: false });
  assert.equal(lost.findings[0].kind, 'audit_integrity');
  assert.match(lost.findings[0].detail, /cut or rewritten/);
  assert.deepEqual(watch([], [], { anchorHeld: true }).findings, []);
});

test('an override without a later review is high; a reviewed one is not', () => {
  const unreviewed = watch([task('t')], log(['chief.override', 't', 'chief']));
  assert.deepEqual(kinds(unreviewed), ['unreviewed_override']);
  assert.deepEqual(unreviewed.findings[0].auditSeqs, [0]);
  assert.deepEqual(kinds(watch([task('t')], log(['chief.override', 't'], ['deputy.reviewed', 't']))), []);
  assert.deepEqual(kinds(watch([task('t')], log(['deputy.reviewed', 't'], ['chief.override', 't']))), ['unreviewed_override']); // a review before the override does not count
});

test('a hold released by whoever placed it is flagged', () => {
  const self = watch([task('t')], log(['task.hold_released', 't', 'x', { heldBy: 'member_auditor', releasedBy: 'member_auditor' }]));
  assert.deepEqual(kinds(self), ['self_released_hold']);
  const other = watch([task('t')], log(['task.hold_released', 't', 'x', { heldBy: 'member_auditor', releasedBy: 'member_director' }]));
  assert.deepEqual(kinds(other), []);
});

test('failures with the same title are counted, however the title is written', () => {
  const failed = (id: string, title: string) => task(id, { title, status: 'failed' });
  const three = watch([failed('1', 'Fix the parser'), failed('2', 'fix the parser!'), failed('3', 'FIX  THE   PARSER')]);
  assert.deepEqual(kinds(three), ['repeated_failure']);
  assert.deepEqual(three.findings[0].taskIds, ['1', '2', '3']);
  assert.deepEqual(kinds(watch([failed('1', 'Fix the parser'), failed('2', 'Fix the parser')])), []);
  assert.deepEqual(kinds(watch([failed('1', 'a b c'), failed('2', 'a b c')], [], { thresholds: { repeatedFailures: 2 } })), ['repeated_failure']);
});

test('the same task created again and again without ever completing is a loop', () => {
  const again = (id: string, status: ColonyTask['status'] = 'pending') => task(id, { title: 'Write the report', status });
  assert.deepEqual(kinds(watch([again('1'), again('2'), again('3')])), ['duplicate_task_loop']);
  assert.deepEqual(kinds(watch([again('1'), again('2'), again('3', 'completed')])), []);
  assert.deepEqual(kinds(watch([again('1'), again('2')])), []);
});

test('a claim that changes hands over and over is a cycle', () => {
  const three = watch([task('t')], log(['claim.stolen', 't'], ['claim.handoff_accepted', 't'], ['claim.stolen', 't']));
  assert.deepEqual(kinds(three), ['claim_cycle']);
  assert.deepEqual(three.findings[0].auditSeqs, [0, 1, 2]);
  assert.deepEqual(kinds(watch([task('t')], log(['claim.stolen', 't'], ['claim.stolen', 't']))), []);
});

test('an open task with no record for too long is stalled, unless it is on hold', () => {
  const old = (id: string, over: Partial<ColonyTask> = {}) => task(id, { status: 'in_progress', createdAt: NOW - 500 * MIN, startedAt: NOW - 400 * MIN, ...over });
  assert.deepEqual(kinds(watch([old('s')])), ['stalled_task']);
  assert.deepEqual(kinds(watch([old('s')], log(['claim.heartbeat', 's']))), []); // a recent record clears it
  assert.deepEqual(kinds(watch([old('s', { hold: { by: 'm', reason: 'r', at: NOW } })])), ['hold_open']);
  assert.deepEqual(kinds(watch([task('p', { status: 'pending', createdAt: NOW - 900 * MIN })])), []); // pending is the health report's business
  assert.deepEqual(kinds(watch([old('s')], [], { thresholds: { stalledMinutes: 1000 } })), []);
});

test('goal drift is only measured for split tasks, and it is a low finding', () => {
  const root = task('root', { title: 'Build the invoice importer', description: 'read ledger rows' });
  const fine = task('c1', { title: 'Build the invoice importer - Testing', parentId: 'root' });
  const odd = task('c2', { title: 'Plan the holiday party', parentId: 'root' });
  const grand = task('c3', { title: 'Order catering', parentId: 'c2' });
  const r = watch([root, fine, odd, grand]);
  assert.deepEqual(r.findings.map((f) => [f.kind, f.severity, f.subject]), [['goal_drift', 'low', 'c2'], ['goal_drift', 'low', 'c3']]);
  assert.deepEqual(r.findings[1].taskIds, ['c3', 'root']); // measured against the root, not the parent
  assert.deepEqual(kinds(watch([task('solo', { title: 'Anything at all' })])), []); // no parent, nothing to compare
});

test('findings are sorted by severity, can be focused on one task, and are deterministic', () => {
  const tasks = [task('a', { status: 'in_progress', createdAt: NOW - 500 * MIN, startedAt: NOW - 500 * MIN }), task('b', { title: 'Same', status: 'failed' }), task('c', { title: 'Same', status: 'failed' }), task('d', { title: 'Same', status: 'failed' })];
  const audit = log(['chief.override', 'x']);
  const r = watch(tasks, audit, { chainOk: false });
  assert.deepEqual(r.findings.map((f) => f.severity), ['critical', 'high', 'high', 'medium']);
  assert.deepEqual(kinds(r), ['audit_integrity', 'repeated_failure', 'unreviewed_override', 'stalled_task']);
  assert.deepEqual(watch(tasks, audit, { chainOk: false }), r);
  assert.deepEqual(kinds(watch(tasks, audit, { focusTaskId: 'b' })), ['repeated_failure']);
  assert.deepEqual(watch(tasks, audit, { focusTaskId: 'nope' }).findings, []);
});

test('thresholds are validated', () => {
  assert.throws(() => watch([], [], { thresholds: { repeatedFailures: 0 } }), /repeatedFailures/);
  assert.throws(() => watch([], [], { thresholds: { stalledMinutes: Number.NaN } }), /stalledMinutes/);
});

// ---- holds in the orchestrator

const hubWith = () => {
  const hub = new ColonyHub();
  hub.registry.register({ id: 'e', name: 'e', role: 'engineer', capabilities: { maxConcurrentTasks: 3 } });
  return hub;
};

test('a hold blocks completing and dispatching, but not failing', async () => {
  const hub = hubWith();
  const t = await hub.orchestrator.createTask({ title: 'T', description: 'd', requiredRole: 'engineer' });
  await hub.orchestrator.holdTask(t.id, 'aud', 'looks wrong');
  await assert.rejects(() => hub.orchestrator.completeTask(t.id, 'e', 'done'), /on hold/);
  assert.equal(hub.orchestrator.getTask(t.id)!.status, 'assigned');
  await hub.orchestrator.failTask(t.id, 'e', 'stopped'); // stopping bad work stays possible
  assert.equal(hub.orchestrator.getTask(t.id)!.status, 'failed');
});

test('a held pending task is not dispatched until the hold is released', async () => {
  const hub = new ColonyHub();
  const t = await hub.orchestrator.createTask({ title: 'T', description: 'd', requiredRole: 'engineer' }); // nobody to take it yet
  assert.equal(t.status, 'pending');
  await hub.orchestrator.holdTask(t.id, 'aud', 'wait');
  hub.registry.register({ id: 'e', name: 'e', role: 'engineer' });
  assert.equal(await hub.orchestrator.tryDispatchTask(t.id), false);
  assert.equal(hub.orchestrator.getTask(t.id)!.status, 'pending');
  await hub.orchestrator.releaseHold(t.id, 'user-approved');
  assert.equal(hub.orchestrator.getTask(t.id)!.status, 'assigned');
});

test('hold errors', async () => {
  const hub = hubWith();
  const t = await hub.orchestrator.createTask({ title: 'T', description: 'd', requiredRole: 'engineer' });
  await assert.rejects(() => hub.orchestrator.holdTask(t.id, 'aud', '  '), /needs a reason/);
  await assert.rejects(() => hub.orchestrator.holdTask('nope', 'aud', 'r'), /not found/);
  await assert.rejects(() => hub.orchestrator.releaseHold(t.id, 'x'), /not on hold/);
  await hub.orchestrator.holdTask(t.id, 'aud', 'r');
  await assert.rejects(() => hub.orchestrator.holdTask(t.id, 'aud2', 'r'), /already on hold/);
  await hub.orchestrator.releaseHold(t.id, 'x');
  await hub.orchestrator.completeTask(t.id, 'e', 'ok');
  await assert.rejects(() => hub.orchestrator.holdTask(t.id, 'aud', 'r'), /nothing to hold/);
});

test('held tasks show up in the health report and are not called unroutable', () => {
  const held = task('h', { requiredRole: 'security', hold: { by: 'aud', reason: 'r', at: NOW } });
  const r = buildHealthReport({ members: [], tasks: [held], claims: [], proposals: [], now: NOW });
  assert.deepEqual(r.bottlenecks.map((b) => b.location), ['on hold']);
});

// ---- CLI

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-watch-test-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function project(name: string) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const run = async (...args: string[]) => {
    const { code, output } = await runCommand(args, dir);
    return { code, out: output as any };
  };
  await run('boot');
  return { dir, run };
}

test('only the auditor can hold; a held task is skipped by next and refused by done', async () => {
  const { run } = await project('hold');
  const id = (await run('task', 'add', 'Build', 'Write the thing', '--role', 'engineer')).out.task.id;

  assert.match((await run('hold', id, '--as', 'engineer', '--reason', 'no')).out.error, /only the auditor/);
  assert.match((await run('hold', id, '--as', 'auditor')).out.error, /--reason/);
  assert.match((await run('hold', 'task_nope', '--as', 'auditor', '--reason', 'x')).out.error, /not found/);

  const held = await run('hold', id, '--as', 'auditor', '--reason', 'does not match the request');
  assert.equal(held.code, 0);
  assert.equal(held.out.task.onHold.by, 'member_auditor');
  assert.match((await run('hold', id, '--as', 'auditor', '--reason', 'again')).out.error, /already on hold/);

  assert.equal((await run('next', '--as', 'engineer')).out.task, null); // not handed out
  assert.match((await run('done', id, '--result', 'finished')).out.error, /on hold/);
  assert.equal((await run('status')).out.tasks[0].onHold.reason, 'does not match the request');
  assert.ok((await run('health')).out.report.bottlenecks.some((b: any) => b.location === 'on hold'));
});

test('release needs a note; the note is redacted; releasing your own hold is flagged', async () => {
  const { dir, run } = await project('release');
  const id = (await run('task', 'add', 'Build', 'Write the thing', '--role', 'engineer')).out.task.id;
  await run('hold', id, '--as', 'auditor', '--reason', 'check with the user');

  assert.match((await run('hold', 'release', id, '--as', 'director')).out.error, /--note/);
  assert.match((await run('hold', 'release', 'task_nope', '--as', 'director', '--note', 'x')).out.error, /not found/);

  const self = await run('hold', 'release', id, '--as', 'auditor', '--note', 'user said fine, mail anna@example.org');
  assert.equal(self.code, 0);
  assert.equal(self.out.selfReleased, true);
  assert.match(self.out.note, /cannot check that a person/);

  const raw = await fs.readFile(path.join(dir, '.colony', 'audit.jsonl'), 'utf-8');
  assert.ok(!raw.includes('anna@example.org'));
  assert.ok(raw.includes('[REDACTED:email]'));

  const watched = await run('watch');
  assert.ok(watched.out.report.findings.some((f: any) => f.kind === 'self_released_hold'));
  assert.equal((await run('next', '--as', 'engineer')).out.task.id, id); // released: workable again
});

test('release by someone else is not flagged', async () => {
  const { run } = await project('release-other');
  const id = (await run('task', 'add', 'Build', 'Write the thing', '--role', 'engineer')).out.task.id;
  await run('hold', id, '--as', 'auditor', '--reason', 'check');
  const released = await run('hold', 'release', id, '--as', 'director', '--note', 'user approved in chat');
  assert.equal(released.out.selfReleased, false);
  assert.ok(!(await run('watch')).out.report.findings.some((f: any) => f.kind === 'self_released_hold'));
  assert.match((await run('hold', 'release', id, '--as', 'director', '--note', 'again')).out.error, /not on hold/);
});

test('watch is read-only, can focus on a task, and reports a clean colony as clean', async () => {
  const { dir, run } = await project('watch');
  const id = (await run('task', 'add', 'Build', 'Write the thing', '--role', 'engineer')).out.task.id;
  const before = await fs.readFile(path.join(dir, '.colony', 'audit.jsonl'), 'utf-8');
  const r = await run('watch');
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.report.findings, []);
  assert.match(r.out.note, /not that the work is right/);
  assert.equal((await run('watch', '--task', id)).code, 0);
  assert.match((await run('watch', '--task', 'task_nope')).out.error, /not found/);
  assert.equal(await fs.readFile(path.join(dir, '.colony', 'audit.jsonl'), 'utf-8'), before);
});

test('closing a task brings up what the watch says about it, without blocking', async () => {
  const { run } = await project('hints');
  let last: any;
  for (let i = 0; i < 3; i++) {
    const id = (await run('task', 'add', 'Fix the parser', 'It breaks on empty input', '--role', 'engineer')).out.task.id;
    await run('next', '--as', 'engineer');
    last = await run('fail', id, '--error', `attempt ${i + 1} failed`);
    assert.equal(last.code, 0);
  }
  assert.ok(last.out.deputy.some((d: any) => d.kind === 'repeated_failure' && d.severity === 'high'));
  assert.equal((await run('watch')).out.report.findings[0].kind, 'repeated_failure');

  const ok = (await run('task', 'add', 'Something else', 'unrelated', '--role', 'engineer')).out.task.id;
  await run('next', '--as', 'engineer');
  assert.equal((await run('done', ok, '--result', 'fine')).out.deputy, undefined); // nothing to say about this one
});

test('a damaged audit log shows up in the watch of a booted colony', async () => {
  const { dir, run } = await project('integrity');
  await run('task', 'add', 'One', 'First', '--role', 'engineer');
  await run('boot'); // anchor the log
  const file = path.join(dir, '.colony', 'audit.jsonl');
  await fs.writeFile(file, '', 'utf-8'); // the log was emptied: the chain of nothing is valid, the anchor is not
  const r = await run('watch');
  assert.ok(r.out.report.findings.some((f: any) => f.kind === 'audit_integrity' && /cut or rewritten/.test(f.detail)));
});
