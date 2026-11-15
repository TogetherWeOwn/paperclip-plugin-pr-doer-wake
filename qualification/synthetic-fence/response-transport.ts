import { isDeepStrictEqual } from 'node:util';
import { decodeResponseFrame } from './response-frame.js';
import { ResponseLedger } from './response-ledger.js';

type HandlerResult = { outcome: unknown; effectAttempt: unknown };
type Writer = (bytes: Uint8Array, complete: (error?: Error | null) => void) => void;

/** Synthetic supervisor response accounting; the owner still controls framing, deadlines and teardown. */
export class ResponseTransport {
  constructor(
    readonly ledger: ResponseLedger,
    private readonly now: () => number,
    private readonly handler: (payload: unknown) => HandlerResult | Promise<HandlerResult>,
    private readonly write: Writer,
  ) {}

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
      const json = JSON.stringify({ ...this.ledger.identity, type: 'RESPONSE', id: frame.id, outcome });
      const encoded = JSON.parse(json);
      if (!Object.hasOwn(encoded, 'outcome') || !isDeepStrictEqual(outcome, encoded.outcome)) {
        throw new Error('invalid response outcome');
      }
      const response = Buffer.from(json);
      this.ledger.response(frame.id, response, this.now());
      let completed = false;
      this.write(Buffer.concat([response, Buffer.from('\n')]), error => {
        if (completed) { this.ledger.poison('duplicate write callback'); return; }
        completed = true;
        try { this.ledger.writeOutcome(frame.id, response.byteLength, !!error, this.now()); }
        catch { /* ledger retains poison and the actual callback result */ }
      });
    } catch (error) {
      this.ledger.poison(error instanceof Error ? error.message : 'transport failure');
      throw error;
    }
  }

  /** Call on close, EOF, stream error or any unresolved teardown. */
  abort(reason: string): void { this.ledger.poison(reason || 'channel aborted'); }
}
