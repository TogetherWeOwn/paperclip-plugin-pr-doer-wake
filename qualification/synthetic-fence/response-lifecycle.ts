import type { Readable } from 'node:stream';
import { decodeResponseFrame } from './response-frame.js';
import { ResponseLedger } from './response-ledger.js';
import { ResponseTransport } from './response-transport.js';

/**
 * Synthetic protocol model only: a supplied readable provides bytes and genuine end events.
 * No adapter hook, worker isolation, cancellation or process teardown is established here.
 * Frames are canonical UTF-8 JSON followed by LF; limits exclude LF. Response outcomes
 * remain scalar-only as required by ResponseTransport. A write callback is not an ACK.
 * A successful result is model evidence only, never authority to start another writer:
 * later callbacks can poison the ledger and cannot revoke an already resolved promise.
 */
export class ResponseLifecycle {
  readonly transport: ResponseTransport;
  private partial = Buffer.alloc(0);
  private ended = false;
  private eof = false;
  private terminal = false;
  private closed = false;
  private closing = false;
  private controlWrites = 0;
  private sealAt?: number;
  private settled = false;
  private timer?: ReturnType<typeof setTimeout>;
  private finish!: (value: boolean) => void;
  private notifyFailure!: (reason: string) => void;
  readonly result = new Promise<boolean>(resolve => { this.finish = resolve; });
  readonly failure = new Promise<string>(resolve => { this.notifyFailure = resolve; });

  constructor(
    readonly ledger: ResponseLedger,
    input: Readable,
    private readonly now: () => number,
    handler: (payload: unknown) => { outcome: unknown; effectAttempt: unknown } | Promise<{ outcome: unknown; effectAttempt: unknown }>,
    private readonly write: (bytes: Uint8Array, callback: (error?: Error | null) => void) => void,
    private readonly teardown: (done: (error?: Error | null) => void) => void,
  ) {
    if (ledger.limits.maxRequests > 1024 || ledger.limits.maxBufferedBytes > 1024 * 1024) throw new Error('lifecycle limit');
    this.transport = new ResponseTransport(ledger, now, handler, (bytes, callback) => {
      this.write(bytes, error => { callback(error); this.advance(); });
    });
    void this.transport.failure.then(reason => this.fail(reason));
    input.on('data', (chunk: unknown) => {
      if (!(chunk instanceof Uint8Array)) this.fail('non-byte stream data');
      else this.data(chunk);
    });
    input.on('end', () => this.end());
    input.on('error', () => this.abort('stream error'));
    input.on('close', () => { if (!this.eof) this.abort('stream closed before EOF'); });
    this.schedule();
  }

  private fail(reason: string): void {
    this.ledger.poison(reason);
    this.notifyFailure(reason);
    if (this.timer) clearTimeout(this.timer);
    if (!this.closed) {
      this.closed = true;
      if (!this.closing) { try { this.teardown(() => {}); } catch { /* failure is already terminal */ } }
      this.finish(false);
    }
  }

  private schedule(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    const deadlines = [this.ledger.limits.phaseDeadline];
    if (this.sealAt !== undefined && !this.ledger.completed) deadlines.push(this.sealAt);
    for (const r of this.ledger.snapshot()) if (r.ackDeadline !== undefined && (!r.acked || !r.writeAccounted)) deadlines.push(r.ackDeadline);
    this.timer = setTimeout(() => {
      try { this.transport.checkDeadline(); this.advance(); } catch { this.fail('deadline'); }
    }, Math.max(0, Math.min(...deadlines) - this.now()));
  }

  private control(type: string, fields: Record<string, unknown> = {}): void {
    const bytes = Buffer.from(JSON.stringify({ ...this.ledger.identity, type, ...fields }));
    if (bytes.length > this.ledger.limits.maxFrameBytes) throw new Error('control frame limit');
    this.controlWrites++;
    let called = false;
    this.write(Buffer.concat([bytes, Buffer.from('\n')]), error => {
      if (called) { this.fail('duplicate control callback'); return; }
      called = true;
      this.controlWrites--;
      if (error) this.fail('control write failed');
      else this.advance();
    });
  }

