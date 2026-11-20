import path from 'node:path';
import { redirectTargets, splitSimple, words } from '../hook/shell-paths.js';
import type { CommandEvent } from './sigma.js';

/**
 * The file events a call would cause, for the Sigma file rules (Sysmon-style events: TargetFilename is the file, Image
 * the program that writes it). They are read from what the line itself shows: redirections (`>` and `>>`), the commands
 * and cmdlets that write a file (Out-File, Set-Content, Add-Content, New-Item, Copy-Item, Move-Item, copy, move, xcopy,
 * robocopy, tee, expand, certutil, bitsadmin, a download with -OutFile or -o) and those that delete one (del, erase, rm,
 * Remove-Item). A file written by the Write or Edit tool is one event too, without an Image (the host is not a program the
 * rules know). A script file, a path built at run time and the data written are not seen.
 *
 * Assumptions: a relative path starts at the working directory; %TEMP%, $env:APPDATA and the like are filled in as the
 * folders of a user called "user" (the guard does not know the real profile), so that the rules that look for a Temp or
 * Startup folder can see them; the Image of a redirection is cmd.exe, of a cmdlet powershell.exe; Sysmon has an event
 * for a changed file time (file_change), which the guard never builds, so a file_change rule never matches here.
 */

const SYSTEM = 'C:\\Windows\\System32\\';
const POWERSHELL_IMAGE = SYSTEM + 'WindowsPowerShell\\v1.0\\powershell.exe';
const PROFILE = 'C:\\Users\\user';
const MAX_EVENTS = 100;

const baseName = (word: string): string => word.replace(/\\/g, '/').split('/').pop() ?? word;

const ENV: Record<string, string> = {
  temp: `${PROFILE}\\AppData\\Local\\Temp`,
  tmp: `${PROFILE}\\AppData\\Local\\Temp`,
  appdata: `${PROFILE}\\AppData\\Roaming`,
  localappdata: `${PROFILE}\\AppData\\Local`,
  userprofile: PROFILE,
  public: 'C:\\Users\\Public',
  programdata: 'C:\\ProgramData',
  windir: 'C:\\Windows',
  systemroot: 'C:\\Windows',
  homepath: '\\Users\\user',
};

/** A path as the rules see it: environment variables filled in, backslashes, absolute when the working directory is a drive path. */
export function normalizePath(raw: string, cwd: string): string | null {
  let p = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!p || p === '-' || p === '/dev/null' || /^nul$/i.test(p)) return null;
  p = p.replace(/%([A-Za-z]+)%|\$env:([A-Za-z]+)/g, (m, a?: string, b?: string) => ENV[(a ?? b ?? '').toLowerCase()] ?? m);
  p = p.replace(/^~(?=[\\/]|$)/, PROFILE).replace(/\//g, '\\');
  if (p.length > 1000 || /[\r\n\0]/.test(p)) return null;
  if (/^[A-Za-z]:\\/.test(p) || p.startsWith('\\\\')) return path.win32.normalize(p);
  if (/^[A-Za-z]:\\/.test(cwd)) return path.win32.resolve(cwd, p);
  return p;
}

type Param = 'path' | 'dest' | 'out' | 'value';
const PARAM_NAMES: Record<string, Param> = {
  path: 'path', literalpath: 'path', filepath: 'out', outfile: 'out', destination: 'dest', pspath: 'path', name: 'value',
};

interface Verb {
  /** What a command does to its file argument(s). */
  kind: 'write' | 'delete' | 'copy' | 'download' | 'tee';
}

const VERBS: Record<string, Verb> = {
  'out-file': { kind: 'write' }, 'set-content': { kind: 'write' }, 'add-content': { kind: 'write' }, sc: { kind: 'write' }, ac: { kind: 'write' },
  'new-item': { kind: 'write' }, ni: { kind: 'write' },
  'copy-item': { kind: 'copy' }, 'move-item': { kind: 'copy' }, copy: { kind: 'copy' }, cp: { kind: 'copy' }, move: { kind: 'copy' }, mv: { kind: 'copy' },
  xcopy: { kind: 'copy' }, robocopy: { kind: 'copy' }, ren: { kind: 'copy' }, rename: { kind: 'copy' }, 'rename-item': { kind: 'copy' }, expand: { kind: 'copy' },
  tee: { kind: 'tee' }, 'tee-object': { kind: 'tee' },
  'invoke-webrequest': { kind: 'download' }, iwr: { kind: 'download' }, 'invoke-restmethod': { kind: 'download' }, irm: { kind: 'download' },
  curl: { kind: 'download' }, wget: { kind: 'download' },
  del: { kind: 'delete' }, erase: { kind: 'delete' }, rm: { kind: 'delete' }, 'remove-item': { kind: 'delete' }, ri: { kind: 'delete' },
};

/** PowerShell parameters that take no value; every other -Parameter takes the next word. */
const SWITCHES = new Set(['force', 'append', 'noclobber', 'recurse', 'usebasicparsing', 'passthru', 'confirm', 'whatif', 'r', 'f', 'q', 's', 'y', 'v']);

