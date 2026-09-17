import { describe, expect, it } from 'vitest';
import { probe } from '../src/capabilities.js';
import { ClaudeBgRunner } from '../src/runner.js';

/**
 * Contract tests against the Claude CLI actually installed on this machine.
 * Opt-in (OMI_LIVE=1) so CI without a Claude install stays green.
 * Read-only: lists and probes, never starts or stops a session.
 */
const live = process.env.OMI_LIVE === '1' ? describe : describe.skip;

live('live CLI contract', () => {
  it('probes the installed CLI as supported', async () => {
    const c = await probe();
    expect(c.cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(c.features.background).toBe(true);
    expect(c.features.attach).toBe(true);
    expect(c.features.agentsJson).toBe(true);
    expect(c.tier).toBe('supported');
  }, 20_000);

  it('lists real sessions in the normalized shape', async () => {
    const sessions = await new ClaudeBgRunner().list();
    expect(Array.isArray(sessions)).toBe(true);
    for (const s of sessions) {
      expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(s.shortId).toMatch(/^[0-9a-f]{8}$/);
      expect(['background', 'interactive']).toContain(s.kind);
      expect(s.cwd.startsWith('/')).toBe(true);
      expect(s.state).not.toBe(undefined);
      // The short id must always agree with the session uuid.
      expect(s.sessionId.replace(/-/g, '').startsWith(s.shortId)).toBe(true);
    }
  }, 20_000);
});
