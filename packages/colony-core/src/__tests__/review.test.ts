import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MAX_REVIEW_ROUNDS, lastVerdict, MAX_KEPT_REVIEWS, maxRoundsOf, REVIEW_LIMIT_HOLDER, reviewBlocksCompletion, validateMaxRounds } from '../chief/review.js';
import { ColonyHub } from '../colony-hub.js';
import { runCommand } from '../cli/commands.js';
import type { ReviewRecord } from '../types.js';

const rec = (verdict: ReviewRecord['verdict']): ReviewRecord => ({ by: 'r', verdict, reason: 'x', at: 0 });

// ---- pure rules

test('what a review blocks', () => {
  assert.equal(reviewBlocksCompletion({}), null);
  assert.equal(reviewBlocksCompletion({ reviewRequired: false, reviews: [rec('approve')] }), null);
  assert.match(reviewBlocksCompletion({ reviewRequired: true })!, /approval first/);
  assert.match(reviewBlocksCompletion({ reviewRequired: true, reviews: [rec('reject')] })!, /rejected/);
  assert.equal(reviewBlocksCompletion({ reviewRequired: true, reviews: [rec('reject'), rec('approve')] }), null);
  assert.match(reviewBlocksCompletion({ reviewRequired: true, reviews: [rec('approve'), rec('reject')] })!, /rejected/); // the latest verdict counts
  assert.match(reviewBlocksCompletion({ reviews: [rec('reject')] })!, /rejected/); // a rejection blocks even when no review was required
});

test('latest verdict, the limit and its validation', () => {
  assert.equal(lastVerdict({}), null);
  assert.equal(lastVerdict({ reviews: [rec('reject'), rec('approve')] }), 'approve');
  assert.equal(maxRoundsOf({}), DEFAULT_MAX_REVIEW_ROUNDS);
  assert.equal(maxRoundsOf({ maxReviewRounds: 5 }), 5);
  for (const bad of [0, 21, 1.5, Number.NaN]) assert.throws(() => validateMaxRounds(bad), /1 to 20/);
  assert.equal(validateMaxRounds(1), 1);
});

// ---- the loop in the orchestrator

const hubWith = () => {
  const hub = new ColonyHub();
  hub.registry.register({ id: 'dev', name: 'dev', role: 'engineer', capabilities: { maxConcurrentTasks: 5 } });
  hub.registry.register({ id: 'rev', name: 'rev', role: 'reviewer' });
  return hub;
};

const started = async (hub: ColonyHub, over: Record<string, unknown> = {}) => {
  const t = await hub.orchestrator.createTask({ title: 'T', description: 'd', requiredRole: 'engineer', ...over });
  await hub.orchestrator.updateTaskProgress(t.id, 'dev', 'in_progress');
  return t;
};

test('a rejection sends the work back and counts a round; an approval does not', async () => {
  const hub = hubWith();
  const t = await started(hub);
  await hub.orchestrator.updateTaskProgress(t.id, 'dev', 'review');
  const rejected = await hub.orchestrator.recordReview(t.id, 'rev', 'reject', 'the empty case is not handled');
  assert.equal(rejected.rounds, 1);
  assert.equal(rejected.escalated, false);
  assert.equal(rejected.task.status, 'in_progress');
  assert.deepEqual(rejected.task.reviews!.map((r) => [r.by, r.verdict, r.reason]), [['rev', 'reject', 'the empty case is not handled']]);

  const approved = await hub.orchestrator.recordReview(t.id, 'rev', 'approve', 'fixed');
  assert.equal(approved.rounds, 1); // an approval adds no round
  assert.equal(approved.task.status, 'in_progress');
});

test('the third rejection puts the task on hold for the user; earlier ones do not', async () => {
  const hub = hubWith();
  const t = await started(hub);
  for (let i = 1; i <= 2; i++) {
    const r = await hub.orchestrator.recordReview(t.id, 'rev', 'reject', `problem ${i}`);
    assert.equal(r.escalated, false);
    assert.equal(hub.orchestrator.getTask(t.id)!.hold, undefined);
  }
  const third = await hub.orchestrator.recordReview(t.id, 'rev', 'reject', 'problem 3');
  assert.equal(third.escalated, true);
  assert.equal(third.rounds, 3);
  assert.equal(third.task.hold!.by, REVIEW_LIMIT_HOLDER);
  assert.match(third.task.hold!.reason, /rejected 3 times/);
  await assert.rejects(() => hub.orchestrator.completeTask(t.id, 'dev', 'done'), /on hold/);
});

test('the limit is per task, and 1 holds at the first rejection', async () => {
  const hub = hubWith();
  const strict = await started(hub, { maxReviewRounds: 1 });
  assert.equal((await hub.orchestrator.recordReview(strict.id, 'rev', 'reject', 'no')).escalated, true);
  await assert.rejects(() => hub.orchestrator.createTask({ title: 'x', description: 'd', maxReviewRounds: 0 }), /1 to 20/);
});

