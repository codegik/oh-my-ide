import { describe, expect, it } from 'vitest';
import { cleanTitle, stripSuspend, TitleScanner } from '../src/pty.js';

/**
 * The CLI never renames a session, but it does publish a running summary of the
 * conversation as the terminal title. That is what names a session here, so the
 * scanner has to survive the shape of real output — including titles split over
 * writes, and titles the CLI starts and then abandons.
 */
describe('TitleScanner', () => {
  const feed = (...chunks: string[]) => {
    const s = new TitleScanner();
    return chunks.map((c) => s.push(c));
  };

  it('reads a BEL-terminated title out of real output', () => {
    // Verbatim tail from `claude attach` after a first prompt, v2.1.272.
    const real =
      '\x1b[38;2;255;168;76mTransmogrifying…\x1b[39m\x1b[30;1H\x1b[28;3H' +
      '\x1b[?25h\x1b]0;✳ Reply with exactly ok\x07\x1b[?25l\x1b[H';
    expect(feed(real)).toEqual(['Reply with exactly ok']);
  });

  it('accepts the ST terminator and OSC 2 as well', () => {
    expect(feed('\x1b]2;fix the retry storm\x1b\\')).toEqual(['fix the retry storm']);
  });

  it('assembles a title split across writes', () => {
    expect(feed('\x1b]0;✳ Reply with', ' exactly ok\x07')).toEqual([null, 'Reply with exactly ok']);
  });

  it('keeps the last title in a chunk, because the CLI repaints it', () => {
    expect(feed('\x1b]0;first\x07 noise \x1b]0;second\x07')).toEqual(['second']);
  });

  it('abandons a title interrupted by another escape, instead of splicing', () => {
    // This is the bug the state machine exists for: a started-then-abandoned
    // title must not be completed by an unrelated BEL later in the stream.
    expect(feed('\x1b]0;half a tit', '\x1b[2Kredraw', 'Reply session\x07')).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('gives nothing for plain output or a title of only decoration', () => {
    expect(feed('\x1b[2J\x1b[H plain output')).toEqual([null]);
    expect(feed('\x1b]0;✳\x07')).toEqual([null]);
  });

  it('stops assembling once a title is absurdly long', () => {
    expect(feed(`\x1b]0;${'x'.repeat(400)}\x07`)).toEqual([null]);
  });

  it('ignores OSC 9;4 progress reports instead of naming a session after them', () => {
    // Regression: this was landing as a session name like "9;4;3;".
    expect(feed('\x1b]9;4;3;50\x07')).toEqual([null]);
    expect(feed('\x1b]9;4;0;0\x1b\\')).toEqual([null]);
  });

  it('still reads a real title arriving right after an ignored OSC 9;4', () => {
    expect(feed('\x1b]9;4;3;50\x07\x1b]0;fix the retry storm\x07')).toEqual([
      'fix the retry storm',
    ]);
  });
});

describe('cleanTitle', () => {
  it('strips status glyphs, squeezes space, and caps the length', () => {
    expect(cleanTitle('✳  why   are payments  timing out')).toBe('why are payments timing out');
    expect(cleanTitle('x'.repeat(200))).toHaveLength(60);
  });
});

/**
 * Ctrl+Z makes the CLI hand the terminal back and wait for a shell to continue
 * it. There is no shell behind a view here, so the pane would go blank and stay
 * deaf while the session itself kept running — see the note in pty.ts.
 */
describe('stripSuspend', () => {
  const strip = (s: string) => stripSuspend(Buffer.from(s, 'utf8')).toString('utf8');

  it('drops Ctrl+Z, on its own or mixed into a burst of typing', () => {
    expect(strip('\x1a')).toBe('');
    expect(strip('hel\x1alo\x1a')).toBe('hello');
  });

  it('leaves every other control byte alone, Ctrl+C included', () => {
    // Ctrl+C, Esc, Enter, Tab, Backspace and a cursor key: all of them mean
    // something to the CLI, and only the one that wedges it is taken away.
    const keys = '\x03\x1b\r\t\x7f\x1b[A';
    expect(strip(keys)).toBe(keys);
  });

  it('keeps pasted text intact, accents and all', () => {
    const pasted = '\x1b[200~pensando em arquitetura, não em código\x1b[201~';
    expect(strip(pasted)).toBe(pasted);
    expect(stripSuspend(Buffer.from(pasted, 'utf8'))).toHaveLength(
      Buffer.byteLength(pasted, 'utf8'),
    );
  });
});
