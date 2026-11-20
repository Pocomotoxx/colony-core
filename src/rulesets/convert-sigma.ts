import { translateRe2, UnsupportedRegex } from './re2.js';
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
/** Windows adds the file name the program was built with; the guard only has the name it was started by (see command-gate.ts). */
export const WINDOWS_PROVIDED_FIELDS = [...PROVIDED_FIELDS, 'OriginalFileName'] as const;
export type Platform = 'linux' | 'windows';
/** The kind of event a rule is written for: a process that starts, or the text of a PowerShell script (Windows ps_script). */
export type Category = 'process_creation' | 'ps_script' | 'registry' | 'file';
/** What a Sigma file rule can be about, and the fields of a file event the guard can give (see file-events.ts). */
const FILE_LOGSOURCES = ['file_event', 'file_change', 'file_delete'];
export const FILE_PROVIDED_FIELDS = ['TargetFilename', 'Image'] as const;
/** What a Sigma registry rule can be about, and the fields of a registry event the guard can give (see registry-events.ts). */
const REGISTRY_LOGSOURCES = ['registry_set', 'registry_delete', 'registry_event'];
export const REGISTRY_PROVIDED_FIELDS = ['TargetObject', 'Details', 'Image', 'EventType'] as const;
/** A PowerShell script has one field: its text. */
export const SCRIPT_PROVIDED_FIELDS = ['ScriptBlockText'] as const;
const OPS = new Set(['contains', 'startswith', 'endswith']);
const DASHES = ['/', '\u2013', '\u2014', '\u2015'];

/**
 * `base64offset`: the value as it appears inside a base64 text, whatever its position (three alignments). The
 * characters that depend on the bytes before or after the value are cut off, as Sigma's own tools do.
 */
function base64Variants(value: string): string[] {
  const bytes = Buffer.from(value, 'utf-8');
  const starts = [0, 2, 3];
  const ends: Array<number | undefined> = [undefined, -3, -2];
  return [0, 1, 2].map((i) => {
    const text = Buffer.concat([Buffer.alloc(i, 0x20), bytes]).toString('base64');
    return text.slice(starts[i], ends[(bytes.length + i) % 3]);
  });
}

/** `windash`: a dash that starts an argument may also be written as / or as an en dash, em dash or horizontal bar. */
function dashVariants(v: string): string[] {
  if (!/(^|\s)-/.test(v)) return [v];
  return [v, ...DASHES.map((d) => v.replace(/(^|\s)-/g, (_m, lead: string) => lead + d))];
}

const isMap = (v: YamlValue | undefined): v is { [k: string]: YamlValue } => typeof v === 'object' && v !== null && !Array.isArray(v);

function clausesOf(map: { [k: string]: YamlValue }): FieldClause[] {
  const out: FieldClause[] = [];
  for (const [key, value] of Object.entries(map)) {
    const [field, ...mods] = key.split('|');
    let op: FieldOp = 'equals';
    let all = false;
    let windash = false;
    let b64 = false;
    let reI = false;
    for (const m of mods) {
      if (m === 'all') all = true;
      else if (m === 'windash') windash = true;
      else if (m === 'base64offset') b64 = true;
      else if (m === 're' && op === 'equals') op = 're';
      else if (m === 'i' && mods.includes('re')) reI = true;
      else if (OPS.has(m) && op === 'equals') op = m as FieldOp;
      else throw new SigmaError(`the modifier "${m}" in ${key} is not supported`);
    }
    const list = Array.isArray(value) ? value : [value];
    if (list.length === 0) throw new SigmaError(`${key} has no values`);
    const values = list.map((v) => {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
      throw new SigmaError(`${key} has a value that is not a string`);
    });
    if (b64) {
      if (op !== 'contains' || windash) throw new SigmaError(`${key}: base64offset is read only with contains`);
      const variants = (v: string): string[] => {
        const out = base64Variants(v);
        if (out.some((x) => x.length < 4)) throw new SigmaError(`${key} has a value too short to look for in base64 text`);
        return out;
      };
      if (all) for (const v of values) out.push({ field, op, values: variants(v), all: false, cs: true });
      else out.push({ field, op, values: values.flatMap(variants), all, cs: true });
      continue;
    }
    if (op === 're') {
      if (windash) throw new SigmaError(`${key} combines re and windash`);
      const sources: string[] = [];
      const flags: string[] = [];
      for (const v of values) {
        try {
          const t = translateRe2(v);
          const f = [...new Set((t.flags + (reI ? 'i' : '')).replace(/[gdy]/g, ''))].join('');
          new RegExp(t.source, f);
          sources.push(t.source);
          flags.push(f);
        } catch (err) {
          if (err instanceof UnsupportedRegex || err instanceof SyntaxError) throw new SigmaError(`${key} has a pattern that cannot be read (${err.message.slice(0, 60)})`);
          throw err;
        }
      }
      out.push({ field, op, values: sources, all, flags });
      continue;
    }
    if (windash && all) {
      // every value must be there, each in any of its dash spellings: one clause per value
      for (const v of values) out.push({ field, op, values: dashVariants(v), all: false });
    } else out.push({ field, op, values: windash ? values.flatMap(dashVariants) : values, all });
  }
  return out;
}

function selectionOf(name: string, value: YamlValue): Selection {
  if (isMap(value)) return [clausesOf(value)];
  if (Array.isArray(value) && value.length > 0 && value.every(isMap)) return (value as Array<{ [k: string]: YamlValue }>).map(clausesOf);
  throw new SigmaError(`the selection ${name} is a keyword list or something else this converter does not read`);
}

export function convertSigma(
  files: Record<string, string>,
  meta: { name: string; version: string; repoUrl: string; platform?: Platform; category?: Category },
): { ruleset: { format: 1; kind: 'commands'; name: string; version: string; platform?: 'windows'; category?: 'ps_script' | 'registry' | 'file'; rules: CommandRule[] }; report: ConversionReport } {
  const platform: Platform = meta.platform ?? 'linux';
  const category: Category = meta.category ?? 'process_creation';
  if (category !== 'process_creation' && platform !== 'windows') throw new SigmaError('PowerShell script and registry rules are Windows rules');
  const provided: readonly string[] = category === 'file' ? FILE_PROVIDED_FIELDS : category === 'registry' ? REGISTRY_PROVIDED_FIELDS : category === 'ps_script' ? SCRIPT_PROVIDED_FIELDS : platform === 'windows' ? WINDOWS_PROVIDED_FIELDS : PROVIDED_FIELDS;
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
    const sourceOk = category === 'registry' || category === 'file' ? typeof logsource.category === 'string' && (category === 'file' ? FILE_LOGSOURCES : REGISTRY_LOGSOURCES).includes(logsource.category) : logsource.category === category;
    if (logsource.product !== platform || !sourceOk) return skip(`not a ${platform === 'windows' ? 'Windows' : 'Linux'} ${category === 'ps_script' ? 'PowerShell script' : category === 'registry' ? 'registry' : category === 'file' ? 'file' : 'process creation'} rule`);
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
      const missing = [...fields].filter((f) => !provided.includes(f));
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
        ...(category === 'registry' || category === 'file' ? { on: String(logsource.category) } : {}),
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
    ruleset: { format: 1, kind: 'commands', name: meta.name, version: meta.version, ...(platform === 'windows' ? { platform: 'windows' as const } : {}), ...(category !== 'process_creation' ? { category } : {}), rules },
    report: { total: rules.length + skipped.length, converted: rules.length, skipped, dropped: {} },
  };
}
