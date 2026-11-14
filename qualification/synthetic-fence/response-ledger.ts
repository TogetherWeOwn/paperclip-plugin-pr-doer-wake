import { createHash } from 'node:crypto';

/** In-memory protocol accounting only; this does not establish process containment. */
export interface LedgerLimits {
  phaseDeadline: number;
  ackTimeout: number;
  sealTimeout: number;
  maxOutstanding: number;
  maxRequests: number;
  maxFrameBytes: number;
  maxBufferedBytes: number;
}

export interface Identity {
  version: 1;
  caseId: string;
  phaseId: string;
  nonce: string;
}

type Request = {
  handlerSettled: boolean;
  outcome?: unknown;
  effectAttempt?: unknown;
  digest?: string;
  byteLength?: number;
  writeAccounted: boolean;
  writeError?: boolean;
  acked: boolean;
  ackDeadline?: number;
};

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** All times are absolute monotonic milliseconds supplied by the owner. */
export class ResponseLedger {
  private readonly requests = new Map<number, Request>();
  private readonly outstanding = new Set<Request>();
  private lastId = 0;
  private sealDeadline?: number;
  private endId?: number;
  private transcript?: string;
  private done = false;
  private buffered = 0;
  private failure?: string;

  readonly identity: Readonly<Identity>;
  readonly limits: Readonly<LedgerLimits>;

  constructor(identity: Identity, limits: LedgerLimits, now: number) {
    const retainedIdentity = { version: identity.version, caseId: identity.caseId, phaseId: identity.phaseId, nonce: identity.nonce };
    const retainedLimits = { phaseDeadline: limits.phaseDeadline, ackTimeout: limits.ackTimeout,
      sealTimeout: limits.sealTimeout, maxOutstanding: limits.maxOutstanding, maxRequests: limits.maxRequests,
      maxFrameBytes: limits.maxFrameBytes, maxBufferedBytes: limits.maxBufferedBytes };
    if (retainedIdentity.version !== 1 || !retainedIdentity.caseId || !retainedIdentity.phaseId || !retainedIdentity.nonce ||
        Object.values(retainedLimits).some(n => !Number.isSafeInteger(n) || n <= 0) ||
        retainedLimits.phaseDeadline <= now || retainedLimits.maxFrameBytes > 65536 ||
        retainedLimits.maxOutstanding > 32 || retainedLimits.ackTimeout > 10000 || retainedLimits.sealTimeout > 10000) {
      throw new Error('invalid ledger identity or limits');
    }
    this.identity = Object.freeze(retainedIdentity);
    this.limits = Object.freeze(retainedLimits);
  }

  private fail(reason: string): never {
    this.failure ??= reason;
    throw new Error(this.failure);
  }

  private check(now: number): void {
    if (this.failure !== undefined) throw new Error(this.failure);
    if (!Number.isFinite(now) || now >= this.limits.phaseDeadline) this.fail('phase deadline');
    if (this.sealDeadline !== undefined && !this.done && now >= this.sealDeadline) this.fail('seal deadline');
    for (const request of this.outstanding) {
      if (request.ackDeadline !== undefined && now >= request.ackDeadline) {
        this.fail('ack deadline');
      }
    }
  }

  /** The channel owner must schedule this at every applicable absolute deadline. */
  checkDeadline(now: number): void { this.check(now); }
  poison(reason: string): void { this.failure ??= reason; }
  get poisoned(): boolean { return this.failure !== undefined; }
  get admissionClosed(): boolean { return this.endId !== undefined || this.poisoned; }
  get completed(): boolean { return this.done && !this.poisoned; }

  private request(id: number): Request {
    const request = this.requests.get(id);
    if (!request) return this.fail('unknown request');
    return request;
  }

