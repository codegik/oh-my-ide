import { runClaude } from './cli.js';
import type { ClaudeCompat } from './types.js';

/** The version range this app has actually been exercised against. */
export const KNOWN_GOOD = { min: '2.1.0', testedUpTo: '2.1.272' } as const;

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function parseVersion(stdout: string): string {
  return /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? '0.0.0';
}

/**
 * Feature-detect rather than version-gate wherever possible: a flag that still
 * exists is more trustworthy than a version number we recognize.
 */
export function detectFeatures(help: string): ClaudeCompat['features'] {
  const has = (re: RegExp) => re.test(help);
  return {
    background: has(/--bg\b|--background\b/),
    attach: has(/^\s*attach\b/m),
    logs: has(/^\s*logs\b/m),
    stop: has(/^\s*stop\b/m),
    respawn: has(/^\s*respawn\b/m),
    agentsJson: has(/^\s*agents\b/m),
    forkSession: has(/--fork-session\b/),
    sessionId: has(/--session-id\b/),
    name: has(/-n, --name\b/),
  };
}

export function classify(version: string, f: ClaudeCompat['features']): ClaudeCompat {
  const notes: string[] = [];
  let tier: ClaudeCompat['tier'] = 'supported';

  // Attach and background are what the cockpit is built on. Without them we fall
  // back to TmuxRunner rather than pretending.
  if (!f.background || !f.attach) {
    tier = 'degraded';
    notes.push('`claude --bg`/`attach` not detected — falling back to the tmux substrate.');
  }
  if (!f.agentsJson) {
    tier = 'degraded';
    notes.push('`claude agents` not detected — session discovery will rely on transcripts alone.');
  }
  if (cmpSemver(version, KNOWN_GOOD.min) < 0) {
    tier = 'unsupported';
    notes.push(`Claude Code ${version} is older than the supported minimum ${KNOWN_GOOD.min}.`);
  } else if (cmpSemver(version, KNOWN_GOOD.testedUpTo) > 0) {
    // Optimistic: newer than we tested is fine until something actually fails.
    notes.push(`Claude Code ${version} is newer than the last tested ${KNOWN_GOOD.testedUpTo}.`);
  }
  return { cliVersion: version, tier, features: f, notes };
}

export async function probe(): Promise<ClaudeCompat> {
  const version = parseVersion(await runClaude(['--version'], { timeoutMs: 10_000 }));
  const help = await runClaude(['--help'], { timeoutMs: 10_000 });
  return classify(version, detectFeatures(help));
}
