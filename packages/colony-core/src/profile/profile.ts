import fs from 'node:fs/promises';
import { writeFileAtomic } from '../atomic-write.js';
import { scanText } from '../injection-scan.js';
import { redactText } from '../redact.js';

/**
 * Developer profile: what the user says about how they work. Declared by the user, answer by
 * answer. The question list is fixed in code (nothing a model or a task result could add), a
 * skipped question means "no preference" and is never filled with a default, and free text goes
 * through the injection scan and the redaction before it is stored.
 */

export class ProfileError extends Error {}

export interface Choice {
  value: string;
  label: string;
}

export interface Question {
  id: string;
  section: string;
  /** Shown to the user. */
  text: string;
  type: 'choice' | 'multi' | 'text';
  options?: readonly Choice[];
  maxLength?: number;
  /** Asked only when the answer to `id` contains one of `includes`. */
  when?: { id: string; includes: readonly string[] };
}

const c = (value: string, label: string): Choice => ({ value, label });

export const QUESTIONS: readonly Question[] = [
  { id: 'languages', section: 'nyelv', type: 'multi', text: 'Melyik nyelveken dolgozol leggyakrabban?', options: [c('typescript', 'TypeScript'), c('javascript', 'JavaScript'), c('python', 'Python'), c('csharp', 'C#'), c('java', 'Java'), c('go', 'Go'), c('rust', 'Rust'), c('other', 'Más')] },
  { id: 'python_typing', section: 'nyelv', type: 'choice', text: 'Pythonban mennyire kérsz típusjelölést?', when: { id: 'languages', includes: ['python'] }, options: [c('strict', 'Mindenhol, szigorúan'), c('public_api', 'Csak a nyilvános függvényeken'), c('none', 'Nem kérek')] },
  { id: 'naming', section: 'stílus', type: 'choice', text: 'Milyen elnevezési stílust követsen?', options: [c('follow_codebase', 'Azt, ami a kódbázisban van'), c('descriptive', 'Hosszabb, leíró nevek'), c('short', 'Rövid nevek')] },
  { id: 'comments', section: 'stílus', type: 'choice', text: 'Mennyi megjegyzést írjon a kódba?', options: [c('none', 'Semmit'), c('why_only', 'Csak a miértet'), c('thorough', 'Részletesen')] },
  { id: 'errors', section: 'stílus', type: 'choice', text: 'Hogyan kezelje a hibákat?', options: [c('fail_fast', 'Gyorsan álljon le hibával'), c('defensive', 'Védekezően, helyreállítással'), c('match_codebase', 'Igazodjon a kódbázishoz')] },
  { id: 'dependencies', section: 'stílus', type: 'choice', text: 'Mennyire adhat hozzá új függőséget?', options: [c('minimal', 'Lehetőleg ne'), c('pragmatic', 'Ha tényleg megéri'), c('any', 'Bármikor')] },
  { id: 'testing', section: 'tesztelés', type: 'choice', text: 'Hogyan tesztelsz?', options: [c('tdd', 'Először a teszt (TDD)'), c('tests_after', 'Utána írom a teszteket'), c('critical_only', 'Csak a kritikus részekre'), c('none', 'Nem tesztelek')] },
  { id: 'change_size', section: 'munkamenet', type: 'choice', text: 'Mekkora változtatásokat várj egyszerre?', options: [c('small_steps', 'Kis lépések'), c('feature_sized', 'Egy funkciónyi'), c('any', 'Mindegy')] },
  { id: 'confirm_before', section: 'munkamenet', type: 'multi', text: 'Mit kérdezzen meg előbb, mielőtt megtenné?', options: [c('delete_files', 'Fájl törlése'), c('add_dependency', 'Új függőség'), c('large_refactor', 'Nagy átalakítás'), c('git_push', 'Git push'), c('nothing', 'Semmit')] },
  { id: 'explain_depth', section: 'munkamenet', type: 'choice', text: 'Mennyire magyarázzon?', options: [c('short', 'Röviden'), c('normal', 'Közepesen'), c('detailed', 'Részletesen')] },
  { id: 'reply_language', section: 'munkamenet', type: 'choice', text: 'Milyen nyelven válaszoljon?', options: [c('hu', 'Magyar'), c('en', 'Angol')] },
  { id: 'learning_goal', section: 'tanulás', type: 'text', maxLength: 200, text: 'Mit szeretnél jobban megtanulni? (szabad szöveg, kihagyható)' },
  { id: 'never_do', section: 'tanulás', type: 'text', maxLength: 300, text: 'Mit ne csináljon soha? (szabad szöveg, kihagyható)' },
];

export interface StoredAnswer {
  /** null = skipped: no preference. */
  value: string | string[] | null;
  at: number;
}

