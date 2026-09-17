import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classify, detectFeatures, parseVersion } from '../src/capabilities.js';

const help = readFileSync(
  new URL('../../../tools/fixtures/claude-help-2.1.272.txt', import.meta.url),
  'utf8',
);

describe('capability probe against the real v2.1.272 surface', () => {
  const features = detectFeatures(help);

  it('detects every flag and subcommand the cockpit depends on', () => {
    expect(features).toMatchObject({
      background: true,
      attach: true,
      logs: true,
      stop: true,
      respawn: true,
      agentsJson: true,
      forkSession: true,
      sessionId: true,
      name: true,
    });
  });

  it('classifies the tested version as supported', () => {
    expect(classify('2.1.272', features).tier).toBe('supported');
  });

  it('degrades rather than failing when background/attach disappear', () => {
    const c = classify('2.1.272', { ...features, background: false, attach: false });
    expect(c.tier).toBe('degraded');
    expect(c.notes.join(' ')).toMatch(/tmux/);
  });

  it('is optimistic about newer versions but says so', () => {
    const c = classify('9.9.9', features);
    expect(c.tier).toBe('supported');
    expect(c.notes.join(' ')).toMatch(/newer than the last tested/);
  });

  it('refuses versions below the supported minimum', () => {
    expect(classify('1.0.0', features).tier).toBe('unsupported');
  });

  it('parses the version string', () => {
    expect(parseVersion('2.1.272 (Claude Code)')).toBe('2.1.272');
  });
});
