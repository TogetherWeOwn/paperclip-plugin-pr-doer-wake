/** Synthetic LF framing only; this does not establish a live or isolated channel. */
export class ByteFramer {
  private partial = Buffer.alloc(0);
  private partialLength = 0;
  private queue: (Buffer | null | undefined)[] = [];
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
        next = this.queue[this.queueIndex];
        this.queue[this.queueIndex++] = undefined;
        if (next) this.queuedBytes -= next.length;
        if (this.queueIndex >= 1024 && this.queueIndex * 2 >= this.queue.length) {
          this.queue.splice(0, this.queueIndex);
          this.queueIndex = 0;
        }
      }
    } catch (error) {
      if (this.failed) throw error;
      this.fail(error instanceof Error ? error.message : 'stream failure');
    } finally {
      this.queue = [];
      this.queuedBytes = 0;
      this.queueIndex = 0;
      this.processing = false;
    }
  }

  private append(bytes: Uint8Array): void {
    const length = this.partialLength + bytes.length;
    if (length > this.partial.length) {
      const capacity = Math.min(this.maxFrameBytes, Math.max(length, this.partial.length * 2, 64));
      const next = Buffer.allocUnsafe(capacity);
      this.partial.copy(next, 0, 0, this.partialLength);
      this.partial = next;
    }
    this.partial.set(bytes, this.partialLength);
    this.partialLength = length;
  }

  private split(chunk: Uint8Array): void {
    if (this.ended) { this.fail('late stream data'); return; }
    let start = 0;
    while (start < chunk.length && !this.failed) {
      const remaining = this.maxFrameBytes - this.partialLength;
      const scan = chunk.subarray(start, start + remaining + 1);
      const delimiter = scan.indexOf(10);
      if (delimiter < 0) {
        if (chunk.length - start > remaining) { this.fail('frame limit'); return; }
        this.append(chunk.subarray(start));
        return;
      }
      this.append(scan.subarray(0, delimiter));
      const frame = Buffer.from(this.partial.subarray(0, this.partialLength));
      this.partialLength = 0;
      this.onFrame(frame);
      start += delimiter + 1;
    }
  }

  private finish(): void {
    if (this.ended || this.partialLength) { this.fail('premature or incomplete EOF'); return; }
    this.ended = true;
    this.onEnd();
  }
}
