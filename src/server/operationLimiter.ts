export class OperationCapacityError extends Error {
  constructor() { super('Database capacity is busy. Please try again shortly.'); }
}

/** Bounds driver/SQLite-child allocations, including schema checks and exports. */
export class OperationLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly maximum: number, private readonly queueLimit = 32) {
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error('Invalid database operation limit.');
  }
  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.maximum) {
      if (this.waiting.length >= this.queueLimit) throw new OperationCapacityError();
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal?.removeEventListener('abort', aborted); resolve(); };
        const aborted = () => {
          const index = this.waiting.indexOf(ready);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal?.reason ?? new Error('Operation cancelled.'));
        };
        this.waiting.push(ready);
        signal?.addEventListener('abort', aborted, { once: true });
      });
    } else this.active++;
    try { signal?.throwIfAborted(); return await operation(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
