import type { GateResult } from '../gates.js';
import { splitSimple, words } from '../hook/shell-paths.js';
import { activeRulesets } from './active.js';
import { registryEventsOf } from './registry-events.js';
import { fileEventsOf, fileWriteEventOf } from './file-events.js';
import type { LoadedRuleset } from './loader.js';
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
/** The findings kept with a warning, each with its own rule id and author (the licence asks that a rule's author is named). */
const MAX_LOGGED_FINDINGS = 100;

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

// ---- PowerShell scripts

const MAX_SCRIPT = 24000;
const MAX_SCRIPTS = 20;

/** The text behind a -EncodedCommand (base64 of UTF-16LE), when it reads like text. */
function decodeEncodedCommand(word: string): string | null {
  if (word.length < 8 || word.length > 60000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(word)) return null;
  const text = Buffer.from(word, 'base64').toString('utf16le');
  let plain = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) plain++;
  }
  return text.length > 0 && plain / text.length >= 0.9 ? text : null;
}

/**
 * The scripts a command hands to PowerShell, for the rule sets written for the text of a script (Sigma ps_script, where
 * the field is ScriptBlockText). A PowerShell tool call is a script itself; so is what follows powershell -Command, and
 * what a powershell -EncodedCommand decodes to (the script block log shows the decoded text too).
 */
export function scriptEventsOf(command: string, tool?: string): CommandEvent[] {
  const scripts: string[] = [];
  const add = (s: string): void => {
    if (s.trim() && scripts.length < MAX_SCRIPTS) scripts.push(s.slice(0, MAX_SCRIPT));
  };
  if (tool === 'PowerShell') add(command);
  for (const simple of splitSimple(command)) {
    const ws = words(simple);
    const prog = baseName(ws[0] ?? '').toLowerCase().replace(/\.exe$/, '');
    if (prog !== 'powershell' && prog !== 'pwsh') continue;
    for (let i = 1; i < ws.length; i++) {
      const w = ws[i].toLowerCase();
      if (w === '-c' || w === '-command') {
        add(ws.slice(i + 1).join(' '));
        break;
      }
      if (/^-(e|ec|enc|encodedcommand)$/.test(w)) {
        const decoded = ws[i + 1] ? decodeEncodedCommand(ws[i + 1]) : null;
        if (decoded) add(decoded);
        break;
      }
    }
  }
  return scripts.map((text) => ({ ScriptBlockText: text }));
}

export async function checkCommandsWithRulesets(command: string, cwd: string, tool?: string): Promise<GateResult[]> {
  const { loaded } = await activeRulesets();
  const sets = loaded.filter((s) => s.kind === 'commands');
  if (sets.length === 0) return [];
  const linux = eventsOf(command, cwd);
  const windows = windowsEventsOf(command, cwd, tool);
  const scripts = scriptEventsOf(command, tool);
  const registry = registryEventsOf(command);
  const files = fileEventsOf(command, cwd);
  if (linux.length === 0 && windows.length === 0 && scripts.length === 0 && registry.length === 0 && files.length === 0) return [];
  return commandWarnings(sets, (set) => (set.category === 'file' ? files : set.category === 'registry' ? registry : set.category === 'ps_script' ? scripts : set.platform === 'windows' ? windows : linux), 'a command of this call');
}

/** The file rules judge a file the Write or Edit tool writes too (the path only; the data written is not looked at). */
export async function checkFileWriteWithRulesets(filePath: string, cwd: string): Promise<GateResult[]> {
  const { loaded } = await activeRulesets();
  const sets = loaded.filter((s) => s.kind === 'commands' && s.category === 'file');
  const events = fileWriteEventOf(filePath, cwd);
  if (sets.length === 0 || events.length === 0) return [];
  return commandWarnings(sets, () => events, 'the file this call writes');
}

/** The hits as a sentence: the first three with title, author, level and status; the authors of the rest are named too (the licence asks that a rule's author is named). */
export function describeHits(list: ReadonlyArray<{ title: string; author: string; level: string; status: string }>): string {
  const shown = list.slice(0, 3).map((h) => `"${h.title}" (author: ${h.author}; level ${h.level}, status ${h.status})`);
  const more = list.length > 3 ? ` and ${list.length - 3} more (authors: ${[...new Set(list.slice(3).map((h) => h.author))].slice(0, 10).join(', ')})` : '';
  return shown.join('; ') + more;
}

function commandWarnings(sets: LoadedRuleset[], eventsFor: (set: LoadedRuleset) => CommandEvent[], subject: string): GateResult[] {
  const hits = new Map<string, { ruleset: string; version: string; id: string; title: string; author: string; level: string; status: string; link: string }>();
  for (const set of sets) {
    const events = eventsFor(set);
    for (const rule of set.commands) {
      if (hits.has(rule.id)) continue;
      if (events.some((e) => ruleMatches(rule, e))) hits.set(rule.id, { ruleset: set.name, version: set.version, id: rule.id, title: rule.title, author: rule.author, level: rule.level, status: rule.status, link: rule.link });
    }
  }
  if (hits.size === 0) return [];

  const list = [...hits.values()];
  return [
    {
      gate: 'command-rulesets',
      decision: 'warn',
      reason: `${list[0].ruleset} ${list[0].version} rule${list.length > 1 ? 's' : ''} match${list.length > 1 ? '' : 'es'} ${subject}: ${describeHits(list)}. Warning only; it does not block. Rules: https://github.com/SigmaHQ/sigma, licensed under the Detection Rule License 1.1.`,
      remediation: [
        'Read the command: the rule describes behaviour that is typical of an attack, and it can also be an ordinary administration or development command.',
        'If it is ordinary, nothing to do; the warning is recorded so that false positives can be counted.',
      ],
      details: {
        count: list.length,
        rules: list.map((h) => h.id),
        titles: list.map((h) => h.title),
        findings: list.slice(0, MAX_LOGGED_FINDINGS).map((h) => ({ ruleset: h.ruleset, rule: h.id, title: h.title, author: h.author, level: h.level, link: h.link })),
      },
    },
  ];
}
