import { describe, expect, it } from 'vitest';
import { ByteFramer } from '../qualification/synthetic-fence/byte-framer.js';

const bytes = (s: string) => Buffer.from(s);

function setup(onFrame?: (frame: string, framer: ByteFramer) => void, frameLimit = 4, queueLimit = 8) {
  const events: string[] = [];
  const framer = new ByteFramer(frameLimit, queueLimit, frame => {
    const value = Buffer.from(frame).toString();
    events.push(`frame:${value}`);
    onFrame?.(value, framer);
  }, () => events.push('end'), reason => events.push(`error:${reason}`));
  return { framer, events };
}

describe('synthetic byte framing', () => {
  it('splits partial, empty and coalesced frames independent of chunk size', () => {
    const { framer, events } = setup();
    framer.data(bytes('a'));
    framer.data(bytes('b\n\n1234\nx\n'));
    framer.end();
    expect(events).toEqual(['frame:ab', 'frame:', 'frame:1234', 'frame:x', 'end']);
  });

  it('orders reentrant chunks after the current chunk and copies queued bytes', () => {
    const queued = bytes('rd\n');
    const { framer, events } = setup((frame, input) => {
      if (frame === 'one') { input.data(queued); queued.fill(120); }
    }, 5);
    framer.data(bytes('one\ntwo\nthi'));
    framer.end();
    expect(events).toEqual(['frame:one', 'frame:two', 'frame:third', 'end']);
  });

  it('serializes reentrant EOF after all current and previously queued input', () => {
    const { framer, events } = setup((frame, input) => {
      if (frame === 'a') { input.data(bytes('c\n')); input.end(); }
    });
    framer.data(bytes('a\nb\n'));
    expect(events).toEqual(['frame:a', 'frame:b', 'frame:c', 'end']);
  });

  it('fails on oversized complete and partial frames, not aggregate chunk size', () => {
    const good = setup(); good.framer.data(bytes('1234\n1234\n1234\n'));
    expect(good.events).toEqual(['frame:1234', 'frame:1234', 'frame:1234']);
    const complete = setup(); complete.framer.data(bytes('12345\n'));
    expect(complete.events).toEqual(['error:frame limit']);
    const partial = setup(); partial.framer.data(bytes('123')); partial.framer.data(bytes('45'));
    expect(partial.events).toEqual(['error:frame limit']);
  });

  it('bounds reentrant bytes and queued EOF events', () => {
    const bytesOverflow = setup((_, input) => { input.data(bytes('12345')); }, 4, 4);
    bytesOverflow.framer.data(bytes('a\nb\n'));
    expect(bytesOverflow.events).toEqual(['frame:a', 'error:reentrant input limit']);
    const countOverflow = setup((_, input) => { for (let i = 0; i < 3; i++) input.end(); }, 4, 2);
    countOverflow.framer.data(bytes('a\n'));
    expect(countOverflow.events).toEqual(['frame:a', 'error:reentrant input limit']);
  });

  it('releases consumed reentrant buffers during sustained replenishment', () => {
    let count = 0;
    const { framer, events } = setup((_, input) => {
      const state = input as unknown as { queue: (Buffer | null | undefined)[]; queueIndex: number };
      if (state.queueIndex) expect(state.queue[state.queueIndex - 1]).toBeUndefined();
      if (++count < 1200) input.data(bytes('x\n'));
    });
    framer.data(bytes('x\n'));
    expect(count).toBe(1200);
    expect(events).toHaveLength(1200);
  });

  it('rejects empty reentrant data queued after EOF', () => {
    const { framer, events } = setup((_, input) => { input.end(); input.data(bytes('')); });
    framer.data(bytes('a\n'));
    expect(events).toEqual(['frame:a', 'end', 'error:late stream data']);
  });

  it('handles a frame delivered byte by byte at the boundary', () => {
    const { framer, events } = setup(undefined, 4096);
    for (let i = 0; i < 4096; i++) framer.data(bytes('x'));
    framer.data(bytes('\n'));
    expect(events).toEqual([`frame:${'x'.repeat(4096)}`]);
  });

  it('propagates errors thrown by the error callback consistently', () => {
    const framer = new ByteFramer(1, 1, () => {}, () => {}, () => { throw new Error('error handler'); });
    expect(() => framer.data(bytes('xx'))).toThrow('error handler');
    const invalid = new ByteFramer(1, 1, () => {}, () => {}, () => { throw new Error('error handler'); });
    expect(() => invalid.data('bad')).toThrow('error handler');
  });

  it('rejects incomplete, repeated and late input', () => {
    const incomplete = setup(); incomplete.framer.data(bytes('x')); incomplete.framer.end();
    expect(incomplete.events).toEqual(['error:premature or incomplete EOF']);
    const duplicate = setup(); duplicate.framer.end(); duplicate.framer.end();
    expect(duplicate.events).toEqual(['end', 'error:premature or incomplete EOF']);
    const late = setup(); late.framer.end(); late.framer.data(bytes(''));
    expect(late.events).toEqual(['end', 'error:late stream data']);
  });

  it('fails once on invalid input, callback exceptions or explicit abort', () => {
    const invalid = setup(); invalid.framer.data('not bytes'); invalid.framer.data(bytes('a\n'));
    expect(invalid.events).toEqual(['error:non-byte stream data']);
    const thrown = setup(() => { throw new Error('handler failed'); });
    thrown.framer.data(bytes('a\nb\n')); thrown.framer.end();
    expect(thrown.events).toEqual(['frame:a', 'error:handler failed']);
    const aborted = setup((_, input) => input.abort('stream closed'));
    aborted.framer.data(bytes('a\nb\n'));
    expect(aborted.events).toEqual(['frame:a', 'error:stream closed']);
    expect(() => new ByteFramer(0, 1, () => {}, () => {}, () => {})).toThrow('invalid framing limit');
  });
});
