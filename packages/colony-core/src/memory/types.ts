export interface MemoryVector {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

export interface MemoryDocument {
  id: string;
  text: string;
  vector?: number[];
  namespace?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  /** Name of the embedding provider that made `vector`; a different provider means the vector is stale. */
  embedder?: string;
}

export interface SearchOptions {
  topK?: number;
  namespace?: string;
  minScore?: number;
  filter?: Record<string, unknown>;
}

export interface SearchResult {
  document: MemoryDocument;
  score: number; // Cosine similarity or relevance score (0.0 to 1.0)
}

/**
 * Model-agnostic embedding provider interface
 * The core ships only a local, deterministic implementation; a project may add its own backend
 */
export interface IEmbeddingProvider {
  name: string;
  dimension: number;
  embedText(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * Model-agnostic vector store interface
 */
export interface IVectorStore {
  upsert(docs: MemoryDocument[]): Promise<void>;
  /** All stored documents. Optional; needed to re-embed after the embedding provider changed. */
  list?(): Promise<MemoryDocument[]>;
  search(queryVector: number[], options?: SearchOptions): Promise<SearchResult[]>;
  delete(ids: string[]): Promise<void>;
  count(namespace?: string): Promise<number>;
  clear(namespace?: string): Promise<void>;
}
