import { expect, it } from 'vitest';
import { OperationLimiter, OperationCapacityError } from '../src/server/operationLimiter';
it('bounds allocations, removes cancelled waiters and reuses capacity after failures', async () => {
  const limiter = new OperationLimiter(1, 1);
  let release!: () => void;
  const first = limiter.run(() => new Promise<void>(resolve => { release = resolve; }));
  const controller = new AbortController();
  let executed = false;
  const waiting = limiter.run(async () => { executed = true; }, controller.signal);
  await expect(limiter.run(async () => {})).rejects.toBeInstanceOf(OperationCapacityError);
  controller.abort();
  await expect(waiting).rejects.toThrow();
  const failure = limiter.run(async () => { throw new Error('fixture failure'); });
  release(); await first;
  await expect(failure).rejects.toThrow('fixture failure');
  expect(executed).toBe(false);
  expect(await limiter.run(async () => 'reused')).toBe('reused');
});
