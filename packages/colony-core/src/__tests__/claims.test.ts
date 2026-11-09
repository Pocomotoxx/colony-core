import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaimError, ClaimLedger } from '../coordination/claim-ledger.js';
import { runCommand } from '../cli/commands.js';

const MIN = 60_000;
const T0 = 1_000_000_000;
const room = { challengerOpenClaims: 0, maxClaims: 2 };

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof ClaimError ? err.code : String(err);
  }
  return undefined;
};

// ---- ledger

test('a task has one open claim; a closed claim can be claimed again', () => {
  const ledger = new ClaimLedger();
  ledger.claim('t1', 'a', T0);
  assert.equal(code(() => ledger.claim('t1', 'b', T0)), 'ALREADY_CLAIMED');
  ledger.close('t1', 'failed', 'a', T0 + 1);
  assert.equal(ledger.claim('t1', 'b', T0 + 2).holderId, 'b');
});

test('only the holder can heartbeat, block or release', () => {
  const ledger = new ClaimLedger();
  ledger.claim('t1', 'a', T0);
  assert.equal(code(() => ledger.heartbeat('t1', 'b', T0)), 'UNAUTHORIZED');
  assert.equal(code(() => ledger.block('t1', 'b', 'x', T0)), 'UNAUTHORIZED');
  assert.equal(code(() => ledger.release('t1', 'b', T0)), 'UNAUTHORIZED');
  assert.equal(code(() => ledger.heartbeat('nope', 'a', T0)), 'NOT_CLAIMED');
});

test('heartbeat validates progress and records it', () => {
  const ledger = new ClaimLedger();
  ledger.claim('t1', 'a', T0);
  assert.equal(code(() => ledger.heartbeat('t1', 'a', T0, 101)), 'VALIDATION_ERROR');
  assert.equal(code(() => ledger.heartbeat('t1', 'a', T0, Number.NaN)), 'VALIDATION_ERROR');
  assert.equal(ledger.heartbeat('t1', 'a', T0 + MIN, 40).progress, 40);
});

test('sweep marks only stale claims and is deterministic', () => {
  const ledger = new ClaimLedger();
  ledger.claim('stale', 'a', T0);
  ledger.claim('fresh', 'b', T0);
  ledger.heartbeat('fresh', 'b', T0 + 25 * MIN);

  assert.deepEqual(ledger.sweep(T0 + 29 * MIN), []);
  const changed = ledger.sweep(T0 + 30 * MIN);
  assert.deepEqual(changed.map((c) => c.taskId), ['stale']);
  assert.equal(ledger.get('stale')?.stealableReason, 'stale');
  assert.equal(ledger.get('stale')?.graceEndsAt, T0 + 40 * MIN);
  assert.equal(ledger.get('fresh')?.status, 'active');
  assert.deepEqual(ledger.sweep(T0 + 31 * MIN), []); // already stealable
});

test('a claim blocked for too long becomes stealable; a heartbeat does not hide the block', () => {
  const ledger = new ClaimLedger({ staleMinutes: 1000 });
  ledger.claim('t1', 'a', T0);
  assert.equal(code(() => ledger.block('t1', 'a', '  ', T0)), 'VALIDATION_ERROR');
  ledger.block('t1', 'a', 'waiting for review', T0);
  ledger.heartbeat('t1', 'a', T0 + 50 * MIN);
  assert.deepEqual(ledger.sweep(T0 + 59 * MIN), []);
  assert.equal(ledger.sweep(T0 + 60 * MIN)[0].stealableReason, 'blocked');
});

test('unblock returns an unblocked claim to active', () => {
  const ledger = new ClaimLedger();
  ledger.claim('t1', 'a', T0);
  assert.equal(code(() => ledger.unblock('t1', 'a', T0)), 'INVALID_STATUS_TRANSITION');
  ledger.block('t1', 'a', 'why', T0);
  const claim = ledger.unblock('t1', 'a', T0 + MIN);
  assert.equal(claim.status, 'active');
  assert.equal(claim.blockedAt, undefined);
});