  /** Stop request generation; requests already on the stream remain admissible until REQUESTS_END. */
  seal(): void {
    try {
      const now = this.now();
      this.ledger.seal(now);
      this.sealAt = Math.min(this.ledger.limits.phaseDeadline, now + this.ledger.limits.sealTimeout);
      this.control('SEAL');
      this.schedule();
    } catch (error) { this.fail(error instanceof Error ? error.message : 'seal failed'); }
  }

  /** Feed bytes from one supervisor-owned readable stream. Frames are canonical UTF-8 JSON plus LF. */
  private data(chunk: Uint8Array): void {
    if (this.closed || this.eof) { this.fail('late stream data'); return; }
    try {
      if (chunk.length > this.ledger.limits.maxBufferedBytes) throw new Error('stream chunk limit');
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 10) continue;
        const length = this.partial.length + i - start;
        if (length > this.ledger.limits.maxFrameBytes) throw new Error('frame limit');
        const frame = Buffer.concat([this.partial, chunk.subarray(start, i)], length);
        this.partial = Buffer.alloc(0);
        this.frame(frame);
        start = i + 1;
      }
      if (this.partial.length + chunk.length - start > this.ledger.limits.maxFrameBytes) throw new Error('frame limit');
      this.partial = Buffer.concat([this.partial, chunk.subarray(start)]);
    } catch (error) { this.fail(error instanceof Error ? error.message : 'stream failure'); }
  }

  private frame(bytes: Uint8Array): void {
    const frame = decodeResponseFrame(bytes, this.ledger.identity, this.ledger.limits.maxFrameBytes);
    if (frame.type === 'REQUESTS_END') {
      this.ledger.requestsEnd(frame.id, this.now());
      this.ended = true;
      this.advance();
    } else if (frame.type === 'PHASE_DONE') {
      this.ledger.phaseDone(frame.id, frame.digest, this.now());
      this.terminal = true;
      this.advance();
    } else {
      void this.transport.receive(bytes).then(() => this.advance(), error => this.fail(error instanceof Error ? error.message : 'transport failure'));
    }
    this.schedule();
  }

  private advance(): void {
    if (this.closed) return;
    try {
      this.transport.checkDeadline();
      if (this.ended && !this.settled && this.ledger.snapshot().every(r => r.handlerSettled && r.writeAccounted && r.acked)) {
        this.settled = true;
        const value = this.ledger.settled(this.now());
        this.control('SETTLED', { id: value.lastId, digest: value.transcriptDigest });
      }
      if (this.terminal && this.eof && this.controlWrites === 0 && !this.closing) {
        this.closing = true;
        let called = false;
        this.teardown(error => {
          if (called) { this.fail('duplicate teardown callback'); return; }
          called = true;
          queueMicrotask(() => {
            if (this.closed) { this.fail('late teardown callback'); return; }
            try {
              this.transport.checkDeadline();
              if (error) throw error;
              this.closed = true;
              if (this.timer) clearTimeout(this.timer);
              this.finish(true);
            } catch (failure) { this.fail(failure instanceof Error ? failure.message : 'teardown failed'); }
          });
        });
      }
      this.schedule();
    } catch (error) { this.fail(error instanceof Error ? error.message : 'lifecycle failure'); }
  }

  /** Invoke only for the stream's actual end event, not close, timeout or cancellation. */
  private end(): void {
    if (this.eof || this.closed || this.partial.length || !this.terminal) { this.fail('premature or incomplete EOF'); return; }
    this.eof = true;
    this.advance();
  }

  /** Transport errors and close before successful teardown are ambiguous. */
  abort(reason: string): void { if (!this.closed) this.fail(reason || 'channel aborted'); }
}
