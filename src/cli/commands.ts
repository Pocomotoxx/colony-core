import path from 'node:path';
import { parseArgs } from 'node:util';
import { BUILTIN_AGENT_PROFILES } from '../agents/agent-profiles.js';
import { ColonySession, loadRules, resolveRevision, STATE_DIR } from './session.js';
import { withStateLock } from '../state-lock.js';

import { CliError, CommandContext, CommandResult, Handler, OPTIONS } from './context.js';
import { tasksHandlers } from './commands-tasks.js';
import { claimsHandlers } from './commands-claims.js';
import { consensusHandlers } from './commands-consensus.js';
import { inspectHandlers } from './commands-inspect.js';
import { safetyHandlers } from './commands-safety.js';
import { memoryHandlers } from './commands-memory.js';
import { errorMessage } from '../errors.js';

export type { CommandResult } from './context.js';

const HANDLERS: Record<string, Handler> = { ...tasksHandlers, ...claimsHandlers, ...consensusHandlers, ...inspectHandlers, ...safetyHandlers, ...memoryHandlers };

export const USAGE = `colony <command> [options]    (every command prints JSON; run \`colony boot\` first)

  boot                                    load the colony, report boot status, print the work protocol
  status                                  members, tasks, open proposals
  task add <title> <description>          [--role R] [--after id,id] [--priority P] [--consensus QUORUM] [--review [--max-review-rounds N]]
  review <taskId> --as <reviewer> (--approve|--reject) --reason <text>   a rejection sends the work back; after N rejections (default 3) the task goes on hold for the user
  plan <taskId> [--kind K] [--apply]      analyze a task and propose its steps, waves and strategy; --apply creates them as tasks
  health [--queue-depth N] [--long-wait-min N]   groups, bottlenecks, alerts, recommendations (read-only, heuristic thresholds)
  score <taskId>                       rank the members for a task (heuristic weights), with backups and why the others cannot
  member list | member preset standard    list members; add the built-in roles a colony is missing
  next --as <role|memberId>              take the next task for that role (with memory context)
  done <taskId> --result <text>           complete a task; a real, non-empty result is required
                                          [--quality 0..1] [--verified-by-test]   what you report; the colony learns from it but cannot check it
  profile interview [--section S]         the next question of the developer profile (fixed questions, skippable)
  profile answer <questionId> <value>     [--skip = no preference]   store an answer; returns the next question
  profile show | profile reset            your answers so far / start over
  verify <taskId> [--timeout-sec N] -- <command> [args...]   the colony runs the check itself and records the evidence; a failed run lowers the quality
  rate <taskId> --quality 0..1            rate a finished task after the fact; the colony memory learns from your rating
  fail <taskId> --error <text>            mark a task failed  [--quality 0..1: how far it got]
  propose <taskId> <topic> --as <member>  [--quorum N | --strategy majority|supermajority|byzantine|unanimous] [--timeout-min M] [--data text]
  topology                                [--type mesh|star|tree|hybrid] [--fanout N] [--degree N] [--from id --to id]
  check                                   run gates BEFORE acting: [--command TEXT] [--text TEXT] [--file PATH [--diff-lines N] [--threshold N]]
                                          [--tool NAME --allow a,b*]; exit 3 on "block". A gate is a check you call, not an interceptor.
  scan (--text TEXT | --file PATH)        look for injection phrasing, hidden characters, personal data; exit 3 on "hostile"
  redact (--text TEXT | --file PATH)      replace e-mail, card, IBAN, phone, IP, JWT, database URL and secrets by placeholders
                                          [--hash kind,kind --salt S]   salted hash instead of a placeholder (never for secrets)
  route test <text>                 which role the router would pick (no side effects)
  route teach <text> --role R [--reward -1..1]   teach it: this kind of task belongs to R (or not, when negative)
  route stats                             how routed tasks spread over roles, and how much was learned
  audit list [--task id] [--type t] [--k N]   the hash-chained log of what was done, by whom
  audit verify                            check the chain and that the log still holds the entry anchored at the last boot
  watch [--task id]                       the Deputy's mechanical checks: loops, repeated failures, cycling claims, stalled or unreviewed work, log integrity (read-only)
  hold <taskId> --as <auditor> --reason <text>        put a task on hold: it cannot be completed or dispatched until released
  hold release <taskId> --as <member> --note <text>   release it; the note is what the user decided (the colony cannot check that a person did)
  claim list | sweep                  who holds which task; sweep marks stale or long-blocked claims stealable
  claim heartbeat <taskId> --as <member>  [--progress 0..100]   show life; takes a stealable claim back
  claim block <taskId> --as <member> --reason <text> | claim unblock <taskId> --as <member>
  claim release <taskId> --as <member>    give the task up (anyone may take it over at once)
  claim steal <taskId> --as <member>      take over a stealable claim (after its grace period)
  claim handoff <taskId> --as <member> --to <member> --reason <text> | claim accept|reject <taskId> --as <member>
  vote <proposalId> --as <member> (--approve|--reject) --reason <text> [--confidence 0..1]   (advisory: stored and reported, never counted as a weight)
  memory add <text>                       [--ns NAMESPACE] [--allow-risky]   hostile text is refused unless --allow-risky
  memory search <query>                   [--k N] [--ns NAMESPACE]

Global: --dir <path>  project directory (default: current directory)`;

