import fs from 'node:fs/promises';
import path from 'node:path';

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function nearestWith(start: string, name: string): Promise<string | null> {
  let dir = start;
  for (;;) {
    if (await isDirectory(path.join(dir, name))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The project a hook call belongs to. The host reports the directory it is in, and after a `cd` that is a
 * subdirectory of the project; the guard must protect the project's `.colony` and `.git`, not those of the
 * subdirectory. So: the nearest directory above (or at) the working directory that holds a `.colony`; failing that,
 * the nearest that holds a `.git`; failing that, the working directory itself.
 */
export async function findProjectRoot(start: string): Promise<string> {
  const from = path.resolve(start);
  return (await nearestWith(from, '.colony')) ?? (await nearestWith(from, '.git')) ?? from;
}
