import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionConfig } from '../shared/types.js';

export const SQLITE_BUCKET = 'dbchat-sqlite';
export interface SqliteObjectStorage {
  upload(owner: string, contents: Buffer): Promise<string>;
  withConnection<T>(owner: string, config: ConnectionConfig, run: (local: ConnectionConfig) => Promise<T>, signal?: AbortSignal): Promise<T>;
  remove(owner: string, key: string): Promise<void>;
  removeOwner(owner: string): Promise<void>;
}

/** Private bucket accessed only by Node. Stored keys are scoped to the authenticated owner. */
export class SupabaseSqliteStorage implements SqliteObjectStorage {
  constructor(private readonly options: { url: string; key: string; maxBytes: number; fetch?: typeof fetch; tempDir?: string }) {}

  private ownerPrefix(owner: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(owner)) throw new Error('Invalid upload owner.');
    return owner + '/';
  }

  private objectPath(owner: string, key: string): string {
    if (!key.startsWith(this.ownerPrefix(owner)) || !/^[a-zA-Z0-9_-]+\/[a-f0-9-]+\.sqlite$/.test(key)) {
      throw new Error('SQLite file does not belong to this account.');
    }
    return key.split('/').map(encodeURIComponent).join('/');
  }

  private async request(route: string, init: RequestInit = {}): Promise<Response> {
    const key = this.options.key;
    const response = await (this.options.fetch ?? fetch)(this.options.url.replace(/\/$/, '') + '/storage/v1/' + route, {
      ...init, redirect: 'error', signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      headers: { apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: 'Bearer ' + key }), ...init.headers }
    });
    if (!response.ok) throw new Error('SQLite file storage is unavailable. Please try again.');
    return response;
  }

  async upload(owner: string, contents: Buffer): Promise<string> {
    if (contents.length > this.options.maxBytes) throw new Error('SQLite file is too large.');
    if (contents.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') throw new Error('Choose a valid SQLite database file.');
    const key = this.ownerPrefix(owner) + randomUUID() + '.sqlite';
    await this.request('object/' + SQLITE_BUCKET + '/' + this.objectPath(owner, key), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' }, body: new Uint8Array(contents)
    });
    return key;
  }

  async withConnection<T>(owner: string, config: ConnectionConfig, run: (local: ConnectionConfig) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!config.sqliteObjectKey) return run(config);
    const objectPath = this.objectPath(owner, config.sqliteObjectKey);
    signal?.throwIfAborted();
    const response = await this.request('object/authenticated/' + SQLITE_BUCKET + '/' + objectPath, { signal });
    if (Number(response.headers.get('content-length')) > this.options.maxBytes) {
      await response.body?.cancel(); throw new Error('SQLite file is too large.');
    }
    if (!response.body) throw new Error('SQLite file is empty.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.length;
        if (bytes > this.options.maxBytes) throw new Error('SQLite file is too large.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const contents = Buffer.concat(chunks);
    if (contents.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') throw new Error('Saved SQLite file is invalid.');
    const directory = await mkdtemp(path.join(this.options.tempDir ?? os.tmpdir(), 'dbchat-query-'));
    try {
      const databasePath = path.join(directory, 'database.sqlite');
      await writeFile(databasePath, contents, { mode: 0o600, flag: 'wx' });
      signal?.throwIfAborted();
      return await run({ ...config, databasePath });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async remove(owner: string, key: string): Promise<void> {
    this.objectPath(owner, key);
    await this.request('object/' + SQLITE_BUCKET, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [key] })
    });
  }

  async removeOwner(owner: string): Promise<void> {
    const prefix = this.ownerPrefix(owner);
    // Delete the first page repeatedly: advancing an offset after deletion skips objects.
    while (true) {
      const response = await this.request('object/list/' + SQLITE_BUCKET, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix, limit: 100, offset: 0, sortBy: { column: 'name', order: 'asc' } })
      });
      const objects = await response.json() as { name: string }[];
      if (!objects.length) return;
      const keys = objects.map(object => prefix + object.name);
      keys.forEach(key => this.objectPath(owner, key));
      await this.request('object/' + SQLITE_BUCKET, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: keys })
      });
    }
  }
}
