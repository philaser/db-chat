import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLiteConnector } from '../src/main/connectors/SQLiteConnector';

describe('SQLiteConnector', () => {
  it('introspects and executes read-only queries', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db-chat-'));
    const dbPath = path.join(dir, 'sample.db');
    const db = new Database(dbPath);
    db.exec("create table users (id integer primary key, name text not null); insert into users(name) values ('Ada'), ('Grace');");
    db.close();

    const connector = new SQLiteConnector();
    await connector.connect({
      id: 'test',
      kind: 'sqlite',
      label: 'sample.db',
      databasePath: dbPath,
      createdAt: new Date().toISOString()
    });

    const schema = await connector.introspect();
    expect(schema.tables[0].name).toBe('users');
    expect(schema.tables[0].columns.map((column) => column.name)).toContain('name');

    const result = await connector.executeQuery('select name from users order by id;', 'safe');
    expect(result.rows).toEqual([{ name: 'Ada' }, { name: 'Grace' }]);
    connector.close();
  });

  it('executes validated table row writes when SAFE mode is off', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db-chat-'));
    const dbPath = path.join(dir, 'sample.db');
    const db = new Database(dbPath);
    db.exec('create table users (id integer primary key, name text not null);');
    db.close();

    const connector = new SQLiteConnector();
    await connector.connect({
      id: 'test-write',
      kind: 'sqlite',
      label: 'sample.db',
      databasePath: dbPath,
      createdAt: new Date().toISOString()
    });

    const writeResult = await connector.executeQuery("insert into users(name) values ('Ada');", 'manual');
    expect(writeResult.rows).toEqual([{ changes: 1, lastInsertRowid: '1' }]);

    const result = await connector.executeQuery('select name from users;', 'safe');
    expect(result.rows).toEqual([{ name: 'Ada' }]);
    connector.close();
  });
});
