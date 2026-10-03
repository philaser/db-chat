import { randomUUID } from 'node:crypto';
import type { SqliteObjectStorage } from './supabaseSqliteStorage.js';

export interface SqliteAsset {
  id: string;
  owner: string;
  objectKey: string;
  fileName: string;
  bytes: number;
  state: 'uploading' | 'pending' | 'attached' | 'deleting' | 'deleted';
  expiresAt?: string;
}
export interface AccountDeletion {
  owner: string;
  phase: 'waiting' | 'storage' | 'auth' | 'complete';
}
export interface AccountDeletionHooks {
  /** Abort and wait for work on every worker; false means retry after leases drain. */
  onAccountDeleting(owner: string): Promise<boolean>;
  /** Cancel and remove durable exports; false means a live export lease remains. */
  cancelExports(owner: string): Promise<boolean>;
  /** Idempotent: an already absent Auth user is success. */
  deleteAuthUser(owner: string): Promise<void>;
}
export interface AssetLifecycleOptions { url: string; serviceRoleKey: string; fetch?: typeof fetch }
interface AssetRow {
  id: string; owner: string; object_key: string; file_name: string; bytes: number | string;
  state: SqliteAsset['state']; expires_at?: string | null; lease_token?: string;
}
interface DeletionRow extends AccountDeletion { lease_token: string }
export class RetainedSqliteQuotaError extends Error {
  constructor() { super('Your saved SQLite files have reached the storage limit. Delete an unused connection or wait for unattached uploads to expire before uploading another file.'); }
}
export class AccountDeletingError extends Error {
  constructor() { super('Account deletion is in progress. This account can no longer accept work.'); }
}

