/**
 * The part of the Sigma rule language that can be judged for a command before it runs: selections of field matches
 * (contains, startswith, endswith, all, equality), and the condition language (and, or, not, parentheses, "1 of" and
 * "all of" a name pattern or "them"). Everything else (regular expressions, base64, aggregation, near, fields that only
 * exist after a process has started) is refused by the converter, rule by rule, with a reason.
 */

export class SigmaError extends Error {}

export type FieldOp = 'contains' | 'startswith' | 'endswith' | 'equals' | 're';

export interface FieldClause {
  field: string;
  op: FieldOp;
  values: string[];
  /** `|all`: every value must match, not any. */
  all: boolean;
  /** For `re`: the JavaScript flags of each translated pattern (Sigma's `re` is case sensitive unless `re|i`). */
  flags?: string[];
  /** Case sensitive: a base64 text has a different spelling for every capital. */
  cs?: boolean;
}

/** An OR of alternatives, each an AND of field clauses (a selection written as a map is one alternative). */
export type Selection = FieldClause[][];

export type Cond =
  | { t: 'sel'; name: string }
  | { t: 'not'; e: Cond }
  | { t: 'and' | 'or'; l: Cond; r: Cond }
  | { t: 'of'; quant: 'one' | 'all'; pattern: string };

export interface CommandRule {
  id: string;
  title: string;
  author: string;
  level: string;
  status: string;
  description: string;
  /** Where the rule is in the upstream repository. */
  link: string;
  selections: Record<string, Selection>;
  condition: Cond;
}

/** What the guard knows about one command before it runs. A selection that names another field cannot match. */
export type CommandEvent = Record<string, string | undefined>;

// ---- the condition language

export function parseCondition(text: string): Cond {
  if (text.includes('|')) throw new SigmaError('an aggregation or a pipe in the condition');
  const tokens = text.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const next = (): string => {
    if (pos >= tokens.length) throw new SigmaError('the condition ends too early');
    return tokens[pos++];
  };
  const kw = (t: string | undefined): string => (t ?? '').toLowerCase();
  const NAME = /^[A-Za-z0-9_*]+$/;

  function parseOr(depth: number): Cond {
    if (depth > 20) throw new SigmaError('the condition is nested too deeply');
    let left = parseAnd(depth);
    while (kw(peek()) === 'or') {
      next();
      left = { t: 'or', l: left, r: parseAnd(depth) };
    }
    return left;
  }
  function parseAnd(depth: number): Cond {
    let left = parseNot(depth);
    while (kw(peek()) === 'and') {
      next();
      left = { t: 'and', l: left, r: parseNot(depth) };
    }
    return left;
  }
  function parseNot(depth: number): Cond {
    if (kw(peek()) === 'not') {
      next();
      return { t: 'not', e: parseNot(depth) };
    }
    return parsePrimary(depth);
  }
  function parsePrimary(depth: number): Cond {
    const t = next();
    if (t === '(') {
      const e = parseOr(depth + 1);
      if (next() !== ')') throw new SigmaError('a parenthesis is not closed');
      return e;
    }
    if ((kw(t) === '1' || kw(t) === 'all') && kw(peek()) === 'of') {
      next();
      const target = next();
      if (kw(target) !== 'them' && !NAME.test(target)) throw new SigmaError(`the pattern ${target} is not supported`);
      return { t: 'of', quant: kw(t) === 'all' ? 'all' : 'one', pattern: kw(target) === 'them' ? '*' : target };
    }
    if (/^\d+$/.test(t)) throw new SigmaError(`"${t} of" is not supported (only "1 of" and "all of")`);
    if (!NAME.test(t) || t.includes('*') || ['and', 'or', 'not', 'of', 'them'].includes(kw(t))) throw new SigmaError(`the token ${t} is not a selection name`);
    return { t: 'sel', name: t };
  }

  const out = parseOr(0);
  if (pos < tokens.length) throw new SigmaError(`unexpected ${tokens[pos]} in the condition`);
  return out;
}

const globToRegExp = (pattern: string): RegExp => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

