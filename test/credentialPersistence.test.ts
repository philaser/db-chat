import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/server/accountStore';
import { assertConnectionDestination } from '../src/server/connectionPolicy';
import type { ConnectionConfig } from '../src/shared/types';

const uri = 'https://audit-user:dummy-uri-secret@database.example:9443/?api_key=another-secret';
const base: ConnectionConfig = { id: 'test', kind: 'elasticsearch', label: 'Test', elasticsearchHost: 'database.example', elasticsearchPort: 9443, elasticsearchUseSsl: false, elasticsearchUrl: uri, createdAt: '2026-09-05T00:00:00Z' };
function location() { return path.join(mkdtempSync(path.join(tmpdir(), 'dbchat-secrets-')), 'store.json'); }

describe('credential and hosted destination boundaries', () => {
  it('encrypts full web URLs while exposing editable nonsecret settings', () => {
    const file = location();
    const store = new AccountStore({ sessionTtlMs: 60000, defaultModel: 'fixture', secretKey: 'test-only', storePath: file });
    const user = store.ensureDevelopmentUser();
    const saved = store.createConnection(user.id, base);
    expect(readFileSync(file, 'utf8')).not.toContain('dummy-uri-secret');
    expect(readFileSync(file, 'utf8')).not.toContain('another-secret');
    expect(saved.elasticsearchUrl).toBe('https://database.example:9443/');
    expect(saved.port).toBe(9443);
    expect(saved.ssl).toBe(false);
    expect(store.getConnectionConfig(user.id, saved.id)?.elasticsearchUrl).toBe(uri);
    expect(store.updateConnection(user.id, saved.id, { label: 'Renamed', elasticsearchUrl: saved.elasticsearchUrl }).port).toBe(9443);
    expect(store.getConnectionConfig(user.id, saved.id)?.elasticsearchUrl).toBe(uri);
  });
  it('allows customer hosts while restricting explicit policies and discovery URIs', () => {
    expect(() => assertConnectionDestination(base)).not.toThrow();
    expect(() => assertConnectionDestination({ ...base, kind: 'postgres', host: 'unapproved.internal' }, ['database.example'])).toThrow();
    expect(() => assertConnectionDestination({ ...base, elasticsearchHost: undefined, elasticsearchUrl: 'https://unapproved.internal\\@database.example' }, ['database.example'])).toThrow();
    expect(() => assertConnectionDestination(base, ['database.example'])).not.toThrow();
    expect(() => assertConnectionDestination({ ...base, elasticsearchHost: undefined, elasticsearchUrl: 'https://database.example@internal.example/' }, ['database.example'])).toThrow();
    expect(() => assertConnectionDestination({ ...base, kind: 'mongodb', mongodbUri: 'mongodb+srv://database.example/' }, ['database.example'])).toThrow('SRV');
    expect(() => assertConnectionDestination({ ...base, kind: 'mongodb', mongodbUri: 'mongodb://database.example,internal.example/' }, ['database.example'])).toThrow();
  });
});
