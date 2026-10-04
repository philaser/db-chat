import { randomUUID } from 'node:crypto';
import type { AccountRepository } from './accountRepository.js';

export class WorkerLeaseError extends Error {
  constructor() { super('The answer service is restarting or temporarily unavailable. Please reconnect.'); }
}
export class TurnCapacityError extends Error {
  constructor() { super('Wait for an active answer to finish before starting another.'); }
}
export interface WorkerHeartbeat { alive: boolean; cancelledTurns: string[] }
export interface WorkerCoordinatorOptions { id?: string; leaseMs?: number; heartbeatMs?: number }

/** The database owns lease time. The local deadline is conservative and monotonic. */
export class WorkerCoordinator {
  readonly id: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private expiry?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private recovery?: Promise<void>;
  private active = false;
  private closed = false;
  private validUntil = 0;
  constructor(private readonly accounts: AccountRepository, private readonly onCancel: (ids: string[]) => void,
    private readonly onLost: () => void, options: WorkerCoordinatorOptions = {}) {
    this.id = options.id ?? randomUUID();
    this.leaseMs = options.leaseMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? 5_000;
    if (this.leaseMs < 1000 || this.leaseMs > 120_000 || this.heartbeatMs < 10 || this.heartbeatMs >= this.leaseMs / 2) throw new Error('Invalid worker lease timing.');
  }
  get ready(): boolean { return this.active && !this.closed && performance.now() < this.validUntil; }
  assertReady(): void { if (!this.ready) { this.lose(); throw new WorkerLeaseError(); } }
  async start(): Promise<void> {
    const started = performance.now();
    const result = await this.accounts.registerWorker(this.id, this.leaseMs);
    if (!result.alive) throw new WorkerLeaseError();
    this.confirm(started);
    this.timer = setInterval(() => { if (!this.pending && this.ready) {
      this.pending = this.renew().finally(() => { this.pending = undefined; });
    } }, this.heartbeatMs);
    this.timer.unref?.();
    try { await this.recover(); } catch (error) { this.lose(); throw error; }
    this.assertReady();
  }
  private confirm(started: number): void {
    this.validUntil = started + this.leaseMs - this.heartbeatMs;
    if (performance.now() >= this.validUntil) { this.lose(); throw new WorkerLeaseError(); }
    this.active = true;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.lose(), this.validUntil - performance.now());
    this.expiry.unref?.();
  }
  private async renew(): Promise<void> {
    try {
      const started = performance.now();
      const result = await this.accounts.heartbeatWorker(this.id, this.leaseMs);
      if (!result.alive || !this.ready) { this.lose(); return; }
      this.confirm(started);
      this.onCancel(result.cancelledTurns);
      void this.recover().catch(() => this.lose());
    } catch { this.lose(); }
  }
  private recover(): Promise<void> {
    this.recovery ??= Promise.resolve().then(() => this.accounts.recoverExpiredTurns()).finally(() => { this.recovery = undefined; });
    return this.recovery;
  }
  private lose(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    if (this.expiry) clearTimeout(this.expiry);
    this.onLost();
  }
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.expiry) clearTimeout(this.expiry);
    // Do not await a delayed heartbeat/recovery here. A released lease cannot
    // be renewed, and closed workers ignore any response already in flight.
    try { await this.accounts.releaseWorker(this.id); } finally { this.active = false; }
  }
}
