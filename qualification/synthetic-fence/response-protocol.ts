import { ResponseChannelReader } from './response-channel.js';
import { ResponseLedger } from './response-ledger.js';

/** Protocol accounting only. The owner remains responsible for writes, exits and cleanup. */
export class ResponseProtocol {
  private readonly abort = new AbortController();
  private readonly reader: ResponseChannelReader;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly ledger: ResponseLedger,
    private readonly now: () => number,
    private readonly dispatch: (id: number, payload: unknown, signal: AbortSignal) => void,
  ) {
    this.reader = new ResponseChannelReader(ledger, frame => {
      const now = this.now();
      switch (frame.type) {
        case 'REQUEST':
          ledger.admit(frame.id, now);
          this.dispatch(frame.id, frame.payload, this.abort.signal);
          break;
        case 'ACK': ledger.acknowledge(frame.id, frame.digest, now); break;
        case 'REQUESTS_END': ledger.requestsEnd(frame.id, now); break;
        case 'PHASE_DONE': ledger.phaseDone(frame.id, frame.digest, now); break;
      }
      this.schedule();
    });
    this.schedule();
  }

  private poison(reason: string): void {
    this.ledger.poison(reason);
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort.abort();
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const deadline = this.ledger.nextDeadline();
    if (deadline === undefined) return;
    const remaining = Math.max(0, deadline - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.ledger.checkDeadline(this.now());
        this.schedule();
      } catch {
        this.poison('protocol deadline');
      }
    }, Math.min(remaining, 2147483647));
  }

  private run<T>(fn: () => T): T {
    try {
      const result = fn();
      this.schedule();
      return result;
    } catch (error) {
      this.poison('protocol failure');
      throw error;
    }
  }

  feed(chunk: Uint8Array): void { this.run(() => this.reader.feed(chunk)); }
  seal(): void { this.run(() => this.ledger.seal(this.now())); }
  response(id: number, bytes: Uint8Array): string { return this.run(() => this.ledger.response(id, bytes, this.now())); }
  writeOutcome(id: number, length: number, error: boolean): void {
    this.run(() => this.ledger.writeOutcome(id, length, error, this.now()));
  }
  settled(): { lastId: number; transcriptDigest: string } { return this.run(() => this.ledger.settled(this.now())); }

  end(): void {
    this.run(() => {
      this.reader.end();
      if (!this.ledger.completed) throw new Error('channel ended before phase done');
    });
  }

  workerExit(success: boolean): void {
    if (!success || !this.ledger.completed) this.poison('worker exit before protocol completion');
  }
  cancel(): void { this.poison('cancelled'); }
}
