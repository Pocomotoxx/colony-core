/**
 * A strict reader for the few shapes of Python source that the vendored presidio files use for their patterns:
 *
 *   Pattern("name", r"regex", 0.6)                         a pattern call (strings may be adjacent literals)
 *   NAME = "text"            and       "XX": "(XX)" + CK + N4     constants and a dict of concatenated strings
 *
 * Nothing is evaluated and nothing is guessed: a string prefix other than r, an f-string, a name that was never defined,
 * or any syntax outside these shapes is an error, so that an upstream change shows up as a failed conversion instead of
 * as a silently different rule.
 */

export class PyParseError extends Error {}

type Tok = { t: 'str'; v: string; triple: boolean } | { t: 'name'; v: string } | { t: 'num'; v: number } | { t: 'op'; v: string } | { t: 'eof' };

const OPS = new Set(['=', '+', ',', ':', '{', '}', '(', ')', '[', ']']);

class Lexer {
  pos: number;
  constructor(private readonly src: string, start = 0) {
    this.pos = start;
  }

  private fail(message: string): never {
    const line = this.src.slice(0, this.pos).split('\n').length;
    throw new PyParseError(`line ${line}: ${message}`);
  }

  /** The text of a string literal starting at the quote, as Python reads it (a raw string keeps its backslashes). */
  private readString(raw: boolean): { v: string; triple: boolean } {
    const q = this.src[this.pos];
    if (this.src.startsWith(q.repeat(3), this.pos)) {
      if (raw) this.fail('a raw triple-quoted string is not supported');
      const end = this.src.indexOf(q.repeat(3), this.pos + 3);
      if (end < 0) this.fail('an unterminated triple-quoted string');
      const v = this.src.slice(this.pos + 3, end);
      this.pos = end + 3;
      return { v, triple: true };
    }
    this.pos++;
    let out = '';
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined || c === '\n') this.fail('an unterminated string');
      if (c === q) {
        this.pos++;
        return { v: out, triple: false };
      }
      if (c === '\\') {
        const e = this.src[this.pos + 1];
        if (e === undefined) this.fail('an unterminated string');
        if (raw) out += c + e;
        else if (e === '\\' || e === '"' || e === "'") out += e;
        else if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else this.fail(`an unsupported escape \\${e}`);
        this.pos += 2;
        continue;
      }
      out += c;
      this.pos++;
    }
  }

  next(): Tok {
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) return { t: 'eof' };
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') this.pos++;
      else if (c === '#') while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
      else break;
    }
    const c = this.src[this.pos];
    const pre = /^[A-Za-z]{1,2}(?=["'])/.exec(this.src.slice(this.pos, this.pos + 3));
    if (pre) {
      if (pre[0] !== 'r' && pre[0] !== 'R') this.fail(`the string prefix "${pre[0]}" is not supported`);
      this.pos += pre[0].length;
      return { t: 'str', ...this.readString(true) };
    }
    if (c === '"' || c === "'") return { t: 'str', ...this.readString(false) };
    const num = /^\d+(?:\.\d+)?/.exec(this.src.slice(this.pos, this.pos + 24));
    if (num) {
      this.pos += num[0].length;
      return { t: 'num', v: Number(num[0]) };
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos, this.pos + 80));
    if (name) {
      this.pos += name[0].length;
      return { t: 'name', v: name[0] };
    }
    if (OPS.has(c)) {
      this.pos++;
      return { t: 'op', v: c };
    }
    return this.fail(`the character "${c}" is not supported`);
  }

  peek(): Tok {
    const at = this.pos;
    const t = this.next();
    this.pos = at;
    return t;
  }

  expectOp(op: string): void {
    const t = this.next();
    if (t.t !== 'op' || t.v !== op) this.fail(`"${op}" was expected`);
  }

  error(message: string): never {
    return this.fail(message);
  }
}

export interface PyPattern {
  name: string;
  regex: string;
  score: number;
}

/** Every `Pattern("name", r"regex", score)` call of a recognizer file, in order. At least one must be there. */
export function extractPatternCalls(source: string): PyPattern[] {
  const out: PyPattern[] = [];
  const re = /(?<![A-Za-z_.])Pattern\(/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const lx = new Lexer(source, m.index + m[0].length);
    const nameTok = lx.next();
    if (nameTok.t !== 'str' || nameTok.triple) lx.error('the pattern name must be a string');
    lx.expectOp(',');
    let regex = '';
    let parts = 0;
    for (;;) {
      const t = lx.peek();
      if (t.t !== 'str' || t.triple) break;
      lx.next();
      regex += t.v;
      parts++;
    }
    if (parts === 0) lx.error('the regex must be string literals');
    lx.expectOp(',');
    const score = lx.next();
    if (score.t !== 'num') lx.error('the score must be a number');
    if (lx.peek().t === 'op' && (lx.peek() as { v: string }).v === ',') lx.next();
    lx.expectOp(')');
    out.push({ name: (nameTok as { v: string }).v, regex, score: (score as { v: number }).v });
  }
  if (out.length === 0) throw new PyParseError('no Pattern(...) call was found');
  return out;
}

/** `regex_per_country`: country code to regex, with the constants it is built from. */
export function evaluateRegexTable(source: string, tableName = 'regex_per_country'): Record<string, string> {
  const lx = new Lexer(source);
  const constants = new Map<string, string>();
  let table: Record<string, string> | null = null;
  let first = true;

  const expr = (): string => {
    let value = '';
    for (;;) {
      const t = lx.next();
      if (t.t === 'str' && !t.triple) value += t.v;
      else if (t.t === 'name') {
        const c = constants.get(t.v);
        if (c === undefined) lx.error(`the name ${t.v} is not defined before it is used`);
        value += c as string;
      } else lx.error('a string or a defined name was expected');
      const p = lx.peek();
      if (p.t === 'op' && p.v === '+') lx.next();
      else return value;
    }
  };

  for (;;) {
    const t = lx.next();
    if (t.t === 'eof') break;
    if (first && t.t === 'str' && t.triple) {
      first = false; // the module docstring
      continue;
    }
    first = false;
    if (t.t !== 'name') lx.error('a statement must start with a name');
    lx.expectOp('=');
    const p = lx.peek();
    if (p.t === 'op' && p.v === '{') {
      lx.next();
      if (t.v !== tableName) lx.error(`an unexpected dict ${t.v}`);
      const entries: Record<string, string> = {};
      for (;;) {
        const k = lx.next();
        if (k.t === 'op' && k.v === '}') break;
        if (k.t !== 'str' || k.triple) lx.error('a dict key must be a string');
        lx.expectOp(':');
        entries[(k as { v: string }).v] = expr();
        const sep = lx.next();
        if (sep.t === 'op' && sep.v === '}') break;
        if (sep.t !== 'op' || sep.v !== ',') lx.error('"," or "}" was expected');
      }
      table = entries;
    } else {
      constants.set((t as { v: string }).v, expr());
    }
  }
  if (!table) throw new PyParseError(`the table ${tableName} was not found`);
  return table;
}