test('steal respects status, grace period, own claim and capacity', () => {
  const ledger = new ClaimLedger();
  ledger.claim('t1', 'a', T0);
  assert.equal(code(() => ledger.steal('t1', 'b', T0, room)), 'NOT_STEALABLE');

  ledger.sweep(T0 + 30 * MIN);
  assert.equal(code(() => ledger.steal('t1', 'b', T0 + 35 * MIN, room)), 'IN_GRACE_PERIOD');
  assert.equal(code(() => ledger.steal('t1', 'a', T0 + 41 * MIN, room)), 'UNAUTHORIZED');
  assert.equal(code(() => ledger.steal('t1', 'b', T0 + 41 * MIN, { challengerOpenClaims: 2, maxClaims: 2 })), 'CHALLENGER_AT_CAPACITY');

  ledger.heartbeat('t1', 'a', T0 + 31 * MIN, 80);
  ledger.sweep(T0 + 62 * MIN);
  const stolen = ledger.steal('t1', 'b', T0 + 72 * MIN, room);
  assert.equal(stolen.previousHolderId, 'a');
  assert.equal(stolen.previousProgress, 80); // high progress does not protect a dead claim
  assert.equal(stolen.claim.holderId, 'b');
  assert.equal(stolen.claim.status, 'active');
  assert.equal(stolen.claim.graceEndsAt, undefined);
});

test('the holder can take a stealable claim back during the grace period', () => {
  const ledger = new ClaimLedger();
  ledger.claim('t1', 'a', T0);
  ledger.sweep(T0 + 30 * MIN);
  const claim = ledger.heartbeat('t1', 'a', T0 + 32 * MIN);
  assert.equal(claim.status, 'active');
  assert.equal(code(() => ledger.steal('t1', 'b', T0 + 60 * MIN, room)), 'NOT_STEALABLE');
});

test('release makes a claim stealable at once', () => {
  const ledger = new ClaimLedger();
  ledger.claim('t1', 'a', T0);
  ledger.release('t1', 'a', T0 + MIN);
  assert.equal(ledger.steal('t1', 'b', T0 + MIN, room).claim.holderId, 'b');
});

test('handoff: request, accept and reject', () => {
  const ledger = new ClaimLedger();
  ledger.claim('t1', 'a', T0);
  assert.equal(code(() => ledger.requestHandoff('t1', 'a', 'a', 'x', T0, { targetOpenClaims: 0, maxClaims: 1 })), 'VALIDATION_ERROR');
  assert.equal(code(() => ledger.requestHandoff('t1', 'a', 'b', 'x', T0, { targetOpenClaims: 1, maxClaims: 1 })), 'TARGET_AT_CAPACITY');
  assert.equal(code(() => ledger.requestHandoff('t1', 'b', 'c', 'x', T0, { targetOpenClaims: 0, maxClaims: 1 })), 'UNAUTHORIZED');

  ledger.requestHandoff('t1', 'a', 'b', 'needs a reviewer', T0, { targetOpenClaims: 0, maxClaims: 1 });
  assert.equal(code(() => ledger.heartbeat('t1', 'a', T0)), 'HANDOFF_PENDING');
  assert.equal(code(() => ledger.acceptHandoff('t1', 'c', T0)), 'UNAUTHORIZED');
  assert.equal(code(() => ledger.rejectHandoff('t1', 'c', T0)), 'UNAUTHORIZED');
  assert.equal(ledger.sweep(T0 + 500 * MIN).length, 0); // a pending handoff is not swept

  ledger.rejectHandoff('t1', 'a', T0 + MIN);
  assert.equal(ledger.get('t1')?.holderId, 'a');
  assert.equal(ledger.get('t1')?.status, 'active');

  ledger.requestHandoff('t1', 'a', 'b', 'again', T0 + 2 * MIN, { targetOpenClaims: 0, maxClaims: 1 });
  const accepted = ledger.acceptHandoff('t1', 'b', T0 + 3 * MIN);
  assert.equal(accepted.holderId, 'b');
  assert.equal(accepted.handoff, undefined);
  assert.equal(code(() => ledger.acceptHandoff('t1', 'b', T0 + 4 * MIN)), 'HANDOFF_NOT_FOUND');
});

