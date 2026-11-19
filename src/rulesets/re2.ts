/**
 * Go (RE2) regular expressions to JavaScript ones, for the rule sets that were written for Go.
 *
 * What it handles: leading and scoped flag groups (i, s, m), named groups (?P<n>), \z and \A, POSIX classes.
 * Case-insensitive parts of a pattern that also has case-sensitive parts are written out as explicit classes
 * ([aA]), because JavaScript before 2025 has no scoped flags. Anything else that JavaScript reads differently or
 * not at all (lookaround, \Q..\E, \pL, \C, ungreedy mode, backreferences, flag groups in the middle of a pattern)
 * is refused with a reason: the caller records the rule as skipped instead of carrying over a changed meaning.
 *
 * Known small differences that are accepted: \s and `.` follow JavaScript (\s also matches a few more spaces;
 * `.` also excludes \r), and case-insensitive matching is ASCII only in the written-out form.
 */

export class UnsupportedRegex extends Error {}

export interface Translated {
  source: string;
  flags: string;
}

const POSIX: Record<string, string> = {
  alnum: 'A-Za-z0-9',
  alpha: 'A-Za-z',
  digit: '0-9',
  xdigit: '0-9A-Fa-f',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\v\\f\\r',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  word: 'A-Za-z0-9_',
  cntrl: '\\x00-\\x1f\\x7f',
  print: ' -~',
  graph: '!-~',
};

const isLetter = (c: string): boolean => /^[A-Za-z]$/.test(c);
const swapCase = (c: string): string => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());

interface Scope {
  i: boolean;
  s: boolean;
}

function parseFlagGroup(spec: string, base: Scope): Scope {
  const out = { ...base };
  let on = true;
  for (const ch of spec) {
    if (ch === '-') on = false;
    else if (ch === 'i') out.i = on;
    else if (ch === 's') out.s = on;
    else throw new UnsupportedRegex(`the flag "${ch}" is not supported`);
  }
  return out;
}

