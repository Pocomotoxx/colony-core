// Compare what the colony's own secret patterns and the vendored rule sets find in a set of files, before anything
// is switched over (see docs/RULESETS-PLAN.md, section 6). Read-only. It prints positions and rule names, never values.
//
//   node scripts/rulesets-measure.mjs [--max-list 60] <file-or-folder>...
//   node scripts/rulesets-measure.mjs --log .colony/ruleset-warnings.jsonl     (what the guard's warnings have been so far)
//   node scripts/rulesets-measure.mjs --pii [--max-list 60] <file-or-folder>...  (personal data: the presidio set against the own patterns)
//   node scripts/rulesets-measure.mjs --commands [--max-list 60] [--all-code] [--ratings <file.json>] [--sample-out <file.json>] <file-or-folder>...
//        (command rules: which of the commands in these files do they match; --all-code also judges the lines of code blocks that are not labelled as a shell;
//         --ratings is [{file, line, rule, verdict: 'false-positive'|'true-positive'}], what a person decided about earlier matches;
//         --sample-out writes the commands that were judged, so that the same sample can be judged again)
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
let commandsMode = false;
let allCode = false;
let ratingsFile;
let sampleOut;
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max-list') maxList = Number(args[++i]);
  else if (args[i] === '--log') logFile = args[++i];
  else if (args[i] === '--pii') piiMode = true;
  else if (args[i] === '--commands') commandsMode = true;
  else if (args[i] === '--all-code') allCode = true;
  else if (args[i] === '--ratings') ratingsFile = args[++i];
  else if (args[i] === '--sample-out') sampleOut = args[++i];
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

/** What each mode of this script measures. Quote it with the numbers: a number without it cannot be compared with another. */
const MEASUREMENT = {
  pii: 'pii-compare v2: baseline = the built-in patterns only; a finding is "same" when kind and exact characters agree',
  commands: 'commands v2: only commands (lines of fenced blocks labelled as a shell, run: lines of workflows, scripts of package.json); other code lines are counted apart; the sample is identified by a hash',
};

