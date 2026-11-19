/**
 * A strict reader for the subset of YAML that the vendored rule files use: block mappings, block sequences (also a
 * sequence of mappings), plain, single- and double-quoted scalars (also over several lines, folded as YAML folds them),
 * block scalars (| and >, also as a sequence item), flow sequences of scalars on one line, and comments. It is not a
 * YAML parser: flow mappings, nested flow collections, anchors and aliases, tags, multiple documents, tabs and
 * everything else are errors, so that a rule file that uses something new fails loudly instead of being half-read.
 */

export class YamlError extends Error {}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

const isBlank = (s: string): boolean => /^\s*(#.*)?$/.test(s);

export function parseYaml(text: string): YamlValue {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = src.split('\n').map((l) => l.replace(/\r$/, ''));
  let i = 0;

  const fail = (message: string): never => {
    throw new YamlError(`line ${Math.min(i, rows.length - 1) + 1}: ${message}`);
  };
  const indentOf = (s: string): number => {
    const n = /^ */.exec(s)![0].length;
    if (s[n] === '\t') fail('a tab is not allowed as indentation');
    return n;
  };
  const skipBlanks = (): void => {
    while (i < rows.length && isBlank(rows[i])) i++;
  };

  // ---- quoted scalars (possibly over several lines)

  /** The index of the closing quote in `text` (which starts with the opening quote), or -1. */
  function findClose(text: string, q: string): number {
    for (let k = 1; k < text.length; k++) {
      const c = text[k];
      if (q === '"' && c === '\\') k++;
      else if (c === q) {
        if (q === "'" && text[k + 1] === "'") k++;
        else return k;
      }
    }
    return -1;
  }

  const ESCAPES: Record<string, string> = { '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: ' ', L: ' ', P: ' ' };

  function decodeDouble(s: string): string {
    let out = '';
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = s[++k];
      if (e !== undefined && e in ESCAPES) out += ESCAPES[e];
      else if (e === 'x' || e === 'u' || e === 'U') {
        const len = e === 'x' ? 2 : e === 'u' ? 4 : 8;
        const hex = s.slice(k + 1, k + 1 + len);
        if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) return fail(`a bad \\${e} escape`);
        out += String.fromCodePoint(parseInt(hex, 16));
        k += len;
      } else return fail(`an unsupported escape \\${e ?? ''}`);
    }
    return out;
  }

  /** The text of a quoted scalar that starts with `first`; further rows are read while it is not closed. */
  function quoted(first: string): string {
    const q = first[0];
    let text = first;
    let end = findClose(text, q);
    while (end < 0) {
      if (i >= rows.length) return fail(`an unterminated ${q === "'" ? 'single' : 'double'}-quoted string`);
      text += '\n' + rows[i++];
      end = findClose(text, q);
    }
    if (!/^\s*(#.*)?$/.test(text.slice(end + 1))) fail('unexpected text after a quoted string');
    // fold the lines as YAML does: a line break becomes a space, a blank line a line break, and in double quotes a
    // backslash before the line break joins the lines without a space
    const lines = text.slice(1, end).split('\n');
    let acc = '';
    let blanks = 0;
    let prevEscaped = false;
    lines.forEach((raw, k) => {
      const last = k === lines.length - 1;
      let s = k > 0 ? raw.replace(/^[ \t]+/, '') : raw;
      let escaped = false;
      if (!last) {
        if (q === '"') {
          const m = /(\\*)$/.exec(s)!;
          if (m[1].length % 2 === 1) {
            s = s.slice(0, -1);
            escaped = true;
          }
        }
        if (!escaped) s = s.replace(/[ \t]+$/, '');
      }
      if (k === 0) acc = s;
      else if (s === '' && !last) blanks++;
      else {
        acc += prevEscaped ? s : blanks > 0 ? '\n'.repeat(blanks) + s : ' ' + s;
        blanks = 0;
      }
      if (!(s === '' && !last && k > 0)) prevEscaped = escaped;
    });
    return q === "'" ? acc.replace(/''/g, "'") : decodeDouble(acc);
  }

  // ---- flow sequences of scalars, on one line

  function flowSequence(t: string): YamlValue[] {
    const m = /^\[(.*)\]\s*(#.*)?$/.exec(t);
    if (!m) return fail('only a flow sequence of scalars on one line is supported');
    const out: YamlValue[] = [];
    let item = '';
    let quote: string | null = null;
    const push = (): void => {
      const v = item.trim();
      item = '';
      if (v === '') return;
      if (v[0] === '[' || v[0] === '{') fail('a nested flow collection is not supported');
      out.push(v[0] === "'" || v[0] === '"' ? flowQuoted(v) : plainValue(v));
    };
    for (const c of m[1]) {
      if (quote) {
        item += c;
        if (c === quote) quote = null;
      } else if (c === "'" || c === '"') {
        quote = c;
        item += c;
      } else if (c === ',') push();
      else item += c;
    }
    if (quote) fail('an unterminated quote in a flow sequence');
    push();
    return out;
  }
  function flowQuoted(v: string): string {
    const end = findClose(v, v[0]);
    if (end !== v.length - 1) return fail('unexpected text after a quoted string');
    return v[0] === "'" ? v.slice(1, -1).replace(/''/g, "'") : decodeDouble(v.slice(1, -1));
  }

  // ---- plain scalars

  /** What a plain scalar may not look like (its first line). */
  function checkPlain(plain: string): void {
    if (/^[[{&*!|>%@`]/.test(plain)) fail('a flow collection, anchor, alias, tag or block indicator in a plain value is not supported');
    if (/: |:$/.test(plain)) fail('a mapping on one line is not supported');
  }

  function plainValue(plain: string): YamlValue {
    if (plain === '' || plain === '~' || plain === 'null') return null;
    checkPlain(plain);
    if (plain === 'true') return true;
    if (plain === 'false') return false;
    if (/^[-+]?\d+$/.test(plain)) return Number(plain);
    if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(plain)) return Number(plain);
    return plain;
  }

  /** A scalar that starts with `raw`; for a plain or quoted one, further rows are read while they belong to it. */
  function scalarAt(raw: string, parentIndent: number): YamlValue {
    const t = raw.trim();
    if (t[0] === "'" || t[0] === '"') return quoted(t);
    if (t[0] === '[') return flowSequence(t);
    if (t[0] === '{') return fail('a flow mapping is not supported');
    const firstHasComment = /\s+#/.test(t);
    let text = t.replace(/\s+#.*$/, '').trim();
    let multi = false;
    checkPlain(text);
    if (!firstHasComment) {
      let blanks = 0;
      while (i < rows.length) {
        const r = rows[i];
        if (r.trim() === '') {
          blanks++;
          i++;
          continue;
        }
        if (indentOf(r) <= parentIndent || r.trim()[0] === '#') break;
        const body = r.trim();
        const comment = /\s+#/.test(body);
        const piece = body.replace(/\s+#.*$/, '').trim();
        if (/: |:$/.test(piece)) fail('a mapping value is not allowed inside a multi-line plain value');
        text += (blanks > 0 ? '\n'.repeat(blanks) : ' ') + piece;
        blanks = 0;
        multi = true;
        i++;
        if (comment) break;
      }
    }
    return multi ? text : plainValue(text);
  }

  function blockScalar(header: string, parentIndent: number): string {
    const m = /^([|>])([-]?)\s*(#.*)?$/.exec(header.trim());
    if (!m) return fail('a block scalar header with an indent indicator or "+" is not supported');
    const lines: string[] = [];
    while (i < rows.length && (isBlankStrict(rows[i]) || indentOf(rows[i]) > parentIndent)) lines.push(rows[i++]);
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    const body = lines.filter((l) => l.trim() !== '');
    const block = body.length === 0 ? 0 : Math.min(...body.map((l) => indentOf(l)));
    const content = lines.map((l) => (l.trim() === '' ? '' : l.slice(block)));
    let text: string;
    if (m[1] === '|') text = content.join('\n');
    else {
      const paragraphs: string[] = [];
      let current: string[] = [];
      for (const l of content) {
        if (l === '') {
          paragraphs.push(current.join(' '));
          current = [];
        } else current.push(l);
      }
      paragraphs.push(current.join(' '));
      text = paragraphs.join('\n');
    }
    return m[2] === '-' ? text : text + '\n';
  }
  const isBlankStrict = (s: string): boolean => s.trim() === '';

  const KEY = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s:#'"\-[{&*!|>%@`][^:#]*?|-[^\s:#][^:#]*?)):(?:\s+(.*))?$/;

  function parseMap(ind: number): { [key: string]: YamlValue } {
    const out: { [key: string]: YamlValue } = {};
    for (;;) {
      skipBlanks();
      if (i >= rows.length) break;
      const line = rows[i];
      const cur = indentOf(line);
      if (cur < ind) break;
      if (cur > ind) fail('unexpected indentation');
      const body = line.slice(ind);
      if (body === '-' || body.startsWith('- ')) break;
      const m = KEY.exec(body);
      if (!m) fail('a "key: value" line was expected');
      const key = (m![1] ?? m![2]?.replace(/''/g, "'") ?? m![3]).trim();
      if (key in out) fail(`the key ${key} is defined twice`);
      const rest = (m![4] ?? '').trim();
      i++;
      if (rest === '' || rest[0] === '#') {
        skipBlanks();
        if (i < rows.length) {
          const next = rows[i];
          const ni = indentOf(next);
          if (ni > ind) {
            out[key] = parseBlock(ni);
            continue;
          }
          if (ni === ind && (next.slice(ind) === '-' || next.slice(ind).startsWith('- '))) {
            out[key] = parseSeq(ind);
            continue;
          }
        }
        out[key] = null;
      } else if (rest[0] === '|' || rest[0] === '>') out[key] = blockScalar(rest, ind);
      else out[key] = scalarAt(rest, ind);
    }
    return out;
  }

  function parseSeq(ind: number): YamlValue[] {
    const out: YamlValue[] = [];
    for (;;) {
      skipBlanks();
      if (i >= rows.length) break;
      const line = rows[i];
      const cur = indentOf(line);
      if (cur < ind) break;
      if (cur > ind) fail('unexpected indentation');
      const body = line.slice(ind);
      if (!(body === '-' || body.startsWith('- '))) break;
      const content = body.slice(1).trimStart();
      const contentIndent = ind + (body.length - content.length);
      if (content === '' || content[0] === '#') {
        i++;
        skipBlanks();
        if (i < rows.length && indentOf(rows[i]) > ind) out.push(parseBlock(indentOf(rows[i])));
        else out.push(null);
      } else if (content[0] === '|' || content[0] === '>') {
        i++;
        out.push(blockScalar(content, ind));
      } else if (KEY.test(content) && content[0] !== "'" && content[0] !== '"') {
        // "- key: value": the rest of the mapping lines up with the first key
        rows[i] = ' '.repeat(contentIndent) + content;
        out.push(parseMap(contentIndent));
      } else {
        i++;
        out.push(scalarAt(content, ind));
      }
    }
    return out;
  }

  function parseBlock(ind: number): YamlValue {
    skipBlanks();
    const body = rows[i].slice(ind);
    return body === '-' || body.startsWith('- ') ? parseSeq(ind) : parseMap(ind);
  }

  skipBlanks();
  if (i >= rows.length) return null;
  if (/^---/.test(rows[i]) || /^\.\.\./.test(rows[i])) fail('document markers are not supported');
  const value = parseBlock(indentOf(rows[i]));
  skipBlanks();
  if (i < rows.length) fail('unexpected content after the document');
  return value;
}
