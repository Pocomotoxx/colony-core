import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The developer's ratings of recalls (docs/RECALL-RATE-PLAN.md). The recall log (`recall.jsonl`, written by the prompt hook)
 * is append-only and is never rewritten: an event is identified by its line number in that log, which does not change
 * when lines are added. A rating is a line of its own in `ratings.jsonl`; the last one for an event counts.
 * The rating is the developer's statement: the colony records it and does not check it.
 */

export const RECALL_LOG = 'recall.jsonl';
export const RATINGS_DIR = 'recall';
export const RATINGS_FILE = 'ratings.jsonl';
export const USEFUL = ['yes', 'partly', 'no'] as const;
export type Useful = (typeof USEFUL)[number];
export const SCORE: Record<Useful, number> = { yes: 1, partly: 0.5, no: 0 };
/** The phase 1 exit criterion (ROADMAP): this many rated sessions, and at least this share useful. */
export const EXIT_SESSIONS = 30;
export const EXIT_SHARE = 0.5;

export interface RecallEvent {
  /** 1-based line number in recall.jsonl: the identifier used by `recall rate`. */
  seq: number;
  at: number;
  session: string | null;
  ids: string[];
}

export interface Rating {
  seq: number;
  at: number;
  session: string | null;
  useful: Useful;
  note?: string;
  ratedAt: number;
}

/** The recall events, in order. A damaged line is skipped, but it keeps its number, so later numbers stay right. */
export async function readRecallEvents(stateDir: string): Promise<RecallEvent[]> {
  const text = await fs.readFile(path.join(stateDir, RECALL_LOG), 'utf-8').catch(() => '');
  const events: RecallEvent[] = [];
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const o = JSON.parse(line) as { at?: unknown; session?: unknown; ids?: unknown };
      if (typeof o.at !== 'number' || !Array.isArray(o.ids)) return;
      events.push({
        seq: index + 1,
        at: o.at,
        session: typeof o.session === 'string' ? o.session : null,
        ids: o.ids.filter((x): x is string => typeof x === 'string').slice(0, 10),
      });
    } catch {
      // a damaged line is left out; its number is not reused
    }
  });
  return events;
}

/** The latest rating per event. Damaged lines are skipped. */
export async function readRatings(stateDir: string): Promise<Map<number, Rating>> {
  const text = await fs.readFile(path.join(stateDir, RATINGS_DIR, RATINGS_FILE), 'utf-8').catch(() => '');
  const latest = new Map<number, Rating>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Partial<Rating>;
      if (typeof o.seq !== 'number' || !USEFUL.includes(o.useful as Useful)) continue;
      latest.set(o.seq, o as Rating);
    } catch {
      // skipped
    }
  }
  return latest;
}

export async function appendRating(stateDir: string, rating: Rating): Promise<void> {
  const dir = path.join(stateDir, RATINGS_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, RATINGS_FILE), `${JSON.stringify(rating)}\n`, 'utf-8');
}

export interface RecallStats {
  events: number;
  rated: number;
  unrated: number;
  /** Distinct sessions among the rated recalls. A recall without a session id is not a session: see unattributed. */
  ratedSessions: number;
  /** Rated recalls that have no session id: they count toward the share, not toward the sessions. */
  unattributed: number;
  counts: Record<Useful, number>;
  /** Mean of the scores (yes 1, partly 0.5, no 0) over rated events, or null when none is rated. */
  usefulShare: number | null;
  /**
   * The same share per session (the mean of that session's rated recalls): how many sessions are at least half useful and how
   * many are below. The overall share weighs a session by its number of rated recalls; this does not.
   */
  perSession: { sessions: number; atLeastHalf: number; belowHalf: number };
  exit: {
    sessions: { have: number; need: number; met: boolean };
    share: { have: number | null; need: number; met: boolean | null };
  };
}

/**
 * The phase 1 numbers. A session counts once however many of its recalls were rated. A recall without a session id
 * cannot be attributed to a session: its rating counts toward the share and is reported as unattributed, but it
 * never counts toward the sessions. The exit is met when both the session count and the share are.
 */
export function recallStats(events: RecallEvent[], ratings: Map<number, Rating>): RecallStats {
  const counts: Record<Useful, number> = { yes: 0, partly: 0, no: 0 };
  const sessions = new Set<string>();
  const bySession = new Map<string, { score: number; n: number }>();
  let unattributed = 0;
  let score = 0;
  let rated = 0;
  for (const e of events) {
    const r = ratings.get(e.seq);
    if (!r) continue;
    rated++;
    counts[r.useful]++;
    score += SCORE[r.useful];
    if (e.session) {
      sessions.add(e.session);
      const s = bySession.get(e.session) ?? { score: 0, n: 0 };
      s.score += SCORE[r.useful];
      s.n++;
      bySession.set(e.session, s);
    } else unattributed++;
  }
  const share = rated === 0 ? null : score / rated;
  return {
    events: events.length,
    rated,
    unrated: events.length - rated,
    ratedSessions: sessions.size,
    unattributed,
    counts,
    usefulShare: share === null ? null : Math.round(share * 1000) / 1000,
    perSession: {
      sessions: bySession.size,
      atLeastHalf: [...bySession.values()].filter((s) => s.score / s.n >= EXIT_SHARE).length,
      belowHalf: [...bySession.values()].filter((s) => s.score / s.n < EXIT_SHARE).length,
    },
    exit: {
      sessions: { have: sessions.size, need: EXIT_SESSIONS, met: sessions.size >= EXIT_SESSIONS },
      share: { have: share === null ? null : Math.round(share * 1000) / 1000, need: EXIT_SHARE, met: share === null ? null : share >= EXIT_SHARE },
    },
  };
}
