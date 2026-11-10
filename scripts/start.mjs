#!/usr/bin/env node
// Start the colony on a project:   node scripts/start.mjs <project folder>      (or: pnpm start <project folder>)
//
// It builds colony-core if it is not built yet (or the source is newer), then runs `colony start --dir <project>`,
// which boots the project and prints the rules and how to work. Only Node.js and pnpm are needed.
//   --no-build   skip the build step (use what is in dist/)
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'cli.js');
const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const positional = args.filter((a) => a !== '--no-build');

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

if (positional.length !== 1) {
  fail('usage: node scripts/start.mjs <project folder>\n\nThe project folder is the folder the work happens in (its state goes to <project>/.colony). Give the full path.');
}
const project = resolve(positional[0]);
if (project === resolve(root)) {
  fail('That is the colony-core folder itself. Give the PROJECT folder you want to work in; the colony keeps its state there (<project>/.colony), not in colony-core.');
}
if (!existsSync(project) || !statSync(project).isDirectory()) {
  fail(`The project folder does not exist: ${project}`);
}

/** The newest modification time under a folder, tests excluded. */
function newest(dir) {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs);
  }
  return latest;
}

function run(command, commandArgs) {
  // pnpm is a .cmd on Windows, which needs a shell; the arguments here are fixed strings
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: ['ignore', 2, 2], shell: process.platform === 'win32' });
  if (result.error) fail(`could not run ${command}: ${result.error.message}\nInstall pnpm (corepack enable, or npm i -g pnpm) and try again.`, 1);
  if (result.status !== 0) fail(`${command} ${commandArgs.join(' ')} failed (exit code ${result.status}). The output is above.`, 1);
}

if (!noBuild) {
  const stale = !existsSync(cli) || newest(join(root, 'src')) > statSync(cli).mtimeMs;
  if (stale) {
    console.error('Building colony-core (first start, or the source changed)...');
    if (!existsSync(join(root, 'node_modules', 'typescript'))) run('pnpm', ['install', '--frozen-lockfile']);
    run('pnpm', ['build']);
  }
} else if (!existsSync(cli)) {
  fail('dist/cli.js is missing and --no-build was given: run `pnpm install && pnpm build` first.', 1);
}

const result = spawnSync(process.execPath, [cli, 'start', '--dir', project], { stdio: 'inherit' });
process.exit(result.status ?? 1);
