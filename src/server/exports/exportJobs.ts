import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type DataFormat = 'csv' | 'xlsx' | 'json';
export type ExportFormat = DataFormat | 'html' | 'markdown';
export interface ExportLimits { maxRows: number; maxBytes: number; timeoutMs: number; ttlMs: number }
export const DEFAULT_EXPORT_LIMITS: ExportLimits = { maxRows: 1_000_000, maxBytes: 100 * 1024 * 1024, timeoutMs: 300_000, ttlMs: 3_600_000 };
export interface ExportSnapshot {
  id: string; title: string; format: ExportFormat; scope: 'visible' | 'all' | 'report';
  status: 'queued' | 'running' | 'ready' | 'error' | 'cancelled';
  rowCount: number; byteCount: number; createdAt: string; expiresAt: string;
  error?: string; downloadUrl?: string; limits: ExportLimits;
}
interface Job { owner: string; chatId: string; snapshot: ExportSnapshot; controller: AbortController; filename?: string; done?: Promise<void>; run?: (context: ExportRun) => Promise<void> }
export interface ExportRun { filename: string; signal: AbortSignal; limits: ExportLimits; progress: (rows: number, bytes: number) => void }
export class ExportError extends Error {}

/** Ephemeral, owner-scoped downloads. Partial files are never downloadable. */
export class ExportJobs {
  private jobs = new Map<string, Job>();
  private directory?: Promise<string>;
  private sweep = setInterval(() => { void this.prune(); }, 60_000).unref();
  private closed = false;
  constructor(readonly limits: ExportLimits = DEFAULT_EXPORT_LIMITS) {}

  start(owner: string, chatId: string, details: Pick<ExportSnapshot, 'title' | 'format' | 'scope'>, run: (context: ExportRun) => Promise<void>): ExportSnapshot {
    if (this.closed) throw new ExportError('Exports are unavailable while the service restarts.');
    // Bounds retained disk use as well as in-flight memory on the hosted instance.
    if ([...this.jobs.values()].filter(job => job.owner === owner).length >= 5) throw new ExportError('Your temporary download quota is full. Delete an earlier export or wait for it to expire.');
    if (this.jobs.size >= 10) throw new ExportError('The download service is busy. Wait for an export to expire and try again.');
    const id = randomUUID();
    const snapshot: ExportSnapshot = { ...details, title: details.title.slice(0, 200), id, status: 'queued', rowCount: 0, byteCount: 0, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + this.limits.ttlMs).toISOString(), limits: this.limits };
    const job: Job = { owner, chatId, snapshot, controller: new AbortController(), run };
    this.jobs.set(id, job);
    this.pump();
    return this.snapshot(job);
  }
  private pump() {
    if (this.closed) return;
    const active = [...this.jobs.values()].filter(job => job.snapshot.status === 'running');
    for (const job of this.jobs.values()) {
      if (active.length >= 2) break;
      if (job.snapshot.status !== 'queued' || active.some(other => other.owner === job.owner)) continue;
      job.snapshot.status = 'running'; active.push(job);
      job.done = this.execute(job, job.run!).finally(() => { delete job.run; this.pump(); });
    }
  }
  private async execute(job: Job, run: (context: ExportRun) => Promise<void>) {
    const timer = setTimeout(() => job.controller.abort(new ExportError('Export timed out. Narrow the query and try again.')), this.limits.timeoutMs).unref();
    try {
      this.directory ??= fs.mkdtemp(path.join(os.tmpdir(), 'dbchat-exports-'));
      job.filename = path.join(await this.directory, job.snapshot.id);
      job.controller.signal.throwIfAborted();
      job.snapshot.status = 'running';
      await run({ filename: job.filename, signal: job.controller.signal, limits: this.limits, progress: (rows, bytes) => { job.snapshot.rowCount = rows; job.snapshot.byteCount = bytes; } });
      job.controller.signal.throwIfAborted();
      const stat = await fs.stat(job.filename);
      if (stat.size > this.limits.maxBytes) throw new ExportError('Export exceeded the file-size limit. Narrow the query and try again.');
      job.snapshot.byteCount = stat.size;
      job.snapshot.status = 'ready';
    } catch (error) {
      if (job.snapshot.status !== 'cancelled') {
        job.snapshot.status = 'error';
        job.snapshot.error = job.controller.signal.reason instanceof ExportError ? job.controller.signal.reason.message : error instanceof ExportError ? error.message : 'The export could not be completed. Check the connection or narrow the query and try again.';
      }
      if (job.filename) await fs.rm(job.filename, { force: true }).catch(() => undefined);
    } finally { clearTimeout(timer); }
  }
  private snapshot(job: Job): ExportSnapshot {
    return { ...job.snapshot, limits: { ...this.limits }, ...(job.snapshot.status === 'ready' ? { downloadUrl: `/api/v1/exports/${job.snapshot.id}/download` } : {}) };
  }
  get(owner: string, id: string): ExportSnapshot | undefined {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner || Date.parse(job.snapshot.expiresAt) <= Date.now()) return undefined;
    return this.snapshot(job);
  }
  list(owner: string, chatId: string): ExportSnapshot[] {
    return [...this.jobs.values()]
      .filter(job => job.owner === owner && job.chatId === chatId && Date.parse(job.snapshot.expiresAt) > Date.now())
      .sort((left, right) => Date.parse(right.snapshot.createdAt) - Date.parse(left.snapshot.createdAt))
      .map(job => this.snapshot(job));
  }
  chatId(owner: string, id: string): string | undefined { return this.get(owner, id) ? this.jobs.get(id)!.chatId : undefined; }
  file(owner: string, id: string): string | undefined { return this.get(owner, id)?.status === 'ready' ? this.jobs.get(id)!.filename : undefined; }
  async cancel(owner: string, id: string): Promise<ExportSnapshot | undefined> {
    if (!this.get(owner, id)) return undefined;
    const job = this.jobs.get(id)!;
    job.snapshot.status = 'cancelled';
    delete job.snapshot.error;
    job.controller.abort();
    await job.done;
    if (job.filename) await fs.rm(job.filename, { force: true }).catch(() => undefined);
    return this.snapshot(job);
  }
  async remove(owner: string, id: string): Promise<void> { await this.cancel(owner, id); const job = this.jobs.get(id); if (job?.owner === owner) this.jobs.delete(id); }
  private async prune() {
    for (const [id, job] of this.jobs) {
      if (Date.parse(job.snapshot.expiresAt) > Date.now()) continue;
      job.controller.abort(); await job.done;
      if (job.filename) await fs.rm(job.filename, { force: true }).catch(() => undefined);
      this.jobs.delete(id);
    }
  }
  async close() {
    this.closed = true; clearInterval(this.sweep);
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all([...this.jobs.values()].map(job => job.done));
    if (this.directory) await fs.rm(await this.directory, { recursive: true, force: true });
    this.jobs.clear();
  }
}
export const EXPORT_MIME: Record<ExportFormat, string> = { csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', html: 'text/html; charset=utf-8', markdown: 'text/markdown; charset=utf-8' };