test('releasing a hold the review limit placed gives the task a fresh set of rounds', async () => {
  const hub = hubWith();
  const t = await started(hub);
  for (let i = 0; i < 3; i++) await hub.orchestrator.recordReview(t.id, 'rev', 'reject', `p${i}`);
  assert.equal(hub.orchestrator.getTask(t.id)!.reviewRounds, 3);
  await hub.orchestrator.releaseHold(t.id, 'dir');
  assert.equal(hub.orchestrator.getTask(t.id)!.reviewRounds, 0);
  const again = await hub.orchestrator.recordReview(t.id, 'rev', 'reject', 'still wrong');
  assert.equal(again.rounds, 1);
  assert.equal(again.escalated, false);

  // a hold placed by someone else does not reset the count
  const u = await started(hub);
  await hub.orchestrator.recordReview(u.id, 'rev', 'reject', 'p');
  await hub.orchestrator.holdTask(u.id, 'aud', 'look at this');
  await hub.orchestrator.releaseHold(u.id, 'dir');
  assert.equal(hub.orchestrator.getTask(u.id)!.reviewRounds, 1);
});

test('completion waits for the approval, and a later rejection blocks it again', async () => {
  const hub = hubWith();
  const t = await started(hub, { reviewRequired: true });
  await assert.rejects(() => hub.orchestrator.completeTask(t.id, 'dev', 'done'), /approval first/);
  await hub.orchestrator.recordReview(t.id, 'rev', 'reject', 'redo');
  await assert.rejects(() => hub.orchestrator.completeTask(t.id, 'dev', 'done'), /rejected/);
  await hub.orchestrator.recordReview(t.id, 'rev', 'approve', 'ok now');
  await hub.orchestrator.recordReview(t.id, 'rev', 'reject', 'wait, no');
  await assert.rejects(() => hub.orchestrator.completeTask(t.id, 'dev', 'done'), /rejected/);
  await hub.orchestrator.recordReview(t.id, 'rev', 'approve', 'fine');
  await hub.orchestrator.completeTask(t.id, 'dev', 'done');
  assert.equal(hub.orchestrator.getTask(t.id)!.status, 'completed');
});

test('a task that needed no review completes without one, but not after a rejection', async () => {
  const hub = hubWith();
  const plain = await started(hub);
  await hub.orchestrator.completeTask(plain.id, 'dev', 'done');
  const rejected = await started(hub);
  await hub.orchestrator.recordReview(rejected.id, 'rev', 'reject', 'no');
  await assert.rejects(() => hub.orchestrator.completeTask(rejected.id, 'dev', 'done'), /rejected/);
  await hub.orchestrator.failTask(rejected.id, 'dev', 'giving up'); // failing stays possible
});

test('review refusals: own task, task not in progress, no reason, unknown task', async () => {
  const hub = hubWith();
  const t = await started(hub);
  await assert.rejects(() => hub.orchestrator.recordReview(t.id, 'dev', 'approve', 'my own work is fine'), /cannot review the task it holds/);
  await assert.rejects(() => hub.orchestrator.recordReview(t.id, 'rev', 'approve', '  '), /needs a reason/);
  await assert.rejects(() => hub.orchestrator.recordReview('nope', 'rev', 'approve', 'x'), /not found/);
  const fresh = await hub.orchestrator.createTask({ title: 'F', description: 'd', requiredRole: 'engineer' }); // assigned, not started
  await assert.rejects(() => hub.orchestrator.recordReview(fresh.id, 'rev', 'approve', 'x'), /only work in progress/);
  assert.equal(hub.orchestrator.getTask(t.id)!.reviews, undefined); // nothing was recorded by the refusals
});

test('only the latest verdicts are kept', async () => {
  const hub = hubWith();
  const t = await started(hub, { maxReviewRounds: 20 });
  for (let i = 0; i < MAX_KEPT_REVIEWS + 5; i++) await hub.orchestrator.recordReview(t.id, 'rev', 'approve', `n${i}`);
  const reviews = hub.orchestrator.getTask(t.id)!.reviews!;
  assert.equal(reviews.length, MAX_KEPT_REVIEWS);
  assert.equal(reviews.at(-1)!.reason, `n${MAX_KEPT_REVIEWS + 4}`);
});

// ---- CLI

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-review-test-'));
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

test('review: roles, flags and reasons are checked', async () => {
  const { run } = await project('cli-checks');
  const id = (await run('task', 'add', 'Build', 'Write the thing', '--role', 'engineer', '--review')).out.task.id;
  await run('next', '--as', 'engineer');
  assert.match((await run('review', id, '--as', 'architect', '--approve', '--reason', 'x')).out.error, /only a reviewer/);
  assert.match((await run('review', id, '--as', 'reviewer', '--reason', 'x')).out.error, /exactly one/);
  assert.match((await run('review', id, '--as', 'reviewer', '--approve', '--reject', '--reason', 'x')).out.error, /exactly one/);
  assert.match((await run('review', id, '--as', 'reviewer', '--approve')).out.error, /--reason/);
  assert.match((await run('review', 'task_nope', '--as', 'reviewer', '--approve', '--reason', 'x')).out.error, /not found/);
  assert.match((await run('task', 'add', 'x', 'y', '--max-review-rounds', '0')).out.error, /--max-review-rounds/);
});

