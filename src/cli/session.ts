import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from '../atomic-write.js';
import { safeGitText } from '../safe-git.js';
import { resolveInside, SafePathError } from '../safe-path.js';
import { ColonyHub } from '../colony-hub.js';
import { VectorCodex } from '../memory/vector-codex.js';
import { FileVectorStore } from '../memory/file-vector-store.js';
import { BUILTIN_AGENT_PROFILES } from '../agents/agent-profiles.js';
import type { SerializedProposal } from '../consensus/consensus-engine.js';
import type { Claim } from '../coordination/claim-ledger.js';
import type { AuditAnchor, AuditEntry } from '../audit-log.js';
import type { RouterState } from '../neural/moe-router.js';
import type { ColonyMember, ColonyTask } from '../types.js';
import { DEFAULT_MANIFEST, DEFAULT_RULES } from './default-rules.js';
import { errorCode, errorMessage } from '../errors.js';

export const STATE_DIR = '.colony';
const RULES_DIR = 'rules';
const MANIFEST_FILE = 'manifest.json';
const LEDGER_FILE = 'ledger.json';
const AUDIT_FILE = 'audit.jsonl';
const MEMORY_FILE = 'memory.json';
const BOOT_FILE = 'boot.json';

export type BootStatus = 'LOADED' | 'UNVERIFIABLE' | 'BLOCKED';

interface LedgerFile {
  version: 1;
  members: ColonyMember[];
  tasks: ColonyTask[];
  proposals: SerializedProposal[];
  /** Absent in ledgers written before claims existed. */
  claims?: Claim[];
  /** What the router learned; absent in older ledgers. */
  router?: RouterState;
}

export interface BootRecord {
  status: BootStatus;
  revision: string; // commit SHA or 'unknown'
  dirty: boolean | null;
  bootedAt: number;
  evidence: Array<{ path: string; sha256: string; bytes: number }>;
  rules: Array<{ path: string; sha256: string; bytes: number }>;
  problems: string[];
  /** Head of the audit log when this boot finished; the next boot checks the log still holds it. */
  audit?: AuditAnchor;
}

export interface LoadedRule {
  path: string;
  sha256: string;
  bytes: number;
  text: string;
}

/**
 * Load the mandatory rule files listed in `.colony/rules/manifest.json`.
 * Any missing, unreadable or out-of-directory entry is reported as a problem; nothing is skipped silently.
 */
export async function loadRules(dir: string): Promise<{ rules: LoadedRule[]; problems: string[] }> {
  const rulesDir = path.join(dir, STATE_DIR, RULES_DIR);
  const rules: LoadedRule[] = [];
  const problems: string[] = [];

  let mandatory: unknown;
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(rulesDir, MANIFEST_FILE), 'utf-8'));
    mandatory = manifest?.mandatory;
  } catch (err) {
    return { rules, problems: [`${RULES_DIR}/${MANIFEST_FILE}: ${errorMessage(err)}`] };
  }
  if (!Array.isArray(mandatory) || mandatory.some((m) => typeof m !== 'string')) {
    return { rules, problems: [`${RULES_DIR}/${MANIFEST_FILE}: 'mandatory' must be an array of file names`] };
  }

  for (const name of mandatory as string[]) {
    let full: string;
    try {
      full = (await resolveInside(rulesDir, name)).resolved;
    } catch (err) {
      if (!(err instanceof SafePathError)) throw err;
      problems.push(`${name}: ${errorCode(err) === 'OUTSIDE' ? 'outside the rules directory' : errorMessage(err)}`);
      continue;
    }
    try {
      const text = await fs.readFile(full, 'utf-8');
      if (!text.trim()) {
        problems.push(`${name}: empty rule file`);
        continue;
      }
      rules.push({ path: `${STATE_DIR}/${RULES_DIR}/${name}`, sha256: sha256(text), bytes: Buffer.byteLength(text), text });
    } catch (err) {
      problems.push(`${name}: ${errorMessage(err)}`);
    }
  }
  return { rules, problems };
}

/** Write the starter rules when the project has no rule manifest yet. Existing rules are never overwritten. */
async function seedRules(dir: string): Promise<boolean> {
  const rulesDir = path.join(dir, STATE_DIR, RULES_DIR);
  const manifestPath = path.join(rulesDir, MANIFEST_FILE);
  try {
    await fs.access(manifestPath);
    return false;
  } catch {
    await fs.mkdir(rulesDir, { recursive: true });
    for (const [name, text] of Object.entries(DEFAULT_RULES)) {
      await fs.writeFile(path.join(rulesDir, name), text, { encoding: 'utf-8', flag: 'wx' }).catch((err) => {
        if (errorCode(err) !== 'EEXIST') throw err;
      });
    }
    await fs.writeFile(manifestPath, JSON.stringify(DEFAULT_MANIFEST, null, 2), 'utf-8');
    return true;
  }
}

