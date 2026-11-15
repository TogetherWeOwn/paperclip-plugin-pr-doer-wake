import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ResponseLedger } from '../qualification/synthetic-fence/response-ledger.js';
import { ResponseTransport } from '../qualification/synthetic-fence/response-transport.js';

const identity = { version: 1 as const, caseId: 'case', phaseId: 'phase', nonce: 'nonce' };
const limits = { phaseDeadline: 20000, ackTimeout: 1000, sealTimeout: 1000, maxOutstanding: 1,
  maxRequests: 3, maxFrameBytes: 65536, maxBufferedBytes: 65536 };
const frame = (type: string, id: number, fields: object) => Buffer.from(JSON.stringify({ ...identity, type, id, ...fields }));
const request = (id = 1) => frame('REQUEST', id, { payload: 'input' });
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes.subarray(0, bytes.length - 1)).digest('hex');

describe('supervisor response transport', () => {
  it.each(['ack-first', 'write-first'])('requires both write and consumer ACK in %s order', async order => {
    const ledger = new ResponseLedger(identity, limits, 0);
    let bytes!: Uint8Array;
    let complete!: (error?: Error | null) => void;
    const handler = vi.fn(() => ({ outcome: 'ok', effectAttempt: 'sent' }));
    const transport = new ResponseTransport(ledger, () => 1, handler, (b, cb) => { bytes = b; complete = cb; });
    await transport.receive(request());
    expect(handler).toHaveBeenCalledOnce();
    const ack = frame('ACK', 1, { digest: digest(bytes) });
    if (order === 'ack-first') { await transport.receive(ack); complete(); }
    else { complete(); await transport.receive(ack); }
    await transport.receive(request(2));
    expect(ledger.snapshot()[0]).toMatchObject({ handlerSettled: true, writeAccounted: true, acked: true });
  });

  it('does not turn an early ACK into host write credit', async () => {
    const ledger = new ResponseLedger(identity, limits, 0);
    let bytes!: Uint8Array;
    const transport = new ResponseTransport(ledger, () => 1, () => ({ outcome: 'ok', effectAttempt: 'none' }), b => { bytes = b; });
    await transport.receive(request());
    await transport.receive(frame('ACK', 1, { digest: digest(bytes) }));
    await expect(transport.receive(request(2))).rejects.toThrow('outstanding limit');
    expect(ledger.poisoned).toBe(true);
  });

  it('does not treat a write callback as consumer acceptance', async () => {
    const ledger = new ResponseLedger(identity, limits, 0);
    const transport = new ResponseTransport(ledger, () => 1, () => ({ outcome: 'ok', effectAttempt: 'none' }), (_b, cb) => cb());
    await transport.receive(request());
    await expect(transport.receive(request(2))).rejects.toThrow('outstanding limit');
    expect(ledger.snapshot()[0]).toMatchObject({ writeAccounted: true, acked: false });
  });

  it('records late handler settlement but never writes after poison', async () => {
    const ledger = new ResponseLedger(identity, limits, 0);
    let resolve!: (result: { outcome: string; effectAttempt: string }) => void;
    const handler = new Promise<{ outcome: string; effectAttempt: string }>(r => { resolve = r; });
    const write = vi.fn();
    const transport = new ResponseTransport(ledger, () => 1, () => handler, write);
    const pending = transport.receive(request());
    transport.abort('stream closed');
    resolve({ outcome: 'ok', effectAttempt: 'attempted' });
    await expect(pending).rejects.toThrow('stream closed');
    expect(write).not.toHaveBeenCalled();
    expect(ledger.snapshot()[0]).toMatchObject({ handlerSettled: true, effectAttempt: 'attempted' });
  });

  it('records a late callback and poisons even after an early ACK', async () => {
    const ledger = new ResponseLedger(identity, limits, 0);
    let now = 1, bytes!: Uint8Array;
    let complete!: (error?: Error | null) => void;
    const transport = new ResponseTransport(ledger, () => now, () => ({ outcome: 'ok', effectAttempt: 'none' }), (b, cb) => { bytes = b; complete = cb; });
    await transport.receive(request());
    await transport.receive(frame('ACK', 1, { digest: digest(bytes) }));
    now = 1001;
    complete();
    expect(ledger.poisoned).toBe(true);
    await expect(transport.failure).resolves.toBe('ack deadline');
    expect(ledger.snapshot()[0]).toMatchObject({ writeAccounted: true, writeError: false, acked: true });
  });

  it('rejects outcomes changed by JSON encoding while retaining handler settlement', async () => {
    const ledger = new ResponseLedger(identity, limits, 0);
    const write = vi.fn();
    const transport = new ResponseTransport(ledger, () => 1, () => ({ outcome: NaN, effectAttempt: 'sent' }), write);
    await expect(transport.receive(request())).rejects.toThrow('invalid response outcome');
    expect(ledger.snapshot()[0]).toMatchObject({ handlerSettled: true, outcome: NaN });
    expect(write).not.toHaveBeenCalled();
  });

  it.each(['x'.repeat(65537), { nested: 'not supported' }])('rejects unbounded or non-scalar outcomes', async outcome => {
    const ledger = new ResponseLedger(identity, limits, 0);
    const write = vi.fn();
    const transport = new ResponseTransport(ledger, () => 1, () => ({ outcome, effectAttempt: 'none' }), write);
    await expect(transport.receive(request())).rejects.toThrow('invalid response outcome');
    expect(write).not.toHaveBeenCalled();
    expect(ledger.poisoned).toBe(true);
  });

  it('retains ambiguous delivery when the writer throws before its callback', async () => {
    const ledger = new ResponseLedger(identity, limits, 0);
    const transport = new ResponseTransport(ledger, () => 1, () => ({ outcome: 'ok', effectAttempt: 'sent' }), () => { throw new Error('uncertain'); });
    await expect(transport.receive(request())).rejects.toThrow('uncertain');
    expect(ledger.snapshot()[0]).toMatchObject({ writeAccounted: false, acked: false });
    expect(ledger.poisoned).toBe(true);
  });

  it('records an error callback and rejects malformed input without dispatch', async () => {
    const ledger = new ResponseLedger(identity, limits, 0);
    const transport = new ResponseTransport(ledger, () => 1, () => ({ outcome: 'ok', effectAttempt: 'none' }), (_b, cb) => cb(new Error('closed')));
    await transport.receive(request());
    expect(ledger.snapshot()[0]).toMatchObject({ writeAccounted: true, writeError: true });
    expect(ledger.poisoned).toBe(true);
    await expect(transport.failure).resolves.toBe('response write failed');
    const other = new ResponseLedger(identity, limits, 0);
    const handler = vi.fn();
    const invalid = new ResponseTransport(other, () => 1, handler, () => {});
    await expect(invalid.receive(Buffer.from('{}'))).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(other.poisoned).toBe(true);
  });
});
