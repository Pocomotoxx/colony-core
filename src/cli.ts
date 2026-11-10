#!/usr/bin/env node
import { runCommand } from './cli/commands.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

if (process.argv[2] === 'hook') {
  // A host's hook: raw protocol on stdout/stderr, no ledger loaded, no state lock taken.
  const { runHook } = await import('./hook/cli.js');
  const sub = process.argv[3];
  const dirIndex = process.argv.indexOf('--dir');
  try {
    const stdinText = sub === 'install' ? '' : await readStdin();
    const run = await runHook(sub, stdinText, process.cwd(), dirIndex > 0 ? process.argv[dirIndex + 1] : undefined, {
      apply: process.argv.includes('--apply'),
      // the host's file for variables that later shell commands should see (set by Claude Code for SessionStart hooks)
      envFile: process.env.CLAUDE_ENV_FILE,
    });
    process.stdout.write(run.stdout);
    process.stderr.write(run.stderr);
    process.exitCode = run.code;
  } catch (err) {
    // the guard fails closed: an uncaught crash would exit 1, which a host treats as a non-blocking error
    process.stderr.write(`Colony hook: failed (${err instanceof Error ? err.message : String(err)}).\n`);
    process.exitCode = sub === 'pretool' ? 2 : 0;
  }
} else {
  const { code, output } = await runCommand(process.argv.slice(2), process.cwd());
  const text = JSON.stringify(output, null, 2);
  (code === 0 ? process.stdout : process.stderr).write(`${text}\n`);
  process.exitCode = code;
}
