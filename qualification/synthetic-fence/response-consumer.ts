import { createHash } from 'node:crypto';
import type { Identity } from './response-ledger.js';

/** Worker-side response acceptance. The adapter must invoke its real consumer here. */
export class ResponseConsumer {
  private readonly pending = new Set<number>();
  private readonly accepting = new Set<number>();
  private failure?: string;
  private lastId = 0;
  private readonly identity: Readonly<Identity>;

  constructor(identity: Identity, private readonly maxFrameBytes: number, private readonly maxOutstanding: number) {
    this.identity = Object.freeze({ version: identity.version, caseId: identity.caseId, phaseId: identity.phaseId, nonce: identity.nonce });
    if (identity.version !== 1 || !identity.caseId || !identity.phaseId || !identity.nonce ||
        !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 65536 ||
        !Number.isSafeInteger(maxOutstanding) || maxOutstanding < 1 || maxOutstanding > 32) throw new Error('invalid consumer limits');
  }

  private fail(reason: string): never {
    this.failure ??= reason;
    throw new Error(this.failure);
  }

  poison(reason: string): void { this.failure ??= reason; }
  get poisoned(): boolean { return this.failure !== undefined; }
  get pendingCount(): number { return this.pending.size; }

  /** Call before sending a request, never after a response arrives. */
  register(id: number): void {
    if (this.poisoned) this.fail(this.failure!);
    if (!Number.isSafeInteger(id) || id !== this.lastId + 1 || this.pending.size >= this.maxOutstanding) this.fail('invalid request registration');
    this.pending.add(id);
    this.lastId = id;
  }

  /** A returned ACK authorizes transmission only after the consumer resolves successfully. */
  async accept(bytes: Uint8Array, consume: (outcome: unknown) => void | Promise<void>): Promise<Uint8Array> {
    if (this.poisoned) this.fail(this.failure!);
    if (bytes.byteLength > this.maxFrameBytes) this.fail('frame limit');
    const received = Buffer.from(bytes);
    const digest = createHash('sha256').update(received).digest('hex');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(received)); }
    catch { return this.fail('malformed response'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return this.fail('malformed response');
    const frame = value as Record<string, unknown>;
    const allowed = ['version', 'caseId', 'phaseId', 'nonce', 'type', 'id', 'outcome'];
    if (JSON.stringify(frame) !== received.toString('utf8') || Object.keys(frame).length !== allowed.length ||
        Object.keys(frame).some(key => !allowed.includes(key)) ||
        frame.version !== this.identity.version || frame.caseId !== this.identity.caseId ||
        frame.phaseId !== this.identity.phaseId || frame.nonce !== this.identity.nonce || frame.type !== 'RESPONSE' ||
        !Number.isSafeInteger(frame.id) || !this.pending.has(frame.id as number) || this.accepting.has(frame.id as number)) {
      return this.fail('invalid response');
    }
    const id = frame.id as number;
    this.accepting.add(id);
    try { await consume(frame.outcome); }
    catch { return this.fail('consumer rejected response'); }
    if (this.poisoned) return this.fail(this.failure!);
    this.accepting.delete(id);
    this.pending.delete(id);
    return Buffer.from(JSON.stringify({ ...this.identity, type: 'ACK', id, digest }) + '\n');
  }
}
