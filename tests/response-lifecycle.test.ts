import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ResponseLedger } from '../qualification/synthetic-fence/response-ledger.js';
import { ResponseLifecycle } from '../qualification/synthetic-fence/response-lifecycle.js';

const identity = { version: 1 as const, caseId: 'case', phaseId: 'phase', nonce: 'nonce' };
const limits = { phaseDeadline: 1000, ackTimeout: 100, sealTimeout: 500, maxOutstanding: 4, maxRequests: 4, maxFrameBytes: 1024, maxBufferedBytes: 4096 };
const encode = (type: string, fields: object) => Buffer.from(JSON.stringify({ ...identity, type, ...fields }) + '\n');
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function setup(
  handler: (payload: unknown) => Promise<{ outcome: unknown; effectAttempt: unknown }> = async () => ({ outcome: 'ok', effectAttempt: 'confirmed' }),
  stop: (done: (error?: Error | null) => void) => void = done => done(),
) {
  let now = 1;
  const writes: { data: Buffer; done: (error?: Error | null) => void }[] = [];
  const teardown = vi.fn(stop);
  const ledger = new ResponseLedger(identity, limits, now);
  const input = new PassThrough();
  const lifecycle = new ResponseLifecycle(ledger, input, () => now, handler, (data, done) => writes.push({ data: Buffer.from(data), done }), teardown);
  const time = (value: number) => { now = value; lifecycle.transport.checkDeadline(); };
  return { ledger, lifecycle, input, writes, teardown, time };
}

