// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { AccountStore } from '../src/server/accountStore';
import { loadWebServerConfig, type WebServerConfig } from '../src/server/config';
import { WebServer } from '../src/server/server';
import type { SqliteObjectStorage } from '../src/server/supabaseSqliteStorage';

const servers: WebServer[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(server => server.close())); });
const contents = Buffer.from('SQLite format 3\0fixture');
class DeletableAccounts extends AccountStore {
  deleteAccount = vi.fn(async (_owner: string) => {});
}
async function fixture(overrides: Partial<WebServerConfig> = {}, storage?: SqliteObjectStorage) {
  const accounts = new DeletableAccounts({ defaultModel: 'fixture', sessionTtlMs: 3600_000, secretKey: 'fixture' });
  const first = accounts.signup('a@example.test', 'fixture-password');
  const second = accounts.signup('b@example.test', 'fixture-password');
  const server = new WebServer({ ...loadWebServerConfig({ DBCHAT_WEB_AUTH_MODE: 'app' }), port: 0, sqliteUploadDir: undefined, ...overrides }, { accounts, sqliteStorage: storage });
  servers.push(server);
  const handle = await server.listen();
  const base = 'http://127.0.0.1:' + (handle.address() as AddressInfo).port + '/api/v1';
  const headers = (session = first.sessionId) => ({ cookie: 'dbchat_auth_session=' + session, 'content-type': 'application/json' });
  const upload = (session = first.sessionId) => fetch(base + '/sqlite-files', { method: 'POST', headers: { ...headers(session), 'x-dbchat-filename': 'fixture.sqlite' }, body: contents });
  return { accounts, first, second, server, base, headers, upload };
}
function storageFixture(): SqliteObjectStorage {
  let sequence = 0;
  return {
    upload: vi.fn(async owner => owner + '/' + (++sequence) + '.sqlite'),
    withConnection: async (_owner, config, run) => run(config),
    remove: vi.fn(async () => {}), removeOwner: vi.fn(async () => {})
  };
}

