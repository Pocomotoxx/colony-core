/**
 * Deterministic HNSW index (approximate nearest neighbours by cosine similarity).
 *
 * Rewritten from the legacy `memory` package. The legacy index drew each node's layer from
 * `Math.random()`, so the same data gave a different graph on every run. Here the layer comes from
 * a hash of the id, ties are broken by id, and there are no events, clocks or timers: the same
 * inserts in the same order always build the same graph, so results are reproducible.
 *
 * Left out on purpose: quantization, binary serialization (the graph is rebuilt from the stored
 * documents), and the event emitter.
 */

export interface HnswOptions {
  /** Links per node on the upper layers (layer 0 keeps twice as many). */
  m?: number;
  /** Candidate list size while inserting. */
  efConstruction?: number;
}

export interface HnswHit {
  id: string;
  /** Cosine similarity, -1..1. */
  score: number;
}

interface Node {
  id: string;
  vector: Float64Array; // unit length, or all zeros for a zero vector
  level: number;
  links: string[][]; // links[layer]
}

interface Candidate {
  id: string;
  dist: number;
}

const MAX_LEVEL = 16;

const before = (a: Candidate, b: Candidate): boolean => a.dist < b.dist || (a.dist === b.dist && a.id < b.id);

function insertSorted(list: Candidate[], item: Candidate): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (before(list[mid], item)) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, item);
}

