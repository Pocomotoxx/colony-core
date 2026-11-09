import fs from 'node:fs/promises';

/**
 * Write a file so that a crash mid-write leaves either the old content or the new one, never a
 * truncated file: write to a temp file next to the target, then rename it over the target.
 */
export async function writeFileAtomic(target: string, text: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(tmp, text, 'utf-8');
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
