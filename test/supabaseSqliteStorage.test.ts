import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionConfig } from '../src/shared/types.js';
import { SupabaseSqliteStorage } from '../src/server/supabaseSqliteStorage.js';

const contents = Buffer.from('SQLite format 3\0fixture');
const objectKey = 'owner/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.sqlite';
const config: ConnectionConfig = { id: 'connection', kind: 'sqlite', label: 'Example', createdAt: '', sqliteObjectKey: objectKey, safetyLevel: 'safe' };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup(handler: typeof fetch, maxBytes = 100) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dbchat-storage-test-')); dirs.push(tempDir);
  return { tempDir, storage: new SupabaseSqliteStorage({ url: 'https://example.supabase.co', key: 'sb_secret_test', maxBytes, fetch: handler, tempDir }) };
}

describe('private SQLite storage', () => {
  it('uploads with the server key and rejects invalid SQLite contents', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const { storage } = await setup(request);
    const key = await storage.upload('owner', contents);
    expect(key).toMatch(/^owner\/[a-f0-9-]+\.sqlite$/);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://example.supabase.co/storage/v1/object/dbchat-sqlite/' + key);
    expect(init?.headers).toMatchObject({ apikey: 'sb_secret_test', 'x-upsert': 'false' });
    expect(init?.headers).not.toHaveProperty('Authorization');
    await expect(storage.upload('owner', Buffer.from('not a database'))).rejects.toThrow('valid SQLite');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('downloads a saved object after adapter restart, scopes its temporary file and cleans it up', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(contents));
    const { storage, tempDir } = await setup(request);
    for (const adapter of [storage, new SupabaseSqliteStorage({ url: 'https://example.supabase.co', key: 'sb_secret_test', maxBytes: 100, fetch: request, tempDir })]) {
      await adapter.withConnection('owner', config, async local => {
        expect(await readFile(local.databasePath!)).toEqual(contents);
        expect((await stat(local.databasePath!)).mode & 0o777).toBe(0o600);
        expect(local.databasePath).toContain(tempDir);
      });
      expect(await readdir(tempDir)).toEqual([]);
    }
    expect(config.databasePath).toBeUndefined();
    expect(request.mock.calls[0][0]).toContain('/object/authenticated/dbchat-sqlite/owner/');
  });

  it('cleans up on query failure and cancellation', async () => {
    const { storage, tempDir } = await setup(async () => new Response(contents));
    await expect(storage.withConnection('owner', config, async () => { throw new Error('query failed'); })).rejects.toThrow('query failed');
    const controller = new AbortController();
    await expect(storage.withConnection('owner', config, async () => { controller.abort(); controller.signal.throwIfAborted(); }, controller.signal)).rejects.toThrow();
    expect(await readdir(tempDir)).toEqual([]);
  });

  it('rejects cross-owner keys before making requests', async () => {
    const request = vi.fn<typeof fetch>(); const { storage } = await setup(request);
    await expect(storage.withConnection('other', config, async () => {})).rejects.toThrow('belong');
    await expect(storage.remove('other', objectKey)).rejects.toThrow('belong');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([true, false])('enforces download size with content-length present=%s', async header => {
    const { storage, tempDir } = await setup(async () => new Response(contents, { headers: header ? { 'content-length': String(contents.length) } : {} }), 16);
    const run = vi.fn();
    await expect(storage.withConnection('owner', config, run)).rejects.toThrow('too large');
    expect(run).not.toHaveBeenCalled(); expect(await readdir(tempDir)).toEqual([]);
  });

  it('removes all owner pages without skipping objects or touching another owner', async () => {
    const remaining = new Set(Array.from({ length: 103 }, (_, i) => 'owner/' + i.toString(16) + '.sqlite'));
    const request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).includes('/list/')) {
        expect(body).toMatchObject({ prefix: 'owner/', offset: 0 });
        return Response.json([...remaining].slice(0, 100).map(key => ({ name: key.split('/')[1] })));
      }
      for (const key of body.prefixes) { expect(remaining.delete(key)).toBe(true); }
      return Response.json({});
    });
    const { storage } = await setup(request); await storage.removeOwner('owner');
    expect(remaining.size).toBe(0); expect(request).toHaveBeenCalledTimes(5);
  });
});
