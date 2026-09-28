import { describe, expect, it } from 'vitest';
import { newlineKeyFor } from '../src/renderer/keys.js';

/**
 * Shift+Enter has to mean "newline" in the pane, and what to send for it depends
 * on the agent. Getting it wrong sends the prompt instead of breaking the line —
 * a half-written message fired at the agent, which nothing can take back.
 */
describe('newlineKeyFor', () => {
  it('sends Meta+Enter to claude, which is what its terminal setup binds', () => {
    expect(newlineKeyFor('claude:1a2b3c4d')).toBe('\x1b\r');
  });

  /**
   * Not ESC CR: a hermes session runs under tmux, and `M-Enter` is a key a tmux
   * config can bind (this repo's author splits the pane with it) — the binding
   * eats the key and hermes never sees it. CSI u has no such collision.
   */
  it('sends CSI u Shift+Enter to hermes, which tmux forwards instead of binding', () => {
    expect(newlineKeyFor('hermes:1a2b3c4d')).toBe('\x1b[13;2u');
  });

  it('falls back to Meta+Enter for an agent it does not know', () => {
    expect(newlineKeyFor('somethingelse:1a2b3c4d')).toBe('\x1b\r');
    expect(newlineKeyFor('1a2b3c4d')).toBe('\x1b\r');
  });
});
