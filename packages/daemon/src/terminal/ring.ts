/**
 * The last `limit` bytes of a terminal's output (Amendment 112), replayed to a page that
 * attaches. Raw bytes, as the shell wrote them: simple, and good enough for a shell. A
 * full-screen program redraws itself when the page sends its size at attach.
 *
 * Trimming cuts at a byte, so the oldest end can fall inside a multi-byte character; those
 * orphaned continuation bytes are dropped so the replay does not open with a replacement mark.
 */

export const REPLAY_BYTES = 512 * 1024;

export class Ring {
  #chunks: Buffer[] = [];
  #size = 0;
  readonly limit: number;

  constructor(limit = REPLAY_BYTES) {
    this.limit = limit;
  }

  get size(): number {
    return this.#size;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    if (this.#size > this.limit) this.#trim();
  }

  /** Everything kept, oldest first, as one buffer. */
  snapshot(): Buffer {
    return Buffer.concat(this.#chunks, this.#size);
  }

  #trim(): void {
    let excess = this.#size - this.limit;
    while (excess > 0 && this.#chunks.length > 0) {
      const first = this.#chunks[0]!;
      if (first.length <= excess) {
        this.#chunks.shift();
        this.#size -= first.length;
        excess -= first.length;
      } else {
        this.#chunks[0] = first.subarray(excess);
        this.#size -= excess;
        excess = 0;
      }
    }
    // Not mid-character: skip the continuation bytes (10xxxxxx) a cut may have left in front.
    let first = this.#chunks[0];
    let dropped = 0;
    while (first && first.length > 0 && dropped < 3 && (first[0]! & 0xc0) === 0x80) {
      first = first.subarray(1);
      dropped += 1;
    }
    if (dropped > 0 && first) {
      this.#chunks[0] = first;
      this.#size -= dropped;
    }
  }
}
