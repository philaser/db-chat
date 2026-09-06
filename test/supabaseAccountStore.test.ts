import { describe, expect, it, vi } from 'vitest';
import { SupabaseAccountStore } from '../src/server/supabaseAccountStore';
import { SecretVault } from '../src/server/accountStore';
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'person@example.test', email_confirmed_at: '2026-09-05', created_at: '2026-09-05', user_metadata: { display_name: 'Person' } };
const tokens = { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, user };
const options = { url: 'https://example.supabase.co', publishableKey: 'public-key', serviceRoleKey: 'private-service-key', secretKey: 'stable-secret-key-at-least-thirty-two-characters', defaultModel: 'test-model', sessionTtlMs: 86400_000 };
type Fetch = typeof globalThis.fetch;
function mockFetch(handler: (url: URL, init: RequestInit) => unknown) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify(await handler(new URL(String(url)), init ?? {})), { status: 200 })) as unknown as Fetch;
}
describe('Supabase account repository', () => {
  it('uses modern publishable and secret keys as apikey headers without treating them as JWTs', async () => {
    const seen: Array<{url: string; headers: Headers}> = [];
    const fetch = mockFetch((url, init) => { seen.push({url:url.pathname,headers:new Headers(init.headers)}); return url.pathname.endsWith('/signup') ? user : []; });
    const store = new SupabaseAccountStore({...options,publishableKey:'sb_publishable_fixture',serviceRoleKey:'sb_secret_fixture',fetch});
    await store.signup(user.email,'password-long');
    await store.getUser(user.id);
    expect(seen[0].headers.get('apikey')).toBe('sb_publishable_fixture');
    expect(seen[1].headers.get('apikey')).toBe('sb_secret_fixture');
    expect(seen.every(item=>!item.headers.has('authorization'))).toBe(true);
  });
  it('keeps confirmation signup unauthenticated without creating application data', async () => {
    const fetch = mockFetch(() => ({ ...user, email_confirmed_at: undefined }));
    const store = new SupabaseAccountStore({ ...options, fetch });
    expect(await store.signup(user.email, 'password-long')).toMatchObject({ confirmationRequired: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('exchanges managed auth tokens for opaque cookie and encrypted durable tokens', async () => {
    const writes: unknown[] = [];
    const fetch = mockFetch((url, init) => {
      if (url.pathname === '/auth/v1/token') return tokens;
      if (init.method === 'POST') { writes.push(JSON.parse(String(init.body))); return []; }
      return [];
    });
    const result = await new SupabaseAccountStore({ ...options, fetch }).login(user.email, 'password');
    expect(result.sessionId).toHaveLength(43);
    const persisted = JSON.stringify(writes);
    expect(persisted).not.toContain(tokens.access_token);
    expect(persisted).not.toContain(tokens.refresh_token);
    expect(persisted).not.toContain(result.sessionId);
    expect(writes).toHaveLength(2);
  });
  it('scopes all connection reads and mutations to their owner and hides full URIs', async () => {
    let row: Record<string, unknown> | undefined;
    const urls: URL[] = [];
    const fetch = mockFetch((url, init) => {
      urls.push(url);
      if (url.pathname.endsWith('dbchat_profiles')) return [{ user_id: user.id, email: user.email, display_name: 'Person', settings: { activeConnectionId: 'existing' } }];
      if (init.method === 'POST') { row = JSON.parse(String(init.body)); return []; }
      return row && url.searchParams.get('user_id') === 'eq.' + user.id ? [row] : [];
    });
    const store = new SupabaseAccountStore({ ...options, fetch });
    const result = await store.createConnection(user.id, { id: '', label: 'Search', kind: 'elasticsearch', host: 'example.test', createdAt: '', elasticsearchUrl: 'https://user:secret@example.test' });
    expect(JSON.stringify(row)).not.toContain('user:secret');
    expect(JSON.stringify(result)).not.toContain('user:secret');
    expect((await store.getConnectionConfig(user.id, result.id))?.elasticsearchUrl).toContain('user:secret');
    expect(await store.getConnectionConfig('another-user', result.id)).toBeNull();
    expect(urls.filter(url => url.pathname.endsWith('dbchat_connections') && url.search).every(url => url.searchParams.has('user_id'))).toBe(true);
  });
  it('does not disclose upstream bodies on failures', async () => {
    const fetch = vi.fn(async () => new Response('password=secret private-access', { status: 401 })) as unknown as Fetch;
    await expect(new SupabaseAccountStore({ ...options, fetch }).login(user.email, 'secret')).rejects.toThrow('Authentication could not be completed');
  });
  it('coalesces simultaneous refresh requests and uses a database lease', async () => {
    const vault = new SecretVault(options.secretKey);
    let row = { id_hash: 'hash', user_id: user.id, encrypted_tokens: vault.encrypt(JSON.stringify(tokens)), expires_at: Date.now()+86400_000, absolute_expires_at: Date.now()+86400_000, access_expires_at: 0, refreshed_at: Date.now(), refresh_lock_until: 0 };
    let refreshCount = 0;
    const fetch = mockFetch((url, init) => {
      if (url.pathname.endsWith('/token')) { refreshCount++; return tokens; }
      if (url.pathname.endsWith('/user')) return user;
      if (url.pathname.endsWith('dbchat_profiles')) return [{ user_id: user.id, email: user.email, display_name: 'Person', settings: {} }];
      if (init.method === 'PATCH') row = { ...row, ...JSON.parse(String(init.body)) };
      return [row];
    });
    const store = new SupabaseAccountStore({ ...options, fetch });
    const principals = await Promise.all([store.principalForSession('cookie'), store.principalForSession('cookie')]);
    expect(refreshCount).toBe(1);
    expect(principals.every(principal => principal?.id === user.id)).toBe(true);
  });
  it('keeps recovery sessions out of normal APIs and rejects password reset from login sessions', async () => {
    let purpose = 'recovery';
    const vault = new SecretVault(options.secretKey);
    const fetch = mockFetch(() => [{ id_hash:'hash',user_id:user.id,purpose,encrypted_tokens:vault.encrypt(JSON.stringify(tokens)),expires_at:Date.now()+60000,absolute_expires_at:Date.now()+60000,access_expires_at:Date.now()+3600000,refreshed_at:Date.now() }]);
    const store = new SupabaseAccountStore({...options,fetch});
    expect(await store.principalForSession('recovery-cookie')).toBeNull();
    purpose='login';
    await expect(store.resetPassword('login-cookie','new-password')).rejects.toThrow('recovery session has expired');
  });
  it('uses ownership-bearing transactional RPCs for turn claim and finalization', async () => {
    const calls: unknown[] = [];
    const fetch = mockFetch((_url, init) => { calls.push(JSON.parse(String(init.body))); return { turnId: 'turn-one', created: true }; });
    const store = new SupabaseAccountStore({ ...options, fetch });
    await store.claimTurn(user.id, 'turn-one', 'chat-one', 'request-one', { id: 'm1', content: 'Question', role: 'user', createdAt: '' }, 'm2');
    await store.finalizeTurn(user.id, { id: 'turn-one', events: [], status: 'complete' });
    expect(calls).toEqual([expect.objectContaining({ owner: user.id, request_id: 'request-one' }), expect.objectContaining({ owner: user.id, turn: expect.objectContaining({ status: 'complete' }) })]);
  });
});