export interface Revision {
  sha: string;
  dirty: boolean | null;
}

/** Resolve the git commit of `dir`; never throws. `.colony/` is ignored for the dirty flag. */
export function resolveRevision(dir: string): Revision {
  const git = (args: string[]): string => safeGitText(dir, args);
  try {
    const sha = git(['rev-parse', 'HEAD']);
    const dirty = git(['status', '--porcelain', '--', '.', `:(exclude)${STATE_DIR}`]).length > 0;
    return { sha, dirty };
  } catch {
    return { sha: 'unknown', dirty: null };
  }
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    throw err;
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * A Colony working session: the hub plus its persisted state under `<dir>/.colony/`.
 * The host (an LLM or a human) drives the colony through it; the session never calls a model.
 */
export class ColonySession {
  /** How many audit entries are already on disk. */
  private auditPersisted = 0;

  private constructor(
    public readonly dir: string,
    public readonly hub: ColonyHub
  ) {}

  private get stateDir(): string {
    return path.join(this.dir, STATE_DIR);
  }

  /** Load state. Throws on unreadable or malformed state files instead of silently resetting them. */
  public static async open(dir: string): Promise<ColonySession> {
    const stateDir = path.join(dir, STATE_DIR);
    const codex = new VectorCodex({ vectorStore: new FileVectorStore({ storagePath: path.join(stateDir, MEMORY_FILE) }) });
    const hub = new ColonyHub({ name: 'Colony', codex });
    await codex.reindex(); // memory written by an older embedding is re-embedded once

    const ledgerText = await readIfExists(path.join(stateDir, LEDGER_FILE));
    if (ledgerText !== null) {
      const ledger = JSON.parse(ledgerText) as LedgerFile;
      if (ledger.version !== 1 || !Array.isArray(ledger.members) || !Array.isArray(ledger.tasks) || !Array.isArray(ledger.proposals)) {
        throw new Error(`${LEDGER_FILE} has an unsupported shape`);
      }
      hub.registry.restore(ledger.members);
      hub.orchestrator.restore(ledger.tasks);
      hub.consensus.restore(ledger.proposals);
      if (ledger.claims !== undefined) {
        if (!Array.isArray(ledger.claims)) throw new Error(`${LEDGER_FILE} has an unsupported shape`);
        hub.claims.restore(ledger.claims);
      }
      if (ledger.router !== undefined) {
        const r = ledger.router;
        if (!r || typeof r.weights !== 'object' || typeof r.routed !== 'object' || typeof r.outcomes !== 'number' || typeof r.rewardSum !== 'number') {
          throw new Error(`${LEDGER_FILE} has an unsupported router state`);
        }
        hub.router.restore(r);
      }
    }

    const memoryText = await readIfExists(path.join(stateDir, MEMORY_FILE));
    if (memoryText !== null) {
      const parsed = JSON.parse(memoryText);
      const ok = Array.isArray(parsed) || (parsed?.v === 2 && Array.isArray(parsed.docs));
      if (!ok) throw new Error(`${MEMORY_FILE} must be a JSON array (legacy) or a v2 document file`);
    }

    const session = new ColonySession(dir, hub);
    const auditText = await readIfExists(path.join(stateDir, AUDIT_FILE));
    if (auditText !== null) {
      const entries = auditText
        .split('\n')
        .filter((line) => line.trim())
        .map((line, i) => {
          try {
            return JSON.parse(line) as AuditEntry;
          } catch {
            throw new Error(`${AUDIT_FILE} line ${i + 1} is not valid JSON`);
          }
        });
      hub.audit.restore(entries); // throws when the hash chain is broken
      session.auditPersisted = entries.length;
    }
    return session;
  }

  public async save(): Promise<void> {
    const ledger: LedgerFile = {
      version: 1,
      members: this.hub.registry.snapshot(),
      tasks: this.hub.orchestrator.snapshot(),
      proposals: this.hub.consensus.snapshot(),
      claims: this.hub.claims.snapshot(),
      router: this.hub.router.snapshot(),
    };
    await fs.mkdir(this.stateDir, { recursive: true });
    await writeFileAtomic(path.join(this.stateDir, LEDGER_FILE), JSON.stringify(ledger, null, 2));

    const fresh = this.hub.audit.snapshot().slice(this.auditPersisted);
    if (fresh.length > 0) {
      await fs.appendFile(path.join(this.stateDir, AUDIT_FILE), fresh.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
      this.auditPersisted += fresh.length;
    }
  }

  /** Register the built-in profiles as members when the colony has none yet. */
  public seedBuiltinMembers(): number {
    if (this.hub.registry.getAllMembers().length > 0) return 0;
    return this.addMissingBuiltinMembers().length;
  }

  /**
   * Register the built-in profiles that are not members yet, by id. Idempotent. Boot only seeds an
   * empty colony; an existing colony gets the newer roles through `member preset standard`.
   */
  public addMissingBuiltinMembers(): string[] {
    const added: string[] = [];
    for (const [key, profile] of Object.entries(BUILTIN_AGENT_PROFILES)) {
      const id = `member_${key}`;
      if (this.hub.registry.getMember(id)) continue;
      this.hub.registry.register({
        id,
        name: profile.name,
        role: profile.role,
        capabilities: { tools: profile.capabilities, maxConcurrentTasks: profile.maxConcurrentTasks },
        metadata: { profileId: profile.id },
      });
      added.push(id);
    }
    return added;
  }

  /**
   * Boot: load and validate the state files, seed members, resolve the revision, record evidence.
   * LOADED = state valid and revision resolved; UNVERIFIABLE = state valid, revision unknown
   * (content work allowed, repository mutation not); BLOCKED = a state file is unreadable or malformed.
   */
  public static async boot(dir: string): Promise<{ record: BootRecord; session: ColonySession | null; rules: LoadedRule[] }> {
    const stateDir = path.join(dir, STATE_DIR);
    const revision = resolveRevision(dir);
    const evidence: BootRecord['evidence'] = [];
    const problems: string[] = [];

    const previous = await ColonySession.readBootRecord(dir).catch(() => null);

    for (const file of [LEDGER_FILE, MEMORY_FILE, AUDIT_FILE]) {
      try {
        const text = await readIfExists(path.join(stateDir, file));
        if (text !== null) evidence.push({ path: `${STATE_DIR}/${file}`, sha256: sha256(text), bytes: Buffer.byteLength(text) });
      } catch (err) {
        problems.push(`${file}: ${errorMessage(err)}`);
      }
    }

    let session: ColonySession | null = null;
    if (problems.length === 0) {
      try {
        session = await ColonySession.open(dir);
      } catch (err) {
        problems.push(errorMessage(err));
      }
    }

    if (session && previous?.audit && !session.hub.audit.contains(previous.audit)) {
      problems.push(`${AUDIT_FILE}: no longer holds the entry recorded at the last boot (truncated or rewritten)`);
    }

    let loaded: LoadedRule[] = [];
    if (session) {
      await seedRules(dir);
      const result = await loadRules(dir);
      loaded = result.rules;
      problems.push(...result.problems);
    }

    const status: BootStatus =
      session === null || problems.length > 0 ? 'BLOCKED' : revision.sha === 'unknown' ? 'UNVERIFIABLE' : 'LOADED';
    const record: BootRecord = {
      status,
      revision: revision.sha,
      dirty: revision.dirty,
      bootedAt: Date.now(),
      evidence,
      rules: loaded.map(({ path: p, sha256: h, bytes }) => ({ path: p, sha256: h, bytes })),
      problems,
      // A blocked boot keeps the older anchor, so the check survives it.
      audit: session && problems.length === 0 ? session.hub.audit.anchor() : previous?.audit,
    };

    if (session) {
      session.seedBuiltinMembers();
      await session.save();
    }
    // Always overwrite the boot record, so a BLOCKED boot revokes an earlier successful one.
    await fs.mkdir(stateDir, { recursive: true });
    await writeFileAtomic(path.join(stateDir, BOOT_FILE), JSON.stringify(record, null, 2));
    return { record, session, rules: loaded };
  }

  /** The record of the last successful boot, or null when the colony has not been booted. */
  public static async readBootRecord(dir: string): Promise<BootRecord | null> {
    const text = await readIfExists(path.join(dir, STATE_DIR, BOOT_FILE));
    return text === null ? null : (JSON.parse(text) as BootRecord);
  }
}
