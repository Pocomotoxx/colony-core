import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HNSW_THRESHOLD } from '../memory/file-vector-store.js';
import { USAGE } from '../cli/commands.js';
import { ConsensusEngine } from '../consensus/consensus-engine.js';
import { MessageBus } from '../message-bus.js';

/**
 * The README is a claim about the code. These tests keep the claims that can be checked
 * mechanically from drifting away from it: thresholds, dependencies, the command list, and
 * what a vote's confidence does.
 */

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readme = await fs.readFile(path.join(repo, 'README.md'), 'utf-8');
const pkg = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf-8'));

test('the README states the same HNSW threshold as the code', () => {
  const m = readme.match(/csak\s+([\d\s]+?)\s*vektor fölött/);
  assert.ok(m, 'the README names the threshold above which the auto mode uses HNSW');
  assert.equal(Number(m![1].replace(/\s+/g, '')), DEFAULT_HNSW_THRESHOLD);
});

test('the README does not claim a library the package does not depend on', () => {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const lib of ['zod']) {
    if (!(lib in deps)) assert.ok(!new RegExp(`${lib}-alapú`, 'i').test(readme), `README says it is ${lib}-based, but ${lib} is not a dependency`);
  }
});

test('the README does not hard-code a test count, which would go stale', () => {
  assert.ok(!/\b\d{2,4}\s+teszt\b/.test(readme), 'a test count in the README goes out of date with the next test');
});

test('every command in the README command table exists in the CLI usage', () => {
  const rows = readme.split('\n').filter((l) => /^\| `[a-z]/.test(l));
  assert.ok(rows.length > 20, 'the command table was found');
  const known = new Set(['hook']); // handled before the command dispatch, listed in the README
  for (const row of rows) {
    const command = row.match(/^\| `([a-z]+)/)![1];
    assert.ok(known.has(command) || USAGE.includes(command), `README lists '${command}', the CLI usage does not`);
  }
});

test('a vote\'s confidence is validated and advisory: it never changes the count', async () => {
  const make = async () => {
    const engine = new ConsensusEngine(new MessageBus());
    const p = await engine.submitProposal({ taskId: 't', proposerId: 'a', topic: 'x', data: {}, quorum: 2 });
    return { engine, id: p.id };
  };
  const { engine, id } = await make();
  for (const confidence of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(engine.castVote(id, { voterId: 'a', approve: true, confidence }), /confidence must be a finite number between 0 and 1/);
  }
  assert.equal(engine.getProposal(id)!.votes.size, 0);

  // two approvals with almost no confidence still meet a quorum of two: the count decides
  await engine.castVote(id, { voterId: 'a', approve: true, confidence: 0.01 });
  assert.equal(engine.getProposal(id)!.status, 'open');
  await engine.castVote(id, { voterId: 'b', approve: true, confidence: 0.01 });
  assert.equal(engine.getProposal(id)!.status, 'approved');

  // and a confident minority cannot outweigh the count
  const other = await make();
  await other.engine.castVote(other.id, { voterId: 'a', approve: true, confidence: 1 });
  assert.equal(other.engine.getProposal(other.id)!.status, 'open');
});

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('the core reads exactly the environment variables the README names, and makes no network call', async () => {
  const files = await sourceFiles(path.join(repo, 'src'));
  const envReads = new Set<string>();
  for (const file of files) {
    const text = await fs.readFile(file, 'utf-8');
    for (const m of text.matchAll(/process\.env\.([A-Za-z_]+)|process\.env\[['"]([A-Za-z_]+)['"]\]/g)) envReads.add(m[1] ?? m[2]);
    assert.ok(!/\bfetch\(|node:https?['"]|node:net['"]|node:dns['"]|node:tls['"]|WebSocket/.test(text), `${path.relative(repo, file)} looks like it uses the network`);
  }
  assert.deepEqual([...envReads].sort(), ['ComSpec']);
  assert.ok(readme.includes('ComSpec'), 'the README names the one environment variable the core reads');
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'the README promises zero runtime dependencies');
});

test('the README says that a claim becomes stealable only when someone runs claim sweep', () => {
  assert.match(readme, /csak amikor valaki lefuttatja a `claim sweep` parancsot/);
});
