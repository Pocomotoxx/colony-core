// Convert the downloaded presidio recognizer files into the colony's personal data rule set and write the provenance record.
// No network: it reads the files that are already in the rule set folder (see docs/RULESETS-PLAN.md).
//
//   node scripts/rulesets-convert-presidio.mjs --dir rulesets/presidio --name presidio --version 2.2.366 --commit <sha> \
//        --source-url <url> --license MIT --retrieved 2026-11-19
//
// The folder must hold the upstream files in source/ (ip_recognizer.py, mac_recognizer.py, credit_card_recognizer.py,
// iban_patterns.py) and the license (LICENSE), unmodified.
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mod = (name) => import(pathToFileURL(join(root, 'dist', 'rulesets', name)).href);
const { convertPresidio, PRESIDIO_FILES, IBAN_FILE } = await mod('convert-presidio.js');
const { sha256Hex, gitBlobSha1 } = await mod('loader.js');

const args = process.argv.slice(2);
const need = (name) => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  if (!v) {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return v;
};

const dir = resolve(need('dir'));
const name = need('name');
const version = need('version');
const commit = need('commit');
const sourceUrl = need('source-url');
const license = need('license');
const retrieved = need('retrieved');

const fileNames = [...Object.keys(PRESIDIO_FILES), IBAN_FILE].sort();
const bytes = Object.fromEntries(fileNames.map((f) => [f, readFileSync(join(dir, 'source', f))]));
const licenseBytes = readFileSync(join(dir, 'LICENSE'));

const { ruleset, report } = convertPresidio(Object.fromEntries(fileNames.map((f) => [f, bytes[f].toString('utf-8')])), { name, version });
const normalized = JSON.stringify(ruleset, null, 2) + '\n';
writeFileSync(join(dir, 'ruleset.json'), normalized, 'utf-8');

const provenance = {
  format: 1,
  name,
  version,
  commit,
  sourceUrl,
  license,
  licenseFile: { file: 'LICENSE', sha256: sha256Hex(licenseBytes) },
  sources: fileNames.map((f) => ({ file: `source/${f}`, sha256: sha256Hex(bytes[f]), gitBlobSha1: gitBlobSha1(bytes[f]), bytes: bytes[f].length })),
  normalized: { file: 'ruleset.json', sha256: sha256Hex(Buffer.from(normalized, 'utf-8')) },
  converter: 'colony rulesets converter 1 (presidio patterns)',
  retrievedAt: retrieved,
  report,
};
writeFileSync(join(dir, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n', 'utf-8');

console.log(JSON.stringify({ name, version, total: report.total, converted: report.converted, skipped: report.skipped }, null, 2));