describe('synthetic response lifecycle', () => {
  it('requires acknowledged delivery, terminal exchange, genuine EOF and control write credit', async () => {
    const { ledger, lifecycle, input, writes, teardown } = setup();
    const request = encode('REQUEST', { id: 1, payload: 'x' });
    input.emit('data',request.subarray(0, 7)); input.emit('data',request.subarray(7));
    await flush();
    lifecycle.seal();
    input.emit('data',encode('REQUESTS_END', { id: 1 }));
    const response = writes[0]!.data.subarray(0, -1);
    input.emit('data',encode('ACK', { id: 1, digest: createHash('sha256').update(response).digest('hex') }));
    expect(writes).toHaveLength(2);
    writes[0]!.done();
    expect(writes).toHaveLength(3);
    const settled = JSON.parse(writes[2]!.data.toString());
    input.emit('data',encode('PHASE_DONE', { id: settled.id, digest: settled.digest }));
    expect(ledger.completed).toBe(true);
    input.end(); await new Promise<void>(resolve => setImmediate(resolve));
    writes[1]!.done(); writes[2]!.done();
    expect(await lifecycle.result).toBe(true);
    expect(teardown).toHaveBeenCalledOnce();
    lifecycle.abort('normal close');
    expect(ledger.poisoned).toBe(false);
    writes[1]!.done();
    expect(await lifecycle.failure).toBe('duplicate control callback');
    expect(ledger.poisoned).toBe(true);
  });

  it('poisons incomplete EOF and records late handler settlement without claiming cancellation', async () => {
    let resolve!: (result: { outcome: unknown; effectAttempt: unknown }) => void;
    const { ledger, lifecycle, input, teardown } = setup(() => new Promise(r => { resolve = r; }));
    input.emit('data',encode('REQUEST', { id: 1, payload: null }));
    input.end(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(await lifecycle.result).toBe(false);
    resolve({ outcome: 'late', effectAttempt: 'ambiguous' });
    await flush();
    expect(ledger.snapshot()[0]!.handlerSettled).toBe(true);
    expect(ledger.poisoned).toBe(true);
    expect(teardown).toHaveBeenCalledOnce();
  });

  it('poisons on late requests, partial frames and write failure', async () => {
    const first = setup();
    first.lifecycle.seal();
    first.input.emit('data',encode('REQUESTS_END', { id: 0 }));
    first.input.emit('data',encode('REQUEST', { id: 1, payload: null }));
    expect(await first.lifecycle.result).toBe(false);
    const second = setup();
    second.input.emit('data',Buffer.from('{'));
    second.input.end(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(await second.lifecycle.result).toBe(false);
    const third = setup();
    third.input.emit('data',encode('REQUEST', { id: 1, payload: null }));
    await flush();
    third.writes[0]!.done(new Error('failed'));
    expect(await third.lifecycle.result).toBe(false);
  });

  it('rejects a teardown that reports success and then throws', async () => {
    const s = setup(undefined, done => { done(); throw new Error('teardown threw'); });
    s.lifecycle.seal();
    s.input.emit('data', encode('REQUESTS_END', { id: 0 }));
    const settled = JSON.parse(s.writes[1]!.data.toString());
    s.input.emit('data', encode('PHASE_DONE', { id: 0, digest: settled.digest }));
    s.writes[0]!.done(); s.writes[1]!.done();
    s.input.end();
    expect(await s.lifecycle.result).toBe(false);
    expect(s.ledger.poisoned).toBe(true);
  });

  it('poisons a teardown that outlives the phase deadline', async () => {
    let complete!: (error?: Error | null) => void;
    const s = setup(undefined, done => { complete = done; });
    s.lifecycle.seal();
    s.input.emit('data', encode('REQUESTS_END', { id: 0 }));
    const settled = JSON.parse(s.writes[1]!.data.toString());
    s.input.emit('data', encode('PHASE_DONE', { id: 0, digest: settled.digest }));
    s.writes[0]!.done(); s.writes[1]!.done();
    s.input.end(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(() => s.time(1000)).toThrow();
    expect(await s.lifecycle.result).toBe(false);
    complete();
    await flush();
    expect(s.ledger.poisoned).toBe(true);
  });

  it('accepts coalesced valid frames regardless of stream chunk size', async () => {
    const s = setup();
    const frames = Array.from({ length: 4 }, (_, index) => {
      const empty = encode('REQUEST', { id: index + 1, payload: '' });
      return encode('REQUEST', { id: index + 1, payload: 'x'.repeat(limits.maxFrameBytes + 1 - empty.length) });
    });
    const chunk = Buffer.concat(frames);
    expect(chunk.length).toBeGreaterThan(limits.maxBufferedBytes);
    s.input.emit('data', chunk);
    expect(s.ledger.snapshot()).toHaveLength(4);
    expect(s.ledger.poisoned).toBe(false);
    s.lifecycle.abort('test cleanup');
    expect(await s.lifecycle.result).toBe(false);
  });

  it('serializes reentrant input after the entire current chunk, including its partial frame', async () => {
    let input!: PassThrough;
    const seen: unknown[] = [];
    const third = encode('REQUEST', { id: 3, payload: 'third' });
    const s = setup(async payload => {
      seen.push(payload);
      if (payload === 'first') input.emit('data', third.subarray(8));
      return { outcome: 'ok', effectAttempt: 'confirmed' };
    });
    input = s.input;
    input.emit('data', Buffer.concat([
      encode('REQUEST', { id: 1, payload: 'first' }),
      encode('REQUEST', { id: 2, payload: 'second' }),
      third.subarray(0, 8),
    ]));
    expect(seen).toEqual(['first', 'second', 'third']);
    expect(s.ledger.poisoned).toBe(false);
    s.lifecycle.abort('test cleanup');
    expect(await s.lifecycle.result).toBe(false);
  });

  it('fails closed when reentrant input exceeds the buffer bound', async () => {
    let input!: PassThrough;
    const s = setup(async () => {
      input.emit('data', Buffer.alloc(limits.maxBufferedBytes + 1));
      return { outcome: 'ok', effectAttempt: 'confirmed' };
    });
    input = s.input;
    input.emit('data', encode('REQUEST', { id: 1, payload: null }));
    expect(await s.lifecycle.result).toBe(false);
    expect(s.ledger.poisoned).toBe(true);
  });

  it('caps long deadline timers at the Node maximum', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const ledger = new ResponseLedger(identity, { ...limits, phaseDeadline: 2_147_483_649 }, 1);
      const lifecycle = new ResponseLifecycle(ledger, new PassThrough(), () => 1, async () => ({ outcome: 'ok', effectAttempt: 'confirmed' }), () => {}, done => done());
      expect(spy).toHaveBeenLastCalledWith(expect.any(Function), 2_147_483_647);
      lifecycle.abort('test cleanup');
      expect(await lifecycle.result).toBe(false);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('bounds framing and observes control write failures', async () => {
    const oversized = setup();
    oversized.input.emit('data',Buffer.alloc(limits.maxFrameBytes + 1, 120));
    expect(await oversized.lifecycle.result).toBe(false);
    const control = setup();
    control.lifecycle.seal();
    control.writes[0]!.done(new Error('control failed'));
    expect(await control.lifecycle.result).toBe(false);
    expect(control.ledger.poisoned).toBe(true);
  });

  it('does not turn a poisoned pending teardown into success', async () => {
    let complete!: (error?: Error | null) => void;
    const s = setup(undefined, done => { complete = done; });
    s.lifecycle.seal();
    s.input.emit('data', encode('REQUESTS_END', { id: 0 }));
    const settled = JSON.parse(s.writes[1]!.data.toString());
    s.input.emit('data', encode('PHASE_DONE', { id: 0, digest: settled.digest }));
    s.writes[0]!.done(); s.writes[1]!.done();
    s.input.end(); await new Promise<void>(resolve => setImmediate(resolve));
    s.writes[0]!.done();
    complete();
    expect(await s.lifecycle.result).toBe(false);
    expect(s.ledger.completed).toBe(false);
    expect(s.teardown).toHaveBeenCalledOnce();
  });

  it('treats success as a snapshot, with late stream data still poisoning the ledger', async () => {
    const s = setup();
    s.lifecycle.seal();
    s.input.emit('data', encode('REQUESTS_END', { id: 0 }));
    const settled = JSON.parse(s.writes[1]!.data.toString());
    s.input.emit('data', encode('PHASE_DONE', { id: 0, digest: settled.digest }));
    s.writes[0]!.done(); s.writes[1]!.done();
    s.input.end(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(await s.lifecycle.result).toBe(true);
    s.input.emit('data', encode('REQUEST', { id: 1, payload: null }));
    expect(await s.lifecycle.failure).toBe('late stream data');
    expect(s.ledger.completed).toBe(false);
    expect(s.ledger.snapshot()).toHaveLength(0);
    expect(s.teardown).toHaveBeenCalledOnce();
  });

  it('does not mistake close without EOF for terminal completion', async () => {
    const s = setup();
    s.lifecycle.seal();
    s.input.emit('data', encode('REQUESTS_END', { id: 0 }));
    const settled = JSON.parse(s.writes[1]!.data.toString());
    s.input.emit('data', encode('PHASE_DONE', { id: 0, digest: settled.digest }));
    s.writes[0]!.done(); s.writes[1]!.done();
    s.input.emit('close');
    expect(await s.lifecycle.result).toBe(false);
    expect(s.ledger.completed).toBe(false);
    expect(s.teardown).toHaveBeenCalledOnce();
  });

  it('fails closed at the response deadline even if the writer never calls back', async () => {
    const { lifecycle, ledger, input, time } = setup();
    input.emit('data',encode('REQUEST', { id: 1, payload: null }));
    await flush();
    expect(() => time(101)).toThrow();
    expect(await lifecycle.result).toBe(false);
    expect(ledger.poisoned).toBe(true);
  });
});
