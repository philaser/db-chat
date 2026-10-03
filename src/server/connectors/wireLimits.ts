import { Transform, type TransformCallback } from 'node:stream';

// A row-count limit cannot bound a single large cell. Check wire headers before
// the driver buffers/decodes the payload, and bound entire buffered responses.
export const MAX_DATABASE_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_DATABASE_RESPONSE_BYTES = 16 * 1024 * 1024;

export class WireResponseBudget {
  private bytes = 0;
  private maximum = MAX_DATABASE_RESPONSE_BYTES;
  reset(streaming = false): void {
    this.bytes = 0;
    this.maximum = streaming ? Infinity : MAX_DATABASE_RESPONSE_BYTES;
  }
  consume(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > this.maximum) throw new Error('Database response exceeded the transport size limit. Narrow the selected columns or rows.');
  }
}

/** Constant-space framing, including fragmented headers and coalesced packets. */
export class WireFrameGuard {
  private readonly header: Buffer;
  private headerBytes = 0;
  private remaining = 0;
  constructor(private readonly kind: 'postgres' | 'mysql' | 'mongodb', private readonly budget: WireResponseBudget, private readonly maxFrameBytes = MAX_DATABASE_FRAME_BYTES) {
    this.header = Buffer.alloc(kind === 'postgres' ? 5 : kind === 'mongodb' ? 16 : 4);
  }
  accept(chunk: Buffer): void {
    this.budget.consume(chunk.length);
    let offset = 0;
    while (offset < chunk.length) {
      if (this.remaining) {
        const length = Math.min(this.remaining, chunk.length - offset);
        this.remaining -= length;
        offset += length;
        continue;
      }
      const length = Math.min(this.header.length - this.headerBytes, chunk.length - offset);
      chunk.copy(this.header, this.headerBytes, offset, offset + length);
      this.headerBytes += length;
      offset += length;
      if (this.headerBytes !== this.header.length) continue;
      const declared = this.kind === 'postgres' ? this.header.readUInt32BE(1) : this.kind === 'mongodb' ? this.header.readUInt32LE(0) : this.header.readUIntLE(0, 3);
      if (declared > this.maxFrameBytes) throw new Error('Database row or message exceeded the transport size limit. Select smaller values.');
      if (this.kind === 'postgres' && declared < 4) throw new Error('Invalid PostgreSQL message length.');
      if (this.kind === 'mongodb' && (declared < 16 || this.header.readUInt32LE(12) === 2012)) throw new Error('Invalid or compressed MongoDB message.');
      this.remaining = declared - (this.kind === 'postgres' ? 4 : this.kind === 'mongodb' ? 16 : 0);
      this.headerBytes = 0;
    }
  }
}

export function guardedPostgresStream(budget: WireResponseBudget): Transform {
  const guard = new WireFrameGuard('postgres', budget);
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try { guard.accept(chunk); callback(null, chunk); }
      catch (error) { callback(error as Error); }
    }
  });
}
