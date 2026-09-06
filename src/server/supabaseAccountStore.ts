import { createHash, randomBytes } from 'node:crypto';
import { SecretVault, splitSecrets, displayConnection, customChatTitle, type AccountStore, type ConnectionTestResult, type StoredConnection } from './accountStore.js';
import { publicConnectionUri } from '../shared/connectionSecrets.js';
import type { ChatMessage, ConnectionConfig, QueryResultArtifact, WebChatSession, WebChatSummary } from '../shared/types.js';
import type { Principal, WebAccountSettings, WebUser, WebTurnSnapshot } from './types.js';
import type { AccountRepository } from './accountRepository.js';
interface AuthUser { id: string; email?: string; email_confirmed_at?: string; created_at: string; user_metadata?: { display_name?: string } }
interface AuthTokens { access_token: string; refresh_token: string; expires_in: number; user: AuthUser }
interface Profile { user_id: string; email: string; display_name: string; email_verified: boolean; created_at: string; settings: WebAccountSettings; encrypted_provider_key?: string | null }
interface Session { id_hash: string; user_id: string; encrypted_tokens: string; access_expires_at: number; expires_at: number; absolute_expires_at: number; refreshed_at: number; refresh_lock_until: number; purpose?: string }
interface ChatRow { id: string; user_id: string; title: string; connection_id?: string; custom_title: boolean; created_at: string; updated_at: string; message_count: number; artifact_count: number }
interface ConnectionRow { id: string; user_id: string; config: ConnectionConfig; encrypted_secrets?: string; status: StoredConnection['status']; last_tested_at?: string; table_count?: number; last_error?: string }
export interface SupabaseAccountStoreOptions {
  url: string; publishableKey: string; serviceRoleKey: string; secretKey: string;
  defaultModel: string; sessionTtlMs: number; sessionAbsoluteTtlMs?: number;
  fetch?: typeof fetch; appOrigin?: string;
}
class SupabaseRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
/** Privileged backend repository. Never instantiate in a browser or expose its keys/tokens. */
export class SupabaseAccountStore implements AccountRepository {
  private readonly vault: SecretVault;
  private readonly fetcher: typeof fetch;
  private readonly refreshes = new Map<string, Promise<Session | null>>();
  constructor(private readonly options: SupabaseAccountStoreOptions) {
    const url = new URL(options.url);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Supabase requires HTTPS.');
    if (!options.publishableKey || !options.serviceRoleKey || options.secretKey.length < 32) throw new Error('Supabase keys and a stable encryption key of at least 32 characters are required.');
    this.vault = new SecretVault(options.secretKey);
    this.fetcher = options.fetch ?? fetch;
  }
  private async request<T>(path: string, method = 'GET', body?: unknown, token?: string, prefer?: string): Promise<T> {
    const isRest = path.startsWith('/rest/');
    const key = isRest || path.startsWith('/auth/v1/admin/') ? this.options.serviceRoleKey : this.options.publishableKey;
    const response = await this.fetcher(this.options.url.replace(/\/$/, '') + path, {
      method, headers: { apikey: key, ...(token ? { Authorization: 'Bearer ' + token } : key.startsWith('sb_') ? {} : { Authorization: 'Bearer ' + key }), 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000)
    });
    // Provider response bodies can contain credentials/query contents. Never surface them.
    if (!response.ok) throw new SupabaseRequestError(path.startsWith('/auth/') ? 'Authentication could not be completed. Check your details or try again.' : 'Saved data is temporarily unavailable. Please try again.', response.status);
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  private async rows<T>(table: string, owner: string, filter = ''): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.request<T[]>(`/rest/v1/${table}?user_id=eq.${encodeURIComponent(owner)}${filter}&limit=500&offset=${offset}`);
      rows.push(...page);
      if (page.length < 500) return rows;
    }
  }
  private async patch(table: string, owner: string, value: unknown, filter = ''): Promise<void> {
    await this.request(`/rest/v1/${table}?user_id=eq.${encodeURIComponent(owner)}${filter}`, 'PATCH', value);
  }
  private async remove(table: string, owner: string, filter = ''): Promise<boolean> {
    const rows = await this.request<unknown[]>(`/rest/v1/${table}?user_id=eq.${encodeURIComponent(owner)}${filter}`, 'DELETE', undefined, undefined, 'return=representation');
    return rows.length > 0;
  }
  private idFilter(id: string): string { return '&id=eq.' + encodeURIComponent(id); }
  private defaultSettings(): WebAccountSettings { return { provider: 'openrouter', model: this.options.defaultModel, effortLevel: 'medium' }; }
  private user(profile: Profile): WebUser { return { id: profile.user_id, email: profile.email, displayName: profile.display_name, emailVerified: profile.email_verified, createdAt: profile.created_at }; }
  private async profile(id: string): Promise<Profile> { const row = (await this.rows<Profile>('dbchat_profiles', id))[0]; if (!row) throw new Error('Account not found.'); return row; }
  private async syncUser(user: AuthUser): Promise<WebUser> {
    const existing = (await this.rows<Profile>('dbchat_profiles', user.id))[0];
    const profile: Profile = { user_id: user.id, email: user.email ?? '', display_name: existing?.display_name ?? user.user_metadata?.display_name ?? user.email?.split('@')[0] ?? 'User', email_verified: Boolean(user.email_confirmed_at), created_at: user.created_at, settings: existing?.settings ?? this.defaultSettings() };
    if (existing && (existing.email !== profile.email || existing.email_verified !== profile.email_verified)) await this.patch('dbchat_profiles', user.id, { email: profile.email, email_verified: profile.email_verified });
    else if (!existing) await this.request('/rest/v1/dbchat_profiles?on_conflict=user_id', 'POST', profile, undefined, 'resolution=ignore-duplicates');
    return this.user(profile);
  }
  ensureDevelopmentUser(): never { throw new Error('Development authentication is unavailable with Supabase.'); }
  async signup(email: string, password: string, displayName?: string) {
    this.assertPassword(password);
    const result = await this.request<Partial<AuthTokens> & { id?: string; email?: string; created_at?: string }>('/auth/v1/signup', 'POST', { email: email.trim().toLowerCase(), password, data: { display_name: displayName?.trim() } });
    const authUser = result.user ?? (result.id ? result as AuthUser : undefined);
    if (!authUser) throw new Error('Account creation could not be completed.');
    // Unconfirmed signup may deliberately return an obfuscated user for existing emails.
    // Do not persist profiles until Auth has issued an authenticated session.
    if (!result.access_token || !result.refresh_token) return { user: { id: authUser.id, email: authUser.email ?? email, displayName: displayName ?? '', emailVerified: false, createdAt: authUser.created_at }, confirmationRequired: true };
    return this.acceptTokens(result as AuthTokens);
  }
  async login(email: string, password: string) { return this.acceptTokens(await this.request<AuthTokens>('/auth/v1/token?grant_type=password', 'POST', { email: email.trim().toLowerCase(), password })); }
  private hash(token: string): string { return createHash('sha256').update(token).digest('base64url'); }
  private async acceptTokens(tokens: AuthTokens, purpose: 'login' | 'recovery' = 'login') {
    if (!tokens.access_token || !tokens.refresh_token || !tokens.user?.id) throw new Error('Authentication did not return a session.');
    const user = await this.syncUser(tokens.user);
    const sessionId = randomBytes(32).toString('base64url');
    const now = Date.now(); const absolute = now + (purpose === 'recovery' ? 15 * 60_000 : (this.options.sessionAbsoluteTtlMs ?? 30 * 86400_000));
    await this.request('/rest/v1/dbchat_sessions', 'POST', { id_hash: this.hash(sessionId), user_id: user.id, encrypted_tokens: this.vault.encrypt(JSON.stringify(tokens)), access_expires_at: now + tokens.expires_in * 1000, expires_at: Math.min(now + this.options.sessionTtlMs, absolute), absolute_expires_at: absolute, refreshed_at: now, purpose });
    return { user, sessionId };
  }
  private async session(token: string): Promise<Session | null> {
    const hash = this.hash(token);
    const rows = await this.request<Session[]>(`/rest/v1/dbchat_sessions?id_hash=eq.${encodeURIComponent(hash)}`);
    const row = rows[0]; const now = Date.now();
    if (!row || row.expires_at <= now || row.absolute_expires_at <= now) { if (row) await this.revokeSession(token); return null; }
    if (row.access_expires_at > now + 60_000) return row;
    const inflight = this.refreshes.get(hash); if (inflight) return inflight;
    const refresh = this.refreshSession(row).finally(() => this.refreshes.delete(hash)); this.refreshes.set(hash, refresh); return refresh;
  }
  private async refreshSession(row: Session): Promise<Session | null> {
    const now = Date.now();
    const filter = `?id_hash=eq.${encodeURIComponent(row.id_hash)}&user_id=eq.${encodeURIComponent(row.user_id)}`;
    // Database lease prevents refresh-token reuse across Node processes. In-process requests share the promise.
    const leased = await this.request<Session[]>(`/rest/v1/dbchat_sessions${filter}&refresh_lock_until=lt.${now}`, 'PATCH', { refresh_lock_until: now + 20_000 }, undefined, 'return=representation');
    if (!leased.length) {
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const latest = (await this.request<Session[]>(`/rest/v1/dbchat_sessions${filter}`))[0];
        if (!latest) return null;
        if (latest.access_expires_at > Date.now() + 60_000) return latest;
      }
      throw new Error('Your session is refreshing. Please try again.');
    }
    try {
      const old = JSON.parse(this.vault.decrypt(leased[0].encrypted_tokens)) as AuthTokens;
      const tokens = await this.request<AuthTokens>('/auth/v1/token?grant_type=refresh_token', 'POST', { refresh_token: old.refresh_token });
      if (tokens.user.id !== row.user_id) throw new Error('Session identity changed.');
      const updated = { ...row, encrypted_tokens: this.vault.encrypt(JSON.stringify(tokens)), access_expires_at: Date.now() + tokens.expires_in * 1000, refresh_lock_until: 0 };
      const saved = await this.request<Session[]>(`/rest/v1/dbchat_sessions${filter}`, 'PATCH', { encrypted_tokens: updated.encrypted_tokens, access_expires_at: updated.access_expires_at, refresh_lock_until: 0 }, undefined, 'return=representation');
      return saved.length ? updated : null;
    } catch (error) {
      if (error instanceof SupabaseRequestError && [400, 401, 403].includes(error.status)) {
        await this.request(`/rest/v1/dbchat_sessions${filter}`, 'DELETE');
        return null;
      }
      await this.request(`/rest/v1/dbchat_sessions${filter}`, 'PATCH', { refresh_lock_until: 0 });
      throw error;
    }
  }
  async principalForSession(sessionId: string | undefined): Promise<Principal | null> {
    if (!sessionId) return null; const session = await this.session(sessionId); if (!session || session.purpose === 'recovery') return null;
    const tokens = JSON.parse(this.vault.decrypt(session.encrypted_tokens)) as AuthTokens;
    let authenticated: AuthUser;
    try { authenticated = await this.request<AuthUser>('/auth/v1/user', 'GET', undefined, tokens.access_token); }
    catch (error) {
      if (error instanceof SupabaseRequestError && [401, 403].includes(error.status)) { await this.revokeSession(sessionId); return null; }
      throw error;
    }
    if (authenticated.id !== session.user_id) return null;
    const user = await this.syncUser(authenticated);
    if (Date.now() - session.refreshed_at >= Math.min(60_000, this.options.sessionTtlMs / 4)) await this.patch('dbchat_sessions', session.user_id, { refreshed_at: Date.now(), expires_at: Math.min(Date.now() + this.options.sessionTtlMs, session.absolute_expires_at) }, '&id_hash=eq.' + encodeURIComponent(session.id_hash));
    return { ...user, roles: ['user'] };
  }
  async revokeSession(sessionId: string | undefined): Promise<void> { if (sessionId) await this.request('/rest/v1/dbchat_sessions?id_hash=eq.' + encodeURIComponent(this.hash(sessionId)), 'DELETE'); }
  async revokeAllSessions(userId: string): Promise<void> { await this.remove('dbchat_sessions', userId); }
  async getUser(userId: string): Promise<WebUser | null> { const profile = (await this.rows<Profile>('dbchat_profiles', userId))[0]; return profile ? this.user(profile) : null; }
  async getSettings(userId: string) { return (await this.profile(userId)).settings; }
  async updateSettings(userId: string, patch: Parameters<AccountStore['updateSettings']>[1]) {
    const profile = await this.profile(userId);
    const settings = { ...profile.settings };
    if (patch.displayName !== undefined) { if (!patch.displayName.trim() || patch.displayName.trim().length > 80) throw new Error('Enter a display name of up to 80 characters.'); profile.display_name = patch.displayName.trim(); }
    if (patch.activeConnectionId !== undefined) { if (patch.activeConnectionId !== null && !await this.getConnectionSummary(userId, patch.activeConnectionId)) throw new Error('Choose one of your connections.'); settings.activeConnectionId = patch.activeConnectionId ?? undefined; }
    if (patch.model !== undefined) settings.model = patch.model.trim() || this.options.defaultModel;
    if (patch.effortLevel !== undefined) settings.effortLevel = patch.effortLevel;
    if (patch.newPassword !== undefined) {
      this.assertPassword(patch.newPassword);
      if (!patch.currentPassword) throw new Error('Enter your current password.');
      const tokens = await this.request<AuthTokens>('/auth/v1/token?grant_type=password', 'POST', { email: profile.email, password: patch.currentPassword });
      if (tokens.user.id !== userId) throw new Error('Account verification failed.');
      await this.request('/auth/v1/user', 'PUT', { password: patch.newPassword }, tokens.access_token);
      await this.revokeAllSessions(userId);
    }
    await this.patch('dbchat_profiles', userId, { display_name: profile.display_name, settings });
    return { user: this.user(profile), settings };
  }
  async requestPasswordReset(email: string, redirectTo: string): Promise<void> { await this.request('/auth/v1/recover?redirect_to=' + encodeURIComponent(redirectTo), 'POST', { email: email.trim().toLowerCase() }); }
  async verifyEmail(tokenHash: string, type: 'signup' | 'recovery' | 'email') { return this.acceptTokens(await this.request<AuthTokens>('/auth/v1/verify', 'POST', { token_hash: tokenHash, type }), type === 'recovery' ? 'recovery' : 'login'); }
  async resetPassword(sessionId: string, newPassword: string): Promise<void> {
    this.assertPassword(newPassword); const session = await this.session(sessionId); if (!session || session.purpose !== 'recovery') throw new Error('Your recovery session has expired.');
    const tokens = JSON.parse(this.vault.decrypt(session.encrypted_tokens)) as AuthTokens;
    await this.request('/auth/v1/user', 'PUT', { password: newPassword }, tokens.access_token);
    await this.revokeAllSessions(session.user_id);
  }
  async deleteAccount(userId: string): Promise<void> { await this.request('/auth/v1/admin/users/' + encodeURIComponent(userId), 'DELETE'); }
  private assertPassword(password: string) { if (password.length < 8) throw new Error('Use at least 8 characters for your password.'); }
  private connection(row: ConnectionRow): StoredConnection { return { id: row.id, userId: row.user_id, config: row.config, encryptedSecrets: row.encrypted_secrets, status: row.status, lastTestedAt: row.last_tested_at, tableCount: row.table_count, lastError: row.last_error }; }
  async listConnections(userId: string) { return (await this.rows<ConnectionRow>('dbchat_connections', userId)).map(row => displayConnection(this.connection(row))).sort((a, b) => a.label.localeCompare(b.label)); }
  async getConnectionSummary(userId: string, id: string) { const row = (await this.rows<ConnectionRow>('dbchat_connections', userId, this.idFilter(id)))[0]; return row ? displayConnection(this.connection(row)) : null; }
  async getConnectionConfig(userId: string, id: string): Promise<ConnectionConfig | null> { const row = (await this.rows<ConnectionRow>('dbchat_connections', userId, this.idFilter(id)))[0]; return row ? { ...row.config, ...(row.encrypted_secrets ? JSON.parse(this.vault.decrypt(row.encrypted_secrets)) : {}), safetyLevel: 'safe' } : null; }
  private connectionValues(input: ConnectionConfig, test?: ConnectionTestResult) {
    if (!input.label?.trim()) throw new Error('Give this connection a name.');
    if (!['sqlite', 'postgres', 'mysql', 'mongodb', 'elasticsearch'].includes(input.kind)) throw new Error('Choose a supported database type.');
    if (input.kind === 'sqlite' && !input.databasePath && !input.sqliteObjectKey) throw new Error('Choose a SQLite file.');
    const split = splitSecrets({ ...input, label: input.label.trim(), safetyLevel: 'safe', createdAt: input.createdAt || new Date().toISOString() });
    return { config: split.config, encrypted_secrets: split.secrets ? this.vault.encrypt(JSON.stringify(split.secrets)) : null, status: test ? (test.ok ? 'ready' : 'unavailable') : 'unavailable', last_tested_at: test ? new Date().toISOString() : null, table_count: test?.tableCount ?? null, last_error: test?.error ?? null };
  }
  async createConnection(userId: string, input: ConnectionConfig, test?: ConnectionTestResult) {
    const id = 'conn_' + randomBytes(12).toString('hex'); await this.profile(userId);
    await this.request('/rest/v1/dbchat_connections', 'POST', { id, user_id: userId, ...this.connectionValues({ ...input, id }, test) });
    const settings = await this.getSettings(userId); if (!settings.activeConnectionId) await this.updateSettings(userId, { activeConnectionId: id });
    return (await this.getConnectionSummary(userId, id))!;
  }
  async updateConnection(userId: string, id: string, patch: Partial<ConnectionConfig>, test?: ConnectionTestResult) {
    const existing = await this.getConnectionConfig(userId, id); if (!existing) throw new Error('Connection not found.');
    const values = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    const merged = { ...existing, ...values, id, createdAt: existing.createdAt, elasticsearchUrl: patch.elasticsearchUrl === publicConnectionUri(existing.elasticsearchUrl) ? existing.elasticsearchUrl : patch.elasticsearchUrl ?? existing.elasticsearchUrl };
    await this.patch('dbchat_connections', userId, this.connectionValues(merged, test), this.idFilter(id)); return (await this.getConnectionSummary(userId, id))!;
  }
  async deleteConnection(userId: string, id: string) { const deleted = await this.remove('dbchat_connections', userId, this.idFilter(id)); if (deleted && (await this.getSettings(userId)).activeConnectionId === id) await this.updateSettings(userId, { activeConnectionId: null }); return deleted; }
  async markConnectionTest(userId: string, id: string, result: ConnectionTestResult) { if (!await this.getConnectionSummary(userId, id)) throw new Error('Connection not found.'); await this.patch('dbchat_connections', userId, { status: result.ok ? 'ready' : 'unavailable', last_tested_at: new Date().toISOString(), table_count: result.tableCount ?? null, last_error: result.error ?? null }, this.idFilter(id)); return (await this.getConnectionSummary(userId, id))!; }
  private summary(row: ChatRow): WebChatSummary { return { id: row.id, title: row.title, connectionId: row.connection_id ?? undefined, messageCount: row.message_count, artifactCount: row.artifact_count, createdAt: row.created_at, updatedAt: row.updated_at }; }
  async listChats(userId: string) { return (await this.rows<ChatRow>('dbchat_chats', userId, '&order=updated_at.desc')).map(row => this.summary(row)); }
  async getChat(userId: string, id: string): Promise<WebChatSession | null> {
    const row = (await this.rows<ChatRow>('dbchat_chats', userId, this.idFilter(id)))[0]; if (!row) return null;
    const [messages, artifacts] = await Promise.all([this.rows<{ body: ChatMessage }>('dbchat_messages', userId, '&chat_id=eq.' + encodeURIComponent(id) + '&order=position.asc'), this.rows<{ body: QueryResultArtifact }>('dbchat_artifacts', userId, '&chat_id=eq.' + encodeURIComponent(id) + '&order=position.asc')]);
    return { ...this.summary(row), messages: messages.map(item => item.body), artifacts: artifacts.map(item => item.body) };
  }
  async createChat(userId: string, connectionId?: string) {
    if (connectionId && !await this.getConnectionSummary(userId, connectionId)) throw new Error('Connection not found.');
    const id = 'chat_' + randomBytes(12).toString('hex');
    await this.request('/rest/v1/dbchat_chats', 'POST', { id, user_id: userId, connection_id: connectionId ?? null }); return (await this.getChat(userId, id))!;
  }
  async updateChat(userId: string, id: string, patch: Parameters<AccountStore['updateChat']>[2]) {
    if (patch.title !== undefined) customChatTitle(patch.title);
    if (patch.connectionId && !await this.getConnectionSummary(userId, patch.connectionId)) throw new Error('Connection not found.');
    await this.request('/rest/v1/rpc/dbchat_update_chat', 'POST', { owner: userId, chat: id, changes: patch });
    const result = await this.getChat(userId, id); if (!result) throw new Error('Chat not found.'); return result;
  }
  async deleteChat(userId: string, id: string) { return this.remove('dbchat_chats', userId, this.idFilter(id)); }
  async hasUserKey(userId: string) { return Boolean((await this.profile(userId)).encrypted_provider_key); }
  async setUserKey(userId: string, key: string) { if (key.trim().length < 10) throw new Error('Enter a valid provider key.'); await this.patch('dbchat_profiles', userId, { encrypted_provider_key: this.vault.encrypt(key.trim()) }); }
  async removeUserKey(userId: string) { await this.patch('dbchat_profiles', userId, { encrypted_provider_key: null }); }
  async resolveProviderKey(userId: string, internalKey?: string): Promise<{ source: 'user' | 'internal' | 'none'; apiKey?: string; hasUserKey: boolean }> { const value = (await this.profile(userId)).encrypted_provider_key; return value ? { source: 'user', apiKey: this.vault.decrypt(value), hasUserKey: true } : { source: internalKey ? 'internal' : 'none', apiKey: internalKey, hasUserKey: false }; }
  async interruptPendingTurns(): Promise<void> { await this.request('/rest/v1/rpc/dbchat_interrupt_pending_turns', 'POST', {}); }
  async saveTurn(userId: string, snapshot: WebTurnSnapshot): Promise<void> { await this.request('/rest/v1/rpc/dbchat_save_turn', 'POST', { owner: userId, turn: snapshot }); }
  async getTurn(userId: string, id: string): Promise<WebTurnSnapshot | null> { return (await this.rows<{ snapshot: WebTurnSnapshot }>('dbchat_turns', userId, this.idFilter(id)))[0]?.snapshot ?? null; }
  async claimTurn(userId: string, turnId: string, chatId: string, requestId: string, userMessage: ChatMessage, assistantMessageId: string): Promise<{ turnId: string; created: boolean }> {
    return this.request('/rest/v1/rpc/dbchat_claim_turn', 'POST', { owner: userId, turn_id: turnId, chat: chatId, request_id: requestId, user_message: userMessage, assistant_message_id: assistantMessageId });
  }
  async finalizeTurn(userId: string, snapshot: WebTurnSnapshot, message?: ChatMessage, artifacts?: QueryResultArtifact[]): Promise<void> { await this.request('/rest/v1/rpc/dbchat_finalize_turn', 'POST', { owner: userId, turn: snapshot, assistant_message: message ?? null, result_artifacts: artifacts ?? [] }); }
}
