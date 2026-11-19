// Convert a downloaded gitleaks configuration into the colony's rule set format and write the provenance record.
// No network: it reads the files that are already in the rule set folder (see docs/RULESETS-PLAN.md).
//
//   node scripts/rulesets-convert.mjs --dir rulesets/gitleaks --name gitleaks --version v8.30.1 --commit <sha> \
//        --source-url <url> --license MIT --retrieved 2026-11-19
//
// The folder must hold the upstream source (source/gitleaks.toml) and its license (LICENSE), unmodified.
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mod = (name) => import(pathToFileURL(join(root, 'dist', 'rulesets', name)).href);
const { convertGitleaks } = await mod('convert-gitleaks.js');
const { sha256Hex, gitBlobSha1 } = await mod('loader.js');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const need = (name) => {
  const v = opt(name);
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

const sourceFile = 'source/gitleaks.toml';
const source = readFileSync(join(dir, sourceFile));
const licenseBytes = readFileSync(join(dir, 'LICENSE'));

const { ruleset, report } = convertGitleaks(source.toString('utf-8'), { name, version });
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
  source: { file: sourceFile, sha256: sha256Hex(source), gitBlobSha1: gitBlobSha1(source), bytes: source.length },
  normalized: { file: 'ruleset.json', sha256: sha256Hex(Buffer.from(normalized, 'utf-8')) },
  converter: 'colony rulesets converter 1 (gitleaks)',
  retrievedAt: retrieved,
  report,
};
writeFileSync(join(dir, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n', 'utf-8');

console.log(JSON.stringify({ name, version, total: report.total, converted: report.converted, skipped: report.skipped.length, dropped: report.dropped }, null, 2));
