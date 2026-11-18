import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../atomic-write.js';
import { resolveInside, SafePathError } from '../safe-path.js';

/**
 * Where the radar looks (docs/RADAR-PLAN.md): the GitHub repositories of the project's own dependencies. The proposal is
 * made from files that are already on disk (package.json, and the package.json of each installed dependency, where the
 * `repository` field names the repository): no network. The developer approves what goes on the list; nothing is
 * fetched from a repository that was not approved by name.
 */

export const MAX_APPROVED = 20;
const MAX_DEPENDENCIES = 500;
const MAX_FILE_BYTES = 1_000_000;
export const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const SECTIONS = ['dependencies', 'optionalDependencies', 'devDependencies'] as const;

export type RepoResult = { repo: string } | { reason: string };

/** The GitHub repository a package.json `repository` field points to ("owner/repo"), or why it does not. */
export function parseRepositoryField(value: unknown): RepoResult {
  let url: string | undefined;
  if (typeof value === 'string') url = value;
  else if (typeof value === 'object' && value !== null && typeof (value as { url?: unknown }).url === 'string') url = (value as { url: string }).url;
  if (!url || !url.trim()) return { reason: 'no repository field' };
  url = url.trim().replace(/^git\+/, '');

  const shortcut = /^(github|gitlab|bitbucket|gist):/.exec(url);
  if (shortcut && shortcut[1] !== 'github') return { reason: `not on GitHub (${shortcut[1]})` };

  const match =
    /^(?:https?|git|ssh):\/\/(?:[^@/\s]+@)?(?:www\.)?github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(url) ??
    /^git@github\.com:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i.exec(url) ??
    /^github:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:#.*)?$/i.exec(url) ??
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#.*)?$/.exec(url);
  if (match) {
    const repo = `${match[1]}/${match[2]}`;
    return REPO_NAME.test(repo) && !repo.includes('..') ? { repo } : { reason: 'the repository name is not a valid owner/repo' };
  }
  const host = /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)/i.exec(url)?.[1];
  return { reason: host ? `not on GitHub (${host.toLowerCase()})` : 'the repository field is not understood' };
}

export interface Candidate {
  name: string;
  range: string;
  section: (typeof SECTIONS)[number];
  repo: string | null;
  reason: string | null;
}

export interface Proposal {
  packageName: string | null;
  considered: number;
  truncated: boolean;
  /** One entry per repository, with the dependencies that point to it (a monorepo serves several). */
  repos: Array<{ repo: string; via: string[] }>;
  unresolved: Array<{ name: string; reason: string }>;
}

async function readJsonInside(dir: string, relative: string): Promise<{ json?: unknown; reason?: string }> {
  let abs: string;
  try {
    abs = (await resolveInside(dir, relative)).resolved;
  } catch (err) {
    if (err instanceof SafePathError) return { reason: err.code === 'OUTSIDE' ? 'resolves outside the project' : err.message };
    throw err;
  }
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat?.isFile()) return { reason: 'not found' };
  if (stat.size > MAX_FILE_BYTES) return { reason: 'larger than 1 MB' };
  try {
    const text = await fs.readFile(abs, 'utf-8');
    return { json: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) };
  } catch {
    return { reason: 'not valid JSON' };
  }
}

/** The proposal for a project folder. Throws a plain message when there is no readable package.json. */
export async function proposeSources(dir: string): Promise<Proposal> {
  const root = await readJsonInside(dir, 'package.json');
  if (root.json === undefined) throw new Error(`package.json: ${root.reason}`);
  if (typeof root.json !== 'object' || root.json === null || Array.isArray(root.json)) throw new Error('package.json must hold a JSON object');
  const pkg = root.json as Record<string, unknown>;

  const deps: Array<{ name: string; range: string; section: (typeof SECTIONS)[number] }> = [];
  const seen = new Set<string>();
  for (const section of SECTIONS) {
    const entries = pkg[section];
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) continue;
    for (const [name, range] of Object.entries(entries as Record<string, unknown>)) {
      if (seen.has(name)) continue;
      seen.add(name);
      deps.push({ name, range: typeof range === 'string' ? range : '', section });
    }
  }
  const truncated = deps.length > MAX_DEPENDENCIES;
  const unresolved: Proposal['unresolved'] = [];
  const byRepo = new Map<string, { repo: string; via: string[] }>();

  for (const dep of deps.slice(0, MAX_DEPENDENCIES)) {
    if (!NPM_NAME.test(dep.name)) {
      unresolved.push({ name: dep.name, reason: 'not a valid package name' });
      continue;
    }
    const installed = await readJsonInside(dir, path.posix.join('node_modules', dep.name, 'package.json'));
    if (installed.json === undefined) {
      unresolved.push({ name: dep.name, reason: installed.reason === 'not found' ? 'not installed (no node_modules entry)' : `its package.json ${installed.reason}` });
      continue;
    }
    const parsed = parseRepositoryField((installed.json as { repository?: unknown } | null)?.repository);
    if ('reason' in parsed) {
      unresolved.push({ name: dep.name, reason: parsed.reason });
      continue;
    }
    const key = parsed.repo.toLowerCase();
    const entry = byRepo.get(key) ?? { repo: parsed.repo, via: [] };
    entry.via.push(dep.name);
    byRepo.set(key, entry);
  }

  const repos = [...byRepo.values()].sort((a, b) => b.via.length - a.via.length || a.repo.localeCompare(b.repo));
  return { packageName: typeof pkg.name === 'string' ? pkg.name.slice(0, 100) : null, considered: Math.min(deps.length, MAX_DEPENDENCIES), truncated, repos, unresolved };
}

// ---- the approved list

export interface ApprovedSource {
  repo: string;
  via: string[];
  approvedAt: number;
  /** `proposal`: it came from the dependencies; `manual`: the developer named it. */
  how: 'proposal' | 'manual';
}

export const sourcesFile = (stateDir: string): string => path.join(stateDir, 'radar', 'sources.json');

export async function readApproved(stateDir: string): Promise<ApprovedSource[]> {
  const text = await fs.readFile(sourcesFile(stateDir), 'utf-8').catch(() => '');
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { repos?: unknown };
    if (!Array.isArray(parsed.repos)) return [];
    return parsed.repos.filter((r): r is ApprovedSource => typeof r?.repo === 'string' && REPO_NAME.test(r.repo) && typeof r.approvedAt === 'number');
  } catch {
    return [];
  }
}

export async function writeApproved(stateDir: string, repos: ApprovedSource[]): Promise<void> {
  const file = sourcesFile(stateDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify({ repos }, null, 2));
}