  /** Register synchronously before invoking any host handler. */
  admit(id: number, now: number): void {
    this.check(now);
    if (this.endId !== undefined || this.done || !Number.isSafeInteger(id) || id !== this.lastId + 1 ||
        id > this.limits.maxRequests) this.fail('invalid request id or admission closed');
    if (this.outstanding.size >= this.limits.maxOutstanding) this.fail('outstanding limit');
    const request: Request = { handlerSettled: false, writeAccounted: false, acked: false };
    this.requests.set(id, request);
    this.outstanding.add(request);
    this.lastId = id;
  }

  /** May be called after poison: a handler must still record its actual outcome. */
  handlerSettled(id: number, outcome: unknown, effectAttempt: unknown): void {
    const request = this.request(id);
    if (request.handlerSettled) this.fail('duplicate handler settlement');
    request.handlerSettled = true;
    request.outcome = outcome;
    request.effectAttempt = effectAttempt;
  }

  /** Register canonical response bytes before initiating its channel write. */
  response(id: number, canonicalBytes: Uint8Array, now: number): string {
    this.check(now);
    const request = this.request(id);
    if (!request.handlerSettled || request.digest !== undefined || canonicalBytes.byteLength > this.limits.maxFrameBytes ||
        this.buffered + canonicalBytes.byteLength > this.limits.maxBufferedBytes) this.fail('invalid response or buffer limit');
    request.digest = digest(canonicalBytes);
    request.byteLength = canonicalBytes.byteLength;
    request.ackDeadline = Math.min(this.limits.phaseDeadline, now + this.limits.ackTimeout);
    this.buffered += canonicalBytes.byteLength;
    return request.digest;
  }

  writeOutcome(id: number, byteLength: number, error: boolean, now: number): void {
    const request = this.request(id);
    if (!request.digest || request.writeAccounted || !Number.isSafeInteger(byteLength) || byteLength !== request.byteLength) {
      this.fail('invalid write outcome');
    }
    // Check deadlines before recording the write, but retain its actual outcome on failure.
    try { this.check(now); } catch { /* poison is rethrown after accounting */ }
    request.writeAccounted = true;
    request.writeError = error;
    this.buffered -= byteLength;
    if (request.acked) this.outstanding.delete(request);
    if (error) this.poison('response write failed');
    this.check(now);
  }

  acknowledge(id: number, responseDigest: string, now: number): void {
    this.check(now);
    const request = this.request(id);
    if (!request.digest || request.acked || request.digest !== responseDigest) this.fail('invalid acknowledgement');
    request.acked = true;
    if (request.writeAccounted) this.outstanding.delete(request);
  }

  seal(now: number): void {
    this.check(now);
    if (this.sealDeadline !== undefined) this.fail('duplicate seal');
    this.sealDeadline = Math.min(this.limits.phaseDeadline, now + this.limits.sealTimeout);
  }

  requestsEnd(lastId: number, now: number): void {
    this.check(now);
    if (this.sealDeadline === undefined || this.endId !== undefined || lastId !== this.lastId) this.fail('invalid requests end');
    this.endId = lastId;
  }

  settled(now: number): { lastId: number; transcriptDigest: string } {
    this.check(now);
    if (this.endId === undefined || this.transcript !== undefined ||
        [...this.requests.values()].some(r => !r.handlerSettled || !r.writeAccounted || !r.acked)) this.fail('unsettled requests');
    const records = [...this.requests].map(([id, r]) => [id, r.digest]);
    this.transcript = digest(Buffer.from(JSON.stringify([this.identity, records])));
    return { lastId: this.endId, transcriptDigest: this.transcript };
  }

  phaseDone(lastId: number, transcriptDigest: string, now: number): void {
    this.check(now);
    if (this.done || this.transcript === undefined || this.endId !== lastId || this.transcript !== transcriptDigest) {
      this.fail('invalid phase done');
    }
    this.done = true;
  }

  /** Does not claim channel EOF, successful exits, reaping or cleanup. */
  snapshot(): ReadonlyArray<Readonly<Request & { id: number }>> {
    return [...this.requests].map(([id, request]) => ({ id, ...request }));
  }
}
