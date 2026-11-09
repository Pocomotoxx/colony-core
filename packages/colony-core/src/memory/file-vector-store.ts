import { writeFileAtomic } from '../atomic-write.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IVectorStore, MemoryDocument, SearchOptions, SearchResult } from './types.js';
import { cosineSimilarity } from './vector-store.js';
import { HnswIndex } from './hnsw-index.js';

/** On-disk row: like MemoryDocument, but the vector may be a base64 Float32 string (v2). */
type StoredDocument = Omit<MemoryDocument, 'vector'> & { vector?: number[] | string };

function encodeDocument(doc: MemoryDocument): StoredDocument {
  if (!doc.vector || doc.vector.length === 0) return { ...doc, vector: undefined };
  return { ...doc, vector: Buffer.from(new Float32Array(doc.vector).buffer).toString('base64') };
}

function decodeDocument(row: StoredDocument): MemoryDocument {
  if (typeof row.vector !== 'string') return row as MemoryDocument;
  const buf = Buffer.from(row.vector, 'base64');
  return { ...row, vector: Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)) };
}

export interface FileVectorStoreOptions {
  storagePath: string; // File path e.g. .colony/memory.json
  /**
   * Search strategy. `linear` is exact. `hnsw` is approximate and fast on large memories.
   * `auto` (default) searches linearly until the memory holds `hnswThreshold` vectors.
   */
  index?: 'linear' | 'hnsw' | 'auto';
  hnswThreshold?: number;
}

/**
 * File-backed Persistent Vector Store
 * Synchronizes vector memory, reasoning patterns, and knowledge directly into git workspace files
 */
export class FileVectorStore implements IVectorStore {
  private storagePath: string;
  private docs = new Map<string, MemoryDocument>();
  private isLoaded = false;
  private loading?: Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly mode: 'linear' | 'hnsw' | 'auto';
  private readonly hnswThreshold: number;
  /** Built on demand from the stored documents; null when not needed or unusable (mixed dimensions). */
  private index: HnswIndex | null = null;
  private indexUnusable = false;

  constructor(options: FileVectorStoreOptions) {
    this.storagePath = options.storagePath;
    this.mode = options.index ?? 'auto';
    this.hnswThreshold = options.hnswThreshold ?? 500;
  }

  private wantsIndex(): boolean {
    if (this.indexUnusable || this.mode === 'linear') return false;
    return this.mode === 'hnsw' || this.docs.size >= this.hnswThreshold;
  }

  /** Build (once) the HNSW graph from the stored documents, in stored order. */
  private ensureIndex(): HnswIndex | null {
    if (!this.wantsIndex()) return null;
    if (this.index) return this.index;
    const index = new HnswIndex();
    try {
      for (const doc of this.docs.values()) {
        if (doc.vector && doc.vector.length > 0) index.add(doc.id, doc.vector);
      }
    } catch {
      this.indexUnusable = true; // e.g. documents with different vector sizes: stay exact
      return null;
    }
    this.index = index;
    return index;
  }

  private dropFromIndex(id: string): void {
    this.index?.remove(id);
  }

  /**
   * Load the file once. The load is memoized as a promise: two callers that start together must
   * wait for the same load. Before, the second one cleared the map after the first had already
   * added its documents, and those documents vanished.
   */
  private ensureLoaded(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    if (this.isLoaded) return;

    try {
      const data = await fs.readFile(this.storagePath, 'utf-8');
      const parsed = JSON.parse(data);
      // v2: { v: 2, docs: [...] } with base64 Float32 vectors. Legacy: a plain array with number[] vectors.
      const rows: StoredDocument[] = Array.isArray(parsed) ? parsed : parsed?.v === 2 && Array.isArray(parsed.docs) ? parsed.docs : [];
      this.docs.clear();
      for (const row of rows) {
        this.docs.set(row.id, decodeDocument(row));
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.warn(`[FileVectorStore] Warning reading ${this.storagePath}:`, err.message);
      }
      this.docs.clear();
    }
    this.isLoaded = true;
  }

  /**
   * Write the file. Writes run one after another, each saving the state as it is when its turn
   * comes, so concurrent upserts cannot interleave their writes or overwrite each other with an
   * older snapshot. Vectors are kept as base64 Float32 (v2), about a tenth of the pretty-printed
   * number list the store wrote before; the old format is still read.
   */
  private persist(): Promise<void> {
    const write = async () => {
      const dir = path.dirname(this.storagePath);
      await fs.mkdir(dir, { recursive: true });
      const serialized = JSON.stringify({ v: 2, docs: Array.from(this.docs.values(), encodeDocument) });
      await writeFileAtomic(this.storagePath, serialized);
    };
    const next = this.writeChain.then(write, write);
    this.writeChain = next.catch(() => undefined); // a failed write must not block the ones after it
    return next;
  }

  public async upsert(documents: MemoryDocument[]): Promise<void> {
    await this.ensureLoaded();
    for (const doc of documents) {
      this.docs.set(doc.id, { ...doc });
      if (this.index) {
        this.dropFromIndex(doc.id);
        if (doc.vector && doc.vector.length > 0) {
          try {
            this.index.add(doc.id, doc.vector);
          } catch {
            this.index = null;
            this.indexUnusable = true;
          }
        }
      }
    }
    await this.persist();
  }

  public async list(): Promise<MemoryDocument[]> {
    await this.ensureLoaded();
    return Array.from(this.docs.values(), (d) => ({ ...d }));
  }

  public async search(queryVector: number[], options: SearchOptions = {}): Promise<SearchResult[]> {
    await this.ensureLoaded();
    const topK = options.topK ?? 5;
    const minScore = options.minScore ?? 0.0;
    const namespace = options.namespace;

    const results: SearchResult[] = [];

    const index = this.ensureIndex();
    if (index) {
      const hits = index.search(queryVector, namespace ? this.docs.size : Math.max(topK * 4, 64), Math.max(topK * 4, 64));
      for (const hit of hits) {
        const document = this.docs.get(hit.id);
        if (!document || (namespace && document.namespace !== namespace)) continue;
        if (hit.score >= minScore) results.push({ document, score: hit.score });
      }
      // With a namespace the graph may hold too few matching vectors near the query: fall back to the exact scan.
      if (!namespace || results.length >= topK) return results.slice(0, topK);
      results.length = 0;
    }

    for (const doc of this.docs.values()) {
      if (namespace && doc.namespace !== namespace) {
        continue;
      }
      // A vector from another embedding size cannot be compared: skip it (reindex fixes it) instead of failing the search.
      if (!doc.vector || doc.vector.length !== queryVector.length) {
        continue;
      }

      const score = cosineSimilarity(queryVector, doc.vector);
      if (score >= minScore) {
        results.push({ document: doc, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  public async delete(ids: string[]): Promise<void> {
    await this.ensureLoaded();
    for (const id of ids) {
      this.docs.delete(id);
      this.dropFromIndex(id);
    }
    await this.persist();
  }

  public async count(namespace?: string): Promise<number> {
    await this.ensureLoaded();
    if (!namespace) return this.docs.size;
    let count = 0;
    for (const doc of this.docs.values()) {
      if (doc.namespace === namespace) count++;
    }
    return count;
  }

  public async clear(namespace?: string): Promise<void> {
    await this.ensureLoaded();
    if (!namespace) {
      this.docs.clear();
      this.index?.clear();
    } else {
      for (const [id, doc] of this.docs.entries()) {
        if (doc.namespace === namespace) {
          this.docs.delete(id);
          this.dropFromIndex(id);
        }
      }
    }
    await this.persist();
  }
}