/** The names a condition refers to; a pattern counts as referring to every name it matches. */
export function referencedSelections(cond: Cond, names: string[]): Set<string> {
  const out = new Set<string>();
  const walk = (c: Cond): void => {
    if (c.t === 'sel') out.add(c.name);
    else if (c.t === 'not') walk(c.e);
    else if (c.t === 'of') {
      for (const n of names) if (globToRegExp(c.pattern).test(n)) out.add(n);
    } else {
      walk(c.l);
      walk(c.r);
    }
  };
  walk(cond);
  return out;
}

// ---- running a rule

export interface CompiledClause {
  field: string;
  op: FieldOp;
  values: string[]; // lower case (not for re)
  all: boolean;
  res?: RegExp[];
  cs?: boolean;
  /** Parallel to values: the pattern of a value that has a wildcard (null for a plain value, which is in values). */
  globs?: Array<Glob | null>;
}

/** A value with wildcards: segments between the `*` of the value; a null in a segment is a `?` (any one character). */
export type Glob = Array<Array<string | null>>;

/**
 * Read a Sigma value (the specification's escaping): `*` is any run of characters, `?` any one character. A
 * backslash before a wildcard makes it a plain character (`\*`); `\\*` is a backslash and a wildcard, `\\\*` a
 * backslash and a plain star. A run of backslashes not followed by a wildcard counts half, rounded up (one or two
 * are one backslash, three or four are two).
 */
export function parseSigmaValue(raw: string): Glob {
  const segs: Glob = [[]];
  const cur = (): Array<string | null> => segs[segs.length - 1];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '\\') {
      let n = 0;
      while (raw[i + n] === '\\') n++;
      const next = raw[i + n];
      const wildcard = next === '*' || next === '?';
      const slashes = wildcard ? Math.floor(n / 2) : Math.ceil(n / 2);
      for (let k = 0; k < slashes; k++) cur().push('\\');
      i += n;
      if (wildcard && n % 2 === 1) {
        cur().push(next);
        i++;
      }
    } else if (c === '*') {
      segs.push([]);
      i++;
    } else if (c === '?') {
      cur().push(null);
      i++;
    } else {
      cur().push(c);
      i++;
    }
  }
  return segs;
}

const hasWildcard = (g: Glob): boolean => g.length > 1 || g[0].some((x) => x === null);

function matchAt(text: string, seg: Array<string | null>, at: number): boolean {
  if (at < 0 || at + seg.length > text.length) return false;
  for (let k = 0; k < seg.length; k++) if (seg[k] !== null && text[at + k] !== seg[k]) return false;
  return true;
}

/** The first place from `from` (not past `last`) where the segment matches, or -1. */
function findSeg(text: string, seg: Array<string | null>, from: number, last: number): number {
  for (let at = from; at <= last; at++) if (matchAt(text, seg, at)) return at;
  return -1;
}

/** Does the text match the pattern the way the field operator says (contains, startswith, endswith, equals)? Linear in the text for each segment: no backtracking. */
function globMatches(op: FieldOp, text: string, g: Glob): boolean {
  const anchorStart = op === 'startswith' || op === 'equals';
  const anchorEnd = op === 'endswith' || op === 'equals';
  if (g.length === 1) {
    const seg = g[0];
    if (anchorStart && anchorEnd) return text.length === seg.length && matchAt(text, seg, 0);
    if (anchorStart) return matchAt(text, seg, 0);
    if (anchorEnd) return matchAt(text, seg, text.length - seg.length);
    return findSeg(text, seg, 0, text.length - seg.length) >= 0;
  }
  let pos = 0;
  let end = text.length;
  const mids = g.slice();
  const first = mids.shift()!;
  const last = mids.pop()!;
  if (anchorStart) {
    if (!matchAt(text, first, 0)) return false;
    pos = first.length;
  } else mids.unshift(first);
  if (anchorEnd) {
    if (text.length - last.length < pos || !matchAt(text, last, text.length - last.length)) return false;
    end = text.length - last.length;
  } else mids.push(last);
  for (const seg of mids) {
    const at = findSeg(text, seg, pos, end - seg.length);
    if (at < 0) return false;
    pos = at + seg.length;
  }
  return true;
}

/** A pattern is tried on windows of this size (a little overlapping), over at most RE_TOTAL_MAX characters of a field, so a huge command cannot make a rule slow. */
const RE_INPUT_MAX = 8000;
const RE_STEP = 7000;
const RE_TOTAL_MAX = 24000;

