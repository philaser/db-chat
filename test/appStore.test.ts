import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppStore } from '../src/main/storage/AppStore';

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir()
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`safe-test:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^safe-test:/, '')
  }
}));

describe('AppStore Elasticsearch passwords', () => {
  it('stores remembered passwords encrypted and hydrates them only for connecting', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db-chat-store-'));
    const filePath = path.join(dir, 'store.json');
    const store = new AppStore(filePath);
    const config = {
      id: 'elastic-remembered',
      kind: 'elasticsearch' as const,
      label: 'elastic.local:9200',
      elasticsearchHost: 'elastic.local',
      elasticsearchPort: 9200,
      elasticsearchUsername: 'elastic-user',
      elasticsearchPassword: 'elastic-password',
      elasticsearchRememberPassword: true,
      createdAt: '2026-05-21T00:00:00.000Z'
    };

    store.saveConnection(config);

    const fileContents = readFileSync(filePath, 'utf8');
    const history = store.listConnections()[0];
    expect(fileContents).not.toContain('elastic-password');
    expect(fileContents).toContain('"elastic-remembered": "safe:');
    expect(history.elasticsearchPassword).toBeUndefined();
    expect(history.elasticsearchHasSavedPassword).toBe(true);
    expect(store.hydrateConnectionSecrets(history).elasticsearchPassword).toBe('elastic-password');
  });
});
