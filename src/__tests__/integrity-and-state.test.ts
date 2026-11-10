import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../cli/commands.js';
import { ColonyHub } from '../colony-hub.js';
import { ConsensusEngine } from '../consensus/consensus-engine.js';
import { MessageBus } from '../message-bus.js';

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-state-'));
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

const hubWith = () => {
  const hub = new ColonyHub();
  hub.registry.register({ id: 'e1', name: 'e1', role: 'engineer', capabilities: { maxConcurrentTasks: 2 } });
  return hub;
};

// ---- ledger integrity

test('a ledger edited by hand is noticed: commands stop, diagnostics report, accepting is explicit and audited', async () => {
  const { dir, run } = await project('tamper');
  const id = (await run('task', 'add', 'T', 'D', '--role', 'engineer')).out.task.id;
  const file = path.join(dir, '.colony', 'ledger.json');
  const ledger = JSON.parse(await fs.readFile(file, 'utf-8'));
  const task = ledger.tasks.find((t: any) => t.id === id);
  task.status = 'completed';
  task.quality = 1;
  await fs.writeFile(file, JSON.stringify(ledger));

  const blocked = await run('status');
  assert.equal(blocked.code, 2);
  assert.match(blocked.out.error, /changed outside the colony/);
  assert.match(blocked.out.error, /boot --accept-changes/);

  // read-only diagnostics still run, report it, and do not write over the evidence
  const watch = await run('watch');
  assert.equal(watch.code, 0);
  assert.ok(watch.out.warnings.some((w: string) => /changed outside the colony/.test(w)));
  const stillBlocked = await run('status');
  assert.equal(stillBlocked.code, 2, 'a diagnostic command must not accept the change by saving');

  // a plain boot does not take it either
  assert.equal((await run('boot')).code, 2);

  const accepted = await run('boot', '--accept-changes');
  assert.equal(accepted.code, 0);
  assert.equal((await run('status')).out.tasks[0].status, 'completed');
  assert.equal((await run('audit', 'list', '--type', 'integrity.accepted')).out.entries.length, 1);
});

test('an audit log cut short is noticed by every command, not only at the next boot', async () => {
  const { dir, run } = await project('cut');
  await run('task', 'add', 'One', 'First', '--role', 'engineer');
  await run('task', 'add', 'Two', 'Second', '--role', 'engineer');
  const auditPath = path.join(dir, '.colony', 'audit.jsonl');
  const lines = (await fs.readFile(auditPath, 'utf-8')).trim().split('\n');
  await fs.writeFile(auditPath, lines[0] + '\n');
  const r = await run('status');
  assert.equal(r.code, 2);
  assert.match(r.out.error, /no longer holds the entries/);
});

test('a state from before the integrity record still opens, and the next save writes one', async () => {
  const { dir, run } = await project('legacy-state');
  await fs.rm(path.join(dir, '.colony', 'integrity.json'));
  assert.equal((await run('status')).code, 0);
  await run('task', 'add', 'A', 'B', '--role', 'engineer');
  const record = JSON.parse(await fs.readFile(path.join(dir, '.colony', 'integrity.json'), 'utf-8'));
  assert.match(record.ledger, /^[0-9a-f]{64}$/);
});

test('a rule manifest with no mandatory rule blocks the boot', async () => {
  const { dir, run } = await project('empty-manifest');
  await fs.writeFile(path.join(dir, '.colony', 'rules', 'manifest.json'), JSON.stringify({ mandatory: [] }));
  const boot = await run('boot');
  assert.equal(boot.code, 2);
  assert.ok(boot.out.boot.problems.some((p: string) => /no rule file/.test(p)));
});

// ---- the state machine in the library layer

