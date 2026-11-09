import { IVectorStore, MemoryDocument, SearchOptions, SearchResult } from './types.js';

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * High-speed In-Memory Vector Store with Cosine Similarity
 * Perfectly suited for ESM/Bun runtime without native C++ compilation dependencies
 */
export class InMemoryVectorStore implements IVectorStore {
  private docs = new Map<string, MemoryDocument>();

  public async upsert(documents: MemoryDocument[]): Promise<void> {
    for (const doc of documents) {
      this.docs.set(doc.id, { ...doc });
    }
  }

  public async list(): Promise<MemoryDocument[]> {
    return Array.from(this.docs.values(), (d) => ({ ...d }));
  }

  public async search(queryVector: number[], options: SearchOptions = {}): Promise<SearchResult[]> {
    const topK = options.topK ?? 5;
    const minScore = options.minScore ?? 0.0;
    const namespace = options.namespace;

    const results: SearchResult[] = [];

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
    for (const id of ids) {
      this.docs.delete(id);
    }
  }

  public async count(namespace?: string): Promise<number> {
    if (!namespace) return this.docs.size;
    let count = 0;
    for (const doc of this.docs.values()) {
      if (doc.namespace === namespace) count++;
    }
    return count;
  }

  public async clear(namespace?: string): Promise<void> {
    if (!namespace) {
      this.docs.clear();
      return;
    }
    for (const [id, doc] of this.docs.entries()) {
      if (doc.namespace === namespace) {
        this.docs.delete(id);
      }
    }
  }
}