const PROTOCOL = [
  'You (the host) are the model: the colony keeps the ledger, the routing, the votes and the memory.',
  'The rule files in `rules` are binding for this session; read them in full before starting work.',
  'Boot proves the state and the rule files were read and hashed. It does not prove that you applied the rules.',
];

export async function runCommand(argv: string[], cwd: string): Promise<CommandResult> {
  try {
    return await dispatch(argv, cwd);
  } catch (err) {
    return { code: err instanceof CliError ? err.code : 1, output: { ok: false, error: errorMessage(err) } };
  }
}

async function dispatch(argv: string[], cwd: string): Promise<CommandResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: OPTIONS,
    });
  } catch (err) {
    throw new CliError(`${errorMessage(err)}\n${USAGE}`);
  }

  const { values, positionals } = parsed;
  const dir = path.resolve(cwd, values.dir ?? '.');
  const [command, sub] = positionals;

  if (!command || command === 'help' || values.help) return { code: 0, output: { ok: true, usage: USAGE } };
  // The whole command loads and rewrites the state, so it runs under the state lock.
  return withStateLock(path.join(dir, STATE_DIR), async (): Promise<CommandResult> => {

    if (command === 'boot') {
      const { record, session, rules } = await ColonySession.boot(dir);
      const ok = record.status !== 'BLOCKED';
      return {
        code: ok ? 0 : 2,
        output: {
          ok,
          boot: record,
          ...(session ? { colony: session.hub.getSnapshot(), roles: Object.values(BUILTIN_AGENT_PROFILES).map((p) => p.role) } : {}),
          protocol: PROTOCOL,
          ...(ok ? { rules: rules.map((r) => ({ path: r.path, sha256: r.sha256, text: r.text })) } : {}),
        },
      };
    }

    const boot = await ColonySession.readBootRecord(dir);
    if (!boot || boot.status === 'BLOCKED') {
      throw new CliError(boot ? `last boot was BLOCKED: ${boot.problems.join('; ')}` : 'colony is not booted: run `colony boot`', 2);
    }
    const currentRules = await loadRules(dir);
    const booted = new Map((boot.rules ?? []).map((r) => [r.path, r.sha256]));
    const drifted =
      currentRules.problems.length > 0 ||
      currentRules.rules.length !== booted.size ||
      currentRules.rules.some((r) => booted.get(r.path) !== r.sha256);
    if (drifted) throw new CliError('rule files changed, vanished or became unreadable since boot: run `colony boot` again', 2);

    const warnings: string[] = [];
    if (resolveRevision(dir).sha !== boot.revision) warnings.push('git revision changed since boot; run `colony boot` again');

    const session = await ColonySession.open(dir);
    const { hub } = session;
    /** What the Deputy's watch says about this task, right after it was closed. Advice, not a gate. */
    const deputyNotes = (taskId: string) =>
      hub
        .watch({ focusTaskId: taskId, anchor: boot.audit })
        .findings.filter((f) => f.severity !== 'low')
        .map((f) => ({ kind: f.kind, severity: f.severity, detail: f.detail }));
    const log = (type: string, aggregateId: string, payload: Record<string, unknown> = {}) =>
      hub.audit.append({ type, aggregateId, actor: values.as ?? 'host', payload }, Date.now());
    const reply = (output: Record<string, unknown>): CommandResult => ({ code: 0, output: { ok: true, ...output, ...(warnings.length ? { warnings } : {}) } });

    const handler = HANDLERS[command];
    if (!handler) throw new CliError(`unknown command '${command}'\n${USAGE}`);
    return handler({ values, positionals, command, sub, dir, boot, session, hub, warnings, log, reply, deputyNotes } as CommandContext);
  });
}
