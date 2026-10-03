// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { MAX_DATABASE_FRAME_BYTES, MAX_DATABASE_RESPONSE_BYTES, WireFrameGuard, WireResponseBudget, guardedPostgresStream } from '../src/server/connectors/wireLimits';

function frame(kind: 'postgres' | 'mysql', length: number, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(kind === 'postgres' ? 5 : 4);
  if (kind === 'postgres') { header[0] = 68; header.writeUInt32BE(length, 1); }
  else header.writeUIntLE(length, 0, 3);
  return Buffer.concat([header, payload]);
}

describe('database wire allocation limits', () => {
  it.each(['postgres', 'mysql'] as const)('rejects oversized %s lengths from the header before receiving a payload', kind => {
    const header = frame(kind, MAX_DATABASE_FRAME_BYTES + 1);
    for (let split = 0; split < header.length; split++) {
      const guard = new WireFrameGuard(kind, new WireResponseBudget());
      guard.accept(header.subarray(0, split));
      expect(() => guard.accept(header.subarray(split))).toThrow(/transport size limit/);
    }
  });
  it.each(['postgres', 'mysql'] as const)('accepts fragmented and coalesced %s frames without retaining payloads', kind => {
    const headerAdjustment = kind === 'postgres' ? 4 : 0;
    const bytes = Buffer.concat([frame(kind, 3 + headerAdjustment, Buffer.from('abc')), frame(kind, headerAdjustment), frame(kind, 2 + headerAdjustment, Buffer.from('de'))]);
    for (let chunkSize = 1; chunkSize <= bytes.length; chunkSize++) {
      const guard = new WireFrameGuard(kind, new WireResponseBudget());
      for (let offset = 0; offset < bytes.length; offset += chunkSize) guard.accept(bytes.subarray(offset, offset + chunkSize));
    }
  });
  it('rejects malformed PostgreSQL lengths', () => {
    expect(() => new WireFrameGuard('postgres', new WireResponseBudget()).accept(frame('postgres', 3))).toThrow(/Invalid PostgreSQL/);
  });
  it('bounds cumulative small messages and resets only at an operation boundary', () => {
    const budget = new WireResponseBudget();
    budget.consume(MAX_DATABASE_RESPONSE_BYTES);
    expect(() => budget.consume(1)).toThrow(/transport size limit/);
    budget.reset(); budget.consume(1);
    budget.reset(true); budget.consume(MAX_DATABASE_RESPONSE_BYTES * 10);
    // Streaming can exceed the total budget, but cannot evade the frame limit.
    expect(() => new WireFrameGuard('mysql', budget).accept(frame('mysql', MAX_DATABASE_FRAME_BYTES + 1))).toThrow(/transport size limit/);
  });
  it('does not forward an oversized PostgreSQL header to the driver parser', async () => {
    const stream = guardedPostgresStream(new WireResponseBudget());
    let forwardedBytes = 0;
    stream.on('data', chunk => { forwardedBytes += chunk.length; });
    const failed = once(stream, 'error');
    stream.write(frame('postgres', 1_000_000_000));
    const [error] = await failed;
    expect(error.message).toMatch(/transport size limit/);
    expect(forwardedBytes).toBe(0);
  });
});

describe('MongoDB wire limits', () => {
  function mongoHeader(length: number, opcode = 2013) {
    const header = Buffer.alloc(16); header.writeUInt32LE(length, 0); header.writeUInt32LE(opcode, 12); return header;
  }
  it('rejects an announced one-gigabyte MongoDB message without receiving a body', () => {
    const guard = new WireFrameGuard('mongodb', new WireResponseBudget(), 20 * 1024 * 1024);
    const header = mongoHeader(1_000_000_000);
    guard.accept(header.subarray(0, 3));
    expect(() => guard.accept(header.subarray(3))).toThrow(/transport size limit/);
  });
  it.each([0, 15])('rejects an invalid MongoDB frame length %i', length => {
    expect(() => new WireFrameGuard('mongodb', new WireResponseBudget()).accept(mongoHeader(length))).toThrow(/Invalid or compressed/);
  });
  it('rejects unsolicited compression before decompression can allocate its declared size', () => {
    expect(() => new WireFrameGuard('mongodb', new WireResponseBudget()).accept(mongoHeader(1024, 2012))).toThrow(/compressed MongoDB/);
  });
});