if (commandsMode) {
  // The commands that the files contain, judged by the command rule sets. A command is: a line of a fenced Markdown block that is
  // labelled as a shell (sh, bash, powershell, console, ...), a run: line of a workflow, a script of package.json. The lines of
  // other code blocks (no label, text, json, diagrams) are NOT commands: they are counted apart (--all-code judges them too).
  // For a set of files that are known to hold ordinary commands, a match is a false positive, but only a person can say so:
  // the matches that nobody rated (--ratings) are counted as unrated, never as false or true.
  const { eventsOf, windowsEventsOf, scriptEventsOf } = await mod('rulesets/command-gate.js');
  const { registryEventsOf } = await mod('rulesets/registry-events.js');
  const { fileEventsOf } = await mod('rulesets/file-events.js');
  const { ruleMatches } = await mod('rulesets/sigma.js');
  const { createHash } = await import('node:crypto');
  const { writeFileSync } = await import('node:fs');
  const sets = loaded.filter((s) => s.kind === 'commands');
  const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'zsh', 'console', 'shell-session', 'sh-session', 'powershell', 'pwsh', 'ps1', 'posh', 'cmd', 'bat', 'batch']);
  const commands = [];
  let otherCodeLines = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf-8');
    const rel = relative(root, file).replace(/\\/g, '/');
    const ext = extname(file).toLowerCase();
    const lines = text.split(/\r?\n/); // a Windows checkout has CRLF: a trailing CR would hide the run: lines of a workflow
    if (ext === '.md') {
      let inside = false;
      let shell = false;
      lines.forEach((l, n) => {
        const fence = /^\s*```\s*([^\s{]*)/.exec(l);
        if (fence) {
          inside = !inside;
          shell = inside && SHELL_LANGS.has(fence[1].toLowerCase());
        } else if (inside && l.trim() && !l.trim().startsWith('#')) {
          const text1 = l.trim().replace(/^(?:\$|PS>|>) /, '');
          if (shell) commands.push({ file: rel, line: n + 1, text: text1, source: 'md-shell' });
          else if (allCode) commands.push({ file: rel, line: n + 1, text: text1, source: 'md-other' });
          else otherCodeLines++;
        }
      });
    } else if (ext === '.yml' || ext === '.yaml') {
      lines.forEach((l, n) => {
        const m = /^\s*(?:- )?run:\s*(.+)$/.exec(l);
        if (m && m[1] !== '|') commands.push({ file: rel, line: n + 1, text: m[1].trim(), source: 'workflow' });
      });
    } else if (file.endsWith('package.json')) {
      for (const [name, value] of Object.entries(JSON.parse(text).scripts ?? {})) commands.push({ file: rel, line: 0, text: String(value), name, source: 'package-script' });
    }
  }
  const ratings = new Map();
  if (ratingsFile) for (const r of JSON.parse(readFileSync(resolve(ratingsFile), 'utf-8'))) ratings.set(`${r.file}:${r.line}:${r.rule}`, r.verdict);
  const built = { process: 0, script: 0, registry: 0, file: 0 };
  const byRule = {};
  const hits = [];
  for (const c of commands) {
    const linuxEvents = eventsOf(c.text, root);
    const windowsEvents = windowsEventsOf(c.text, root, 'PowerShell');
    const scriptEvents = scriptEventsOf(c.text, 'PowerShell');
    const registryEvents = registryEventsOf(c.text);
    const fileEvents = fileEventsOf(c.text, process.cwd());
    if (linuxEvents.length + windowsEvents.length > 0) built.process++;
    if (scriptEvents.length > 0) built.script++;
    if (registryEvents.length > 0) built.registry++;
    if (fileEvents.length > 0) built.file++;
    for (const set of sets) {
      const events = set.category === 'file' ? fileEvents : set.category === 'registry' ? registryEvents : set.category === 'ps_script' ? scriptEvents : set.platform === 'windows' ? windowsEvents : linuxEvents;
      for (const rule of set.commands) {
        if (events.some((e) => ruleMatches(rule, e))) {
          byRule[rule.title] = (byRule[rule.title] ?? 0) + 1;
          hits.push({ ...c, title: rule.title, verdict: ratings.get(`${c.file}:${c.line}:${rule.title}`) ?? 'unrated' });
        }
      }
    }
  }
  const sorted = [...commands].sort((x, y) => (x.file + ':' + String(x.line).padStart(6, '0') + x.text).localeCompare(y.file + ':' + String(y.line).padStart(6, '0') + y.text));
  const sampleId = createHash('sha256').update(JSON.stringify(sorted.map((c) => [c.file, c.line, c.text]))).digest('hex').slice(0, 12);
  if (sampleOut) writeFileSync(resolve(sampleOut), JSON.stringify(sorted, null, 1));
  const verdicts = { 'false-positive': 0, 'true-positive': 0, unrated: 0 };
  for (const h of hits) verdicts[h.verdict] = (verdicts[h.verdict] ?? 0) + 1;
  console.log(JSON.stringify({
    measurement: MEASUREMENT.commands,
    sample: { id: sampleId, files: files.length, commands: commands.length, bySource: commands.reduce((o, c) => ({ ...o, [c.source]: (o[c.source] ?? 0) + 1 }), {}), otherCodeLinesNotJudged: otherCodeLines },
    commandsForWhichAnEventWasBuilt: built,
    ruleSets: sets.map((s) => `${s.name} ${s.version} (${s.commands.length} rules)`),
    commandsWithAMatch: new Set(hits.map((h) => h.file + ':' + h.line + ':' + h.text)).size,
    matches: { total: hits.length, ...verdicts },
    byRule,
  }, null, 2));
  console.log(`\nmatches (${hits.length}${hits.length > maxList ? `, first ${maxList}` : ''}):`);
  for (const h of hits.slice(0, maxList)) console.log(`  ${h.file}:${h.line}  [${h.title}] (${h.source}, ${h.verdict})  ${h.text.slice(0, 110)}`);
  process.exit(0);
}

if (piiMode) {
  // Personal data: what the presidio set finds, and whether the colony's OWN built-in patterns find the same thing.
  // The baseline is fixed: the built-in patterns only (redactText with builtinOnly), never the redactor with the rule sets,
  // so adding or updating a rule set cannot change the baseline. A finding is compared with the baseline's spans of the SAME
  // text by position: "same" = the same kind on exactly the same characters, "partly" = the baseline finds something that
  // overlaps it (another kind or other bounds), "none" = the baseline finds nothing there. Positions and rule names are
  // printed, never values.
  const { findPii } = await mod('rulesets/pii.js');
  const { findRedactSpans } = await mod('redact.js');
  const rows = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf-8');
    const rel = relative(root, file).replace(/\\/g, '/');
    const own = findRedactSpans(text, { builtinOnly: true });
    for (const f of findPii(text, loaded).findings) {
      const end = f.offset + f.length;
      const same = own.some((s) => s.kind === f.entity && s.start === f.offset && s.end === end);
      const overlap = !same && own.some((s) => s.start < end && f.offset < s.end);
      rows.push({ file: rel, line: lineOf(text, f.offset), entity: f.entity, rule: f.rule, match: same ? 'same' : overlap ? 'partly' : 'none' });
    }
  }
  const entities = {};
  for (const r of rows) {
    const e = (entities[r.entity] ??= { findings: 0, sameByBuiltin: 0, partlyByBuiltin: 0, onlyByRuleSet: 0 });
    e.findings++;
    if (r.match === 'same') e.sameByBuiltin++;
    else if (r.match === 'partly') e.partlyByBuiltin++;
    else e.onlyByRuleSet++;
  }
  console.log(JSON.stringify({ measurement: MEASUREMENT.pii, files: files.length, ruleSets: loaded.map((s) => `${s.name} ${s.version} (${s.kind})`), byEntity: entities }, null, 2));
  const only = rows.filter((r) => r.match !== 'same');
  console.log(`\nnot found by the built-in patterns on the same characters (${only.length}${only.length > maxList ? `, first ${maxList}` : ''}):`);
  for (const r of only.slice(0, maxList)) console.log(`  ${r.file}:${r.line}  ${r.entity}  ${r.rule}  [${r.match}]`);
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