/** 32-bit string hash (FNV-1a) with a murmur-style finalizer so similar ids spread out. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class HnswIndex {
  private readonly m: number;
  private readonly efConstruction: number;
  private readonly nodes = new Map<string, Node>();
  private entry: string | null = null;
  private dimensions = 0;

  constructor(options: HnswOptions = {}) {
    this.m = options.m ?? 16;
    this.efConstruction = options.efConstruction ?? 100;
    if (!Number.isInteger(this.m) || this.m < 2) throw new Error('HNSW m must be an integer >= 2');
    if (!Number.isInteger(this.efConstruction) || this.efConstruction < 1) throw new Error('HNSW efConstruction must be a positive integer');
  }

  public get size(): number {
    return this.nodes.size;
  }

  public has(id: string): boolean {
    return this.nodes.has(id);
  }

  /** The layer of a node is fixed by its id, with the usual geometric distribution (factor 1/ln m). */
  public levelFor(id: string): number {
    const u = (hash32(id) + 1) / 4294967297; // (0, 1)
    return Math.min(MAX_LEVEL, Math.floor(-Math.log(u) / Math.log(this.m)));
  }

  /** Add a vector; an existing id is replaced. */
  public add(id: string, vector: number[]): void {
    if (vector.length === 0) throw new Error('cannot index an empty vector');
    if (this.nodes.size > 0 && vector.length !== this.dimensions) {
      throw new Error(`Vector dimension mismatch: ${this.dimensions} vs ${vector.length}`);
    }
    if (this.nodes.has(id)) this.remove(id);
    if (this.nodes.size === 0) this.dimensions = vector.length;

    const level = this.levelFor(id);
    const node: Node = { id, vector: this.normalize(vector), level, links: Array.from({ length: level + 1 }, () => []) };

    if (this.entry === null) {
      this.nodes.set(id, node);
      this.entry = id;
      return;
    }

    let current = this.entry;
    const top = this.nodes.get(this.entry)!.level;
    for (let layer = top; layer > level; layer--) {
      current = this.searchLayer(node.vector, [current], 1, layer)[0].id;
    }

    this.nodes.set(id, node);
    let entries = [current];
    for (let layer = Math.min(level, top); layer >= 0; layer--) {
      const found = this.searchLayer(node.vector, entries, this.efConstruction, layer).filter((c) => c.id !== id);
      const chosen = found.slice(0, this.m);
      node.links[layer] = chosen.map((c) => c.id);
      for (const c of chosen) {
        const other = this.nodes.get(c.id)!;
        other.links[layer].push(id);
        this.prune(other, layer);
      }
      if (found.length > 0) entries = found.map((c) => c.id);
    }

    if (level > top) this.entry = id;
  }

  /** Remove a vector and mend the links of its neighbours. Returns false for an unknown id. */
  public remove(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    this.nodes.delete(id);

    for (let layer = 0; layer <= node.level; layer++) {
      for (const neighborId of node.links[layer]) {
        const neighbor = this.nodes.get(neighborId);
        if (!neighbor || !neighbor.links[layer]) continue;
        const pool = new Set(neighbor.links[layer].filter((l) => l !== id));
        for (const other of node.links[layer]) if (other !== neighborId) pool.add(other);
        neighbor.links[layer] = Array.from(pool).filter((l) => this.nodes.has(l));
        this.prune(neighbor, layer);
      }
    }

    if (this.entry === id) {
      let best: Node | undefined;
      for (const n of this.nodes.values()) {
        if (!best || n.level > best.level || (n.level === best.level && n.id < best.id)) best = n;
      }
      this.entry = best?.id ?? null;
    }
    return true;
  }

  public clear(): void {
    this.nodes.clear();
    this.entry = null;
    this.dimensions = 0;
  }

  /** The k most similar vectors, best first. `ef` widens the search (default: max(k, 64)). */
  public search(query: number[], k: number, ef?: number): HnswHit[] {
    if (this.entry === null || k < 1) return [];
    if (query.length !== this.dimensions) throw new Error(`Vector dimension mismatch: ${this.dimensions} vs ${query.length}`);
    const q = this.normalize(query);
    let current = this.entry;
    for (let layer = this.nodes.get(this.entry)!.level; layer > 0; layer--) {
      current = this.searchLayer(q, [current], 1, layer)[0].id;
    }
    return this.searchLayer(q, [current], Math.max(ef ?? 64, k), 0)
      .slice(0, k)
      .map((c) => ({ id: c.id, score: 1 - c.dist }));
  }

  private normalize(vector: number[]): Float64Array {
    let norm = 0;
    for (const x of vector) norm += x * x;
    norm = Math.sqrt(norm);
    const out = new Float64Array(vector.length);
    if (norm === 0) return out;
    for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
    return out;
  }

  private dist(a: Float64Array, b: Float64Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return 1 - dot;
  }

  private searchLayer(query: Float64Array, entries: string[], ef: number, layer: number): Candidate[] {
    const visited = new Set<string>(entries);
    const frontier: Candidate[] = [];
    const best: Candidate[] = [];
    for (const id of entries) {
      const c = { id, dist: this.dist(query, this.nodes.get(id)!.vector) };
      insertSorted(frontier, c);
      insertSorted(best, c);
    }
    while (best.length > ef) best.pop();

    while (frontier.length > 0) {
      const current = frontier.shift()!;
      const worst = best[best.length - 1];
      if (best.length >= ef && before(worst, current)) break;
      for (const neighborId of this.nodes.get(current.id)!.links[layer] ?? []) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        const neighbor = this.nodes.get(neighborId);
        if (!neighbor) continue;
        const c = { id: neighborId, dist: this.dist(query, neighbor.vector) };
        if (best.length < ef || before(c, best[best.length - 1])) {
          insertSorted(frontier, c);
          insertSorted(best, c);
          if (best.length > ef) best.pop();
        }
      }
    }
    return best;
  }

  /** Keep the closest links of a node on one layer (layer 0 allows twice m). */
  private prune(node: Node, layer: number): void {
    const limit = layer === 0 ? this.m * 2 : this.m;
    const links = node.links[layer].filter((id) => this.nodes.has(id));
    if (links.length <= limit) {
      node.links[layer] = links;
      return;
    }
    const ranked: Candidate[] = [];
    for (const id of links) insertSorted(ranked, { id, dist: this.dist(node.vector, this.nodes.get(id)!.vector) });
    node.links[layer] = ranked.slice(0, limit).map((c) => c.id);
  }
}