describe('hosted request and upload budgets', () => {
  it('rejects oversized chat metadata before parsing or writing saved state', async () => {
    const f = await fixture({ maxBodyBytes: 1024, maxChatBodyBytes: 16 * 1024 * 1024 });
    const chat = f.accounts.createChat(f.first.user.id);
    const create = vi.spyOn(f.accounts, 'createChat');
    const update = vi.spyOn(f.accounts, 'updateChat');
    for (const [route, method] of [['/chats', 'POST'], ['/chats/' + chat.id, 'PATCH']]) {
      const response = await fetch(f.base + route, { method, headers: f.headers(), body: JSON.stringify({ title: 'x'.repeat(2048) }) });
      expect(response.status).toBe(413);
    }
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('isolates authenticated request budgets for accounts behind the same proxy', async () => {
    const f = await fixture();
    for (let i = 0; i < 120; i++) expect((await fetch(f.base + '/unknown', { method: 'POST', headers: f.headers() })).status).toBe(404);
    expect((await fetch(f.base + '/unknown', { method: 'POST', headers: f.headers() })).status).toBe(429);
    expect((await fetch(f.base + '/unknown', { method: 'POST', headers: f.headers(f.second.sessionId) })).status).toBe(404);
  });

  it.each([0, 1])('trusts only configured proxy hops for unauthenticated throttles (hops=%s)', async hops => {
    const f = await fixture({ trustedProxyHops: hops });
    const call = (forwarded: string) => fetch(f.base + '/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': forwarded }, body: '{}' });
    for (let i = 0; i < 5; i++) expect((await call('198.51.100.' + (i + 1) + ', 203.0.113.1')).status).toBe(400);
    expect((await call('198.51.100.99, 203.0.113.1')).status).toBe(429);
    expect((await call('198.51.100.99, 203.0.113.2')).status).toBe(hops ? 400 : 429);
  });

  it('includes suggestions in the database-check budget', async () => {
    const f = await fixture();
    for (let i = 0; i < 20; i++) expect((await fetch(f.base + '/connections/missing/suggestions', { headers: f.headers() })).status).toBe(404);
    expect((await fetch(f.base + '/connections/missing/suggestions', { headers: f.headers() })).status).toBe(429);
  });

  it('reserves upload allowance before writing objects and keeps failures charged', async () => {
    const storage = storageFixture();
    vi.mocked(storage.upload).mockRejectedValueOnce(new Error('Synthetic storage failure'));
    const f = await fixture({ sqliteUploadsPerAccountPerDay: 1 }, storage);
    expect((await f.upload()).status).toBe(400);
    const rejected = await f.upload();
    expect(rejected.status).toBe(429);
    expect((await rejected.json()).error).toContain('daily SQLite upload allowance');
    expect(storage.upload).toHaveBeenCalledTimes(1);
  });

  it('rejects simultaneous uploads before a second reservation or body reaches storage', async () => {
    const storage = storageFixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(storage.upload).mockImplementationOnce(async owner => { await gate; return owner + '/held.sqlite'; });
    const f = await fixture({ maxConcurrentUploads: 1 }, storage);
    const reserve = vi.spyOn(f.accounts, 'reserveSqliteUpload');
    const first = f.upload();
    await vi.waitFor(() => expect(storage.upload).toHaveBeenCalledOnce());
    expect((await f.upload(f.second.sessionId)).status).toBe(429);
    expect(reserve).toHaveBeenCalledOnce();
    release(); expect((await first).status).toBe(201);
  });

  it('keeps an upload available after invalid connection input and preserves bound files on shutdown', async () => {
    const storage = storageFixture();
    const f = await fixture({}, storage);
    const uploaded = await (await f.upload()).json();
    const save = (label: string) => fetch(f.base + '/connections', { method: 'POST', headers: f.headers(), body: JSON.stringify({ kind: 'sqlite', label, sqliteUploadId: uploaded.uploadId }) });
    expect((await save('')).status).toBe(500);
    expect((await save('Saved database')).status).toBe(201);
    expect((await save('Duplicate database')).status).toBe(500);
    await f.server.close();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('deletes unbound files on graceful shutdown', async () => {
    const storage = storageFixture();
    const f = await fixture({}, storage);
    expect((await f.upload()).status).toBe(201);
    await f.server.close();
    expect(storage.remove).toHaveBeenCalledWith(f.first.user.id, f.first.user.id + '/1.sqlite');
  });

  it('expires pending uploads after one hour while the server remains running', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      const storage = storageFixture();
      const f = await fixture({}, storage);
      expect((await f.upload()).status).toBe(201);
      await vi.advanceTimersByTimeAsync(3600_000);
      expect(storage.remove).toHaveBeenCalledWith(f.first.user.id, f.first.user.id + '/1.sqlite');
    } finally { vi.useRealTimers(); }
  });

  it('does not reuse or delete an asset when an earlier connection save committed but its response failed', async () => {
    const storage = storageFixture();
    const f = await fixture({}, storage);
    const uploaded = await (await f.upload()).json();
    const create = f.accounts.createConnection.bind(f.accounts);
    vi.spyOn(f.accounts, 'createConnection').mockImplementationOnce((...args) => { create(...args); throw new Error('Synthetic response loss'); });
    const save = () => fetch(f.base + '/connections', { method: 'POST', headers: f.headers(), body: JSON.stringify({ kind: 'sqlite', label: 'Saved database', sqliteUploadId: uploaded.uploadId }) });
    expect((await save()).status).toBe(500);
    expect((await save()).status).toBe(500);
    expect(f.accounts.listConnections(f.first.user.id)).toHaveLength(1);
    await f.server.close();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('blocks new owner work and waits for an admitted upload before deleting storage and the account', async () => {
    const storage = storageFixture();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(storage.upload).mockImplementationOnce(async owner => { await gate; order.push('upload-complete'); return owner + '/held.sqlite'; });
    vi.mocked(storage.removeOwner).mockImplementation(async () => { order.push('remove-owner'); });
    const f = await fixture({}, storage);
    f.accounts.deleteAccount.mockImplementation(async () => { order.push('delete-account'); });
    const upload = f.upload();
    await vi.waitFor(() => expect(storage.upload).toHaveBeenCalledOnce());
    const deletion = fetch(f.base + '/account', { method: 'DELETE', headers: f.headers(), body: JSON.stringify({ password: 'fixture-password' }) });
    await vi.waitFor(async () => expect((await fetch(f.base + '/unknown', { method: 'POST', headers: f.headers() })).status).toBe(409));
    expect(storage.removeOwner).not.toHaveBeenCalled();
    expect(f.accounts.deleteAccount).not.toHaveBeenCalled();
    release();
    expect((await upload).status).toBe(201);
    expect((await deletion).status).toBe(200);
    expect(order).toEqual(['upload-complete', 'remove-owner', 'delete-account']);
    expect((await fetch(f.base + '/unknown', { method: 'POST', headers: f.headers(f.second.sessionId) })).status).toBe(404);
  });

  it('leaves the account and storage intact if active owner work cannot drain in time', async () => {
    const storage = storageFixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(storage.upload).mockImplementationOnce(async owner => { await gate; return owner + '/held.sqlite'; });
    const f = await fixture({ shutdownGraceMs: 20 }, storage);
    const upload = f.upload();
    await vi.waitFor(() => expect(storage.upload).toHaveBeenCalledOnce());
    const deletion = await fetch(f.base + '/account', { method: 'DELETE', headers: f.headers(), body: JSON.stringify({ password: 'fixture-password' }) });
    expect(deletion.status).toBe(400);
    expect(storage.removeOwner).not.toHaveBeenCalled();
    expect(f.accounts.deleteAccount).not.toHaveBeenCalled();
    release(); expect((await upload).status).toBe(201);
    expect(f.accounts.deleteAccount).not.toHaveBeenCalled();
  });
});

describe('quota configuration validation', () => {
  it.each(['0', '-1', '0.5', '2147483648', 'NaN', ''])('rejects invalid durable allowance %s at startup', value => {
    expect(() => loadWebServerConfig({ DBCHAT_WEB_MANAGED_TURNS_PER_DAY: value })).toThrow('must be an integer');
    expect(() => loadWebServerConfig({ DBCHAT_WEB_SQLITE_UPLOAD_BYTES_PER_DAY: value })).toThrow('must be an integer');
  });
});