export interface CompiledCommandRule {
  id: string;
  title: string;
  author: string;
  level: string;
  status: string;
  description: string;
  link: string;
  selections: Map<string, CompiledClause[][]>;
  condition: Cond;
  patterns: Map<string, RegExp>;
}

function compilePlain(c: FieldClause): CompiledClause {
  const parsed = c.values.map((v) => parseSigmaValue(c.cs ? v : v.toLowerCase()));
  const globs = parsed.map((g) => (hasWildcard(g) ? g : null));
  return {
    field: c.field,
    op: c.op,
    values: parsed.map((g, i) => (globs[i] ? '' : g[0].join(''))),
    all: c.all,
    ...(c.cs ? { cs: true } : {}),
    ...(globs.some((g) => g) ? { globs } : {}),
  };
}

export function compileCommandRule(rule: CommandRule): CompiledCommandRule {
  const selections = new Map<string, CompiledClause[][]>();
  for (const [name, sel] of Object.entries(rule.selections)) {
    selections.set(
      name,
      sel.map((alt) =>
        alt.map((c) =>
          c.op === 're'
            ? { field: c.field, op: c.op, values: c.values, all: c.all, res: c.values.map((v, i) => new RegExp(v, c.flags?.[i] ?? '')) }
            : compilePlain(c),
        ),
      ),
    );
  }
  const patterns = new Map<string, RegExp>();
  const collect = (c: Cond): void => {
    if (c.t === 'of') patterns.set(c.pattern, globToRegExp(c.pattern));
    else if (c.t === 'not') collect(c.e);
    else if (c.t === 'and' || c.t === 'or') {
      collect(c.l);
      collect(c.r);
    }
  };
  collect(rule.condition);
  return { id: rule.id, title: rule.title, author: rule.author, level: rule.level, status: rule.status, description: rule.description, link: rule.link, selections, condition: rule.condition, patterns };
}

function clauseMatches(c: CompiledClause, event: CommandEvent): boolean {
  const raw = event[c.field];
  if (raw === undefined) return false;
  if (c.op === 're') {
    const text = raw.length > RE_TOTAL_MAX ? raw.slice(0, RE_TOTAL_MAX) : raw;
    const hit = (re: RegExp): boolean => {
      for (let at = 0; ; at += RE_STEP) {
        re.lastIndex = 0;
        if (re.test(at === 0 && text.length <= RE_INPUT_MAX ? text : text.slice(at, at + RE_INPUT_MAX))) return true;
        if (at + RE_INPUT_MAX >= text.length) return false;
      }
    };
    return c.all ? c.res!.every(hit) : c.res!.some(hit);
  }
  const v = c.cs ? raw : raw.toLowerCase();
  const one = (want: string, i: number): boolean => {
    const g = c.globs?.[i];
    if (g) return globMatches(c.op, v, g);
    return c.op === 'contains' ? v.includes(want) : c.op === 'startswith' ? v.startsWith(want) : c.op === 'endswith' ? v.endsWith(want) : v === want;
  };
  return c.all ? c.values.every(one) : c.values.some(one);
}

/** Does the rule match this event? */
export function ruleMatches(rule: CompiledCommandRule, event: CommandEvent): boolean {
  const cache = new Map<string, boolean>();
  const selection = (name: string): boolean => {
    let r = cache.get(name);
    if (r === undefined) {
      const alts = rule.selections.get(name);
      r = alts !== undefined && alts.some((alt) => alt.every((c) => clauseMatches(c, event)));
      cache.set(name, r);
    }
    return r;
  };
  const ev = (c: Cond): boolean => {
    switch (c.t) {
      case 'sel':
        return selection(c.name);
      case 'not':
        return !ev(c.e);
      case 'and':
        return ev(c.l) && ev(c.r);
      case 'or':
        return ev(c.l) || ev(c.r);
      case 'of': {
        const re = rule.patterns.get(c.pattern)!;
        const names = [...rule.selections.keys()].filter((n) => re.test(n));
        if (names.length === 0) return false;
        return c.quant === 'all' ? names.every(selection) : names.some(selection);
      }
    }
  };
  return ev(rule.condition);
}
