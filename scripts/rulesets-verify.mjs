// Check every vendored rule set against its provenance record (hashes of the license, the upstream source and the converted
// rules) and print what each one is. Exit code 1 when any set fails: a set that fails is not used by the colony.
//
//   node scripts/rulesets-verify.mjs
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { loadRulesets } = await import(pathToFileURL(join(root, 'dist', 'rulesets', 'loader.js')).href);

const { loaded, failed } = await loadRulesets();
for (const s of loaded) {
  const p = s.provenance;
  const count = s.kind === 'pii' ? s.pii.length : s.kind === 'commands' ? s.commands.length : s.rules.length;
  console.log(`ok      ${s.name} ${s.version}  ${s.kind}  ${count} rules (${p.report.skipped.length} skipped of ${p.report.total})  license ${p.license}  commit ${p.commit.slice(0, 10)}  retrieved ${p.retrievedAt}`);
  for (const sk of p.report.skipped) console.log(`          skipped ${sk.id}: ${sk.reason}`);
}
for (const f of failed) console.log(`FAILED  ${f.name}: ${f.error}`);
if (loaded.length + failed.length === 0) console.log('no rule sets found');
process.exitCode = failed.length > 0 ? 1 : 0;
