// Take the process creation rules (Linux by default, Windows with --platform windows) out of a Sigma release package, keep them as they are, convert them into the
// colony's command rule format and write the provenance record (see docs/RULESETS-PLAN.md, section 7/a).
// No network: it reads a package that was downloaded already, and refuses it unless its SHA-256 is the digest you give
// (the one the GitHub releases API reports for the asset).
//
//   node scripts/rulesets-convert-sigma.mjs --archive <sigma_core.zip> --dir rulesets/sigma --version r2026-07-01 \
//        --commit <sha> --digest sha256:<hex> --url <asset url> --retrieved 2026-11-19
// Optional: --name <set name, default sigma> --platform <linux|windows> --category <process_creation|ps_script> --include <folder in the package> --asset <file name>
//
// The folder must hold NOTICE (written by the colony: the rules are under the Detection Rule License 1.1).
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mod = (name) => import(pathToFileURL(join(root, 'dist', 'rulesets', name)).href);
const { convertSigma } = await mod('convert-sigma.js');
const { readZip } = await mod('zip-lite.js');
const { sha256Hex } = await mod('loader.js');

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

const archivePath = resolve(need('archive'));
const dir = resolve(need('dir'));
const version = need('version');
const commit = need('commit');
const digest = need('digest');
const url = need('url');
const retrieved = need('retrieved');
const optional = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const platform = optional('platform') ?? 'linux';
if (platform !== 'linux' && platform !== 'windows') {
  console.error('--platform must be linux or windows');
  process.exit(2);
}
const setName = optional('name') ?? 'sigma';
const assetName = optional('asset') ?? 'sigma_core.zip';
const category = optional('category') ?? 'process_creation';
if (category !== 'process_creation' && category !== 'ps_script') {
  console.error('--category must be process_creation or ps_script');
  process.exit(2);
}
const PREFIX = optional('include') ?? (category === 'ps_script' ? 'rules/windows/powershell/powershell_script/' : `rules/${platform}/process_creation/`);

const archive = readFileSync(archivePath);
if (digest !== `sha256:${sha256Hex(archive)}`) {
  console.error(`the archive's SHA-256 is sha256:${sha256Hex(archive)}, not the digest you gave (${digest}). Nothing was changed.`);
  process.exit(1);
}

const picked = readZip(archive)
  .filter((e) => e.name.startsWith(PREFIX) && /\.ya?ml$/.test(e.name))
  .sort((a, b) => a.name.localeCompare(b.name));
if (picked.length === 0) {
  console.error(`the archive has no ${PREFIX} rules. Nothing was changed.`);
  process.exit(1);
}

rmSync(join(dir, 'source'), { recursive: true, force: true });
const sources = [];
const texts = {};
for (const e of picked) {
  const bytes = e.data();
  const target = join(dir, 'source', e.name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  sources.push({ file: `source/${e.name}`, sha256: sha256Hex(bytes), bytes: bytes.length });
  texts[e.name] = bytes.toString('utf-8');
}

const { ruleset, report } = convertSigma(texts, { name: setName, version, repoUrl: `https://github.com/SigmaHQ/sigma/blob/${version}`, platform, category });
const normalized = JSON.stringify(ruleset, null, 2) + '\n';
writeFileSync(join(dir, 'ruleset.json'), normalized, 'utf-8');

const provenance = {
  format: 1,
  name: setName,
  version,
  commit,
  sourceUrl: `https://github.com/SigmaHQ/sigma/releases/tag/${version}`,
  license: 'DRL-1.1',
  licenseFile: { file: 'NOTICE', sha256: sha256Hex(readFileSync(join(dir, 'NOTICE'))) },
  archive: { name: assetName, sha256: sha256Hex(archive), bytes: archive.length, url, digest },
  sources,
  normalized: { file: 'ruleset.json', sha256: sha256Hex(Buffer.from(normalized, 'utf-8')) },
  converter: `colony rulesets converter 1 (sigma ${platform} ${category})`,
  retrievedAt: retrieved,
  report,
};
writeFileSync(join(dir, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n', 'utf-8');

console.log(JSON.stringify({ version, files: sources.length, total: report.total, converted: report.converted, skipped: report.skipped }, null, 2));
