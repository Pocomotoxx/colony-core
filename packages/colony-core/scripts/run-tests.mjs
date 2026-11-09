// Runs every compiled test file with the Node test runner.
// Node 20 does not expand globs in `node --test`, and cmd.exe does not either, so the list is built here.
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

function collect(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? collect(path) : name.endsWith('.test.js') ? [path] : [];
  });
}

const files = collect(root).sort();
if (files.length === 0) {
  console.error('No compiled tests found: run `pnpm build` first.');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
