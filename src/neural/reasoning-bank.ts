import { VectorCodex } from '../memory/vector-codex.js';

const SOLUTION_GIST_CHARS = 2000;

/** What the bank stores in a document's metadata (all optional: older entries lack some). */
interface PatternMeta {
  role?: string;
  score?: number;
  verified?: boolean;
  problem?: string;
  solution?: string;
}

export interface ReasoningPattern {
  id: string;
  problem: string;
  solution: string;
  role: string;
  successScore: number; // 0.0 to 1.0
  createdAt: number;
  /** Similarity to the query, set by `recallPatterns`. */
  relevance?: number;
  /** The colony ran a check on this work and it passed. */
  verified?: boolean;
}

/**
 * ReasoningBank - Long-term associative memory for successful problem-solving trajectories
 * Agents learn by indexing reported successes and retrieving relevant solutions when facing similar challenges.
 * The colony does not verify a result itself; it records what the executing host reported.
 */
export class ReasoningBank {
  private codex: VectorCodex;
  private readonly namespace = 'reasoning_bank';

  constructor(codex: VectorCodex) {
    this.codex = codex;
  }

  /**
   * Record a reported successful execution pattern into the Reasoning Bank
   */
  public async recordPattern(pattern: {
    problem: string;
    solution: string;
    role: string;
    successScore?: number;
    verified?: boolean;
    /** A stable id makes a later record for the same work replace this one. */
    id?: string;
  }): Promise<ReasoningPattern> {
    const id = pattern.id ?? `pattern_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const score = pattern.successScore ?? 1.0;

    const patternEntry: ReasoningPattern = {
      id,
      problem: pattern.problem,
      solution: pattern.solution,
      role: pattern.role,
      successScore: score,
      createdAt: Date.now(),
    };

    // The full solution lives in the metadata; the document text (what is embedded) keeps its start only,
    // so a long result is not stored twice.
    const gist = pattern.solution.length > SOLUTION_GIST_CHARS ? `${pattern.solution.slice(0, SOLUTION_GIST_CHARS)}…` : pattern.solution;
    const documentText = `[ROLE: ${pattern.role}] Problem: ${pattern.problem}\nReported Solution Strategy:${gist}`;

    await this.codex.storeDocuments([
      {
        id,
        text: documentText,
        namespace: this.namespace,
        metadata: {
          role: pattern.role,
          score,
          verified: Boolean(pattern.verified),
          problem: pattern.problem,
          solution: pattern.solution,
        },
      },
    ]);

    return patternEntry;
  }

  /**
   * Recall the most relevant historical solutions for a given task or challenge
   */
  public async recallPatterns(
    queryText: string,
    options: { topK?: number; minScore?: number; role?: string } = {}
  ): Promise<ReasoningPattern[]> {
    const searchResults = await this.codex.search(queryText, {
      topK: options.topK ?? 3,
      minScore: options.minScore ?? 0.25, // `||` here turned an explicit 0 back into 0.25
      namespace: this.namespace,
    });

    const patterns: ReasoningPattern[] = [];

    for (const res of searchResults) {
      const meta = res.document.metadata as PatternMeta | undefined;
      if (options.role && meta?.role && meta.role !== options.role) {
        continue;
      }

      patterns.push({
        id: res.document.id,
        problem: meta?.problem || res.document.text,
        solution: meta?.solution || '',
        role: meta?.role || 'unknown',
        successScore: meta?.score ?? res.score, // `||` would turn a reported 0 into the similarity score
        createdAt: res.document.createdAt,
        relevance: res.score,
        verified: Boolean(meta?.verified),
      });
    }

    return patterns;
  }

  public async count(): Promise<number> {
    return this.codex.count(this.namespace);
  }
}
