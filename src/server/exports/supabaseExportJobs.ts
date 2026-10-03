import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { ExportError, type ExportLimits, type ExportRun, type ExportSnapshot } from './exportJobs.js';
import type { ExportRepository } from './exportRepository.js';

interface ExportRow {
  id: string; user_id: string; chat_id: string; worker_id: string;
  title: string; format: ExportSnapshot['format']; scope: ExportSnapshot['scope'];
  status: ExportSnapshot['status']; executing: boolean; row_count: number; byte_count: number;
  error?: string; limits: ExportLimits; object_key: string; object_deleted: boolean;
  remove_requested: boolean; created_at: string; expires_at: string;
}
interface LocalJob { row: ExportRow; controller: AbortController; run: (context: ExportRun) => Promise<void>; done?: Promise<void> }
const BUCKET = 'dbchat-exports';

/** Durable download metadata and private object storage, with fenced execution. */
export class SupabaseExportJobs implements ExportRepository {
  private readonly worker = randomUUID();
  private readonly jobs = new Map<string, LocalJob>();
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private cleaning?: Promise<void>;
  private closed = false;
  constructor(readonly limits: ExportLimits, private readonly options: { url: string; serviceRoleKey: string; fetch?: typeof fetch; pollMs?: number }) {}

  private async text(response: Response, maximum = 2 * 1024 * 1024): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > maximum) throw new ExportError('Invalid download metadata.');
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }

  private async request(route: string, init: RequestInit = {}): Promise<Response> {
    const key = this.options.serviceRoleKey;
    const response = await (this.options.fetch ?? fetch)(this.options.url.replace(/\/$/, '') + route, {
      ...init, redirect: 'error', signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(15_000),
      headers: { apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: 'Bearer ' + key }), ...init.headers }
    });
    if (!response.ok) {
      // Never expose upstream bodies. Only recognize our fixed capacity markers.
      const text = await this.text(response, 8192).catch(() => '');
      if (text.includes('DBCHAT_EXPORT_ACCOUNT_LIMIT')) throw new ExportError('Your temporary download quota is full. Remove an earlier download or wait for cleanup.');
      if (text.includes('DBCHAT_EXPORT_GLOBAL_LIMIT')) throw new ExportError('The download service is busy. Wait for cleanup and try again.');
      throw new ExportError('Downloads are temporarily unavailable. Please try again.');
    }
    return response;
  }
  private async json<T>(route: string, init?: RequestInit): Promise<T> {
    const response = await this.request(route, init);
    const text = await this.text(response);
    return (text ? JSON.parse(text) : undefined) as T;
  }
  private rpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
    return this.json<T>('/rest/v1/rpc/dbchat_export_' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  async initialize(): Promise<void> {
    await this.json('/rest/v1/dbchat_exports?select=id&limit=0');
    this.timer = setInterval(() => { void this.poll(); }, this.options.pollMs ?? 5000).unref();
    void this.poll();
  }
  private snapshot(row: ExportRow): ExportSnapshot {
    return { id: row.id, title: row.title, format: row.format, scope: row.scope, status: row.status,
      rowCount: Number(row.row_count), byteCount: Number(row.byte_count), createdAt: row.created_at,
      expiresAt: row.expires_at, limits: row.limits, ...(row.error ? { error: row.error } : {}),
      ...(row.status === 'ready' ? { downloadUrl: `/api/v1/exports/${row.id}/download` } : {}) };
  }
  private async rows(owner: string, filter: string): Promise<ExportRow[]> {
    return this.json(`/rest/v1/dbchat_exports?user_id=eq.${encodeURIComponent(owner)}&remove_requested=eq.false&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&${filter}`);
  }
  async get(owner: string, id: string) { const row = (await this.rows(owner, 'id=eq.' + encodeURIComponent(id) + '&limit=1'))[0]; return row ? this.snapshot(row) : undefined; }
  async list(owner: string, chatId: string) { return (await this.rows(owner, 'chat_id=eq.' + encodeURIComponent(chatId) + '&order=created_at.desc&limit=10')).map(row => this.snapshot(row)); }
  async chatId(owner: string, id: string) { return (await this.rows(owner, 'id=eq.' + encodeURIComponent(id) + '&limit=1'))[0]?.chat_id; }

  async start(owner: string, chatId: string, details: Pick<ExportSnapshot, 'title' | 'format' | 'scope'>, run: (context: ExportRun) => Promise<void>): Promise<ExportSnapshot> {
    if (this.closed) throw new ExportError('Exports are unavailable while the service restarts.');
    const row = await this.rpc<ExportRow>('create', { p_owner: owner, p_id: randomUUID(), p_worker: this.worker, p_chat: chatId, p_details: details, p_limits: this.limits });
    this.jobs.set(row.id, { row, controller: new AbortController(), run });
    void this.poll();
    return this.snapshot(row);
  }
  private poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.maintain().catch(() => {
      // A failed heartbeat cannot be treated as evidence that ownership remains.
      for (const job of this.jobs.values()) job.controller.abort(new ExportError('Download coordination is unavailable.'));
      console.error('[dbchat:exports] coordination or cleanup unavailable');
    }).finally(() => { this.polling = undefined; });
    return this.polling;
  }
  private async maintain(): Promise<void> {
    for (const [id, job] of this.jobs) {
      if (job.controller.signal.aborted && !job.done) {
        await this.rpc('finish', { p_id: id, p_worker: this.worker, p_status: 'cancelled', p_rows: 0, p_bytes: 0 }).catch(() => undefined);
        this.jobs.delete(id); continue;
      }
      const row = await this.rpc<ExportRow | null>('tick', { p_id: id, p_worker: this.worker, p_start: !this.closed && !job.done });
      if (!row || row.status === 'cancelled') { job.controller.abort(); if (!job.done) { this.jobs.delete(id); } continue; }
      job.row = row;
      if (row.status === 'running' && !job.done) {
        job.done = this.execute(job).finally(() => { this.jobs.delete(id); });
      }
    }
    // Slow object deletion must not delay execution heartbeats.
    void this.sweep();
  }
  private async execute(job: LocalJob): Promise<void> {
    const { row, controller } = job;
    const timeout = setTimeout(() => controller.abort(new ExportError('Export timed out.')), row.limits.timeoutMs).unref();
    let directory: string | undefined;
    let rows = 0;
    try {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dbchat-export-'));
      const filename = path.join(directory, row.id);
      controller.signal.throwIfAborted();
      await job.run({ filename, signal: controller.signal, limits: row.limits, progress: count => { rows = count; } });
      controller.signal.throwIfAborted();
      const stat = await fs.stat(filename);
      if (stat.size > row.limits.maxBytes || rows > row.limits.maxRows) throw new ExportError('Export limit exceeded.');
      // Refresh ownership immediately before the external write. A failed/lost
      // upload or publication remains discoverable through the reserved key.
      const current = await this.rpc<ExportRow | null>('tick', { p_id: row.id, p_worker: this.worker, p_start: false });
      if (current?.status !== 'running') throw new ExportError('Export is no longer active.');
      const input = createReadStream(filename);
      try {
        const request: RequestInit & { duplex: 'half' } = { method: 'POST', duplex: 'half', signal: controller.signal,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(stat.size), 'x-upsert': 'false' }, body: Readable.toWeb(input) as ReadableStream<Uint8Array> };
        const response = await this.request('/storage/v1/object/' + BUCKET + '/' + row.object_key, request);
        await response.body?.cancel();
      } finally { input.destroy(); }
      controller.signal.throwIfAborted();
      await this.rpc('finish', { p_id: row.id, p_worker: this.worker, p_status: 'ready', p_rows: rows, p_bytes: stat.size });
    } catch {
      // Finish is idempotent: a lost successful publication response cannot
      // downgrade a ready job or delete its file.
      await this.rpc('finish', { p_id: row.id, p_worker: this.worker, p_status: controller.signal.aborted ? 'cancelled' : 'error', p_rows: 0, p_bytes: 0 }).catch(() => undefined);
    } finally {
      clearTimeout(timeout);
      if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  async read(owner: string, id: string): Promise<Readable | undefined> {
    const row = (await this.rows(owner, 'id=eq.' + encodeURIComponent(id) + '&limit=1'))[0];
    if (!row || row.status !== 'ready') return undefined;
    const response = await this.request('/storage/v1/object/authenticated/' + BUCKET + '/' + row.object_key);
    if (!response.body) throw new ExportError('The download file is unavailable.');
    let bytes = 0;
    const maximum = Math.min(Number(row.byte_count), row.limits.maxBytes);
    const limiter = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maximum ? new ExportError('Invalid download size.') : null, chunk);
    }, flush(callback) { callback(bytes !== maximum ? new ExportError('Incomplete download.') : null); } });
    const input = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
    input.on('error', error => limiter.destroy(error));
    limiter.on('close', () => input.destroy());
    return input.pipe(limiter);
  }
  async cancel(owner: string, id: string): Promise<ExportSnapshot | undefined> {
    await this.rpc('cancel', { p_owner: owner, p_id: id, p_remove: false });
    const job = this.jobs.get(id);
    if (job?.row.user_id === owner) { job.controller.abort(); await job.done; }
    await this.poll();
    return this.get(owner, id);
  }
  async remove(owner: string, id: string): Promise<void> {
    await this.rpc('cancel', { p_owner: owner, p_id: id, p_remove: true });
    const job = this.jobs.get(id);
    if (job?.row.user_id === owner) { job.controller.abort(); await job.done; }
    await this.poll();
  }
  async cancelOwner(owner: string): Promise<void> {
    await this.rpc('cancel', { p_owner: owner, p_id: null, p_remove: true });
    const owned = [...this.jobs.values()].filter(job => job.row.user_id === owner);
    for (const job of owned) job.controller.abort();
    await Promise.all(owned.map(job => job.done));
    await this.poll();
    await this.sweep();
    const pending = await this.json<ExportRow[]>(`/rest/v1/dbchat_exports?user_id=eq.${encodeURIComponent(owner)}&or=(executing.eq.true,object_deleted.eq.false)&limit=1`);
    if (pending.length) throw new ExportError('Account downloads are still stopping. Cleanup will retry.');
  }
  private sweep(): Promise<void> {
    this.cleaning ??= this.cleanup().catch(() => {
      console.error('[dbchat:exports] object cleanup unavailable; will retry');
    }).finally(() => { this.cleaning = undefined; });
    return this.cleaning;
  }
  private async cleanup(): Promise<void> {
    for (let index = 0; index < 10; index++) {
      const token = randomUUID();
      const row = await this.rpc<ExportRow | null>('cleanup_claim', { p_token: token });
      if (!row) return;
      const response = await this.request('/storage/v1/object/' + BUCKET, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [row.object_key] }) });
      await response.body?.cancel();
      await this.rpc('cleanup_finish', { p_id: row.id, p_token: token });
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.polling;
    const owned = [...this.jobs.values()];
    for (const job of owned) job.controller.abort();
    await this.rpc('stop_worker', { p_worker: this.worker }).catch(() => undefined);
    await Promise.all(owned.map(job => job.done));
    await this.poll();
    await this.sweep();
  }
}
