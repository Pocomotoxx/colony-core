/**
 * Append-only audit log with a hash chain.
 *
 * Takes the idea of the legacy `shared` event store (an append-only log with a version per
 * aggregate) and drops the SQLite/WASM storage, timers and event emitter. Each entry carries the
 * SHA-256 of its own canonical JSON and of the entry before it.
 *
 * What the chain proves: an entry in the middle was not edited, removed or reordered without the
 * following hashes breaking. What it does NOT prove: there is no signature, so someone who rewrites
 * the file and recomputes every hash produces a valid chain, and cutting entries off the end is
 * invisible on its own. `anchor()` and `contains()` let a caller remember the head at one moment
 * and later check that the log still holds it, which catches both for the span since that moment.
 */

import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEntry {
  seq: number;
  at: number;
  type: string;
  /** What the entry is about, e.g. a task or claim id. */
  aggregateId: string;
  /** 1 for the first entry about this aggregate, then counting up. */
  version: number;
  actor: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export type AuditInput = Pick<AuditEntry, 'type' | 'aggregateId' | 'actor'> & { payload?: Record<string, unknown> };

export type AuditVerification = { ok: true; entries: number; head: string } | { ok: false; brokenAt: number; reason: string };

export interface AuditAnchor {
  entries: number;
  head: string;
}

export interface AuditFilter {
  aggregateId?: string;
  type?: string;
  actor?: string;
  /** Keep only the last `limit` matches. */
  limit?: number;
}

/** JSON with sorted object keys, so equal content always gives equal bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const hashOf = (entry: Omit<AuditEntry, 'hash'>): string => createHash('sha256').update(canonicalJson(entry)).digest('hex');

export class AuditLog {
  private entries: AuditEntry[] = [];
  private versions = new Map<string, number>();

  public get length(): number {
    return this.entries.length;
  }

  public head(): string {
    return this.entries.length === 0 ? GENESIS_HASH : this.entries[this.entries.length - 1].hash;
  }

  public anchor(): AuditAnchor {
    return { entries: this.entries.length, head: this.head() };
  }

  public append(input: AuditInput, at: number): AuditEntry {
    const version = (this.versions.get(input.aggregateId) ?? 0) + 1;
    const body: Omit<AuditEntry, 'hash'> = {
      seq: this.entries.length,
      at,
      type: input.type,
      aggregateId: input.aggregateId,
      version,
      actor: input.actor,
      payload: structuredClone(input.payload ?? {}),
      prevHash: this.head(),
    };
    const entry: AuditEntry = { ...body, hash: hashOf(body) };
    this.entries.push(entry);
    this.versions.set(input.aggregateId, version);
    return entry;
  }

  public list(filter: AuditFilter = {}): AuditEntry[] {
    const matches = this.entries.filter(
      (e) =>
        (filter.aggregateId === undefined || e.aggregateId === filter.aggregateId) &&
        (filter.type === undefined || e.type === filter.type) &&
        (filter.actor === undefined || e.actor === filter.actor)
    );
    return structuredClone(filter.limit !== undefined && filter.limit >= 0 ? matches.slice(Math.max(0, matches.length - filter.limit)) : matches);
  }

  public snapshot(): AuditEntry[] {
    return structuredClone(this.entries);
  }

  /** Check the chain of any list of entries without loading it. */
  public static verifyEntries(entries: readonly AuditEntry[]): AuditVerification {
    let prev = GENESIS_HASH;
    const versions = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.seq !== i) return { ok: false, brokenAt: i, reason: `entry ${i} has seq ${e.seq}` };
      if (e.prevHash !== prev) return { ok: false, brokenAt: i, reason: `entry ${i} does not follow the previous hash` };
      const { hash, ...body } = e;
      if (hashOf(body) !== hash) return { ok: false, brokenAt: i, reason: `entry ${i} was changed (hash mismatch)` };
      const expected = (versions.get(e.aggregateId) ?? 0) + 1;
      if (e.version !== expected) return { ok: false, brokenAt: i, reason: `entry ${i} has version ${e.version}, expected ${expected}` };
      versions.set(e.aggregateId, expected);
      prev = hash;
    }
    return { ok: true, entries: entries.length, head: prev };
  }

  public verify(): AuditVerification {
    return AuditLog.verifyEntries(this.entries);
  }

  /** Replace the log with `entries` after verifying their chain. Throws when the chain is broken. */
  public restore(entries: AuditEntry[]): void {
    const result = AuditLog.verifyEntries(entries);
    if (!result.ok) throw new Error(`audit log is broken: ${result.reason}`);
    this.entries = structuredClone(entries);
    this.versions.clear();
    for (const e of this.entries) this.versions.set(e.aggregateId, e.version);
  }

  /** True when the log still holds exactly the state remembered in `anchor` as its prefix. */
  public contains(anchor: AuditAnchor): boolean {
    if (anchor.entries === 0) return true;
    return this.entries.length >= anchor.entries && this.entries[anchor.entries - 1].hash === anchor.head;
  }
}
