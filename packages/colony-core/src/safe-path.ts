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

import fs from 'node:fs/promises';
import path from 'node:path';
import { errorCode } from './errors.js';

export class SafePathError extends Error {
  constructor(public readonly code: 'EMPTY' | 'NUL' | 'TOO_LONG' | 'OUTSIDE', message: string) {
    super(message);
  }
}

const MAX_PATH = 4096;

/** realpath of the longest existing ancestor, with the missing remainder re-attached. */
export async function canonicalize(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (err) {
    if (errorCode(err) !== 'ENOENT' && errorCode(err) !== 'ENOTDIR') return target;
  }
  const parent = path.dirname(target);
  if (parent === target) return target;
  return path.join(await canonicalize(parent), path.basename(target));
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
