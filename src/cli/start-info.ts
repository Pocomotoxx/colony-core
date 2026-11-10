import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * What `colony start` adds to a boot: how to work, and whether the host's hooks are installed.
 * Model-facing text is English; the commands are spelled out with the project directory filled in.
 */

export interface HooksStatus {
  /** The colony's guard (PreToolUse) is in the project's `.claude/settings.json`. */
  installed: boolean;
  /** What to run (by the user, not the model: the guard refuses `hook` commands from a shell tool) when it is not. */
  hint: string | null;
}

export async function hooksStatus(projectDir: string, cliPath: string): Promise<HooksStatus> {
  const file = path.join(projectDir, '.claude', 'settings.json');
  let installed = false;
  try {
    const settings = JSON.parse(await fs.readFile(file, 'utf-8')) as { hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }> } };
    installed = (settings.hooks?.PreToolUse ?? []).some((g) => (g.hooks ?? []).some((h) => /\bhook pretool\b/.test(h.command ?? '')));
  } catch {
    // no settings file, or one that is not JSON: not installed
  }
  const cli = cliPath.replace(/\\/g, '/');
  return {
    installed,
    hint: installed ? null : `The host's hooks (the guard, evidence from test runs, recall) are not installed in this project. The user can install them: node "${cli}" hook install --apply --dir "${projectDir}"  (without --apply it only prints what it would write).`,
  };
}

/** The working loop, with the project directory filled in. */
export function workflow(projectDir: string, cliPath: string): string[] {
  const cli = `node "${cliPath.replace(/\\/g, '/')}"`;
  const dir = `--dir "${projectDir}"`;
  return [
    `1. Add your work as a task: ${cli} task add "<title>" "<description>" --role engineer ${dir}`,
    `2. Take it: ${cli} next --as engineer ${dir}. The output shows what the colony remembers about similar work (recall.worked / recall.caution): show it to the user before you start, and let them decide whether to apply it.`,
    '3. Do the work. Run the project\'s tests or build and look at the result; do not report a result you did not see.',
    `4. Close it: ${cli} done <task id> --result "<what you did and how you checked>" --quality 0..1 ${dir}  (add --verified-by-test only if a test really ran and was green), or ${cli} fail <task id> --error "<why>" ${dir}.`,
    'Every command prints JSON. A non-zero exit code means the command did not do what you asked: read the error, do not retry blindly.',
  ];
}
