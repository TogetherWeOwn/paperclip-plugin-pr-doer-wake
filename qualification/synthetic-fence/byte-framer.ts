/** Synthetic LF framing only; this does not establish a live or isolated channel. */
export class ByteFramer {
  private partial = Buffer.alloc(0);
  private queue: (Buffer | null)[] = [];
  private queuedBytes = 0;
  private queueIndex = 0;
  private processing = false;
  private ended = false;
  private failed = false;

  constructor(
    private readonly maxFrameBytes: number,
    private readonly maxQueuedBytes: number,
    private readonly onFrame: (frame: Uint8Array) => void,
    private readonly onEnd: () => void,
    private readonly onError: (reason: string) => void,
  ) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 ||
        !Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < 1) throw new Error('invalid framing limit');
  }

  data(chunk: unknown): void {
    if (this.failed) return;
    if (this.ended) { this.fail('late stream data'); return; }
    if (!(chunk instanceof Uint8Array)) { this.fail('non-byte stream data'); return; }
    this.enqueue(chunk);
  }

  end(): void { this.enqueue(null); }

  abort(reason: string): void { this.fail(reason || 'stream error'); }

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.partial = Buffer.alloc(0);
    this.queue = [];
    this.queuedBytes = 0;
    this.onError(reason);
  }

  private enqueue(chunk: Uint8Array | null): void {
    if (this.failed) return;
    if (this.processing) {
      if (chunk && chunk.length === 0) return;
      if (this.queue.length - this.queueIndex >= this.maxQueuedBytes ||
          (chunk && chunk.length > this.maxQueuedBytes - this.queuedBytes)) {
        this.fail('reentrant input limit');
        return;
      }
      this.queue.push(chunk === null ? null : Buffer.from(chunk));
      this.queuedBytes += chunk?.length ?? 0;
      return;
    }
    this.processing = true;
    try {
      let next: Uint8Array | null | undefined = chunk;
      while (next !== undefined && !this.failed) {
        if (next === null) this.finish(); else this.split(next);
        next = this.queue[this.queueIndex++];
        if (next) this.queuedBytes -= next.length;
        if (this.queueIndex >= 1024 && this.queueIndex * 2 >= this.queue.length) {
          this.queue.splice(0, this.queueIndex);
          this.queueIndex = 0;
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'stream failure');
    } finally {
      this.queue = [];
      this.queuedBytes = 0;
      this.queueIndex = 0;
      this.processing = false;
    }
  }

  private split(chunk: Uint8Array): void {
    if (this.ended) { this.fail('late stream data'); return; }
    let start = 0;
    for (let i = 0; i < chunk.length && !this.failed; i++) {
      if (chunk[i] !== 10) continue;
      const length = this.partial.length + i - start;
      if (length > this.maxFrameBytes) { this.fail('frame limit'); return; }
      const frame = Buffer.concat([this.partial, chunk.subarray(start, i)], length);
      this.partial = Buffer.alloc(0);
      this.onFrame(frame);
      start = i + 1;
    }
    if (this.failed) return;
    const length = this.partial.length + chunk.length - start;
    if (length > this.maxFrameBytes) { this.fail('frame limit'); return; }
    this.partial = Buffer.concat([this.partial, chunk.subarray(start)], length);
  }

  private finish(): void {
    if (this.ended || this.partial.length) { this.fail('premature or incomplete EOF'); return; }
    this.ended = true;
    this.onEnd();
  }
}