test('a task is closed once, by its holder, while it is being worked on', async () => {
  const hub = hubWith();
  hub.registry.register({ id: 'e2', name: 'e2', role: 'engineer' });
  const t = await hub.orchestrator.createTask({ title: 'A', description: 'B', requiredRole: 'engineer' });
  await assert.rejects(hub.orchestrator.completeTask(t.id, 'someone-else', 'x'), /held by/);
  await hub.orchestrator.completeTask(t.id, t.assignedAgentId!, 'first', { quality: 0.9 });
  await assert.rejects(hub.orchestrator.completeTask(t.id, t.assignedAgentId!, 'again'), /only an open task can be completed/);
  await assert.rejects(hub.orchestrator.failTask(t.id, t.assignedAgentId!, 'late'), /only an open task can be failed/);
  await assert.rejects(hub.orchestrator.updateTaskProgress(t.id, 'e1', 'in_progress'), /only an open task can change its progress/);
  assert.equal(hub.orchestrator.getTask(t.id)!.outputResult, 'first');
  assert.equal(hub.orchestrator.getTask(t.id)!.quality, 0.9);
});

test('a task cannot be handed to a member that is gone, offline or full', async () => {
  const hub = hubWith();
  hub.registry.register({ id: 'off', name: 'off', role: 'engineer' });
  hub.registry.updateStatus('off', 'offline');
  const t = await hub.orchestrator.createTask({ title: 'A', description: 'B', requiredRole: 'engineer' });
  await assert.rejects(hub.orchestrator.reassignTask(t.id, 'nobody'), /not found/);
  await assert.rejects(hub.orchestrator.reassignTask(t.id, 'off'), /offline/);
  hub.registry.register({ id: 'full', name: 'full', role: 'engineer', capabilities: { maxConcurrentTasks: 1 } });
  hub.registry.assignTask('full', 'other-task');
  await assert.rejects(hub.orchestrator.reassignTask(t.id, 'full'), /at capacity/);
});

test('a member keeps its offline or error status when it takes or finishes a task; one with open tasks cannot be removed', async () => {
  const hub = hubWith();
  hub.registry.register({ id: 'off', name: 'off', role: 'engineer', capabilities: { maxConcurrentTasks: 5 } });
  hub.registry.updateStatus('off', 'offline');
  hub.registry.assignTask('off', 'x');
  assert.equal(hub.registry.getMember('off')!.status, 'offline');
  hub.registry.updateStatus('off', 'error');
  hub.registry.completeTask('off', 'x');
  assert.equal(hub.registry.getMember('off')!.status, 'error');

  const t = await hub.orchestrator.createTask({ title: 'A', description: 'B', requiredRole: 'engineer' });
  assert.throws(() => hub.registry.unregister(t.assignedAgentId!), /still holds 1 open task/);
  assert.equal(hub.registry.unregister('off'), true);
});

test('submitAdaptiveTask leaves the caller\'s options alone', async () => {
  const hub = hubWith();
  const options = { title: 'Fix the bug', description: 'a bug in the code' };
  await hub.submitAdaptiveTask(options);
  assert.deepEqual(options, { title: 'Fix the bug', description: 'a bug in the code' });
});

// ---- consensus input and deadline

