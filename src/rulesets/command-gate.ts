import type { GateResult } from '../gates.js';
import { splitSimple, words } from '../hook/shell-paths.js';
import { activeRulesets } from './active.js';
import { ruleMatches, type CommandEvent } from './sigma.js';

/**
 * The vendored command rule sets (Sigma rules for Linux process creation) as a gate that only WARNS. A rule matches a
 * command before it runs: the command is split into the simple commands of the shell line (the same split the guard uses
 * for writes), and each becomes an event with the fields a command has: Image (the program), CommandLine (its words) and
 * CurrentDirectory. Rules that need the parent process or the user were skipped when the set was converted.
 *
 * The Detection Rule License asks that a message based on a match names the rule's author: the warning does.
 * Every warning is recorded like those of the secret rules (see gate.ts), so that false positives can be counted.
 */

/** Programs that start another program; the command they start is judged too ("sudo bash -c ..."). */
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'exec', 'command', 'nice', 'ionice', 'stdbuf', 'timeout', 'doas']);
const MAX_EVENTS = 200;

const baseName = (word: string): string => word.replace(/\\/g, '/').split('/').pop() ?? word;

/** The Image of a command: its program as a path. A bare name gets /usr/bin/, which is where the rules expect to see it. */
const imageOf = (program: string): string => (program.includes('/') ? program : `/usr/bin/${program}`);

export function eventsOf(command: string, cwd: string): CommandEvent[] {
  const events: CommandEvent[] = [];
  for (const simple of splitSimple(command)) {
    const ws = words(simple);
    if (ws.length === 0) continue;
    const variants: string[][] = [ws];
    let k = 0;
    while (k < ws.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[k]) || WRAPPERS.has(baseName(ws[k])) || (k > 0 && ws[k].startsWith('-') && WRAPPERS.has(baseName(ws[0]))))) {
      k++;
      if (k < ws.length) variants.push(ws.slice(k));
    }
    for (const v of variants) events.push({ Image: imageOf(v[0]), CommandLine: v.join(' '), CurrentDirectory: cwd });
    if (events.length >= MAX_EVENTS) break;
  }
  return events.slice(0, MAX_EVENTS);
}

// ---- Windows

const WIN_SYSTEM = 'C:\\Windows\\System32\\';
const POWERSHELL_IMAGE = WIN_SYSTEM + 'WindowsPowerShell\\v1.0\\powershell.exe';
const PWSH_IMAGE = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const MAX_COMMANDLINE = 8000;

/** The Image of a Windows command: a path stays as it is, a bare name is taken to be a program of System32 (a cmdlet has no image). */
function windowsImageOf(program: string): string {
  const p = program.replace(/\//g, '\\');
  const lower = p.toLowerCase();
  if (lower === 'powershell' || lower === 'powershell.exe') return POWERSHELL_IMAGE;
  if (lower === 'pwsh' || lower === 'pwsh.exe') return PWSH_IMAGE;
  if (p.includes('\\') || /^[A-Za-z]+-[A-Za-z]+$/.test(p)) return p;
  return WIN_SYSTEM + (/\.[A-Za-z0-9]{1,4}$/.test(p) ? p : p + '.exe');
}

/**
 * The events of a command for the Windows rule sets. The Image is the program (see above), the CommandLine is the text
 * of the simple command as it was written (Windows logs the command line as one string), and OriginalFileName is the
 * file name of the Image: the guard cannot read the name a program was built with, so a renamed program is not seen
 * by the rules that look for exactly that. A command that hands a script to cmd or PowerShell (cmd /c, powershell
 * -Command) is judged again for what it runs. When the host tool is PowerShell, the whole command is also one event of
 * powershell.exe, because that is the process that reads it.
 */
export function windowsEventsOf(command: string, cwd: string, tool?: string, depth = 0): CommandEvent[] {
  const events: CommandEvent[] = [];
  const add = (image: string, line: string): void => {
    events.push({ Image: image, CommandLine: line.slice(0, MAX_COMMANDLINE), CurrentDirectory: cwd, OriginalFileName: baseName(image) });
  };
  if (tool === 'PowerShell' && depth === 0 && command.trim()) add(POWERSHELL_IMAGE, 'powershell.exe -Command ' + command.trim());
  for (const simple of splitSimple(command)) {
    const ws = words(simple);
    let k = 0;
    while (k < ws.length && (ws[k] === '&' || ws[k] === '.')) k++;
    if (k >= ws.length) continue;
    const image = windowsImageOf(ws[k]);
    add(image, simple.trim());
    const prog = baseName(ws[k]).toLowerCase().replace(/\.exe$/, '');
    if (depth === 0 && (prog === 'cmd' || prog === 'powershell' || prog === 'pwsh')) {
      const at = ws.findIndex((w, i) => i > k && (prog === 'cmd' ? /^\/[ck]$/i.test(w) : /^-(c|command)$/i.test(w)));
      if (at >= 0 && at + 1 < ws.length) events.push(...windowsEventsOf(ws.slice(at + 1).join(' '), cwd, undefined, depth + 1));
    }
    if (events.length >= MAX_EVENTS) break;
  }
  return events.slice(0, MAX_EVENTS);
}

export async function checkCommandsWithRulesets(command: string, cwd: string, tool?: string): Promise<GateResult[]> {
  const { loaded } = await activeRulesets();
  const sets = loaded.filter((s) => s.kind === 'commands');
  if (sets.length === 0) return [];
  const linux = eventsOf(command, cwd);
  const windows = windowsEventsOf(command, cwd, tool);
  if (linux.length === 0 && windows.length === 0) return [];

  const hits = new Map<string, { ruleset: string; version: string; id: string; title: string; author: string; level: string; status: string; link: string }>();
  for (const set of sets) {
    const events = set.platform === 'windows' ? windows : linux;
    for (const rule of set.commands) {
      if (hits.has(rule.id)) continue;
      if (events.some((e) => ruleMatches(rule, e))) hits.set(rule.id, { ruleset: set.name, version: set.version, id: rule.id, title: rule.title, author: rule.author, level: rule.level, status: rule.status, link: rule.link });
    }
  }
  if (hits.size === 0) return [];

  const list = [...hits.values()];
  const shown = list.slice(0, 3).map((h) => `"${h.title}" (author: ${h.author}; level ${h.level}, status ${h.status})`);
  return [
    {
      gate: 'command-rulesets',
      decision: 'warn',
      reason: `${list[0].ruleset} ${list[0].version} rule${list.length > 1 ? 's' : ''} match${list.length > 1 ? '' : 'es'} a command of this call: ${shown.join('; ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''}. Warning only; it does not block. Rules: https://github.com/SigmaHQ/sigma, licensed under the Detection Rule License 1.1.`,
      remediation: [
        'Read the command: the rule describes behaviour that is typical of an attack, and it can also be an ordinary administration or development command.',
        'If it is ordinary, nothing to do; the warning is recorded so that false positives can be counted.',
      ],
      details: {
        count: list.length,
        rules: list.map((h) => h.id),
        titles: list.map((h) => h.title),
        findings: list.slice(0, 20).map((h) => ({ ruleset: h.ruleset, rule: h.id, title: h.title, author: h.author, level: h.level, link: h.link })),
      },
    },
  ];
}
