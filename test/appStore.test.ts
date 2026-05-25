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

describe('AppStore generic password connectors', () => {
  it('stores remembered MySQL passwords encrypted and hydrates them', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db-chat-store-'));
    const filePath = path.join(dir, 'store.json');
    const store = new AppStore(filePath);
    const config = {
      id: 'mysql-conn',
      kind: 'mysql' as const,
      label: 'mysql.local:3306',
      host: 'mysql.local',
      port: 3306,
      database: 'mydb',
      username: 'root',
      password: 'mysql-password',
      rememberPassword: true,
      createdAt: '2026-05-21T00:00:00.000Z'
    };

    store.saveConnection(config);

    const fileContents = readFileSync(filePath, 'utf8');
    const history = store.listConnections()[0];
    expect(fileContents).not.toContain('mysql-password');
    expect(fileContents).toContain('"mysql-conn": "safe:');
    expect(history.password).toBeUndefined();
    expect(history.hasSavedPassword).toBe(true);
    expect(store.hydrateConnectionSecrets(history).password).toBe('mysql-password');
  });

  it('stores remembered PostgreSQL passwords encrypted and hydrates them', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db-chat-store-'));
    const filePath = path.join(dir, 'store.json');
    const store = new AppStore(filePath);
    const config = {
      id: 'pg-conn',
      kind: 'postgres' as const,
      label: 'pg.local:5432',
      host: 'pg.local',
      port: 5432,
      database: 'mydb',
      username: 'admin',
      password: 'pg-password',
      rememberPassword: true,
      createdAt: '2026-05-21T00:00:00.000Z'
    };

    store.saveConnection(config);

    const fileContents = readFileSync(filePath, 'utf8');
    const history = store.listConnections()[0];
    expect(fileContents).not.toContain('pg-password');
    expect(history.hasSavedPassword).toBe(true);
    expect(store.hydrateConnectionSecrets(history).password).toBe('pg-password');
  });

  it('stores remembered MongoDB passwords encrypted and hydrates them', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db-chat-store-'));
    const filePath = path.join(dir, 'store.json');
    const store = new AppStore(filePath);
    const config = {
      id: 'mongo-conn',
      kind: 'mongodb' as const,
      label: 'mongo.local:27017',
      host: 'mongo.local',
      port: 27017,
      database: 'mydb',
      username: 'admin',
      password: 'mongo-password',
      authDatabase: 'admin',
      rememberPassword: true,
      createdAt: '2026-05-21T00:00:00.000Z'
    };

    store.saveConnection(config);

    const fileContents = readFileSync(filePath, 'utf8');
    const history = store.listConnections()[0];
    expect(fileContents).not.toContain('mongo-password');
    expect(history.hasSavedPassword).toBe(true);
    expect(history.authDatabase).toBe('admin');
    expect(store.hydrateConnectionSecrets(history).password).toBe('mongo-password');
  });

  it('does not hydrate password when not remembered', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db-chat-store-'));
    const filePath = path.join(dir, 'store.json');
    const store = new AppStore(filePath);
    const config = {
      id: 'no-remember',
      kind: 'mysql' as const,
      label: 'mysql.local:3306',
      host: 'mysql.local',
      port: 3306,
      database: 'mydb',
      username: 'root',
      password: 'tmp-password',
      createdAt: '2026-05-21T00:00:00.000Z'
    };

    store.saveConnection(config);

    const history = store.listConnections()[0];
    expect(history.hasSavedPassword).toBeFalsy();
    expect(store.hydrateConnectionSecrets(history).password).toBeUndefined();
  });

  it('retains MySQL and PostgreSQL connections with same host/port/database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db-chat-store-'));
    const filePath = path.join(dir, 'store.json');
    const store = new AppStore(filePath);

    const mysqlConfig = {
      id: 'mysql-same',
      kind: 'mysql' as const,
      label: 'mysql.local:3306/mydb',
      host: 'db.local',
      port: 3306,
      database: 'mydb',
      createdAt: '2026-05-21T00:00:00.000Z'
    };

    const pgConfig = {
      id: 'pg-same',
      kind: 'postgres' as const,
      label: 'pg.local:5432/mydb',
      host: 'db.local',
      port: 3306,
      database: 'mydb',
      createdAt: '2026-05-21T00:00:00.000Z'
    };

    store.saveConnection(mysqlConfig);
    store.saveConnection(pgConfig);

    const connections = store.listConnections();
    expect(connections).toHaveLength(2);
    expect(connections[0].id).toBe('pg-same');
    expect(connections[1].id).toBe('mysql-same');
  });
});