test('the full loop: reject, feedback in next, blocked done, approve, done', async () => {
  const { dir, run } = await project('cli-loop');
  const id = (await run('task', 'add', 'Build', 'Write the thing', '--role', 'engineer', '--review')).out.task.id;
  assert.deepEqual((await run('status')).out.tasks[0].review, { required: true, rounds: 0, maxRounds: 3, last: null });
  await run('next', '--as', 'engineer');

  assert.match((await run('done', id, '--result', 'first try')).out.error, /approval first/);

  const rejected = await run('review', id, '--as', 'reviewer', '--reject', '--reason', 'the empty input case crashes; contact anna@example.org');
  assert.equal(rejected.code, 0);
  assert.deepEqual([rejected.out.review.verdict, rejected.out.review.rounds, rejected.out.review.escalated], ['reject', 1, false]);
  assert.match(rejected.out.note, /sees the reason in `next`/);

  const next = await run('next', '--as', 'engineer');
  assert.equal(next.out.reviewFeedback.round, 1);
  assert.match(next.out.reviewFeedback.reason, /empty input case crashes/);
  assert.ok(!next.out.reviewFeedback.reason.includes('anna@example.org'));
  assert.match((await run('done', id, '--result', 'second try')).out.error, /rejected/);

  const approved = await run('review', id, '--as', 'reviewer', '--approve', '--reason', 'handles empty input now');
  assert.match(approved.out.note, /not a test result/);
  assert.equal((await run('next', '--as', 'engineer')).out.reviewFeedback, null);
  assert.equal((await run('done', id, '--result', 'third try')).code, 0);

  const raw = await fs.readFile(path.join(dir, '.colony', 'audit.jsonl'), 'utf-8');
  assert.ok(!raw.includes('anna@example.org'));
  const reviews = (await run('audit', 'list', '--type', 'task.reviewed')).out.entries;
  assert.deepEqual(reviews.map((e: any) => [e.payload.verdict, e.payload.round]), [['reject', 1], ['approve', 1]]);
});

test('three rejections hold the task for the user; releasing it gives a fresh set of rounds', async () => {
  const { run } = await project('cli-limit');
  const id = (await run('task', 'add', 'Build', 'Write the thing', '--role', 'engineer')).out.task.id;
  await run('next', '--as', 'engineer');

  for (let i = 1; i <= 2; i++) assert.equal((await run('review', id, '--as', 'reviewer', '--reject', '--reason', `problem ${i}`)).out.review.escalated, false);
  const third = await run('review', id, '--as', 'reviewer', '--reject', '--reason', 'problem 3');
  assert.equal(third.out.review.escalated, true);
  assert.match(third.out.note, /on hold and the user has to decide/);
  assert.equal(third.out.task.onHold.by, 'review-limit');
  assert.equal((await run('next', '--as', 'engineer')).out.task, null); // held: not handed out
  assert.ok((await run('watch')).out.report.findings.some((f: any) => f.kind === 'hold_open'));
  assert.ok((await run('health')).out.report.bottlenecks.some((b: any) => b.location === 'on hold'));
  const held = (await run('audit', 'list', '--type', 'task.held')).out.entries;
  assert.equal(held[0].payload.by, 'review-limit');

  const released = await run('hold', 'release', id, '--as', 'director', '--note', 'user: try once more, here is the missing detail');
  assert.equal(released.out.reviewRoundsReset, true);
  assert.equal(released.out.selfReleased, false);
  assert.equal(released.out.task.review.rounds, 0);
  assert.ok((await run('next', '--as', 'engineer')).out.task);
});

test('a reviewer cannot review the task it holds', async () => {
  const { run } = await project('cli-self');
  const id = (await run('task', 'add', 'Review the plan', 'Read the plan and report', '--role', 'reviewer')).out.task.id;
  await run('next', '--as', 'reviewer');
  assert.match((await run('review', id, '--as', 'reviewer', '--approve', '--reason', 'looks fine')).out.error, /cannot review the task it holds/);
});

test('--max-review-rounds sets the limit for one task', async () => {
  const { run } = await project('cli-max');
  const id = (await run('task', 'add', 'Build', 'Write the thing', '--role', 'engineer', '--max-review-rounds', '1')).out.task.id;
  await run('next', '--as', 'engineer');
  assert.equal((await run('review', id, '--as', 'reviewer', '--reject', '--reason', 'no')).out.review.escalated, true);
});
