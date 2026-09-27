/**
 * The agent-neutral session contract.
 *
 * It lives in `core` rather than in either adapter because both of them
 * implement it and neither may know the other exists: `claude-adapter` is the
 * only place allowed to know about `~/.claude` and the `claude` CLI,
 * `hermes-adapter` the only one allowed to know about `~/.hermes` and `hermes`.
 * Everything above them speaks this vocabulary and routes by `AgentId`.
 */

/** Every agent the cockpit can drive. The default is first. */
export const AGENT_IDS = ['claude', 'hermes'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** What the UI calls each one. */
export const AGENT_LABEL: Record<AgentId, string> = {
  claude: 'claude',
  hermes: 'hermes',
};

export const DEFAULT_AGENT: AgentId = 'claude';

export function isAgentId(v: unknown): v is AgentId {
  return typeof v === 'string' && (AGENT_IDS as readonly string[]).includes(v);
}

/** Coerces anything stored or sent over the wire, defaulting rather than throwing. */
export function toAgentId(v: unknown): AgentId {
  return isAgentId(v) ? v : DEFAULT_AGENT;
}

/**
 * A session ref's external id: `<agent>:<session key>`.
 *
 * The prefix is what lets an id-only code path — `pty.open`, a stop, a usage
 * lookup — find the runner that owns it without being handed the track. Refs
 * written before there was more than one agent have no prefix at all, so a
 * bare id reads as Claude's, which is what it was.
 */
export function sessionKey(agent: AgentId, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

export function agentOf(externalId: string): AgentId {
  const i = externalId.indexOf(':');
  return i < 0 ? DEFAULT_AGENT : toAgentId(externalId.slice(0, i));
}

/** The id as its own agent knows it, with our prefix taken off. */
export function sessionIdOf(externalId: string): string {
  const i = externalId.indexOf(':');
  return i < 0 ? externalId : externalId.slice(i + 1);
}

/** Our single normalized view of a session, whoever is running it. */
export interface NormalizedSession {
  /** Which CLI owns it. */
  agent: AgentId;
  /** The durable join key, in the owning agent's own id space. */
  sessionId: string;
  /** Short id the agent's own commands take. Derived when absent. */
  shortId: string;
  kind: 'background' | 'interactive';
  cwd: string;
  name: string | null;
  startedAt: number;
  pid: number | null;
  /** Normalized from whatever asymmetric shape the agent reports. */
  state: SessionState;
  /** What the agent actually said, kept for debugging and for unknown values. */
  rawState: string | null;
  /**
   * Whether the process is doing something right now. Null when the row has no
   * process to ask.
   */
  busy: boolean | null;
  confidence: StateConfidence;
  /**
   * The id the agent files this conversation under, when that is not the key we
   * run it by. Hermes writes its session row on the first message, so a session
   * we just started has a key of ours and no id of its own yet.
   */
  agentSessionId?: string | null;
}

export type SessionState =
  | 'STARTING'
  | 'WORKING'
  | 'NEEDS_INPUT'
  | 'NEEDS_PERMISSION'
  | 'IDLE'
  | 'FAILED'
  | 'STOPPED'
  | 'RESUMABLE'
  | 'UNKNOWN';

/**
 * `observed`  — the agent confirmed it within the freshness window.
 * `derived`   — inferred from the transcript or the session store alone.
 * `stale`     — no confirmation recently; the UI renders this as a hollow dot.
 *
 * Honest ambiguity beats a confident lie.
 */
export type StateConfidence = 'observed' | 'derived' | 'stale';

export interface StartedSession {
  agent: AgentId;
  sessionId: string;
  shortId: string;
  name: string | null;
  cwd: string;
  agentSessionId?: string | null;
}

/** One conversation that ran here before and can be picked up again. */
export interface PastSession {
  agent: AgentId;
  sessionId: string;
  cwd: string;
  gitBranch: string | null;
  /** First line of the conversation, or whatever the agent titled it. */
  preview: string | null;
  lastActivityAt: number;
}

/** What a session has spent. Tokens are the agent's own numbers, never estimates. */
export interface SessionUsage {
  sessionId: string;
  model: string | null;
  gitBranch: string | null;
  /**
   * What the most recent request sent: how much the conversation weighs now.
   * Null when the agent does not record it — hermes keeps per-session totals but
   * nothing per request, and a number made up from message lengths would look
   * exactly as authoritative as one that is real.
   */
  contextTokens: number | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  subagents: number;
  subagentTokens: number;
  /**
   * What the conversation cost, when the agent prices it itself. Null for Claude
   * on purpose: dollars there would need a price table that goes stale on the
   * next pricing change. Hermes stores the figure, so it is passed through.
   */
  costUsd: number | null;
  lastActivityAt: number | null;
}

/** Whether an agent can be driven at all, and how well. */
export interface AgentCompat {
  agent: AgentId;
  cliVersion: string;
  tier: 'supported' | 'degraded' | 'unsupported';
  /** False when the CLI is not installed, or something it needs is missing. */
  available: boolean;
  notes: string[];
}

/**
 * Every agent implements this. What differs underneath is who owns a session's
 * lifetime: Claude's own supervisor for `ClaudeBgRunner`, a detached tmux
 * session for `HermesRunner` (see docs/decisions/0003-hermes-substrate.md).
 */
export interface SessionRunner {
  readonly agent: AgentId;
  /** An absent prompt starts the session idle, waiting for its first message. */
  start(o: {
    cwd: string;
    prompt?: string;
    name?: string;
    sessionId?: string;
  }): Promise<StartedSession>;
  /** argv for a PTY the daemon owns, and for the "attach in your terminal" button. */
  attachCommand(s: { shortId: string }): { file: string; args: string[] };
  /**
   * `cwd` matters: an agent looks a transcript up under the folder it runs in.
   * `agentSessionId` is passed when the key we run a session by is not the id
   * its own agent files it under — see NormalizedSession.agentSessionId.
   */
  resume(o: {
    sessionId: string;
    cwd?: string;
    fork?: boolean;
    agentSessionId?: string | null;
  }): Promise<StartedSession>;
  stop(s: { shortId: string }): Promise<void>;
  remove(s: { shortId: string }): Promise<void>;
  list(): Promise<NormalizedSession[]>;
  /** Recent raw ANSI bytes. Works without a TTY. */
  logs(s: { shortId: string }): Promise<string>;
  /** Conversations that ran in a folder before and are not live now. */
  past(cwd: string): PastSession[];
  /** Whether a session can still be picked up at all. */
  canResume(sessionId: string, agentSessionId?: string | null): boolean;
  /** Tokens spent, by whichever of a session's ids are known. */
  usage(sessionIds: string[], cwdHint?: string): SessionUsage | null;
  probe(): Promise<AgentCompat>;
}
