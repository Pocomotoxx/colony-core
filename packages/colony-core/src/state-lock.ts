import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorCode } from './errors.js';

/**
 * A lock for the state directory, so two hosts running commands at the same time cannot overwrite
 * each other's ledger. Every command loads the whole state and writes it back, so the whole command
 * runs under the lock.
 *
 * The lock is a file created with `wx` (it fails if it exists). A lock is stale, and may be taken
 * over, when its owner is a dead process on this machine, or when it is older than `staleMs` (a
 * command is short; the age is the fallback when the owner cannot be checked, for example on
 * another machine).
 *
 * Taking over a stale lock is itself guarded by a second `wx` file (the takeover mutex): only its
 * holder may remove a stale lock, and it re-reads the lock first and removes it only if it is still
 * the very lock that was judged stale. A new lock can only be created while no lock file exists, so
 * between that re-read and the removal nobody can slip a fresh lock in. (A plain "delete when
 * stale" lets a slow waiter delete the FRESH lock another waiter had just created; renaming the
 * lock away and back has a gap in which a third process creates a second lock.)
 *
 * Honest limit: the one remaining window is a live holder that is merely older than `staleMs`
 * finishing at exactly the moment of the takeover. Commands take milliseconds to seconds, the
 * default is a minute.
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
  /** Unique to this acquisition, so a release or a takeover can tell whose lock a file is. */
  token: string;
}

const LOCK_FILE = 'state.lock';
const TAKEOVER_FILE = 'state.lock.takeover';
/** A takeover takes microseconds; a mutex file older than this was left by a crash. */
const TAKEOVER_STALE_MS = 10_000;

/**
 * `open(..., 'wx')` failed because the file is there (EEXIST), or, on Windows, because the previous
 * file of that name is still being deleted: then the error is EPERM or EACCES instead. Both mean
 * "busy, try again".
 */
function isBusy(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'EEXIST' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === 'EPERM'; // exists, but not ours to signal
  }
}

async function readInfo(file: string): Promise<LockInfo | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
    return typeof parsed?.pid === 'number' && typeof parsed?.at === 'number' && typeof parsed?.token === 'string' ? (parsed as LockInfo) : null;
  } catch {
    return null;
  }
}

async function ageOf(file: string): Promise<number> {
  try {
    return Date.now() - (await fs.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Remove the lock at `file` if, and only if, it is still the one judged stale (`held`, or an
 * unreadable file that is still old when `held` is null). Only one process at a time gets in.
 */
async function takeOverStale(stateDir: string, file: string, held: LockInfo | null, staleMs: number): Promise<void> {
  const mutex = path.join(stateDir, TAKEOVER_FILE);
  let handle;
  try {
    handle = await fs.open(mutex, 'wx');
  } catch (err) {
    if (!isBusy(err)) throw err;
    if ((await ageOf(mutex)) > TAKEOVER_STALE_MS) await fs.rm(mutex, { force: true }); // left by a crash
    return; // another waiter is taking over: wait for its result
  }
  try {
    const current = await readInfo(file);
    const unchanged = held === null ? current === null && (await ageOf(file)) > staleMs : current !== null && current.token === held.token;
    if (unchanged) await fs.rm(file, { force: true });
  } finally {
    await handle.close();
    await fs.rm(mutex, { force: true });
  }
}

/** Run `work` while holding the lock of `stateDir`. The lock is released when `work` ends, however it ends. */
export async function withStateLock<T>(stateDir: string, work: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const { timeoutMs = 10_000, staleMs = 60_000, pollMs = 25 } = options;
  const file = path.join(stateDir, LOCK_FILE);
  await fs.mkdir(stateDir, { recursive: true });
  const info: LockInfo = { pid: process.pid, host: os.hostname(), at: Date.now(), token: `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}` };
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(JSON.stringify(info));
      await handle.close();
      break;
    } catch (err) {
      if (!isBusy(err)) throw err;
    }
    const held = await readInfo(file);
    const sameHost = held?.host === info.host;
    const stale = held === null ? (await ageOf(file)) > staleMs : (sameHost && !processAlive(held.pid)) || Date.now() - held.at > staleMs;
    if (stale) {
      await takeOverStale(stateDir, file, held, staleMs);
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
    // Remove the lock only if it is still ours: if this command ran past `staleMs` and was taken
    // over, the file belongs to someone else now.
    const current = await readInfo(file);
    if (current?.token === info.token) await fs.rm(file, { force: true });
  }
}
