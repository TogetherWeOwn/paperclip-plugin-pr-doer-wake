import { describe, expect, it } from 'vitest';
import { ResponseChannelReader } from '../qualification/synthetic-fence/response-channel.js';
import { ResponseLedger } from '../qualification/synthetic-fence/response-ledger.js';

const identity = { version: 1 as const, caseId: 'case', phaseId: 'phase', nonce: 'nonce' };
const limits = { phaseDeadline: 20000, ackTimeout: 1000, sealTimeout: 1000, maxOutstanding: 2,
  maxRequests: 3, maxFrameBytes: 1024, maxBufferedBytes: 1024 };
const packet = (value: unknown) => {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
};
const request = (id: number) => ({ ...identity, type: 'REQUEST', id, payload: {} });

describe('ordered channel reader', () => {
  it('handles fragmented and coalesced frames in channel order', () => {
    const ledger = new ResponseLedger(identity, limits, 0);
    const seen: number[] = [];
    const reader = new ResponseChannelReader(ledger, frame => seen.push(frame.id));
    const bytes = Buffer.concat([packet(request(1)), packet(request(2))]);
    for (let i = 0; i < bytes.length; i += 3) reader.feed(bytes.subarray(i, i + 3));
    reader.end();
    expect(seen).toEqual([1, 2]);
    expect(ledger.poisoned).toBe(false);
  });

  it('poisons on oversized length, malformed frame and partial EOF', () => {
    for (const input of [Buffer.from([0, 0, 4, 1]), Buffer.from([0, 0, 0, 1, 0xff]), Buffer.from([0, 0])]) {
      const ledger = new ResponseLedger(identity, limits, 0);
      const reader = new ResponseChannelReader(ledger, () => {});
      expect(() => { reader.feed(input); reader.end(); }).toThrow();
      expect(ledger.poisoned).toBe(true);
    }
  });

  it('poisons and stops delivery when the handler rejects a frame', () => {
    const ledger = new ResponseLedger(identity, limits, 0);
    let calls = 0;
    const reader = new ResponseChannelReader(ledger, () => { calls++; throw new Error('invalid protocol'); });
    expect(() => reader.feed(Buffer.concat([packet(request(1)), packet(request(2))]))).toThrow('invalid protocol');
    expect(calls).toBe(1);
    expect(ledger.poisoned).toBe(true);
  });
});
