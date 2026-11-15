import { isDeepStrictEqual } from 'node:util';
import { decodeResponseFrame } from './response-frame.js';
import { ResponseLedger } from './response-ledger.js';

type HandlerResult = { outcome: unknown; effectAttempt: unknown };
type Writer = (bytes: Uint8Array, complete: (error?: Error | null) => void) => void;

/** Synthetic supervisor response accounting; the owner still controls framing, deadlines and teardown. */
export class ResponseTransport {
  private notifyFailure!: (reason: string) => void;
  /** Resolves on the first failure, including callbacks arriving after receive returns. */
  readonly failure = new Promise<string>(resolve => { this.notifyFailure = resolve; });

  private fail(reason: string): void {
    this.ledger.poison(reason);
    this.notifyFailure(reason);
  }

  constructor(
    readonly ledger: ResponseLedger,
    private readonly now: () => number,
    private readonly handler: (payload: unknown) => HandlerResult | Promise<HandlerResult>,
    private readonly write: Writer,
  ) {}

  /** The owner schedules deadlines through this method, not directly on the ledger. */
  checkDeadline(): void {
    try { this.ledger.checkDeadline(this.now()); }
    catch (error) {
      this.fail(error instanceof Error ? error.message : 'deadline check failed');
      throw error;
    }
  }

  /** Input is one undelimited frame. Admission happens before dispatch. */
  async receive(bytes: Uint8Array): Promise<void> {
    try {
      this.ledger.checkDeadline(this.now());
      const frame = decodeResponseFrame(bytes, this.ledger.identity, this.ledger.limits.maxFrameBytes);
      if (frame.type === 'ACK') {
        this.ledger.acknowledge(frame.id, frame.digest, this.now());
        return;
      }
      if (frame.type !== 'REQUEST') throw new Error('terminal exchange not supported');
      // An ACK has a fixed-length digest; ensure it can be received before any effect.
      const ack = JSON.stringify({ ...this.ledger.identity, type: 'ACK', id: frame.id, digest: '0'.repeat(64) });
      if (Buffer.byteLength(ack) > this.ledger.limits.maxFrameBytes) throw new Error('ack frame limit');
      this.ledger.admit(frame.id, this.now());
      let result: HandlerResult;
      try {
        result = await this.handler(frame.payload);
      } catch (error) {
        this.ledger.handlerSettled(frame.id, error, 'ambiguous');
        throw new Error('handler failed');
      }
      const outcome = result?.outcome;
      this.ledger.handlerSettled(frame.id, outcome, result?.effectAttempt);
      this.ledger.checkDeadline(this.now());
      // This slice admits only scalar outcomes, bounding serialization before allocation.
      const max = this.ledger.limits.maxFrameBytes;
      if ((outcome !== null && !['string', 'number', 'boolean'].includes(typeof outcome)) ||
          (typeof outcome === 'string' && outcome.length > max) ||
          Object.values(this.ledger.identity).some(value => typeof value === 'string' && value.length > max)) {
        throw new Error('invalid response outcome or identity size');
      }
      const json = JSON.stringify({ ...this.ledger.identity, type: 'RESPONSE', id: frame.id, outcome });
      const encoded = JSON.parse(json);
      if (!Object.hasOwn(encoded, 'outcome') || !isDeepStrictEqual(outcome, encoded.outcome)) {
        throw new Error('invalid response outcome');
      }
      const response = Buffer.from(json);
      this.ledger.response(frame.id, response, this.now());
      let completed = false;
      this.write(Buffer.concat([response, Buffer.from('\n')]), error => {
        if (completed) { this.fail('duplicate write callback'); return; }
        completed = true;
        try { this.ledger.writeOutcome(frame.id, response.byteLength, !!error, this.now()); }
        catch (failure) { this.fail(failure instanceof Error ? failure.message : 'write accounting failed'); }
      });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'transport failure');
      throw error;
    }
  }

  /** Call on an error or premature close/EOF, not a successful terminal teardown. */
  abort(reason: string): void { this.fail(reason || 'channel aborted'); }
}
