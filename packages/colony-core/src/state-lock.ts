import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * A lock for the state directory, so two hosts running commands at the same time cannot overwrite
 * each other's ledger. Every command loads the whole state and writes it back, so the whole command
 * runs under the lock.
 *
 * The lock is a file created with `wx` (it fails if it exists). A lock is stale, and taken over, when
 * its owner is a dead process on this machine, or when it is older than `staleMs` (a command is short;
 * the age is the fallback when the owner cannot be checked, for example on another machine).
 */

export class LockTimeoutError extends Error {}

export interface LockOptions {
  /** How long to wait for a busy lock. */
  timeoutMs?: number;
  /** A lock older than this is considered abandoned. */
  staleMs?: number;
  pollMs?: number;
}

interface LockInfo {
  pid: number;
  host: string;
  at: number;
}

const LOCK_FILE = 'state.lock';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM'; // exists, but not ours to signal
  }
}

async function readInfo(file: string): Promise<LockInfo | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
    return typeof parsed?.pid === 'number' && typeof parsed?.at === 'number' ? (parsed as LockInfo) : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `work` while holding the lock of `stateDir`. The lock is released when `work` ends, however it ends. */
export async function withStateLock<T>(stateDir: string, work: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const { timeoutMs = 10_000, staleMs = 60_000, pollMs = 25 } = options;
  const file = path.join(stateDir, LOCK_FILE);
  await fs.mkdir(stateDir, { recursive: true });
  const info: LockInfo = { pid: process.pid, host: os.hostname(), at: Date.now() };
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(JSON.stringify(info));
      await handle.close();
      break;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }
    const held = await readInfo(file);
    const sameHost = held?.host === info.host;
    const stale = held === null ? await ageOf(file) > staleMs : (sameHost && !processAlive(held.pid)) || Date.now() - held.at > staleMs;
    if (stale) {
      await fs.rm(file, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new LockTimeoutError(`another colony command holds the state lock (pid ${held?.pid ?? '?'}); try again in a moment`);
    }
    await sleep(pollMs);
  }

  try {
    return await work();
  } finally {
    await fs.rm(file, { force: true });
  }
}

async function ageOf(file: string): Promise<number> {
  try {
    return Date.now() - (await fs.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}