/** The words that are neither redirections, switches nor the values of parameters. */
function positionals(ws: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < ws.length; i++) {
    const w = ws[i];
    if (/^(?:\d|&)?>>?\|?/.test(w)) {
      if (/^(?:\d|&)?>>?\|?$/.test(w)) i++;
      continue;
    }
    if (w.startsWith('-')) {
      if (!SWITCHES.has(w.slice(1).toLowerCase())) i++;
      continue;
    }
    // cmd-style switches (/y, /s, /q): short, no path separator after the slash
    if (/^\/[A-Za-z?]{1,12}$/.test(w)) continue;
    out.push(w);
  }
  return out;
}

function named(ws: string[]): Partial<Record<Param, string>> {
  const found: Partial<Record<Param, string>> = {};
  for (let i = 1; i < ws.length - 1; i++) {
    const m = /^-([A-Za-z]+)$/.exec(ws[i]);
    const param = m ? PARAM_NAMES[m[1].toLowerCase()] : undefined;
    if (param && found[param] === undefined) found[param] = ws[i + 1];
  }
  return found;
}

/** The files a command writes or deletes, as [path, delete?] pairs. */
function targetsOf(prog: string, ws: string[]): Array<[string, boolean]> {
  const verb = VERBS[prog];
  if (verb) {
    const n = named(ws);
    const pos = positionals(ws);
    if (verb.kind === 'delete') return [[n.path ?? pos[0], true]].filter((t): t is [string, boolean] => t[0] !== undefined);
    if (verb.kind === 'write' || verb.kind === 'tee') {
      const file = n.out ?? n.path ?? pos[0];
      return file !== undefined ? [[file, false]] : [];
    }
    if (verb.kind === 'copy') {
      const dest = n.dest ?? (pos.length >= 2 ? pos[1] : undefined);
      return dest ? [[dest, false]] : [];
    }
    // a download writes only when told where: -OutFile, or -o / --output / -O for curl and wget
    if (n.out) return [[n.out, false]];
    const at = ws.findIndex((w, i) => i > 0 && /^(?:-o|--output|-output-document|--output-document|-outfile)$/i.test(w));
    return at >= 0 && ws[at + 1] ? [[ws[at + 1], false]] : [];
  }
  if (prog === 'certutil') {
    const lw = ws.map((w) => w.toLowerCase());
    if (lw.includes('-urlcache') || lw.includes('/urlcache') || lw.includes('-decode') || lw.includes('-encode') || lw.includes('-decodehex')) {
      const rest = ws.slice(1).filter((w) => !/^[-/]/.test(w));
      const target = lw.includes('-decode') || lw.includes('-encode') || lw.includes('-decodehex') ? rest[1] : rest[1] ?? rest[rest.length - 1];
      return target ? [[target, false]] : [];
    }
  }
  if (prog === 'bitsadmin') {
    const at = ws.findIndex((w) => w.toLowerCase() === '/transfer');
    const rest = ws.slice(at + 1).filter((w) => !w.startsWith('/'));
    if (at >= 0 && rest.length >= 3) return [[rest[rest.length - 1], false]];
  }
  return [];
}

function imageFor(prog: string, ws0: string): string {
  if (VERBS[prog] && /^[A-Za-z]+-[A-Za-z]+$|^(?:sc|ac|ni|ri|cp|mv|rm|iwr|irm|ri)$/.test(prog)) return POWERSHELL_IMAGE;
  if (prog === 'powershell' || prog === 'pwsh') return POWERSHELL_IMAGE;
  const p = ws0.replace(/\//g, '\\');
  if (p.includes('\\')) return p;
  return SYSTEM + (/\.[A-Za-z0-9]{1,4}$/.test(p) ? p : p + '.exe');
}

export function fileEventsOf(command: string, cwd: string, depth = 0): CommandEvent[] {
  const events: CommandEvent[] = [];
  const push = (file: string, del: boolean, image: string): void => {
    const target = normalizePath(file, cwd);
    if (target && events.length < MAX_EVENTS) events.push({ Image: image, TargetFilename: target, LogsourceCategory: del ? 'file_delete' : 'file_event' });
  };
  for (const simple of splitSimple(command)) {
    const ws = words(simple);
    if (ws.length === 0) continue;
    const prog = baseName(ws[0]).toLowerCase().replace(/\.exe$/, '');
    for (const target of redirectTargets(ws)) push(target, false, SYSTEM + 'cmd.exe');
    for (const [file, del] of targetsOf(prog, ws)) push(file, del, imageFor(prog, ws[0]));
    if (depth === 0 && (prog === 'cmd' || prog === 'powershell' || prog === 'pwsh')) {
      const at = ws.findIndex((w, i) => i > 0 && (prog === 'cmd' ? /^\/[ck]$/i.test(w) : /^-(c|command)$/i.test(w)));
      if (at >= 0 && at + 1 < ws.length) events.push(...fileEventsOf(ws.slice(at + 1).join(' '), cwd, depth + 1));
    }
    if (events.length >= MAX_EVENTS) break;
  }
  return events.slice(0, MAX_EVENTS);
}

/** The event of a file the Write or Edit tool creates or changes. There is no Image. */
export function fileWriteEventOf(filePath: string, cwd: string): CommandEvent[] {
  const target = normalizePath(filePath, cwd);
  return target ? [{ TargetFilename: target, LogsourceCategory: 'file_event' }] : [];
}
