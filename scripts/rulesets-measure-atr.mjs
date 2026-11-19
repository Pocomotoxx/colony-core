// Measure the ATR (Agent Threat Rules) prompt-injection rules against the colony's own injection scanner, before anything
// is adopted (see docs/RULESETS-PLAN.md, section 6/f). Read-only, no network: you give it a folder of ATR rule files that you
// downloaded yourself.
//
//   node scripts/rulesets-measure-atr.mjs --rules <folder of ATR .yaml rules> [--guard eval/guard-set.json ...] [--corpus]
//
// What it prints (JSON):
//   - how many rules were evaluated, and why the others were not (semantic tier, unreadable, unsupported syntax);
//   - a self test: the rules' own labelled cases (true positives and true negatives) must come out as they say. This checks the
//     evaluator below, not the rules: a disagreement means this script reads a rule differently from the project;
//   - for each guard set: attacks caught and benign texts flagged, by the own scanner and by the ATR rules (all rules or only
//     the ones whose maturity is "stable"; all fields or only the fields that carry external content);
//   - with --corpus: the own scanner on ATR's labelled cases, and the attack styles it misses most.
//
// How a rule is read (ATR spec 3.5): detection.conditions is a list of {field, operator: regex, value}; condition is "any" or
// "all". The rules' own tests only come out right when the regular expressions are matched case-insensitively, so that is
// done by default (an inline (?i) is read too). Rules of the "semantic" tier and the expression form are not evaluated.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mod = (name) => import(pathToFileURL(join(root, 'dist', name)).href);
const { parseYaml } = await mod('rulesets/yaml-lite.js');
const { scanText } = await mod('injection-scan.js');

const args = process.argv.slice(2);
const rulesDir = args[args.indexOf('--rules') + 1];
if (args.indexOf('--rules') < 0 || !rulesDir) {
  console.error('usage: node scripts/rulesets-measure-atr.mjs --rules <folder> [--guard <set.json> ...] [--corpus]');
  process.exit(2);
}
const guards = args.flatMap((a, i) => (a === '--guard' ? [args[i + 1]] : []));
const corpusMode = args.includes('--corpus');
const EXTERNAL = new Set(['content', 'tool_response', 'tool_description']);

// ---- load and compile

