import { parseCondition, referencedSelections, SigmaError, type CommandRule, type FieldClause, type FieldOp, type Selection } from './sigma.js';
import type { ConversionReport, SkippedRule } from './types.js';
import { parseYaml, YamlError, type YamlValue } from './yaml-lite.js';

/**
 * Convert Sigma rule files (process creation rules for Linux) into the colony's command rule format. A rule is carried
 * over only when everything in it can be judged for a command before it runs; otherwise it is skipped with its reason,
 * and the report says how many and why. Nothing is guessed.
 */

/** What the guard knows about a command before it runs. The other Sigma fields (the parent process, the user, ...) do not exist yet. */
export const PROVIDED_FIELDS = ['Image', 'CommandLine', 'CurrentDirectory'] as const;
const OPS = new Set(['contains', 'startswith', 'endswith']);

const isMap = (v: YamlValue | undefined): v is { [k: string]: YamlValue } => typeof v === 'object' && v !== null && !Array.isArray(v);

function clausesOf(map: { [k: string]: YamlValue }): FieldClause[] {
  const out: FieldClause[] = [];
  for (const [key, value] of Object.entries(map)) {
    const [field, ...mods] = key.split('|');
    let op: FieldOp = 'equals';
    let all = false;
    for (const m of mods) {
      if (m === 'all') all = true;
      else if (OPS.has(m) && op === 'equals') op = m as FieldOp;
      else throw new SigmaError(`the modifier "${m}" in ${key} is not supported`);
    }
    const list = Array.isArray(value) ? value : [value];
    if (list.length === 0) throw new SigmaError(`${key} has no values`);
    const values = list.map((v) => {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
      throw new SigmaError(`${key} has a value that is not a string`);
    });
    if (values.some((v) => v.includes('*') || v.includes('?'))) throw new SigmaError(`${key} uses a wildcard, which is not supported`);
    out.push({ field, op, values, all });
  }
  return out;
}

function selectionOf(name: string, value: YamlValue): Selection {
  if (isMap(value)) return [clausesOf(value)];
  if (Array.isArray(value) && value.length > 0 && value.every(isMap)) return (value as Array<{ [k: string]: YamlValue }>).map(clausesOf);
  throw new SigmaError(`the selection ${name} is a keyword list or something else this converter does not read`);
}

export function convertSigma(files: Record<string, string>, meta: { name: string; version: string; repoUrl: string }): { ruleset: { format: 1; kind: 'commands'; name: string; version: string; rules: CommandRule[] }; report: ConversionReport } {
  const rules: CommandRule[] = [];
  const skipped: SkippedRule[] = [];
  const seen = new Set<string>();

  const handle = (path: string): void => {
    const base = path.split('/').pop() ?? path;
    const id = base.replace(/\.ya?ml$/, '');
    const skip = (reason: string) => void skipped.push({ id, reason });
    let doc: YamlValue;
    try {
      doc = parseYaml(files[path]);
    } catch (err) {
      if (err instanceof YamlError) return skip(`the file could not be read (${err.message})`);
      throw err;
    }
    if (!isMap(doc)) return skip('the file is not a rule');
    const str = (k: string): string => (typeof doc[k] === 'string' ? (doc[k] as string) : '');
    const ruleId = str('id');
    const title = str('title');
    const author = str('author');
    if (!/^[0-9a-f-]{36}$/.test(ruleId) || !title) return skip('the rule has no usable id or title');
    if (!author) return skip('the rule names no author (the license asks for it)');
    if (seen.has(ruleId)) return skip('duplicate rule id');
    seen.add(ruleId);
    const logsource = isMap(doc.logsource) ? doc.logsource : {};
    if (logsource.product !== 'linux' || logsource.category !== 'process_creation') return skip('not a Linux process creation rule');
    const detection = isMap(doc.detection) ? doc.detection : null;
    if (!detection) return skip('the rule has no detection');

    try {
      if (typeof detection.condition !== 'string') throw new SigmaError('the condition is not a single expression');
      if ('timeframe' in detection) throw new SigmaError('an aggregation over time');
      const selections: Record<string, Selection> = {};
      for (const [name, value] of Object.entries(detection)) {
        if (name === 'condition') continue;
        selections[name] = selectionOf(name, value);
      }
      const names = Object.keys(selections);
      if (names.length === 0) throw new SigmaError('the rule has no selection');
      const condition = parseCondition(detection.condition);
      const used = referencedSelections(condition, names);
      for (const n of used) if (!(n in selections)) throw new SigmaError(`the condition refers to ${n}, which is not defined`);
      if (used.size === 0) throw new SigmaError('the condition refers to no selection');

      const fields = new Set<string>();
      for (const n of used) for (const alt of selections[n]) for (const c of alt) fields.add(c.field);
      const missing = [...fields].filter((f) => !(PROVIDED_FIELDS as readonly string[]).includes(f));
      if (missing.length > 0) throw new SigmaError(`needs ${missing.join(', ')}, which a command does not have before it runs`);

      const description = (typeof doc.description === 'string' ? doc.description : '').replace(/\s+/g, ' ').trim().slice(0, 400);
      rules.push({
        id: ruleId,
        title,
        author,
        level: str('level'),
        status: str('status'),
        description,
        link: `${meta.repoUrl}/${path}`,
        selections,
        condition,
      });
    } catch (err) {
      if (err instanceof SigmaError) return skip(err.message);
      throw err;
    }
  };
  for (const path of Object.keys(files).sort()) handle(path);

  return {
    ruleset: { format: 1, kind: 'commands', name: meta.name, version: meta.version, rules },
    report: { total: rules.length + skipped.length, converted: rules.length, skipped, dropped: {} },
  };
}