export function translateRe2(pattern: string): Translated {
  let rest = pattern;
  const global: Scope = { i: false, s: false };
  let multiline = false;

  // flags at the very start: (?i) (?s) (?is) (?m)
  for (;;) {
    const m = /^\(\?([a-zA-Z-]+)\)/.exec(rest);
    if (!m) break;
    let on = true;
    for (const ch of m[1]) {
      if (ch === '-') on = false;
      else if (ch === 'i') global.i = on;
      else if (ch === 's') global.s = on;
      else if (ch === 'm') multiline = on;
      else throw new UnsupportedRegex(`the flag "${ch}" is not supported`);
    }
    rest = rest.slice(m[0].length);
  }

  // scoped groups (?i:...) / (?-i:...) / (?s:...) make it necessary to write case folding out
  // (also a flag group in the middle, (?i), which holds to the end of the group it is in)
  const scoped = /\(\?[a-zA-Z]*-?[a-zA-Z]*:/.test(rest.replace(/\(\?:/g, '')) || /\(\?[a-zA-Z-]+\)/.test(rest);
  const explicit = scoped; // case folding is written out only when the pattern has scoped flag groups
  const useIFlag = global.i && !explicit;
  const useSFlag = global.s && !explicit;

  let out = '';
  const stack: Scope[] = [];
  let scope: Scope = { ...global };

  const foldLetter = (c: string): string => (explicit && scope.i && isLetter(c) ? `[${c}${swapCase(c)}]` : c);

  let i = 0;
  while (i < rest.length) {
    const c = rest[i];

    if (c === '\\') {
      const e = rest[i + 1];
      if (e === undefined) throw new UnsupportedRegex('a trailing backslash');
      if (e === 'z') out += '(?![\\s\\S])';
      else if (e === 'A') out += '(?<![\\s\\S])';
      else if (e === 'Q' || e === 'E' || e === 'C' || e === 'p' || e === 'P' || e === 'Z' || e === 'h' || e === 'H' || e === 'R' || e === 'G' || e === 'K') {
        throw new UnsupportedRegex(`the escape \\${e} is not supported`);
      } else if (e >= '1' && e <= '9') throw new UnsupportedRegex('a backreference');
      else if (e === 'x' && rest[i + 2] === '{') throw new UnsupportedRegex('a \\x{...} code point');
      else out += `\\${e}`;
      i += 2;
      continue;
    }

    if (c === '[') {
      // a character class
      let j = i + 1;
      let negate = false;
      if (rest[j] === '^') {
        negate = true;
        j++;
      }
      const items: string[] = [];
      let first = true;
      for (;;) {
        if (j >= rest.length) throw new UnsupportedRegex('an unterminated character class');
        const d = rest[j];
        if (d === ']' && !first) break;
        first = false;
        if (d === '[' && rest[j + 1] === ':') {
          const close = rest.indexOf(':]', j + 2);
          const name = close < 0 ? '' : rest.slice(j + 2, close);
          if (!(name in POSIX)) throw new UnsupportedRegex(`the POSIX class [:${name}:] is not supported`);
          items.push(POSIX[name]);
          j = close + 2;
          continue;
        }
        if (d === '[') {
          items.push('\\[');
          j++;
          continue;
        }
        if (d === '\\') {
          const e = rest[j + 1];
          if (e === undefined) throw new UnsupportedRegex('a trailing backslash');
          if (e === 'p' || e === 'P' || e === 'Q' || e === 'E' || e === 'h' || e === 'H') throw new UnsupportedRegex(`the escape \\${e} is not supported`);
          if (e === 'x' && rest[j + 2] === '{') throw new UnsupportedRegex('a \\x{...} code point');
          items.push(`\\${e}`);
          j += 2;
          continue;
        }
        // a range a-z?
        if (rest[j + 1] === '-' && rest[j + 2] !== undefined && rest[j + 2] !== ']' && rest[j + 2] !== '\\') {
          const lo = d;
          const hi = rest[j + 2];
          items.push(`${lo}-${hi}`);
          if (explicit && scope.i && isLetter(lo) && isLetter(hi)) {
            if ((lo === lo.toLowerCase()) !== (hi === hi.toLowerCase())) throw new UnsupportedRegex('a letter range that crosses cases');
            items.push(`${swapCase(lo)}-${swapCase(hi)}`);
          }
          j += 3;
          continue;
        }
        items.push(d);
        if (explicit && scope.i && isLetter(d)) items.push(swapCase(d));
        j++;
      }
      out += `[${negate ? '^' : ''}${items.join('')}]`;
      i = j + 1;
      continue;
    }

    if (c === '(') {
      if (rest[i + 1] === '?') {
        const m = /^\(\?([a-zA-Z-]*):/.exec(rest.slice(i));
        if (rest.startsWith('(?:', i)) {
          stack.push(scope);
          out += '(?:';
          i += 3;
          continue;
        }
        if (rest.startsWith('(?P<', i) || rest.startsWith('(?<', i)) {
          if (rest.startsWith('(?<=', i) || rest.startsWith('(?<!', i)) throw new UnsupportedRegex('lookaround');
          const nameStart = rest.startsWith('(?P<', i) ? i + 4 : i + 3;
          const close = rest.indexOf('>', nameStart);
          if (close < 0) throw new UnsupportedRegex('an unterminated group name');
          stack.push(scope);
          out += `(?<${rest.slice(nameStart, close)}>`;
          i = close + 1;
          continue;
        }
        if (rest.startsWith('(?=', i) || rest.startsWith('(?!', i)) throw new UnsupportedRegex('lookaround');
        const inline = /^\(\?([a-zA-Z-]+)\)/.exec(rest.slice(i));
        if (inline) {
          // (?i) in the middle: it holds to the end of the group it is in (the scope is restored when that group closes)
          scope = parseFlagGroup(inline[1], scope);
          i += inline[0].length;
          continue;
        }
        if (m) {
          stack.push(scope);
          scope = parseFlagGroup(m[1], scope);
          out += '(?:';
          i += m[0].length;
          continue;
        }
        throw new UnsupportedRegex('a flag group in the middle of a pattern');
      }
      stack.push(scope);
      out += '(';
      i++;
      continue;
    }

    if (c === ')') {
      const back = stack.pop();
      if (back === undefined) throw new UnsupportedRegex('an unbalanced parenthesis');
      scope = back;
      out += ')';
      i++;
      continue;
    }

    if (c === '.' && explicit && scope.s) {
      out += '[\\s\\S]';
      i++;
      continue;
    }

    out += foldLetter(c);
    i++;
  }
  if (stack.length > 0) throw new UnsupportedRegex('an unbalanced parenthesis');

  return { source: out, flags: `${useIFlag ? 'i' : ''}${useSFlag ? 's' : ''}${multiline ? 'm' : ''}` };
}
