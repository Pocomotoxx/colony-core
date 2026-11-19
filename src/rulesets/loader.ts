import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversionReport, PiiEntity, PiiRule, PiiRulesetFile, RuleAllowlist, RuleEntry, RulePattern, RulesetFile, SecretFinding } from './types.js';

/**
 * Loading and running the vendored rule sets (see docs/RULESETS-PLAN.md).
 *
 * A rule set is a folder: `PROVENANCE.json`, the upstream license, the upstream source files as they were downloaded,
 * and `ruleset.json`, the converted rules that the core runs. The loader checks every one of them against the hashes in
 * PROVENANCE.json. A set that fails any check is NOT loaded: the failure is returned, never swallowed, so that a
 * tampered or half-updated set cannot quietly mean "less protection".
 *
 * The files are small and are read synchronously: redaction is synchronous, and a hook is a short-lived process.
 */

export class RulesetError extends Error {}

export interface SourceHash {
  file: string;
  sha256: string;
  gitBlobSha1: string;
  bytes: number;
}

export interface Provenance {
  format: 1;
  name: string;
  version: string;
  commit: string;
  sourceUrl: string;
  license: string;
  licenseFile: { file: string; sha256: string };
  /** One upstream file (the gitleaks set) ... */
  source?: SourceHash;
  /** ... or several (the presidio set). */
  sources?: SourceHash[];
  normalized: { file: string; sha256: string };
  converter: string;
  retrievedAt: string;
  report: ConversionReport;
}

export const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** The hash git gives a file: sha1 of "blob <size>\0" and the bytes. It is what the upstream repository reports for a tag. */
export const gitBlobSha1 = (data: Buffer): string =>
  createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');

export const defaultRulesetsDir = (): string => fileURLToPath(new URL('../../rulesets', import.meta.url));

interface CompiledAllowlist {
  regexes: RegExp[];
  stopwords: string[];
  target: RuleAllowlist['target'];
  condition: RuleAllowlist['condition'];
}

interface CompiledRule {
  id: string;
  regex: RegExp;
  keywords: string[];
  entropy: number | null;
  secretGroup: number | null;
  allowlists: CompiledAllowlist[];
}

export interface CompiledPiiRule {
  id: string;
  entity: PiiEntity;
  regex: RegExp;
  score: number | null;
}

export interface LoadedRuleset {
  kind: 'secrets' | 'pii';
  name: string;
  version: string;
  dir: string;
  provenance: Provenance;
  /** The secret rules (empty for a pii set). */
  rules: CompiledRule[];
  globalAllowlist: CompiledAllowlist | null;
  /** The personal data rules (empty for a secrets set). */
  pii: CompiledPiiRule[];
}

const compilePattern = (p: RulePattern): RegExp => new RegExp(p.source, `${p.flags.replace(/[dg]/g, '')}dg`);

function compileAllowlist(a: RuleAllowlist): CompiledAllowlist {
  return { regexes: a.regexes.map(compilePattern), stopwords: a.stopwords, target: a.target, condition: a.condition };
}

function readBytes(file: string, what: string): Buffer {
  try {
    return readFileSync(file);
  } catch {
    throw new RulesetError(`${what} is missing or unreadable: ${path.basename(file)}`);
  }
}

function checkSecretsShape(f: Partial<RulesetFile> | null, expectName: string, expectVersion: string): RulesetFile {
  if (!f || typeof f !== 'object' || f.format !== 1 || !Array.isArray(f.rules)) throw new RulesetError('ruleset.json has an unsupported shape');
  if (f.name !== expectName || f.version !== expectVersion) throw new RulesetError('ruleset.json does not belong to the provenance record (name or version differs)');
  for (const r of f.rules as RuleEntry[]) {
    if (typeof r?.id !== 'string' || typeof r.pattern?.source !== 'string' || typeof r.pattern?.flags !== 'string' || !Array.isArray(r.keywords) || !Array.isArray(r.allowlists)) {
      throw new RulesetError(`a rule of ruleset.json is malformed (${typeof r?.id === 'string' ? r.id : '?'})`);
    }
  }
  return f as RulesetFile;
}

const PII_ENTITIES = new Set<string>(['ip_address', 'iban', 'credit_card', 'mac_address']);

