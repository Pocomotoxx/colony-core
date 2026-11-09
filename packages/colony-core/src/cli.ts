#!/usr/bin/env node
import { runCommand } from './cli/commands.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

if (process.argv[2] === 'hook') {
  // A host's tool hook: raw protocol on stdout/stderr, no state loaded, no lock taken.
  const { runHook } = await import('./hook/cli.js');
  const sub = process.argv[3];
  const dirIndex = process.argv.indexOf('--dir');
  const stdinText = sub === 'pretool' ? await readStdin() : '';
  const run = await runHook(sub, stdinText, process.cwd(), dirIndex > 0 ? process.argv[dirIndex + 1] : undefined);
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exitCode = run.code;
} else {
  const { code, output } = await runCommand(process.argv.slice(2), process.cwd());
  const text = JSON.stringify(output, null, 2);
  (code === 0 ? process.stdout : process.stderr).write(`${text}\n`);
  process.exitCode = code;
}
