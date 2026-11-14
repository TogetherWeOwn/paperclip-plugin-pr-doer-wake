import { describe, expect, it } from 'vitest';
import { decodeResponseFrame } from '../qualification/synthetic-fence/response-frame.js';

const identity = { version: 1 as const, caseId: 'case', phaseId: 'phase', nonce: 'nonce' };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const ack = { ...identity, id: 1, type: 'ACK', digest: 'a'.repeat(64) };

describe('response frame validation', () => {
  it('accepts a bounded matching acknowledgement', () => {
    expect(decodeResponseFrame(encode(ack), identity, 65536)).toMatchObject({ type: 'ACK', id: 1 });
  });
  it.each([
    { ...ack, nonce: 'other' }, { ...ack, caseId: 'other' }, { ...ack, phaseId: 'other' },
    { ...ack, version: 2 }, { ...ack, id: -1 }, { ...ack, digest: 'wrong' },
    { ...ack, type: 'unknown' }, { ...ack, extra: true },
  ])('rejects invalid identity and frame fields', frame => {
    expect(() => decodeResponseFrame(encode(frame), identity, 65536)).toThrow();
  });
  it('accepts canonical nested payloads and frames at the byte limit', () => {
    const request = { ...identity, id: 1, type: 'REQUEST', payload: { text: 'é', nested: [null, true, 1] } };
    const bytes = encode(request);
    expect(decodeResponseFrame(bytes, identity, bytes.byteLength)).toEqual(request);
    expect(() => decodeResponseFrame(bytes, identity, bytes.byteLength - 1)).toThrow('frame limit');
  });
  it.each([
    JSON.stringify(ack).replace('"id":1', '"id":1,"id":1'),
    JSON.stringify({ ...identity, id: 1, type: 'REQUEST', payload: { a: 1 } }).replace('"a":1', '"a":1,"a":1'),
    JSON.stringify(ack).replace('"id":1', '"id":1.0'),
    JSON.stringify(ack).replace('"caseId":"case"', '"caseId":"\\u0063ase"'),
    JSON.stringify(ack).replace('"id":1', '"id": 1'),
    '﻿' + JSON.stringify(ack),
  ])('rejects duplicate keys and noncanonical encodings', frame => {
    expect(() => decodeResponseFrame(Buffer.from(frame), identity, 65536)).toThrow('malformed');
  });
  it('rejects malformed, incomplete and oversized frames', () => {
    expect(() => decodeResponseFrame(Buffer.from([0xff]), identity, 65536)).toThrow('malformed');
    expect(() => decodeResponseFrame(Buffer.from('{'), identity, 65536)).toThrow('malformed');
    expect(() => decodeResponseFrame(encode(ack), identity, 1)).toThrow('frame limit');
  });
});
