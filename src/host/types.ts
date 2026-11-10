/**
 * What the colony needs to know about a tool call, whatever host made it.
 *
 * The guard and the recorder work on these types only. A host adapter (see `claude-code.ts`)
 * translates a host's own payload into them, so supporting another host means writing another
 * adapter, not changing the checks.
 */

export type ToolCall =
  /** A shell command (Bash, PowerShell, ...). */
  | { kind: 'shell'; command: string }
  /** A tool that writes a file. `path` is undefined when the host sent none. `texts` is what it writes. */
  | { kind: 'file-write'; tool: string; path: string | undefined; texts: string[] }
  /** Anything the colony does not look into. */
  | { kind: 'other'; name: string };

export interface HostSession {
  /** The host's own identifier of the session, when it supplies one. */
  id?: string;
  /** The working directory the host reports. */
  cwd?: string;
}

export interface HostRequest {
  call: ToolCall;
  session: HostSession;
}

/** The guard's verdict, host-neutral. */
export type GuardDecision = 'allow' | 'ask' | 'deny';

export interface GuardVerdict {
  decision: GuardDecision;
  /** Shown to the host/user. Never contains a secret. */
  reason: string;
  /** Names of the gates that fired. */
  gates: string[];
  /** Non-blocking notes (warnings). */
  notes: string[];
}