const notEvaluated = {};
const note = (why, id) => (notEvaluated[why] ??= []).push(id);
const rules = [];
for (const f of readdirSync(resolve(rulesDir)).filter((n) => /\.ya?ml$/.test(n)).sort()) {
  let doc;
  try {
    doc = parseYaml(readFileSync(join(resolve(rulesDir), f), 'utf-8'));
  } catch (e) {
    note('the file could not be read: ' + String(e.message).replace(/^line \d+: /, '').slice(0, 70), f);
    continue;
  }
  const id = doc?.id ?? f;
  if (doc?.detection_tier !== 'pattern') { note(`detection tier ${doc?.detection_tier}`, id); continue; }
  const det = doc.detection;
  if (!det || !Array.isArray(det.conditions) || (det.condition !== 'any' && det.condition !== 'all')) { note('a condition form that is not evaluated', id); continue; }
  const conds = [];
  let why = null;
  for (const c of det.conditions) {
    if (c.operator !== 'regex' || typeof c.value !== 'string') { why = `operator ${c.operator}`; break; }
    let src = c.value;
    const flags = new Set(['i']);
    for (let m = /^\(\?([a-z]+)\)/.exec(src); m; m = /^\(\?([a-z]+)\)/.exec(src)) {
      for (const ch of m[1]) {
        if (ch === 'i' || ch === 's' || ch === 'm') flags.add(ch);
        else why = `the flag ${ch}`;
      }
      src = src.slice(m[0].length);
    }
    if (why) break;
    if (/\(\?[a-z-]+[:)]/.test(src) || /\\[AZz]/.test(src) || /\(\?>/.test(src) || /\(\?P</.test(src) || /[*+?}]\+/.test(src)) { why = 'regex syntax that JavaScript reads differently'; break; }
    try {
      conds.push({ field: c.field, re: new RegExp(src, [...flags].join('') + (/\\p\{|\\u\{|[\u{10000}-\u{10FFFF}]/u.test(src) ? 'u' : '')) });
    } catch (e) {
      why = 'does not compile: ' + String(e.message).slice(0, 50);
      break;
    }
  }
  if (why) { note(why, id); continue; }
  rules.push({ id, title: doc.title, maturity: doc.maturity, mode: det.condition, conds, tests: doc.test_cases ?? {} });
}

function matches(rule, text, fields) {
  const conds = fields ? rule.conds.filter((c) => fields.has(c.field)) : rule.conds;
  if (conds.length === 0) return false;
  const hit = (c) => ((c.re.lastIndex = 0), c.re.test(text));
  // an "all" rule cannot be judged when some of its conditions are on other fields
  return rule.mode === 'all' ? conds.length === rule.conds.length && conds.every(hit) : conds.some(hit);
}

// ---- self test

let tpTotal = 0, tpHit = 0, tnTotal = 0, tnClean = 0;
const disagreements = [];
for (const r of rules) {
  for (const t of r.tests.true_positives ?? []) {
    if (typeof t.input !== 'string' || t.expected !== 'triggered') continue;
    tpTotal++;
    if (matches(r, t.input, null)) tpHit++;
    else disagreements.push(`${r.id}: a true positive is not matched`);
  }
  for (const t of r.tests.true_negatives ?? []) {
    if (typeof t.input !== 'string' || t.expected !== 'not_triggered') continue;
    tnTotal++;
    if (!matches(r, t.input, null)) tnClean++;
    else disagreements.push(`${r.id}: a true negative is matched`);
  }
}

// ---- the guard sets

const guardResults = guards.map((file) => {
  const set = JSON.parse(readFileSync(resolve(file), 'utf-8'));
  const items = set.items ?? set;
  const rows = items.map((it) => {
    const own = scanText(it.text).verdict;
    const hit = (pred, fields) => rules.filter((r) => pred(r) && matches(r, it.text, fields)).map((r) => r.id);
    return { id: it.id, label: it.label, own, all: hit(() => true, null), stable: hit((r) => r.maturity === 'stable', null), external: hit(() => true, EXTERNAL), externalStable: hit((r) => r.maturity === 'stable', EXTERNAL) };
  });
  const attacks = rows.filter((r) => r.label === 'attack');
  const benign = rows.filter((r) => r.label === 'benign');
  const rate = (list, f) => `${list.filter(f).length}/${list.length}`;
  const line = (f) => ({ attacksCaught: rate(attacks, f), benignFlagged: rate(benign, f) });
  return {
    file,
    items: items.length,
    ownHostile: line((r) => r.own === 'hostile'),
    ownHostileOrSuspicious: line((r) => r.own !== 'clean'),
    atrAllRulesAllFields: line((r) => r.all.length > 0),
    atrAllRulesExternalFields: line((r) => r.external.length > 0),
    atrStableRules: line((r) => r.stable.length > 0),
    atrStableRulesExternalFields: line((r) => r.externalStable.length > 0),
    ownOrAtr: line((r) => r.own !== 'clean' || r.all.length > 0),
    benignFlaggedByAtr: benign.filter((r) => r.all.length > 0).map((r) => ({ item: r.id, rules: r.all.slice(0, 5) })),
  };
});

// ---- the labelled cases of the rules, as a corpus for the own scanner

let corpus;
if (corpusMode) {
  const seen = new Set();
  const attacks = [];
  const benign = [];
  for (const r of rules) {
    for (const t of r.tests.true_positives ?? []) if (typeof t.input === 'string' && t.expected === 'triggered' && !seen.has(t.input)) { seen.add(t.input); attacks.push({ title: r.title, text: t.input }); }
    for (const t of r.tests.true_negatives ?? []) if (typeof t.input === 'string' && t.expected === 'not_triggered' && !seen.has(t.input)) { seen.add(t.input); benign.push({ title: r.title, text: t.input }); }
  }
  const judge = (list) => list.map((s) => ({ ...s, verdict: scanText(s.text.slice(0, 20000)).verdict }));
  const a = judge(attacks);
  const b = judge(benign);
  const count = (list, v) => list.filter((x) => x.verdict === v).length;
  const missed = {};
  const totals = {};
  for (const x of a) {
    totals[x.title] = (totals[x.title] ?? 0) + 1;
    if (x.verdict === 'clean') missed[x.title] = (missed[x.title] ?? 0) + 1;
  }
  corpus = {
    note: 'The cases are the rules\' own: the attacks favour what the ATR rules catch, and a "benign" case is benign for ITS rule only (it may be an attack for another), so the benign figures are an upper bound on false positives, not a rate.',
    attacks: { samples: a.length, hostile: count(a, 'hostile'), suspicious: count(a, 'suspicious'), missed: count(a, 'clean') },
    benign: { samples: b.length, hostile: count(b, 'hostile'), suspicious: count(b, 'suspicious'), clean: count(b, 'clean') },
    stylesMissedMost: Object.entries(missed).sort((p, q) => q[1] - p[1]).slice(0, 12).map(([title, n]) => `${n}/${totals[title]} ${title}`),
  };
}

console.log(
  JSON.stringify(
    {
      rulesFolder: rulesDir,
      evaluated: rules.length,
      evaluatedByMaturity: rules.reduce((o, r) => ((o[r.maturity] = (o[r.maturity] ?? 0) + 1), o), {}),
      notEvaluated: Object.fromEntries(Object.entries(notEvaluated).map(([k, v]) => [k, v.length])),
      selfTest: { truePositivesMatched: `${tpHit}/${tpTotal}`, trueNegativesClean: `${tnClean}/${tnTotal}`, disagreements: disagreements.slice(0, 10) },
      guardSets: guardResults,
      ...(corpus ? { corpus } : {}),
    },
    null,
    2,
  ),
);
