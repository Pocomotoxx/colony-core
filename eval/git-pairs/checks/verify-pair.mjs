import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Hidden check of a git pair (eval/git-pairs). Runs in the workspace (the task's copy of the starting fixture).
// 1. The test files must be exactly the ones of the fix commit: a changed test is a failed check (no edited tests).
// 2. Then the same test files are run with node --test; the exit code is the result.
const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(here, '..', 'manifest.json'), 'utf-8'));
const id = process.argv[2];
const pair = manifest.pairs[id];
if (!pair) {
  console.error(`unknown pair '${id}'`);
  process.exit(2);
}

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
for (const [file, want] of Object.entries(pair.tests)) {
  if (!existsSync(file)) {
    console.error(`the test file ${file} is missing`);
    process.exit(1);
  }
  if (sha(file) !== want) {
    console.error(`the test file ${file} was changed: tests must not be edited, fix the code`);
    process.exit(1);
  }
}

const run = spawnSync(process.execPath, ['--test', ...Object.keys(pair.tests)], { encoding: 'utf-8', timeout: 120_000 });
process.stdout.write(run.stdout ?? '');
process.stderr.write(run.stderr ?? '');
process.exit(run.status ?? 1);