test('a proposal needs a positive integer quorum and a positive timeout; a past deadline closes it without a vote', async () => {
  const engine = new ConsensusEngine(new MessageBus());
  const base = { taskId: 't', proposerId: 'a', topic: 'x', data: {} };
  for (const quorum of [-1, 0, 1.5, Number.NaN]) {
    await assert.rejects(engine.submitProposal({ ...base, quorum }), /quorum must be a positive integer/, String(quorum));
  }
  for (const timeoutMs of [0, -5, Number.NaN]) {
    await assert.rejects(engine.submitProposal({ ...base, timeoutMs }), /timeoutMs must be a positive/, String(timeoutMs));
  }
  const p = await engine.submitProposal({ ...base, quorum: 2, timeoutMs: 5 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(engine.getProposal(p.id)!.status, 'open');
  assert.equal(await engine.expireDue(), 1);
  assert.equal(engine.getProposal(p.id)!.status, 'timeout');
  assert.equal(await engine.expireDue(), 0);
  await assert.rejects(engine.castVote(p.id, { voterId: 'a', approve: true }), /already finalized \(timeout\)/);
});

test('a finished task cannot be brought back to a vote, and an expired proposal is closed on the next command', async () => {
  const { run } = await project('propose');
  const id = (await run('task', 'add', 'Done', 'finished', '--role', 'engineer')).out.task.id;
  await run('next', '--as', 'engineer');
  await run('done', id, '--result', 'ok', '--quality', '0.9');
  const p = await run('propose', id, 'again?', '--as', 'engineer', '--quorum', '2');
  assert.equal(p.code, 1);
  assert.match(p.out.error, /only a task that is being worked on/);
  assert.equal((await run('status')).out.tasks.find((t: any) => t.id === id).status, 'completed');
});

// ---- size of what the ledger keeps

test('a result or error over the limit is refused with advice, and a stored long result is not stored twice', async () => {
  const hub = hubWith();
  const t = await hub.orchestrator.createTask({ title: 'Big', description: 'huge', requiredRole: 'engineer' });
  await assert.rejects(hub.orchestrator.completeTask(t.id, t.assignedAgentId!, 'x'.repeat(100_001)), /the limit is 100000.*summary and the path/);
  await assert.rejects(hub.orchestrator.failTask(t.id, t.assignedAgentId!, 'e'.repeat(100_001)), /the error text is 100001 characters/);
  assert.equal(hub.orchestrator.getTask(t.id)!.status, 'assigned'); // nothing changed

  const long = 'y'.repeat(60_000);
  await hub.orchestrator.completeTask(t.id, t.assignedAgentId!, long, { quality: 0.8 });
  const [doc] = (await hub.codex.store.list!()).filter((d) => d.namespace === 'reasoning_bank');
  assert.ok(doc.text.length < 3000, `the embedded text is a gist (${doc.text.length} chars)`);
  assert.equal((doc.metadata as { solution: string }).solution.length, 60_000); // the full text is kept once
  const [pattern] = await hub.reasoningBank.recallPatterns('Big huge', { minScore: 0 });
  assert.equal(pattern.solution.length, 60_000);
});

test('the done command reports the limit as a plain error', async () => {
  const { run } = await project('size-cli');
  const id = (await run('task', 'add', 'Big', 'huge', '--role', 'engineer')).out.task.id;
  await run('next', '--as', 'engineer');
  const r = await run('done', id, '--result', 'z'.repeat(100_001), '--quality', '0.5');
  assert.equal(r.code, 1);
  assert.match(r.out.error, /the limit is 100000/);
  assert.equal((await run('done', id, '--result', 'a summary', '--quality', '0.5')).code, 0);
});

// ---- who voted

test('a quorum reached by identical reasons within seconds is flagged: the colony cannot tell members apart', async () => {
  const { run } = await project('votes');
  const id = (await run('task', 'add', 'Risky', 'needs a vote', '--role', 'engineer')).out.task.id;
  await run('next', '--as', 'engineer');
  const p = (await run('propose', id, 'ship?', '--as', 'engineer', '--quorum', '3')).out.proposal;
  await run('vote', p.id, '--as', 'director', '--approve', '--reason', 'Looks fine to me');
  await run('vote', p.id, '--as', 'architect', '--approve', '--reason', 'looks  fine to me');
  const last = await run('vote', p.id, '--as', 'reviewer', '--approve', '--reason', 'Checked the diff and the tests');
  assert.equal(last.out.proposal.status, 'approved');
  const warnings: string[] = last.out.warnings ?? [];
  assert.ok(warnings.some((w) => /exactly the same reason \(member_director, member_architect\)/.test(w)), JSON.stringify(warnings));
  assert.ok(warnings.some((w) => /3 votes came within/.test(w)), JSON.stringify(warnings));
});