function checkPiiShape(f: Partial<PiiRulesetFile> | null, expectName: string, expectVersion: string): PiiRulesetFile {
  if (!f || typeof f !== 'object' || f.format !== 1 || f.kind !== 'pii' || !Array.isArray(f.rules)) throw new RulesetError('ruleset.json has an unsupported shape');
  if (f.name !== expectName || f.version !== expectVersion) throw new RulesetError('ruleset.json does not belong to the provenance record (name or version differs)');
  for (const r of f.rules as PiiRule[]) {
    if (typeof r?.id !== 'string' || !PII_ENTITIES.has(r.entity) || typeof r.pattern?.source !== 'string' || typeof r.pattern?.flags !== 'string' || (r.score !== undefined && typeof r.score !== 'number')) {
      throw new RulesetError(`a rule of ruleset.json is malformed (${typeof r?.id === 'string' ? r.id : '?'})`);
    }
  }
  return f as PiiRulesetFile;
}

/** Load one rule set folder, verifying it first. Throws RulesetError when anything does not match. */
export function loadRulesetSync(dir: string): LoadedRuleset {
  let provenance: Provenance;
  try {
    provenance = JSON.parse(readBytes(path.join(dir, 'PROVENANCE.json'), 'the provenance record').toString('utf-8')) as Provenance;
  } catch (err) {
    if (err instanceof RulesetError) throw err;
    throw new RulesetError('PROVENANCE.json is not valid JSON');
  }
  if (provenance?.format !== 1 || typeof provenance.name !== 'string' || typeof provenance.version !== 'string') throw new RulesetError('PROVENANCE.json has an unsupported shape');

  const license = readBytes(path.join(dir, provenance.licenseFile.file), 'the license file');
  if (sha256Hex(license) !== provenance.licenseFile.sha256) throw new RulesetError('the license file does not match its recorded hash');

  const sources = provenance.sources ?? (provenance.source ? [provenance.source] : []);
  if (sources.length === 0) throw new RulesetError('PROVENANCE.json records no upstream source file');
  for (const s of sources) {
    const bytes = readBytes(path.join(dir, s.file), 'the upstream source file');
    if (sha256Hex(bytes) !== s.sha256) throw new RulesetError(`the upstream source file ${s.file} does not match its recorded SHA-256`);
    if (gitBlobSha1(bytes) !== s.gitBlobSha1) throw new RulesetError(`the upstream source file ${s.file} does not match its recorded git blob hash`);
  }

  const normalizedBytes = readBytes(path.join(dir, provenance.normalized.file), 'the converted rules');
  if (sha256Hex(normalizedBytes) !== provenance.normalized.sha256) throw new RulesetError('the converted rules do not match their recorded hash (the file was changed after the conversion)');

  let parsed: { kind?: string } | null;
  try {
    parsed = JSON.parse(normalizedBytes.toString('utf-8')) as { kind?: string } | null;
  } catch {
    throw new RulesetError('ruleset.json is not valid JSON');
  }

  try {
    if (parsed?.kind === 'pii') {
      const file = checkPiiShape(parsed as Partial<PiiRulesetFile>, provenance.name, provenance.version);
      return {
        kind: 'pii',
        name: file.name,
        version: file.version,
        dir,
        provenance,
        rules: [],
        globalAllowlist: null,
        pii: file.rules.map((r) => ({ id: r.id, entity: r.entity, regex: compilePattern(r.pattern), score: r.score ?? null })),
      };
    }
    const file = checkSecretsShape(parsed as Partial<RulesetFile> | null, provenance.name, provenance.version);
    return {
      kind: 'secrets',
      name: file.name,
      version: file.version,
      dir,
      provenance,
      rules: file.rules.map((r) => ({
        id: r.id,
        regex: compilePattern(r.pattern),
        keywords: r.keywords,
        entropy: r.entropy,
        secretGroup: r.secretGroup,
        allowlists: r.allowlists.map(compileAllowlist),
      })),
      globalAllowlist: file.globalAllowlist ? compileAllowlist(file.globalAllowlist) : null,
      pii: [],
    };
  } catch (err) {
    if (err instanceof RulesetError) throw err;
    throw new RulesetError(`a rule does not compile (${err instanceof Error ? err.message : String(err)})`);
  }
}

