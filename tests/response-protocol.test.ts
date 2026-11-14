import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponseLedger } from '../qualification/synthetic-fence/response-ledger.js';
import { ResponseProtocol } from '../qualification/synthetic-fence/response-protocol.js';

const identity = { version: 1 as const, caseId: 'case', phaseId: 'phase', nonce: 'nonce' };
const limits = { phaseDeadline: 20000, ackTimeout: 1000, sealTimeout: 1000, maxOutstanding: 2,
  maxRequests: 3, maxFrameBytes: 1024, maxBufferedBytes: 1024 };
const packet = (type: string, id: number, extra = {}) => {
  const body = Buffer.from(JSON.stringify({ ...identity, type, id, ...extra }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
};

afterEach(() => vi.useRealTimers());

describe('response protocol', () => {
  it('registers requests before dispatch and processes early ACK and ordered terminal frames', () => {
    const ledger = new ResponseLedger(identity, limits, 0);
    const protocol = new ResponseProtocol(ledger, () => 1, id => {
      expect(ledger.snapshot()[0]?.id).toBe(id);
      ledger.handlerSettled(id, 'ok', 'attempted');
    });
    protocol.feed(packet('REQUEST', 1, { payload: {} }));
    const bytes = Buffer.from('response');
    const hash = protocol.response(1, bytes);
    protocol.feed(packet('ACK', 1, { digest: hash }));
    protocol.writeOutcome(1, bytes.length, false);
    protocol.seal();
    protocol.feed(packet('REQUESTS_END', 1));
    const terminal = protocol.settled();
    protocol.feed(packet('PHASE_DONE', terminal.lastId, { digest: terminal.transcriptDigest }));
    protocol.end();
    protocol.workerExit(true);
    expect(ledger.completed).toBe(true);
  });

  it('poisons and aborts a live handler on incomplete EOF, retaining its eventual outcome', () => {
    const ledger = new ResponseLedger(identity, limits, 0);
    let signal: AbortSignal | undefined;
    const protocol = new ResponseProtocol(ledger, () => 1, (_id, _payload, s) => { signal = s; });
    protocol.feed(packet('REQUEST', 1, { payload: {} }));
    expect(() => protocol.end()).toThrow('before phase done');
    expect(signal?.aborted).toBe(true);
    ledger.handlerSettled(1, 'late', 'ambiguous');
    expect(ledger.snapshot()[0]).toMatchObject({ handlerSettled: true, effectAttempt: 'ambiguous' });
  });

  it('fires an absolute ACK deadline without further channel activity', () => {
    vi.useFakeTimers();
    let now = 1;
    const ledger = new ResponseLedger(identity, limits, 0);
    let signal: AbortSignal | undefined;
    const protocol = new ResponseProtocol(ledger, () => now, (id, _payload, s) => {
      signal = s;
      ledger.handlerSettled(id, 'ok', 'attempted');
    });
    protocol.feed(packet('REQUEST', 1, { payload: {} }));
    protocol.response(1, Buffer.from('response'));
    now = 1001;
    vi.advanceTimersByTime(1000);
    expect(ledger.poisoned).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it('poisons malformed messages and early worker exit', () => {
    for (const exit of [false, true]) {
      const ledger = new ResponseLedger(identity, limits, 0);
      const protocol = new ResponseProtocol(ledger, () => 1, () => {});
      if (exit) protocol.workerExit(true);
      else expect(() => protocol.feed(packet('ACK', 1, { digest: '0'.repeat(64) }))).toThrow();
      expect(ledger.poisoned).toBe(true);
    }
  });
});
