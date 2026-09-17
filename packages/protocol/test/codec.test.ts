import { describe, expect, it } from 'vitest';
import { LineDecoder, encodeLine } from '../src/index.js';

describe('LineDecoder', () => {
  it('holds an incomplete trailing line across chunks', () => {
    const d = new LineDecoder();
    expect(d.push('{"a":1}\n{"b":')).toEqual([{ a: 1 }]);
    expect(d.push('2}\n')).toEqual([{ b: 2 }]);
  });

  it('survives a split at every possible byte boundary', () => {
    const msgs = [{ t: 'hello', protocol: 1 }, { t: 'rpc', id: 7, method: 'sessions.list' }];
    const wire = msgs.map(encodeLine).join('');
    // A socket read boundary lands mid-message often enough that not buffering
    // is a guaranteed bug, so prove every split works.
    for (let cut = 0; cut <= wire.length; cut++) {
      const d = new LineDecoder();
      const out = [...d.push(wire.slice(0, cut)), ...d.push(wire.slice(cut))];
      expect(out).toEqual(msgs);
    }
  });

  it('drops malformed lines without throwing', () => {
    const d = new LineDecoder();
    expect(d.push('not json\n{"ok":true}\n')).toEqual([{ ok: true }]);
  });

  it('ignores blank lines', () => {
    expect(new LineDecoder().push('\n\n{"a":1}\n')).toEqual([{ a: 1 }]);
  });
});
