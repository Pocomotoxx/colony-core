/**
 * A strict reader for the small subset of TOML that the vendored rule files use (comments, tables, arrays of
 * tables, strings, numbers, booleans and arrays). It is not a general TOML parser: anything outside the subset
 * (dotted keys, inline tables, dates, multi-line basic strings, ...) is an error, so that a rule file that uses
 * something new fails loudly instead of being half-read.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlError extends Error {}

const BARE_KEY = /[A-Za-z0-9_-]/;
const NUMBER = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;

export function parseToml(text: string): TomlTable {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let pos = 0;
  const root: TomlTable = {};
  let current: TomlTable = root;

  const lineOf = (at: number): number => src.slice(0, at).split('\n').length;
  const fail = (message: string): never => {
    throw new TomlError(`line ${lineOf(pos)}: ${message}`);
  };

  const skipSpaces = (): void => {
    while (pos < src.length && (src[pos] === ' ' || src[pos] === '\t')) pos++;
  };
  const skipComment = (): void => {
    if (src[pos] === '#') while (pos < src.length && src[pos] !== '\n') pos++;
  };
  /** Spaces, comments and line breaks (between array items). */
  const skipBlank = (): void => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (src[pos] === '\r') pos++;
      else if (src[pos] === '\n') pos++;
      else return;
    }
  };

  const parseKey = (): string => {
    skipSpaces();
    if (src[pos] === '"') return parseBasicString();
    const start = pos;
    while (pos < src.length && BARE_KEY.test(src[pos])) pos++;
    if (pos === start) fail('a key was expected');
    return src.slice(start, pos);
  };

  const parseBasicString = (): string => {
    if (src.startsWith('"""', pos)) fail('multi-line basic strings are not supported');
    pos++; // opening quote
    let out = '';
    for (;;) {
      if (pos >= src.length || src[pos] === '\n') fail('an unterminated string');
      const c = src[pos++];
      if (c === '"') return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = src[pos++];
      if (e === 'n') out += '\n';
      else if (e === 't') out += '\t';
      else if (e === 'r') out += '\r';
      else if (e === 'b') out += '\b';
      else if (e === 'f') out += '\f';
      else if (e === '"') out += '"';
      else if (e === '\\') out += '\\';
      else if (e === 'u' || e === 'U') {
        const len = e === 'u' ? 4 : 8;
        const hex = src.slice(pos, pos + len);
        if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) fail('a bad unicode escape');
        out += String.fromCodePoint(parseInt(hex, 16));
        pos += len;
      } else fail(`an unsupported escape \\${e ?? ''}`);
    }
  };

  const parseLiteralString = (): string => {
    if (src.startsWith("'''", pos)) {
      pos += 3;
      if (src[pos] === '\r' && src[pos + 1] === '\n') pos += 2;
      else if (src[pos] === '\n') pos++;
      const end = src.indexOf("'''", pos);
      if (end < 0) fail('an unterminated multi-line string');
      // up to two further quotes may follow the closing delimiter as part of the content
      let close = end;
      while (src[close + 3] === "'" && close - end < 2) close++;
      const value = src.slice(pos, close);
      pos = close + 3;
      return value;
    }
    pos++;
    const start = pos;
    while (pos < src.length && src[pos] !== "'" && src[pos] !== '\n') pos++;
    if (src[pos] !== "'") fail('an unterminated string');
    const value = src.slice(start, pos);
    pos++;
    return value;
  };

  const parseValue = (): TomlValue => {
    skipSpaces();
    const c = src[pos];
    if (c === '"') return parseBasicString();
    if (c === "'") return parseLiteralString();
    if (c === '[') {
      pos++;
      const items: TomlValue[] = [];
      for (;;) {
        skipBlank();
        if (src[pos] === ']') {
          pos++;
          return items;
        }
        items.push(parseValue());
        skipBlank();
        if (src[pos] === ',') pos++;
        else if (src[pos] !== ']') fail('a "," or "]" was expected in an array');
      }
    }
    if (src.startsWith('true', pos) && !BARE_KEY.test(src[pos + 4] ?? ' ')) {
      pos += 4;
      return true;
    }
    if (src.startsWith('false', pos) && !BARE_KEY.test(src[pos + 5] ?? ' ')) {
      pos += 5;
      return false;
    }
    const m = NUMBER.exec(src.slice(pos, pos + 40));
    if (m && !BARE_KEY.test(src[pos + m[0].length] ?? ' ')) {
      pos += m[0].length;
      return Number(m[0]);
    }
    return fail('a value this reader does not support');
  };

  /** Walk a dotted table path; an array of tables on the way means its last element. */
  const descend = (path: string[], create: boolean): TomlTable => {
    let node: TomlTable = root;
    for (const seg of path) {
      let next = node[seg];
      if (next === undefined) {
        if (!create) fail(`the table ${path.join('.')} does not exist`);
        next = {};
        node[seg] = next;
      }
      if (Array.isArray(next)) {
        const last = next[next.length - 1];
        if (typeof last !== 'object' || last === null || Array.isArray(last)) fail(`${seg} is not a table`);
        next = last;
      }
      if (typeof next !== 'object' || next === null) fail(`${seg} is not a table`);
      node = next as TomlTable;
    }
    return node;
  };

  while (pos < src.length) {
    skipBlank();
    if (pos >= src.length) break;
    if (src[pos] === '[') {
      const array = src[pos + 1] === '[';
      pos += array ? 2 : 1;
      const path: string[] = [parseKey()];
      skipSpaces();
      while (src[pos] === '.') {
        pos++;
        path.push(parseKey());
        skipSpaces();
      }
      if (array ? !src.startsWith(']]', pos) : src[pos] !== ']') fail('a table header was not closed');
      pos += array ? 2 : 1;
      const parent = descend(path.slice(0, -1), true);
      const name = path[path.length - 1];
      if (array) {
        const existing = parent[name];
        if (existing !== undefined && !Array.isArray(existing)) fail(`${name} is already a table`);
        const list = (existing ?? []) as TomlValue[];
        const table: TomlTable = {};
        list.push(table);
        parent[name] = list;
        current = table;
      } else {
        if (parent[name] !== undefined) fail(`the table ${name} is defined twice`);
        const table: TomlTable = {};
        parent[name] = table;
        current = table;
      }
    } else {
      const key = parseKey();
      skipSpaces();
      if (src[pos] === '.') fail('dotted keys are not supported');
      if (src[pos] !== '=') fail('an "=" was expected after the key');
      pos++;
      if (key in current) fail(`the key ${key} is defined twice`);
      current[key] = parseValue();
    }
    skipSpaces();
    skipComment();
    if (pos < src.length && src[pos] !== '\n' && src[pos] !== '\r') fail('unexpected text after a value');
  }
  return root;
}
