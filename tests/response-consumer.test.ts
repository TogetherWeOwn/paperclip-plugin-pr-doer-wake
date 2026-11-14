import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ResponseConsumer } from '../qualification/synthetic-fence/response-consumer.js';

const identity = { version: 1 as const, caseId: 'case', phaseId: 'phase', nonce: 'nonce' };
const response = (id: number) => Buffer.from(JSON.stringify({ ...identity, type: 'RESPONSE', id, outcome: { ok: true } }));

describe('response consumer hook', () => {
  it('sends no acknowledgement until the registered consumer accepts the decoded response', async () => {
    const consumer = new ResponseConsumer(identity, 65536, 2);
    consumer.register(1);
    let release!: () => void;
    const accepted = new Promise<void>(resolve => { release = resolve; });
    let finished = false;
    const bytes = response(1);
    const ack = consumer.accept(bytes, async outcome => {
      expect(outcome).toEqual({ ok: true });
      await accepted;
    }).then(value => { finished = true; return value; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(consumer.pendingCount).toBe(1);
    release();
    expect(JSON.parse(Buffer.from(await ack).toString())).toEqual({ ...identity, type: 'ACK', id: 1,
      digest: createHash('sha256').update(bytes).digest('hex') });
    expect(consumer.pendingCount).toBe(0);
  });

  it('binds the received bytes even if the input buffer is later modified', async () => {
    const consumer = new ResponseConsumer(identity, 65536, 1);
    consumer.register(1);
    const bytes = response(1);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const ack = await consumer.accept(bytes, () => { bytes.fill(0); });
    expect(JSON.parse(Buffer.from(ack).toString()).digest).toBe(digest);
  });

  it('poisons rather than acknowledges a failed consumer', async () => {
    const consumer = new ResponseConsumer(identity, 65536, 2);
    consumer.register(1);
    await expect(consumer.accept(response(1), () => { throw new Error('refused'); })).rejects.toThrow('consumer rejected');
    expect(consumer.poisoned).toBe(true);
    expect(consumer.pendingCount).toBe(1);
    expect(() => consumer.register(2)).toThrow();
  });

  it('rejects unknown, duplicate and malformed responses', async () => {
    const unknown = new ResponseConsumer(identity, 65536, 2);
    await expect(unknown.accept(response(1), () => {})).rejects.toThrow('invalid response');
    const duplicate = new ResponseConsumer(identity, 65536, 2);
    duplicate.register(1);
    await duplicate.accept(response(1), () => {});
    await expect(duplicate.accept(response(1), () => {})).rejects.toThrow('invalid response');
    const malformed = new ResponseConsumer(identity, 65536, 2);
    malformed.register(1);
    await expect(malformed.accept(Buffer.from([0xff]), () => {})).rejects.toThrow('malformed response');
  });

  it('poisons before consumption when the acknowledgement exceeds the frame limit', async () => {
    const bytes = response(1);
    const consumer = new ResponseConsumer(identity, bytes.byteLength, 1);
    consumer.register(1);
    let consumed = false;
    await expect(consumer.accept(bytes, () => { consumed = true; })).rejects.toThrow('frame limit');
    expect(consumed).toBe(false);
    expect(consumer.poisoned).toBe(true);
  });

  it('poisons on a deeply nested response that cannot be canonicalized', async () => {
    const consumer = new ResponseConsumer(identity, 65536, 1);
    consumer.register(1);
    const prefix = JSON.stringify({ ...identity, type: 'RESPONSE', id: 1 }).slice(0, -1);
    const bytes = Buffer.from(`${prefix},"outcome":${'['.repeat(10000)}0${']'.repeat(10000)}}`);
    await expect(consumer.accept(bytes, () => {})).rejects.toThrow('invalid response');
    expect(consumer.poisoned).toBe(true);
    expect(() => consumer.register(2)).toThrow();
  });

  it('does not acknowledge acceptance completing after channel poison', async () => {
    const consumer = new ResponseConsumer(identity, 65536, 1);
    consumer.register(1);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ack = consumer.accept(response(1), () => gate);
    consumer.poison('channel closed');
    release();
    await expect(ack).rejects.toThrow('channel closed');
    expect(consumer.pendingCount).toBe(1);
  });
});
