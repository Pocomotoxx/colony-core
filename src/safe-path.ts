/**
 * Containment check for file paths, with symlinks resolved.
 *
 * Rewritten from the legacy `security` path validator. The lexical check the CLI used so far
 * (`path.relative` must not start with `..`) accepts a symlink or junction inside the project
 * that points outside it. Here both sides are canonicalized first: the root, and the candidate
 * (its longest existing ancestor is resolved through the filesystem, the missing tail is appended).
 *
 * Left out on purpose: the legacy blocklists of file names and extensions and its `..` substring
 * ban, which also rejects honest names like `a..b`. Containment is decided by the resolved path.
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { errorCode } from './errors.js';

export class SafePathError extends Error {
  constructor(public readonly code: 'EMPTY' | 'NUL' | 'TOO_LONG' | 'OUTSIDE' | 'UNRESOLVABLE', message: string) {
    super(message);
  }
}

const MAX_PATH = 4096;

const MAX_LINKS = 40;

const unresolvable = (target: string, code: string | undefined): SafePathError =>
  new SafePathError('UNRESOLVABLE', `cannot resolve '${path.basename(target)}' (${code ?? 'error'}): its state is unknown, so it is not judged by its name`);

/** Only a path that is really missing (ENOENT, ENOTDIR) is handled by name; any other failure is an unknown state and is refused. */
const isMissing = (err: unknown): boolean => errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR';

/**
 * realpath of the longest existing ancestor, with the missing remainder re-attached.
 * One rule for every failure, here and in canonicalizeSync: a path that does not exist is resolved through its parent;
 * a link that points nowhere (dangling) is followed to where it points, because a write through it creates that file;
 * every other error (no permission, a loop of links, ...) throws SafePathError('UNRESOLVABLE') instead of falling back to the text of the name.
 */
export async function canonicalize(target: string, links = 0): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (err) {
    if (!isMissing(err)) throw unresolvable(target, errorCode(err));
  }
  const parent = path.dirname(target);
  if (parent === target) return target;
  const real = path.join(await canonicalize(parent, links), path.basename(target));
  let isLink = false;
  try {
    isLink = (await fs.lstat(real)).isSymbolicLink();
  } catch (err) {
    if (!isMissing(err)) throw unresolvable(target, errorCode(err));
  }
  if (!isLink) return real;
  if (links >= MAX_LINKS) throw unresolvable(target, 'ELOOP');
  return canonicalize(path.resolve(path.dirname(real), await fs.readlink(real)), links + 1);
}

/** The same, synchronously (the shell check cannot wait). */
export function canonicalizeSync(target: string, links = 0): string {
  try {
    return realpathSync(target);
  } catch (err) {
    if (!isMissing(err)) throw unresolvable(target, errorCode(err));
  }
  const parent = path.dirname(target);
  if (parent === target) return target;
  const real = path.join(canonicalizeSync(parent, links), path.basename(target));
  let isLink = false;
  try {
    isLink = lstatSync(real).isSymbolicLink();
  } catch (err) {
    if (!isMissing(err)) throw unresolvable(target, errorCode(err));
  }
  if (!isLink) return real;
  if (links >= MAX_LINKS) throw unresolvable(target, 'ELOOP');
  return canonicalizeSync(path.resolve(path.dirname(real), readlinkSync(real)), links + 1);
}

const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

/** True when `candidate` is `root` or lies under it. Both must already be canonical absolute paths. */
export function isWithin(root: string, candidate: string): boolean {
  const a = fold(root);
  const b = fold(candidate);
  if (a === b) return true;
  const boundary = a.endsWith(path.sep) ? a : a + path.sep;
  return b.startsWith(boundary);
}

export interface ResolvedPath {
  /** Canonical absolute path. */
  resolved: string;
  /** Path relative to the canonical root. */
  relative: string;
}

/** Resolve `input` against `root` and make sure the canonical result stays inside the canonical root. */
export async function resolveInside(root: string, input: string): Promise<ResolvedPath> {
  if (!input || !input.trim()) throw new SafePathError('EMPTY', 'path is empty');
  if (input.includes('\0')) throw new SafePathError('NUL', 'path contains a NUL byte');
  if (input.length > MAX_PATH) throw new SafePathError('TOO_LONG', `path is longer than ${MAX_PATH} characters`);

  const canonicalRoot = await canonicalize(path.resolve(root));
  const resolved = await canonicalize(path.resolve(root, input));
  if (!isWithin(canonicalRoot, resolved)) {
    throw new SafePathError('OUTSIDE', `'${input}' resolves outside '${path.basename(canonicalRoot)}'`);
  }
  return { resolved, relative: path.relative(canonicalRoot, resolved) };
}
