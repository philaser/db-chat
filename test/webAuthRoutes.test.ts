import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebServer } from '../src/server/server';
import { AccountStore } from '../src/server/accountStore';
import { loadWebServerConfig } from '../src/server/config';
class RecoveryStore extends AccountStore {
  requestPasswordReset = vi.fn(async (_email: string, _redirect: string) => {});
  verifyEmail = vi.fn(async (_hash: string, _type: 'signup' | 'recovery' | 'email') => this.signup('verified@example.test', 'test-password'));
  resetPassword = vi.fn(async (_session: string, _password: string) => {});
  deleteAccount = vi.fn(async (_owner: string) => {});
}
describe('managed authentication routes', () => {
  let server: WebServer | undefined;
  afterEach(async () => { await server?.close(); });
  async function start() {
    const accounts = new RecoveryStore({ defaultModel: 'fixture', sessionTtlMs: 60000, secretKey: 'fixture' });
    const config = { ...loadWebServerConfig({ DBCHAT_WEB_AUTH_MODE: 'app' }), port: 0, sqliteUploadDir: undefined, allowedOrigin: 'https://app.example.test' };
    server = new WebServer(config, { accounts });
    const node = await server.listen(); const base = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
    const call = (route: string, body: unknown, cookie?: string, method = 'POST') => fetch(base + '/api/v1' + route, { method, headers: { 'content-type': 'application/json', origin: config.allowedOrigin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    return { accounts, call };
  }
  it('uses configured callback origin and returns a non-enumerating recovery response', async () => {
    const { accounts, call } = await start();
    const response = await call('/auth/forgot-password', { email: 'person@example.test', redirectTo: 'https://attacker.example.test' });
    expect(response.status).toBe(202);
    expect(accounts.requestPasswordReset).toHaveBeenCalledWith('person@example.test', 'https://app.example.test/auth/confirm');
    expect(await response.json()).toMatchObject({ ok: true });
  });
  it('exchanges verification tokens into HttpOnly cookies and rejects unsupported types', async () => {
    const { accounts, call } = await start();
    const invalid = await call('/auth/verify', { tokenHash: 'fixture-hash', type: 'oauth' });
    expect(invalid.status).toBe(400); expect(accounts.verifyEmail).not.toHaveBeenCalled();
    const response = await call('/auth/verify', { tokenHash: 'fixture-hash', type: 'recovery' });
    expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(await response.json()).toMatchObject({ recovery: true, session: { authenticated: false } });
  });
  it('requires a recovery cookie for reset and clears it after success', async () => {
    const { accounts, call } = await start();
    expect((await call('/auth/reset-password', { password: 'new-password' })).status).toBe(401);
    const verified = await call('/auth/verify', { tokenHash: 'fixture-hash', type: 'recovery' });
    const cookie = verified.headers.get('set-cookie')!.split(';')[0];
    const response = await call('/auth/reset-password', { password: 'new-password' }, cookie);
    expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toContain('Max-Age=0'); expect(accounts.resetPassword).toHaveBeenCalledOnce();
  });
  it('requires current password before deleting only the authenticated account', async () => {
    const { accounts, call } = await start();
    const signup = await call('/auth/signup', { email: 'person@example.test', password: 'test-password' });
    const cookie = signup.headers.get('set-cookie')!.split(';')[0]; const { user } = await signup.json();
    expect((await call('/account', { password: 'wrong-password' }, cookie, 'DELETE')).status).toBe(400);
    expect(accounts.deleteAccount).not.toHaveBeenCalled();
    expect((await call('/account', { password: 'test-password' }, cookie, 'DELETE')).status).toBe(200);
    expect(accounts.deleteAccount).toHaveBeenCalledWith(user.id);
  });
});
