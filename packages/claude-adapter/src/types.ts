/**
 * Normalized types the rest of the app sees. Nothing outside this package may
 * know that `~/.claude` or the `claude` CLI exist.
 *
 * The session vocabulary itself — `NormalizedSession`, `SessionRunner` and the
 * rest — is agent-neutral and lives in `@omi/core`, because the hermes adapter
 * implements the same contract and neither adapter may import the other. Only
 * what is genuinely Claude-shaped stays here.
 */

export type {
  AgentCompat,
  AgentId,
  NormalizedSession,
  SessionRunner,
  SessionState,
  SessionUsage,
  StartedSession,
  StateConfidence,
} from '@omi/core';

export interface ClaudeCompat {
  cliVersion: string;
  tier: 'supported' | 'degraded' | 'unsupported';
  features: {
    background: boolean;
    attach: boolean;
    logs: boolean;
    stop: boolean;
    respawn: boolean;
    agentsJson: boolean;
    forkSession: boolean;
    sessionId: boolean;
    name: boolean;
  };
  notes: string[];
}
