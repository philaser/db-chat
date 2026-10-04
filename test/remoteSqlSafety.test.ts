import { describe, expect, it, vi } from 'vitest';
import { PostgresConnector } from '../src/server/connectors/PostgresConnector';
import { MySQLConnector } from '../src/server/connectors/MySQLConnector';

describe('remote SQL read-only transaction boundary', () => {
  it.each([false, true])('MySQL destroys timed-out queries before rollback (caller signal: %s)', async withSignal => {
    const timeout = Object.assign(new Error('Query inactivity timeout'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
    let destroyed = false;
    const destroy = vi.fn(() => { destroyed = true; });
    const query = vi.fn(async (sql: string | { sql: string; timeout: number }) => {
      if (typeof sql === 'object' && sql.sql.startsWith('SELECT')) throw timeout;
      if (sql === 'ROLLBACK') {
        expect(destroyed).toBe(true);
        throw new Error('Connection closed');
      }
      return [[], []];
    });
    const connector = new MySQLConnector();
    Reflect.set(connector, 'connection', { query, destroy });
    connector.setSafetyLevel('safe');
    await expect(connector.executeQuery('SELECT SLEEP(60)', withSignal ? { signal: new AbortController().signal } : undefined)).rejects.toBe(timeout);
    expect(destroy).toHaveBeenCalledOnce();
    await expect(connector.executeQuery('SELECT 1')).rejects.toThrow('No database is connected');
  });

  it.each([false, true])('PostgreSQL always rolls back its read transaction (query failure: %s)', async failure => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM (')) {
        if (failure) throw new Error('read failed');
        return { rows: [{ count: 1 }], fields: [{ name: 'count' }], command: 'SELECT', rowCount: 1 };
      }
      return { rows: [], fields: [], command: '', rowCount: 0 };
    });
    const connector = new PostgresConnector();
    Reflect.set(connector, 'client', { query });
    connector.setSafetyLevel('safe');
    if (failure) await expect(connector.executeQuery('SELECT COUNT(*) FROM items')).rejects.toThrow('read failed');
    else expect((await connector.executeQuery('SELECT COUNT(*) FROM items')).rows).toEqual([{ count: 1 }]);
    expect(query.mock.calls[0][0]).toBe('BEGIN READ ONLY');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it.each([false, true])('MySQL always rolls back and sets a driver deadline (query failure: %s)', async failure => {
    const query = vi.fn(async (sql: string | { sql: string; timeout: number }) => {
      if (typeof sql === 'object' && sql.sql.startsWith('SELECT')) {
        if (failure) throw new Error('read failed');
        return [[{ count: 1 }], []];
      }
      return [[], []];
    });
    const connector = new MySQLConnector();
    Reflect.set(connector, 'connection', { query });
    connector.setSafetyLevel('safe');
    if (failure) await expect(connector.executeQuery('SELECT COUNT(*) FROM items')).rejects.toThrow('read failed');
    else expect((await connector.executeQuery('SELECT COUNT(*) FROM items')).rows).toEqual([{ count: 1 }]);
    expect(query.mock.calls[0][0]).toEqual({ sql: 'START TRANSACTION READ ONLY', timeout: 30000 });
    expect(query.mock.calls[1][0]).toMatchObject({ timeout: 30000 });
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
