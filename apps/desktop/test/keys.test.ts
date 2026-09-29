import { describe, expect, it } from 'vitest';
import { clipboardKeyFor, newlineKeyFor, pastesImageOnEmpty } from '../src/renderer/keys.js';

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

/** A keydown as Chromium reports it for a US layout. */
function key(
  k: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
  code?: string,
) {
  return {
    key: k,
    code: code ?? (k.length === 1 ? `Key${k.toUpperCase()}` : k),
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
  };
}

/**
 * On Omarchy, Super+C / Super+V reach an app that is not tagged as a terminal
 * as plain Ctrl+C / Ctrl+V; Ctrl+Shift+C / Ctrl+Shift+V and the Insert pair are
 * the terminal ones. Every one of them has to do something in the pane.
 */
describe('clipboardKeyFor', () => {
  const H = 'hermes:1a2b3c4d';
  const C = 'claude:1a2b3c4d';

  it('pastes on Ctrl+Shift+V and Shift+Insert, whatever the agent', () => {
    for (const id of [H, C]) {
      expect(clipboardKeyFor(id, key('V', { ctrl: true, shift: true }), false)).toBe('paste');
      expect(clipboardKeyFor(id, key('Insert', { shift: true }), false)).toBe('paste');
    }
  });

  /**
   * Behind tmux, hermes' own ^V arrives rewritten as `ESC[118;5u` and does
   * nothing — so Super+V, which is Ctrl+V by the time it gets here, has to be
   * a paste we do ourselves.
   */
  it('pastes on Ctrl+V for hermes', () => {
    expect(clipboardKeyFor(H, key('v', { ctrl: true }), false)).toBe('paste');
  });

  it("leaves Claude's Ctrl+V to Claude, which pastes images with it", () => {
    expect(clipboardKeyFor(C, key('v', { ctrl: true }), false)).toBeNull();
  });

  it('copies on Ctrl+Shift+C and Ctrl+Insert, whatever the agent', () => {
    for (const id of [H, C]) {
      expect(clipboardKeyFor(id, key('C', { ctrl: true, shift: true }), false)).toBe('copy');
      expect(clipboardKeyFor(id, key('Insert', { ctrl: true }), false)).toBe('copy');
    }
  });

  /** Ctrl+C is the interrupt; it only copies when there is something to copy. */
  it('copies on Ctrl+C only with a selection in the terminal', () => {
    for (const id of [H, C]) {
      expect(clipboardKeyFor(id, key('c', { ctrl: true }), true)).toBe('copy');
      expect(clipboardKeyFor(id, key('c', { ctrl: true }), false)).toBeNull();
    }
  });

  it('follows the layout, and the key position only for a non-Latin layout', () => {
    // Dvorak: the key in QWERTY's V position types K, so it is not a paste.
    expect(clipboardKeyFor(H, key('k', { ctrl: true }, 'KeyV'), false)).toBeNull();
    // Russian: the V position types м, which is still Ctrl+V.
    expect(clipboardKeyFor(H, key('м', { ctrl: true }, 'KeyV'), false)).toBe('paste');
  });

  it('keeps its hands off other chords', () => {
    expect(clipboardKeyFor(H, key('v'), false)).toBeNull();
    expect(clipboardKeyFor(H, key('v', { alt: true, ctrl: true }), false)).toBeNull();
    expect(clipboardKeyFor(H, key('Insert'), false)).toBeNull();
    expect(clipboardKeyFor(H, key('Insert', { ctrl: true, shift: true }), false)).toBeNull();
    expect(clipboardKeyFor(H, key('x', { ctrl: true }), true)).toBeNull();
  });
});

/**
 * With no text on the clipboard hermes takes an empty bracketed paste as an
 * image paste. Claude would read the same bytes as nothing at all.
 */
describe('pastesImageOnEmpty', () => {
  it('is hermes only', () => {
    expect(pastesImageOnEmpty('hermes:1a2b3c4d')).toBe(true);
    expect(pastesImageOnEmpty('claude:1a2b3c4d')).toBe(false);
    expect(pastesImageOnEmpty('1a2b3c4d')).toBe(false);
  });
});