export interface ProfileState {
  version: 1;
  answers: Record<string, StoredAnswer>;
}

export const emptyProfile = (): ProfileState => ({ version: 1, answers: {} });

const find = (id: string): Question => {
  const q = QUESTIONS.find((x) => x.id === id);
  if (!q) throw new ProfileError(`unknown question '${id}'; ids: ${QUESTIONS.map((x) => x.id).join(', ')}`);
  return q;
};

const asList = (v: StoredAnswer['value']): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);

/** Whether the question applies, given the answers so far. */
export function isActive(state: ProfileState, q: Question): boolean {
  if (!q.when) return true;
  const given = asList(state.answers[q.when.id]?.value ?? null);
  return q.when.includes.some((x) => given.includes(x));
}

export interface Progress {
  answered: number;
  skipped: number;
  total: number;
}

export function progress(state: ProfileState): Progress {
  const active = QUESTIONS.filter((q) => isActive(state, q));
  const answers = active.map((q) => state.answers[q.id]).filter((a): a is StoredAnswer => a !== undefined);
  return { answered: answers.filter((a) => a.value !== null).length, skipped: answers.filter((a) => a.value === null).length, total: active.length };
}

/** The next unanswered question, optionally limited to one section; null when done. */
export function nextQuestion(state: ProfileState, section?: string): Question | null {
  if (section !== undefined && !QUESTIONS.some((q) => q.section === section)) {
    throw new ProfileError(`unknown section '${section}'; sections: ${[...new Set(QUESTIONS.map((q) => q.section))].join(', ')}`);
  }
  return QUESTIONS.find((q) => (section === undefined || q.section === section) && isActive(state, q) && state.answers[q.id] === undefined) ?? null;
}

export interface AnswerResult {
  state: ProfileState;
  warnings: string[];
}

/** Record an answer (or, with `raw === null`, a skip). Pure: returns a new state. */
export function applyAnswer(state: ProfileState, id: string, raw: string | null, now: number): AnswerResult {
  const q = find(id);
  if (!isActive(state, q)) throw new ProfileError(`question '${id}' does not apply to the answers so far`);
  const warnings: string[] = [];
  let value: StoredAnswer['value'];

  if (raw === null) {
    value = null;
  } else if (q.type === 'choice') {
    const v = raw.trim();
    if (!q.options!.some((o) => o.value === v)) throw new ProfileError(`'${id}' takes one of: ${q.options!.map((o) => o.value).join(', ')}`);
    value = v;
  } else if (q.type === 'multi') {
    const parts = [...new Set(raw.split(',').map((p) => p.trim()).filter(Boolean))];
    const bad = parts.filter((p) => !q.options!.some((o) => o.value === p));
    if (parts.length === 0 || bad.length > 0) throw new ProfileError(`'${id}' takes a comma-separated list from: ${q.options!.map((o) => o.value).join(', ')}`);
    value = parts;
  } else {
    const text = raw.trim();
    if (!text) throw new ProfileError(`'${id}' needs text; use --skip for no preference`);
    if (text.length > q.maxLength!) throw new ProfileError(`'${id}' is limited to ${q.maxLength} characters`);
    const scan = scanText(text);
    if (scan.verdict === 'hostile') throw new ProfileError(`'${id}' refused: the text looks hostile (${scan.threats.map((t) => t.description).join('; ')}). A profile comes back as instructions to the agents.`);
    const redacted = redactText(text);
    if (redacted.changed) warnings.push(`'${id}': personal data or a secret was replaced before storing (${redacted.findings.map((f) => f.kind).join(', ')})`);
    value = redacted.text;
  }

  const answers = { ...state.answers, [id]: { value, at: now } };
  // A conditional answer whose condition no longer holds is dropped, not kept as a stale preference.
  const next: ProfileState = { version: 1, answers };
  for (const dep of QUESTIONS) if (dep.when && !isActive(next, dep)) delete next.answers[dep.id];
  return { state: next, warnings };
}

/** The answers as {id: value}, skipped questions left out: what an agent should be given. */
export function effectivePreferences(state: ProfileState): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const q of QUESTIONS) {
    const a = state.answers[q.id];
    if (a && a.value !== null && isActive(state, q)) out[q.id] = a.value;
  }
  return out;
}

export async function loadProfile(file: string): Promise<ProfileState> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return emptyProfile();
    throw err;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProfileError(`profile file is not valid JSON: ${file}; fix or remove it (it is never overwritten silently)`);
  }
  if (parsed?.version !== 1 || typeof parsed.answers !== 'object' || parsed.answers === null) {
    throw new ProfileError(`profile file has an unknown format: ${file}`);
  }
  return parsed as ProfileState;
}

export async function saveProfile(file: string, state: ProfileState): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(state, null, 2));
}
