/**
 * A strict reader for the small subset of YAML that the Sigma rule files use: block mappings, block sequences (also a
 * sequence of mappings), plain, single- and double-quoted scalars, block scalars (| and >), and comments. It is not a
 * YAML parser: flow collections, anchors and aliases, tags, multiple documents, tabs and everything else are errors, so
 * that a rule file that uses something new fails loudly instead of being half-read.
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

  /** The text of a scalar, without its trailing comment. */
  function scalar(raw: string): YamlValue {
    const t = raw.trim();
    if (t[0] === "'") {
      let out = '';
      let k = 1;
      for (;;) {
        if (k >= t.length) return fail('an unterminated single-quoted string');
        if (t[k] === "'") {
          if (t[k + 1] === "'") {
            out += "'";
            k += 2;
            continue;
          }
          k++;
          break;
        }
        out += t[k++];
      }
      if (!/^\s*(#.*)?$/.test(t.slice(k))) fail('unexpected text after a quoted string');
      return out;
    }
    if (t[0] === '"') {
      let out = '';
      let k = 1;
      for (;;) {
        if (k >= t.length) return fail('an unterminated double-quoted string');
        const c = t[k++];
        if (c === '"') break;
        if (c !== '\\') {
          out += c;
          continue;
        }
        const e = t[k++];
        if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === '\\' || e === '"' || e === '/') out += e;
        else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(t.slice(k, k + 4))) {
          out += String.fromCharCode(parseInt(t.slice(k, k + 4), 16));
          k += 4;
        } else return fail(`an unsupported escape \\${e ?? ''}`);
      }
      if (!/^\s*(#.*)?$/.test(t.slice(k))) fail('unexpected text after a quoted string');
      return out;
    }
    const plain = t.replace(/\s+#.*$/, '').trim();
    if (plain === '' || plain === '~' || plain === 'null') return null;
    if (/^[[{&*!|>%@`]/.test(plain)) return fail('a flow collection, anchor, alias, tag or block indicator in a plain value is not supported');
    if (/: |:$/.test(plain)) return fail('a mapping on one line is not supported');
    if (plain === 'true') return true;
    if (plain === 'false') return false;
    if (/^[-+]?\d+$/.test(plain)) return Number(plain);
    if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(plain)) return Number(plain);
    return plain;
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
      else out[key] = scalar(rest);
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
        fail('a block scalar as a sequence item is not supported');
      } else if (KEY.test(content) && content[0] !== "'" && content[0] !== '"') {
        // "- key: value": the rest of the mapping lines up with the first key
        rows[i] = ' '.repeat(contentIndent) + content;
        out.push(parseMap(contentIndent));
      } else {
        i++;
        out.push(scalar(content));
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
