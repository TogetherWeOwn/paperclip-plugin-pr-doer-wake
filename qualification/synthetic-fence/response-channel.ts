import { decodeResponseFrame } from './response-frame.js';
import { ResponseLedger } from './response-ledger.js';

type Incoming = ReturnType<typeof decodeResponseFrame>;

/** Ordered, length-prefixed input framing; this is not a consumer bridge or process owner. */
export class ResponseChannelReader {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private frame?: Buffer;
  private frameBytes = 0;
  private ended = false;
  private reading = false;

  constructor(private readonly ledger: ResponseLedger, private readonly onFrame: (frame: Incoming) => void) {}

  feed(chunk: Uint8Array): void {
    if (this.ended || this.ledger.poisoned) throw new Error('channel closed or poisoned');
    try {
      if (this.reading) throw new Error('reentrant channel read');
      this.reading = true;
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (!this.frame) {
          const count = Math.min(4 - this.headerBytes, chunk.byteLength - offset);
          this.header.set(chunk.subarray(offset, offset + count), this.headerBytes);
          this.headerBytes += count;
          offset += count;
          if (this.headerBytes < 4) continue;
          const length = this.header.readUInt32BE();
          if (length === 0 || length > this.ledger.limits.maxFrameBytes || length > this.ledger.limits.maxBufferedBytes) {
            throw new Error('frame limit');
          }
          this.frame = Buffer.alloc(length);
        }
        const count = Math.min(this.frame.length - this.frameBytes, chunk.byteLength - offset);
        this.frame.set(chunk.subarray(offset, offset + count), this.frameBytes);
        this.frameBytes += count;
        offset += count;
        if (this.frameBytes === this.frame.length) {
          const frame = decodeResponseFrame(this.frame, this.ledger.identity, this.ledger.limits.maxFrameBytes);
          this.frame = undefined;
          this.frameBytes = 0;
          this.headerBytes = 0;
          this.onFrame(frame);
          if (this.ledger.poisoned) throw new Error('channel poisoned');
        }
      }
    } catch (error) {
      this.ledger.poison('invalid channel frame');
      throw error;
    } finally {
      this.reading = false;
    }
  }

  end(): void {
    if (this.reading) {
      this.ledger.poison('reentrant channel end');
      throw new Error('reentrant channel end');
    }
    if (this.ended) return;
    this.ended = true;
    if (this.headerBytes || this.frame) {
      this.ledger.poison('incomplete channel frame');
      throw new Error('incomplete channel frame');
    }
  }
}
