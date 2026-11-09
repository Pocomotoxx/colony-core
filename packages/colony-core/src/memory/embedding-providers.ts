import { IEmbeddingProvider } from './types.js';

export interface MockEmbeddingOptions {
  dimension?: number;
}

/**
 * Words that carry no topic, in Hungarian and English. Dropping them keeps "the" and "a" from
 * making two unrelated texts look alike.
 */
const STOPWORDS = new Set([
  'a', 'az', 'es', 'egy', 'hogy', 'nem', 'is', 'de', 'meg', 'ra', 're', 'be', 'ki', 'el', 'fel', 'le', 'van', 'volt', 'lesz', 'mint', 'vagy', 'ez', 'azt', 'ezt',
  'the', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'be', 'it', 'this', 'that', 'at', 'by', 'as', 'from',
]);

/** FNV-1a, 32 bit: small, fast, stable across runs and platforms. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Lowercase, accents folded (Hungarian ő/ű included), everything that is not a letter or digit becomes a space. */
export function embeddingTokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

// Weights of the three feature kinds. Whole words say the most; the character pieces let
// "feladat" meet "feladatokat" and "parse" meet "parser", which matters in an agglutinative language.
const WORD_WEIGHT = 1.0;
const GRAM_WEIGHTS: Record<number, number> = { 3: 0.35, 4: 0.5 };

/**
 * Deterministic local embedding provider.
 * No network, no model, no API key: the colony core never depends on an external service.
 *
 * It hashes words and character 3- and 4-grams of each word (with word-boundary marks) into a
 * fixed-size vector (the hashing trick, with a sign bit so collisions tend to cancel), with
 * sublinear term frequency. That is lexical similarity with morphology tolerance: texts about
 * the same things in related word forms land close. It is NOT a meaning model: synonyms with no
 * shared letters ("car" and "automobile") stay apart. A project that needs that can plug in its
 * own provider through the `IEmbeddingProvider` interface.
 */
export class DeterministicEmbeddingProvider implements IEmbeddingProvider {
  public name = 'deterministic-local-v2';
  public dimension: number;

  constructor(options: MockEmbeddingOptions = {}) {
    this.dimension = options.dimension || 512;
  }

  private features(text: string): Map<string, number> {
    const counts = new Map<string, number>();
    const add = (feature: string) => counts.set(feature, (counts.get(feature) ?? 0) + 1);
    for (const word of embeddingTokens(text)) {
      add(`w:${word}`);
      const marked = `<${word}>`;
      for (const n of [3, 4]) {
        for (let i = 0; i + n <= marked.length; i++) add(`g${n}:${marked.slice(i, i + n)}`);
      }
    }
    return counts;
  }

  public async embedText(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimension).fill(0);
    for (const [feature, count] of this.features(text)) {
      const kind = feature[0] === 'w' ? WORD_WEIGHT : GRAM_WEIGHTS[Number(feature[1])];
      const h = fnv1a(feature);
      const sign = (h >>> 31) === 0 ? 1 : -1;
      vector[h % this.dimension] += sign * kind * (1 + Math.log(count));
    }
    let sumSquares = 0;
    for (const v of vector) sumSquares += v * v;
    const mag = Math.sqrt(sumSquares) || 1;
    return vector.map((v) => v / mag);
  }

  public async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embedText(t)));
  }
}

/**
 * The embedding the colony used before v2: every character hashed by its code and POSITION, so a
 * shifted text looks unrelated. Kept only as the baseline of the retrieval benchmark.
 */
export class PositionalCharEmbeddingProvider implements IEmbeddingProvider {
  public name = 'deterministic-local';
  public dimension = 128;

  public async embedText(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimension).fill(0);
    const clean = text.toLowerCase();
    for (let i = 0; i < clean.length; i++) vector[(clean.charCodeAt(i) * 31 + i) % this.dimension] += 1.0;
    let sumSquares = 0;
    for (const v of vector) sumSquares += v * v;
    const mag = Math.sqrt(sumSquares) || 1;
    return vector.map((v) => v / mag);
  }

  public async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embedText(t)));
  }
}