/** Durable state owns admission/attachment; storage side effects are idempotent. */
export class SupabaseAssetLifecycle {
  private readonly fetcher: typeof fetch;
  private readonly base: string;
  constructor(private readonly options: AssetLifecycleOptions) {
    const url = new URL(options.url);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Supabase requires HTTPS.');
    this.base = options.url.replace(/\/$/, '');
    this.fetcher = options.fetch ?? fetch;
  }
  private async request<T>(route: string, body?: unknown): Promise<T> {
    const key = this.options.serviceRoleKey;
    const response = await this.fetcher(this.base + '/rest/v1/' + route, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: 'Bearer ' + key }), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) throw new Error('Saved file lifecycle is temporarily unavailable. Please try again.');
    return await response.json() as T;
  }
  private rpc<T>(name: string, input: Record<string, unknown>): Promise<T> { return this.request('rpc/' + name, input); }
  async assertReady(): Promise<void> {
    await this.request('dbchat_sqlite_assets?select=id&limit=0');
    await this.request('dbchat_account_deletions?select=owner&limit=0');
  }
  async isAccountDeleting(owner: string): Promise<boolean> {
    const rows = await this.request<unknown[]>('dbchat_account_deletions?select=owner&owner=eq.' + encodeURIComponent(owner) + '&limit=1');
    return rows.length > 0;
  }
  async assertAccountActive(owner: string): Promise<void> {
    if (await this.isAccountDeleting(owner)) throw new AccountDeletingError();
  }
  async beginUpload(owner: string, fileName: string, bytes: number, id = randomUUID()): Promise<SqliteAsset> {
    const result = await this.rpc<{ accepted: boolean; asset?: AssetRow }>('dbchat_begin_sqlite_upload', { owner, asset_id: id, file_name: fileName, upload_bytes: bytes });
    if (!result.accepted) throw new RetainedSqliteQuotaError();
    if (!result.asset) throw new Error('The upload could not be registered.');
    return asset(result.asset);
  }
  async completeUpload(owner: string, id: string): Promise<SqliteAsset> {
    return asset(await this.rpc<AssetRow>('dbchat_complete_sqlite_upload', { owner, asset_id: id }));
  }
  async resolveUpload(owner: string, id: string): Promise<SqliteAsset> {
    await this.assertAccountActive(owner);
    const rows = await this.request<AssetRow[]>('dbchat_sqlite_assets?owner=eq.' + encodeURIComponent(owner) + '&id=eq.' + encodeURIComponent(id) + '&limit=1');
    const row = rows[0];
    if (!row || row.state !== 'pending' || !row.expires_at || Date.parse(row.expires_at) <= Date.now()) throw new Error('This upload has expired or is already attached. Choose a SQLite file again.');
    return asset(row);
  }
  async beginAccountDeletion(owner: string): Promise<AccountDeletion> {
    const job = await this.rpc<DeletionRow>('dbchat_begin_account_deletion', { owner });
    return { owner: job.owner, phase: job.phase };
  }
  /** Lost replies/crashes leave rows claimable by another worker after the lease. */
  async reconcile(storage: SqliteObjectStorage, hooks: AccountDeletionHooks): Promise<{ discovered: number; removed: number; accountsCompleted: number; pending: number; failed: number }> {
    const summary = { discovered: await this.rpc<number>('dbchat_discover_sqlite_orphans', {}), removed: 0, accountsCompleted: 0, pending: 0, failed: 0 };
    const assets = await this.rpc<AssetRow[]>('dbchat_claim_asset_cleanup', {});
    for (const row of assets) {
      let succeeded = false;
      try { await storage.remove(row.owner, row.object_key); succeeded = true; }
      catch { summary.failed++; }
      const committed = await this.rpc<boolean>('dbchat_finish_asset_cleanup', { asset_id: row.id, token: row.lease_token, succeeded });
      if (succeeded && committed) summary.removed++;
    }
    const jobs = await this.rpc<DeletionRow[]>('dbchat_claim_account_deletions', {});
    for (const job of jobs) {
      const advance = (next_phase: string) => this.rpc<boolean>('dbchat_advance_account_deletion', { owner: job.owner, token: job.lease_token, next_phase });
      try {
        // Repeat these callbacks even after a partial Storage/Auth failure.
        if (!await hooks.onAccountDeleting(job.owner) || !await hooks.cancelExports(job.owner)) {
          summary.pending++; await advance('retry'); continue;
        }
        if (job.phase === 'waiting' || job.phase === 'storage') {
          if (!await advance('storage')) { summary.pending++; await advance('retry'); continue; }
        }
        // An earlier delete may have completed before an in-flight Storage
        // request committed. Retrying the owner sweep is safe and necessary.
        await storage.removeOwner(job.owner);
        if (!await advance('auth')) { summary.pending++; await advance('retry'); continue; }
        await hooks.deleteAuthUser(job.owner);
        if (await advance('complete')) summary.accountsCompleted++;
        else { summary.pending++; await advance('retry'); }
      } catch {
        summary.failed++;
        await advance('retry');
      }
    }
    return summary;
  }
}
function asset(row: AssetRow): SqliteAsset {
  return { id: row.id, owner: row.owner, objectKey: row.object_key, fileName: row.file_name, bytes: Number(row.bytes), state: row.state, ...(row.expires_at ? { expiresAt: row.expires_at } : {}) };
}

/** Auth DELETE is retried by the durable job; a lost successful reply is success. */
export async function deleteSupabaseAuthUser(options: AssetLifecycleOptions, owner: string): Promise<void> {
  const key = options.serviceRoleKey;
  const fetcher = options.fetch ?? fetch;
  const url = options.url.replace(/\/$/, '') + '/auth/v1/admin/users/' + encodeURIComponent(owner);
  const headers = { apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: 'Bearer ' + key }) };
  const request = (method: string) => fetcher(url, { method, headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  try {
    const response = await request('DELETE');
    const succeeded = response.ok || response.status === 404;
    await response.body?.cancel();
    if (succeeded) return;
  } catch { /* A transport failure does not establish whether Auth committed. */ }
  try {
    const response = await request('GET');
    const missing = response.status === 404;
    await response.body?.cancel();
    if (missing) return;
  } catch { /* Keep the job retryable. */ }
  throw new Error('Account deletion is still pending. It will be retried automatically.');
}