test('close is idempotent and ignores unknown tasks; heldBy lists open claims only', () => {
  const ledger = new ClaimLedger();
  assert.equal(ledger.close('nope', 'completed', 'a', T0), undefined);
  ledger.claim('t1', 'a', T0);
  ledger.claim('t2', 'a', T0);
  ledger.close('t1', 'completed', 'a', T0 + 1);
  ledger.close('t1', 'failed', 'a', T0 + 2);
  assert.equal(ledger.get('t1')?.outcome, 'completed');
  assert.deepEqual(ledger.heldBy('a').map((c) => c.taskId), ['t2']);
});

test('snapshot and restore keep every claim, and a restored copy is independent', () => {
  const ledger = new ClaimLedger();
  ledger.claim('t1', 'a', T0);
  ledger.block('t1', 'a', 'why', T0 + 1);
  const copy = new ClaimLedger();
  copy.restore(JSON.parse(JSON.stringify(ledger.snapshot())));
  assert.deepEqual(copy.get('t1'), ledger.get('t1'));
  copy.unblock('t1', 'a', T0 + 2);
  assert.equal(ledger.get('t1')?.status, 'blocked');
});

test('the policy rejects negative or non-finite values', () => {
  assert.throws(() => new ClaimLedger({ staleMinutes: -1 }), /staleMinutes/);
  assert.throws(() => new ClaimLedger({ graceMinutes: Number.NaN }), /graceMinutes/);
});

// ---- CLI

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-claims-test-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function project(name: string) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const run = async (...args: string[]) => {
    const { code: exit, output } = await runCommand(args, dir);
    return { code: exit, out: output as any };
  };
  const ledgerPath = path.join(dir, '.colony', 'ledger.json');
  const editLedger = async (edit: (ledger: any) => void) => {
    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf-8'));
    edit(ledger);
    await fs.writeFile(ledgerPath, JSON.stringify(ledger), 'utf-8');
  };
  await run('boot');
  return { run, editLedger };
}

test('next opens a claim and done closes it', async () => {
  const { run } = await project('open-close');
  const added = await run('task', 'add', 'Build', 'Write the thing', '--role', 'engineer');
  const next = await run('next', '--as', 'engineer');
  const taskId = added.out.task.id;
  assert.equal(next.out.task.id, taskId);

  const list = await run('claim', 'list');
  assert.equal(list.out.claims.length, 1);
  assert.equal(list.out.claims[0].taskId, taskId);
  assert.equal(list.out.claims[0].status, 'active');

  await run('done', taskId, '--result', 'built it');
  assert.equal((await run('claim', 'list')).out.claims.length, 0);
});

