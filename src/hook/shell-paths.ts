import path from 'node:path';

/**
 * Does a shell command write to, move or delete anything inside the colony's protected
 * directories (`.colony/`, `.git/`)?
 *
 * The earlier check matched the literal text `> .colony/`; `./.colony/x`, an absolute path,
 * `src/../.colony/x`, `cd .colony && echo > x`, `dd of=`, `mv evil .colony` all slipped past it.
 * This one reads the command the way a shell would, roughly: it splits it into simple commands,
 * follows `cd`, expands `$PWD`, finds the targets of redirections and of the tools that write,
 * resolves every target against the working directory, and compares the RESOLVED path.
 *
 * Honest limit: it is a reading of text, not a sandbox. It does not run the shell, so it cannot
 * see variables it does not know, command substitution, aliases, globs, a script file's contents,
 * or a symlink that points into a protected directory.
 */

const PROTECTED = new Set(['.colony', '.git']);

/** Tools whose every argument is something they change or remove. */
const ALL_ARGS = new Set([
  'rm', 'rmdir', 'unlink', 'truncate', 'touch', 'chmod', 'chown', 'chgrp', 'mkdir', 'mkfifo', 'shred', 'mv', 'del', 'erase', 'rd', 'ren', 'move',
  'remove-item', 'ri', 'move-item', 'mi', 'rename-item', 'rni', 'new-item', 'ni', 'clear-content', 'clc', 'set-content', 'sc', 'add-content', 'ac', 'out-file',
]);
/** Tools that read their sources and write only the last argument (or `-t DIR`). */
const LAST_ARG = new Set(['cp', 'install', 'rsync', 'ln', 'copy', 'xcopy', 'copy-item', 'cpi', 'ditto']);

export interface ShellWrite {
  reason: string;
  /** `deny` for the colony's own state; `ask` for the host's settings file, which the user may want to edit through the model. */
  decision: 'deny' | 'ask';
}

/** Split on `;`, `&&`, `||`, `|`, `&` and newlines, outside quotes. */
function splitSimple(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && command[i + 1] !== '>' && command[i - 1] !== '>')) {
      if (current.trim()) parts.push(current);
      current = '';
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++;
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Whitespace-separated words with quotes removed. Redirection operators glued to a word stay in it. */
function words(simple: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;
  for (const ch of simple) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) out.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started || current) out.push(current);
  return out;
}

function expand(text: string, projectDir: string): string {
  const here = projectDir.replace(/\\/g, '/');
  return text
    .replace(/\$\{PWD\}|\$PWD|\$\(pwd\)|`pwd`|%CD%|\$env:PWD|\$\(Get-Location\)|\$PSScriptRoot/gi, here)
    .replace(/\$\{?(?:CLAUDE_PROJECT_DIR|PROJECT_DIR)\}?/g, here);
}

/** `.colony`, `.git`, or `settings` (the host's `.claude/settings.json` / `settings.local.json`, where the guard's hooks live). */
function protectedHit(target: string, cwd: string, projectDir: string): string | null {
  if (!target || target.startsWith('-') && !target.includes('/')) return null;
  // A backslash is read as a separator on every platform: PowerShell accepts it on Linux and macOS too,
  // and for a guard the safe mistake is to see a separator where a shell sees an escape.
  const resolved = path.resolve(cwd, target.replace(/\\/g, '/'));
  const rel = path.relative(projectDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const segments = rel.split(path.sep).map((s) => s.toLowerCase());
  if (PROTECTED.has(segments[0])) return segments[0];
  if (segments[0] === '.claude' && segments.length >= 2 && /^settings(?:\.local)?\.json$/.test(segments[1])) return 'settings';
  return null;
}

function toolName(word: string): string {
  const base = word.replace(/\\/g, '/').split('/').pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/** Targets of redirections in a list of words: `> f`, `>> f`, `>f`, `2>f`, `&>f`. */
function redirectTargets(ws: string[]): string[] {
  const targets: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const m = ws[i].match(/^(?:\d|&)?>>?\|?(.*)$/);
    if (!m) continue;
    if (m[1]) targets.push(m[1]);
    else if (ws[i + 1] !== undefined) targets.push(ws[i + 1]);
  }
  return targets;
}

/** The first protected-path write found in `command`, or null. */
export function findProtectedWrite(command: string, projectDirInput: string): ShellWrite | null {
  const projectDir = path.resolve(projectDirInput);
  const text = expand(command, projectDir);
  let cwd = projectDir;

  for (const simple of splitSimple(text)) {
    const ws = words(simple);
    if (ws.length === 0) continue;
    const hit = (target: string): ShellWrite | null => {
      const top = protectedHit(target, cwd, projectDir);
      if (!top) return null;
      if (top === 'settings') return { decision: 'ask', reason: "the command changes the host's settings file (.claude/settings*.json), which holds the guard's hooks" };
      return { decision: 'deny', reason: top === '.colony' ? "the command changes something inside .colony/; the colony's state and rule files change only through colony commands" : 'the command changes something inside .git/' };
    };

    // redirections apply to any command
    for (const target of redirectTargets(ws)) {
      const found = hit(target);
      if (found) return found;
    }

    const tool = toolName(ws[0]);
    const args = ws.slice(1).filter((w) => !/^(?:\d|&)?>>?\|?/.test(w));
    // the word after a bare redirection operator is the target, not an argument
    const plain = args.filter((w, i) => !(i > 0 && /^(?:\d|&)?>>?\|?$/.test(args[i - 1] ?? '')));
    const operands = plain.filter((w) => !w.startsWith('-') || w.includes('/') || w.includes('\\'));

    if (tool === 'cd' || tool === 'pushd' || tool === 'set-location' || tool === 'sl' || tool === 'chdir') {
      if (operands[0]) cwd = path.resolve(cwd, operands[0].replace(/\\/g, '/'));
      continue;
    }

    if (ALL_ARGS.has(tool)) {
      for (const a of operands) {
        const found = hit(a);
        if (found) return found;
      }
    } else if (LAST_ARG.has(tool)) {
      const tIndex = plain.findIndex((w) => w === '-t' || w === '--target-directory');
      const target = tIndex >= 0 ? plain[tIndex + 1] : operands[operands.length - 1];
      const found = target ? hit(target) : null;
      if (found) return found;
    } else if (tool === 'tee') {
      for (const a of operands) {
        const found = hit(a);
        if (found) return found;
      }
    } else if (tool === 'sed' && plain.some((w) => /^-[a-zA-Z]*i/.test(w) || w === '--in-place' || w.startsWith('--in-place='))) {
      for (const a of operands) {
        const found = hit(a);
        if (found) return found;
      }
    } else if (tool === 'dd') {
      for (const w of plain) {
        if (w.startsWith('of=')) {
          const found = hit(w.slice(3));
          if (found) return found;
        }
      }
    } else if (['python', 'python3', 'node', 'perl', 'ruby', 'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd'].includes(tool) || /^python[0-9.]+$/.test(tool)) {
      // inline code that names a protected directory: refuse, the code can do anything with it
      const inline = plain.some((w) => w === '-c' || w === '-e' || w === '-Command' || w === '-command' || w === '/c' || w === '-lc');
      if (inline && /(?:^|[\s'"/\\])\.(?:colony|git)(?:[\s'"/\\]|$)/i.test(simple)) {
        return { decision: 'deny', reason: 'an inline script names .colony/ or .git/; the guard cannot read what it does there' };
      }
    }
  }
  return null;
}
