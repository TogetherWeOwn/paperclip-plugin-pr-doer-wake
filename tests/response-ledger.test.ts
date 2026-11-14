import { describe, expect, it } from 'vitest';
import { ResponseLedger } from '../qualification/synthetic-fence/response-ledger.js';

const limits = { phaseDeadline: 20000, ackTimeout: 1000, sealTimeout: 1000, maxOutstanding: 2,
  maxRequests: 3, maxFrameBytes: 65536, maxBufferedBytes: 65536 };
const identity = { version: 1 as const, caseId: 'case', phaseId: 'phase', nonce: 'nonce' };
const ledger = () => new ResponseLedger(identity, limits, 0);
const bytes = Buffer.from('response');

function prepare(l: ResponseLedger, id = 1) {
  l.admit(id, 1);
  l.handlerSettled(id, 'ok', 'attempted');
  return l.response(id, bytes, 2);
}

describe('response ledger', () => {
  it('latches an early ACK but waits for the write and ordered seal', () => {
    const l = ledger();
    const hash = prepare(l);
    l.acknowledge(1, hash, 3);
    l.writeOutcome(1, bytes.length, false, 4);
    l.seal(5);
    l.requestsEnd(1, 6);
    const terminal = l.settled(7);
    l.phaseDone(terminal.lastId, terminal.transcriptDigest, 8);
    expect(l.completed).toBe(true);
    expect(l.snapshot()[0]).toMatchObject({ outcome: 'ok', effectAttempt: 'attempted', acked: true });
  });

  it('poisons a failed write even after an early ACK', () => {
    const l = ledger();
    const hash = prepare(l);
    l.acknowledge(1, hash, 3);
    expect(() => l.writeOutcome(1, bytes.length, true, 4)).toThrow('write failed');
    expect(l.poisoned).toBe(true);
    expect(l.completed).toBe(false);
  });

  it.each([1002, 1003])('records but rejects a late write after an early ACK at %i', now => {
    const l = ledger();
    const hash = prepare(l);
    l.acknowledge(1, hash, 3);
    expect(() => l.writeOutcome(1, bytes.length, false, now)).toThrow('ack deadline');
    expect(l.snapshot()[0]).toMatchObject({ writeAccounted: true, writeError: false, acked: true });
    expect(l.poisoned).toBe(true);
  });

  it('does not permit admission after an empty poison reason', () => {
    const l = ledger();
    l.poison('');
    expect(l.poisoned).toBe(true);
    expect(() => l.admit(1, 1)).toThrow();
  });

  it('retains validated identity and limits when the caller mutates its inputs', () => {
    const sourceIdentity = { ...identity };
    const sourceLimits = { ...limits, maxOutstanding: 1 };
    const l = new ResponseLedger(sourceIdentity, sourceLimits, 0);
    sourceIdentity.nonce = 'changed';
    sourceLimits.maxOutstanding = 32;
    expect(l.identity.nonce).toBe('nonce');
    prepare(l);
    expect(() => l.admit(2, 3)).toThrow('outstanding limit');
  });

  it('records the actual write result after a separate poison', () => {
    const l = ledger();
    prepare(l);
    l.poison('channel closed');
    expect(() => l.writeOutcome(1, bytes.length, true, 4)).toThrow('channel closed');
    expect(l.snapshot()[0]).toMatchObject({ writeAccounted: true, writeError: true });
  });

  it('releases outstanding slots for either ACK/write ordering while retaining history', () => {
    const l = new ResponseLedger(identity, { ...limits, maxOutstanding: 1 }, 0);
    const first = prepare(l);
    l.writeOutcome(1, bytes.length, false, 3);
    l.acknowledge(1, first, 4);
    const second = prepare(l, 2);
    l.acknowledge(2, second, 5);
    l.writeOutcome(2, bytes.length, false, 6);
    l.admit(3, 7);
    expect(l.snapshot()).toHaveLength(3);
  });

  it('includes ACK waiters in the outstanding limit', () => {
    const l = ledger();
    prepare(l);
    prepare(l, 2);
    expect(() => l.admit(3, 3)).toThrow('outstanding limit');
  });

  it.each(['duplicate', 'digest', 'unknown'])('rejects %s acknowledgements', scenario => {
    const l = ledger();
    const hash = prepare(l);
    if (scenario === 'duplicate') l.acknowledge(1, hash, 3);
    expect(() => l.acknowledge(scenario === 'unknown' ? 2 : 1, scenario === 'digest' ? 'bad' : hash, 4)).toThrow();
    expect(l.poisoned).toBe(true);
  });

  it('permits in-flight admission during sealing but rejects requests after the marker', () => {
    const l = ledger();
    l.seal(1);
    l.admit(1, 2);
    l.requestsEnd(1, 3);
    expect(() => l.admit(2, 4)).toThrow('admission closed');
  });

  it('poisons an expired ACK and records a handler settlement after poison', () => {
    const l = ledger();
    prepare(l);
    l.admit(2, 3);
    expect(() => l.acknowledge(1, 'x', 1002)).toThrow('ack deadline');
    l.handlerSettled(2, 'late failure', 'ambiguous');
    expect(l.snapshot()[1]).toMatchObject({ handlerSettled: true, effectAttempt: 'ambiguous' });
  });

  it('rejects terminal messages before settlement and mismatched transcript echoes', () => {
    const l = ledger();
    const hash = prepare(l);
    l.writeOutcome(1, bytes.length, false, 3);
    l.acknowledge(1, hash, 4);
    l.seal(5);
    l.requestsEnd(1, 6);
    l.settled(7);
    expect(() => l.phaseDone(1, 'wrong', 8)).toThrow('invalid phase done');
  });
});