test('a dead holder is swept, then the task is stolen by another member', async () => {
  const { run, editLedger } = await project('steal');
  const added = await run('task', 'add', 'Build', 'Write the thing', '--role', 'engineer');
  const taskId = added.out.task.id;
  const next = await run('next', '--as', 'engineer');
  const holder = next.out.member.id;
  const thief = 'member_reviewer';
  assert.notEqual(holder, thief);

  // Nothing is stale yet, so there is nothing to steal.
  assert.deepEqual((await run('claim', 'sweep')).out.markedStealable, []);
  const early = await run('claim', 'steal', taskId, '--as', thief);
  assert.equal(early.code, 1);
  assert.match(early.out.error, /NOT_STEALABLE/);

  // Age the claim by an hour, as if the holder's session had died.
  await editLedger((l) => {
    for (const c of l.claims) c.lastActivityAt -= 60 * MIN;
  });
  const swept = await run('claim', 'sweep');
  assert.equal(swept.out.markedStealable[0].taskId, taskId);
  assert.equal(swept.out.markedStealable[0].reason, 'stale');

  const grace = await run('claim', 'steal', taskId, '--as', thief);
  assert.match(grace.out.error, /IN_GRACE_PERIOD/);

  await editLedger((l) => {
    for (const c of l.claims) c.graceEndsAt = Date.now() - 1;
  });
  const stolen = await run('claim', 'steal', taskId, '--as', thief);
  assert.equal(stolen.code, 0);
  assert.equal(stolen.out.previousHolderId, holder);
  assert.equal(stolen.out.claim.holderId, thief);

  const status = await run('status');
  assert.equal(status.out.tasks.find((t: any) => t.id === taskId).assignedAgentId, thief);
  const members = status.out.members as any[];
  assert.deepEqual(members.find((m) => m.id === holder).tasks, []);
  assert.deepEqual(members.find((m) => m.id === thief).tasks, [taskId]);

  await run('done', taskId, '--result', 'finished by the thief');
  assert.equal((await run('claim', 'list')).out.claims.length, 0);
});

test('handoff moves the task to the target once accepted', async () => {
  const { run } = await project('handoff');
  const added = await run('task', 'add', 'Review', 'Review the thing', '--role', 'engineer');
  const taskId = added.out.task.id;
  const holder = (await run('next', '--as', 'engineer')).out.member.id;

  const noReason = await run('claim', 'handoff', taskId, '--as', holder, '--to', 'member_reviewer');
  assert.match(noReason.out.error, /needs a reason/);
  const unknown = await run('claim', 'handoff', taskId, '--as', holder, '--to', 'nobody', '--reason', 'x');
  assert.match(unknown.out.error, /--to must be a member id/);

  await run('claim', 'handoff', taskId, '--as', holder, '--to', 'member_reviewer', '--reason', 'needs a reviewer');
  const wrong = await run('claim', 'accept', taskId, '--as', 'member_tester');
  assert.match(wrong.out.error, /UNAUTHORIZED/);

  const accepted = await run('claim', 'accept', taskId, '--as', 'member_reviewer');
  assert.equal(accepted.code, 0);
  assert.equal(accepted.out.claim.holderId, 'member_reviewer');
  const status = await run('status');
  assert.equal(status.out.tasks.find((t: any) => t.id === taskId).assignedAgentId, 'member_reviewer');
});

test('heartbeat, block and release go through the CLI', async () => {
  const { run } = await project('lifecycle');
  const taskId = (await run('task', 'add', 'Build', 'Write the thing', '--role', 'engineer')).out.task.id;
  const holder = (await run('next', '--as', 'engineer')).out.member.id;

  const beat = await run('claim', 'heartbeat', taskId, '--as', holder, '--progress', '50');
  assert.equal(beat.out.claim.progress, 50);
  const bad = await run('claim', 'heartbeat', taskId, '--as', holder, '--progress', '500');
  assert.match(bad.out.error, /VALIDATION_ERROR/);

  assert.equal((await run('claim', 'block', taskId, '--as', holder, '--reason', 'waiting')).out.claim.status, 'blocked');
  assert.equal((await run('claim', 'unblock', taskId, '--as', holder)).out.claim.status, 'active');
  assert.equal((await run('claim', 'release', taskId, '--as', holder)).out.claim.status, 'stealable');

  const missing = await run('claim', 'heartbeat', 'task_nope', '--as', holder);
  assert.match(missing.out.error, /not found/);
});

test('a ledger written before claims existed still loads', async () => {
  const { run, editLedger } = await project('legacy-ledger');
  await editLedger((l) => {
    delete l.claims;
  });
  const list = await run('claim', 'list');
  assert.equal(list.code, 0);
  assert.deepEqual(list.out.claims, []);
});