export async function loadRuleset(dir: string): Promise<LoadedRuleset> {
  return loadRulesetSync(dir);
}

export interface LoadResult {
  loaded: LoadedRuleset[];
  /** Rule sets that are present but failed a check. Reported, never dropped silently. */
  failed: Array<{ name: string; error: string }>;
}

/** Load every rule set folder under `root` (a folder with a PROVENANCE.json). A missing root is an empty result. */
export function loadRulesetsSync(root: string = defaultRulesetsDir()): LoadResult {
  const result: LoadResult = { loaded: [], failed: [] };
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return result;
  }
  for (const name of names) {
    const dir = path.join(root, name);
    if (!existsSync(path.join(dir, 'PROVENANCE.json'))) continue; // not a rule set folder
    try {
      result.loaded.push(loadRulesetSync(dir));
    } catch (err) {
      result.failed.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

export async function loadRulesets(root: string = defaultRulesetsDir()): Promise<LoadResult> {
  return loadRulesetsSync(root);
}

// ---- running the secret rules

/** Shannon entropy in bits per character. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = [...text].length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

const MAX_TEXT_CHARS = 2_000_000;
const MAX_MATCHES_PER_RULE = 1000;

function lineAround(text: string, start: number, end: number): string {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const to = text.indexOf('\n', end);
  return text.slice(from, to < 0 ? text.length : to);
}

function allowed(a: CompiledAllowlist, match: string, secret: string, line: string): boolean {
  const target = a.target === 'match' ? match : a.target === 'line' ? line : secret;
  const byRegex = a.regexes.length > 0 ? a.regexes.some((r) => ((r.lastIndex = 0), r.test(target))) : null;
  const lowerSecret = secret.toLowerCase();
  const byStop = a.stopwords.length > 0 ? a.stopwords.some((w) => lowerSecret.includes(w)) : null;
  if (a.condition === 'AND') return (byRegex ?? true) && (byStop ?? true) && (byRegex !== null || byStop !== null);
  return byRegex === true || byStop === true;
}

export interface ScanResult {
  findings: SecretFinding[];
  /** True when the text was longer than the scan limit and only its start was checked. */
  truncated: boolean;
}

/**
 * Where the rule sets find secrets in `text`: rule set, rule, offset and length of the secret. The value is never
 * copied out. A rule runs only when the text holds one of its keywords; the secret must reach the rule's entropy and
 * must not be allowed by an allowlist. Only the secrets sets are used.
 */
export function scanSecrets(text: string, sets: LoadedRuleset[], options: { maxChars?: number } = {}): ScanResult {
  const limit = options.maxChars ?? MAX_TEXT_CHARS;
  const truncated = text.length > limit;
  const body = truncated ? text.slice(0, limit) : text;
  const lowered = body.toLowerCase();
  const findings: SecretFinding[] = [];

  for (const set of sets) {
    if (set.kind !== 'secrets') continue;
    for (const rule of set.rules) {
      if (rule.keywords.length > 0 && !rule.keywords.some((k) => lowered.includes(k))) continue;
      let count = 0;
      for (const m of body.matchAll(rule.regex)) {
        if (++count > MAX_MATCHES_PER_RULE) break;
        const indices = (m as RegExpMatchArray & { indices?: Array<[number, number] | undefined> }).indices;
        const whole: [number, number] = [m.index ?? 0, (m.index ?? 0) + m[0].length];
        let span = whole;
        const group = rule.secretGroup ?? (m.length > 1 ? 1 : null);
        if (group !== null && indices?.[group]) span = indices[group] as [number, number];
        const secret = body.slice(span[0], span[1]);
        if (rule.entropy !== null && shannonEntropy(secret) < rule.entropy) continue;
        const line = lineAround(body, whole[0], whole[1]);
        const lists = [...rule.allowlists, ...(set.globalAllowlist ? [set.globalAllowlist] : [])];
        if (lists.some((a) => allowed(a, m[0], secret, line))) continue;
        findings.push({ ruleset: set.name, rule: rule.id, offset: span[0], length: span[1] - span[0] });
      }
    }
  }
  return { findings: findings.sort((a, b) => a.offset - b.offset), truncated };
}
