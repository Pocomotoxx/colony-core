#!/usr/bin/env node
// Measure the colony's LOCAL scan on labelled sets of invented texts. No network, no key.
//
//   node scripts/scan-eval.mjs eval/guard-set.json eval/guard-set-2.json
//
// Each set: { "items": [ { "id", "label": "benign" | "attack", "text" } ] }. For every set it prints how many attacks the
// scan calls hostile or suspicious, how many benign texts it flags, and which ones. It needs the build (dist/).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scanFile = join(root, 'dist', 'injection-scan.js');
if (!existsSync(scanFile)) {
  console.error('dist/ is missing: run `pnpm install && pnpm build` first.');
  process.exit(1);
}
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/scan-eval.mjs <set.json> [<set.json> ...]');
  process.exit(2);
}
const { scanText } = await import(pathToFileURL(scanFile).href);
const rate = (n, d) => (d === 0 ? null : Number((n / d).toFixed(3)));

const out = {};
for (const file of files) {
  const text = readFileSync(resolve(file), 'utf-8');
  const set = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const rows = set.items.map((it) => {
    const r = scanText(it.text);
    return { id: it.id, label: it.label, verdict: r.verdict, threats: r.threats.map((t) => `${t.type}/${t.severity}`) };
  });
  const attack = rows.filter((r) => r.label === 'attack');
  const benign = rows.filter((r) => r.label === 'benign');
  const hostile = (r) => r.verdict === 'hostile';
  const flagged = (r) => r.verdict !== 'clean';
  out[file] = {
    attacks: attack.length,
    benign: benign.length,
    hostileOnAttacks: rate(attack.filter(hostile).length, attack.length),
    flaggedOnAttacks: rate(attack.filter(flagged).length, attack.length),
    hostileOnBenign: rate(benign.filter(hostile).length, benign.length),
    flaggedOnBenign: rate(benign.filter(flagged).length, benign.length),
    missedAttacks: attack.filter((r) => !flagged(r)).map((r) => r.id),
    attacksOnlySuspicious: attack.filter((r) => r.verdict === 'suspicious').map((r) => r.id),
    benignHostile: benign.filter(hostile).map((r) => r.id),
    benignSuspicious: benign.filter((r) => r.verdict === 'suspicious').map((r) => r.id),
  };
}
console.log(JSON.stringify(out, null, 2));
