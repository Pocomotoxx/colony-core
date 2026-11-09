import {
  applyAnswer, effectivePreferences, emptyProfile, loadProfile, nextQuestion, progress, ProfileError, ProfileState, Question, saveProfile,
} from '../profile/profile.js';

export { ProfileError };

export interface ProfileInput {
  file: string;
  sub: string | undefined;
  args: string[];
  section?: string;
  skip: boolean;
  now: number;
}

export interface ProfileOutput {
  output: Record<string, unknown>;
  warnings: string[];
  /** Set when an answer was stored or the profile was reset (for the audit log; never the content). */
  changed?: { action: 'answered' | 'skipped' | 'reset'; id?: string };
}

const view = (q: Question) => ({
  id: q.id,
  section: q.section,
  text: q.text,
  type: q.type,
  ...(q.options ? { options: q.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
  ...(q.maxLength ? { maxLength: q.maxLength } : {}),
});

const step = (state: ProfileState, section?: string) => {
  const q = nextQuestion(state, section);
  return q ? { next: view(q), progress: progress(state) } : { done: true, progress: progress(state), preferences: effectivePreferences(state) };
};

/**
 * The profile interview as stateless steps: `interview` returns the next question, `answer` stores
 * one answer and returns the question after it. Interrupt and continue any time.
 */
export async function runProfile(input: ProfileInput): Promise<ProfileOutput> {
  const { file, sub, args, section, skip, now } = input;

  if (sub === 'interview') return { output: step(await loadProfile(file), section), warnings: [] };

  if (sub === 'show') {
    const state = await loadProfile(file);
    return { output: { progress: progress(state), preferences: effectivePreferences(state), skipped: Object.entries(state.answers).filter(([, a]) => a.value === null).map(([id]) => id) }, warnings: [] };
  }

  if (sub === 'answer') {
    const [id, value] = args;
    if (!id) throw new ProfileError('usage: profile answer <questionId> <value> | profile answer <questionId> --skip');
    if (skip && value !== undefined) throw new ProfileError('pass either a value or --skip, not both');
    if (!skip && value === undefined) throw new ProfileError(`profile answer ${id} needs a value, or --skip for no preference`);
    const { state, warnings } = applyAnswer(await loadProfile(file), id, skip ? null : value!, now);
    await saveProfile(file, state);
    return { output: { recorded: id, skipped: skip, ...step(state, section) }, warnings, changed: { action: skip ? 'skipped' : 'answered', id } };
  }

  if (sub === 'reset') {
    await saveProfile(file, emptyProfile());
    return { output: { reset: true }, warnings: [], changed: { action: 'reset' } };
  }

  throw new ProfileError('usage: profile interview [--section S] | profile answer <id> <value> [--skip] | profile show | profile reset');
}
