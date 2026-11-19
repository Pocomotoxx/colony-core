// Compare what the colony's own secret patterns and the vendored rule sets find in a set of files, before anything
// is switched over (see docs/RULESETS-PLAN.md, section 6). Read-only. It prints positions and rule names, never values.
//
//   node scripts/rulesets-measure.mjs [--max-list 60] <file-or-folder>...
//   node scripts/rulesets-measure.mjs --log .colony/ruleset-warnings.jsonl     (what the guard's warnings have been so far)
//   node scripts/rulesets-measure.mjs --pii [--max-list 60] <file-or-folder>...  (personal data: the presidio set against the own patterns)
//
// Folders are walked for text files (node_modules, .git, dist and rulesets are skipped, files over 1 MB are skipped).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mod = (name) => import(pathToFileURL(join(root, 'dist', name)).href);
const { findSecretSpans } = await mod('gates.js');
const { loadRulesets, scanSecrets } = await mod('rulesets/loader.js');

const args = process.argv.slice(2);
let maxList = 60;
let logFile;
let piiMode = false;
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max-list') maxList = Number(args[++i]);
  else if (args[i] === '--log') logFile = args[++i];
  else if (args[i] === '--pii') piiMode = true;
  else targets.push(args[i]);
}

if (logFile) {
  // the warnings the guard recorded (rule names and counts, no values): how often each rule fired, and in which tool
  const rows = readFileSync(resolve(logFile), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const byRule = {};
  const byTool = {};
  for (const r of rows) {
    for (const rule of r.rules ?? []) byRule[rule] = (byRule[rule] ?? 0) + 1;
    byTool[r.tool] = (byTool[r.tool] ?? 0) + 1;
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
  console.log(JSON.stringify({ warnings: rows.length, from: rows[0] ? new Date(rows[0].at).toISOString() : null, to: rows.length ? new Date(rows[rows.length - 1].at).toISOString() : null, byRule: sorted(byRule), byTool: sorted(byTool) }, null, 2));
  process.exit(0);
}

if (targets.length === 0) {
  console.error('usage: node scripts/rulesets-measure.mjs [--max-list N] <file-or-folder>... | --log <file>');
  process.exit(2);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'rulesets', 'eval-work', '.claude']);
const TEXT = new Set(['.ts', '.mjs', '.js', '.json', '.md', '.toml', '.yml', '.yaml', '.txt', '.ps1', '.sh', '.html', '.css']);
const files = [];
const walk = (p) => {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) if (!SKIP_DIRS.has(name)) walk(join(p, name));
  } else if (st.isFile() && st.size <= 1_000_000 && (TEXT.has(extname(p).toLowerCase()) || targets.includes(p))) files.push(p);
};
for (const t of targets) walk(resolve(t));

const { loaded, failed } = await loadRulesets();
if (failed.length > 0) console.error('rule sets that FAILED their checks and are not used:', JSON.stringify(failed));

const lineOf = (text, offset) => text.slice(0, offset).split('\n').length;

if (piiMode) {
  // Personal data: what the presidio set finds, and whether the colony's own redaction would also take that text.
  // A finding is judged by redacting its text on its own; positions and rule names are printed, never values.
  const { findPii } = await mod('rulesets/pii.js');
  const { redactText } = await mod('redact.js');
  const rows = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf-8');
    const rel = relative(root, file).replace(/\\/g, '/');
    for (const f of findPii(text, loaded).findings) {
      const own = redactText(text.slice(f.offset, f.offset + f.length)).changed;
      rows.push({ file: rel, line: lineOf(text, f.offset), entity: f.entity, rule: f.rule, own });
    }
  }
  const entities = {};
  for (const r of rows) {
    const e = (entities[r.entity] ??= { findings: 0, alsoByOwnPatterns: 0, onlyByRuleSet: 0 });
    e.findings++;
    if (r.own) e.alsoByOwnPatterns++;
    else e.onlyByRuleSet++;
  }
  console.log(JSON.stringify({ files: files.length, ruleSets: loaded.map((s) => `${s.name} ${s.version} (${s.kind})`), byEntity: entities }, null, 2));
  const only = rows.filter((r) => !r.own);
  console.log(`\nfound only by the rule set (${only.length}${only.length > maxList ? `, first ${maxList}` : ''}):`);
  for (const r of only.slice(0, maxList)) console.log(`  ${r.file}:${r.line}  ${r.entity}  ${r.rule}`);
  process.exit(0);
}
const perRule = new Map();
const newHits = [];
const oldHits = [];
let bytes = 0;
let truncated = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf-8');
  bytes += text.length;
  const rel = relative(root, file).replace(/\\/g, '/');
  for (const f of findSecretSpans(text)) oldHits.push({ file: rel, line: lineOf(text, f.offset), rule: f.pattern, offset: f.offset, length: f.length });
  const result = scanSecrets(text, loaded);
  if (result.truncated) truncated++;
  for (const f of result.findings) {
    perRule.set(f.rule, (perRule.get(f.rule) ?? 0) + 1);
    newHits.push({ file: rel, line: lineOf(text, f.offset), rule: f.rule, offset: f.offset, length: f.length });
  }
}

// an old finding and a new one that overlap are the same place
const overlaps = (a, b) => a.file === b.file && a.offset < b.offset + b.length && b.offset < a.offset + a.length;
const oldOnly = oldHits.filter((o) => !newHits.some((n) => overlaps(o, n)));
const newOnly = newHits.filter((nw) => !oldHits.some((o) => overlaps(o, nw)));
const both = newHits.length - newOnly.length;

console.log(JSON.stringify({
  files: files.length,
  characters: bytes,
  truncatedFiles: truncated,
  ruleSets: loaded.map((s) => `${s.name} ${s.version} (${s.rules.length} rules)`),
  ownPatterns: { findings: oldHits.length },
  ruleSetFindings: { findings: newHits.length, alsoFoundByOwnPatterns: both, onlyByRuleSets: newOnly.length },
  ownPatternsOnly: oldOnly.length,
  byRule: Object.fromEntries([...perRule.entries()].sort((a, b) => b[1] - a[1])),
}, null, 2));

const show = (title, list) => {
  console.log(`\n${title} (${list.length}${list.length > maxList ? `, first ${maxList}` : ''}):`);
  for (const h of list.slice(0, maxList)) console.log(`  ${h.file}:${h.line}  ${h.rule}`);
};
show('found only by the rule sets', newOnly);
show('found only by the colony\'s own patterns', oldOnly);
