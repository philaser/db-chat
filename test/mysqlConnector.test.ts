import { describe, expect, it, vi } from 'vitest';
import { MySQLConnector } from '../src/server/connectors/MySQLConnector';

describe('MySQL connector schema and cancellation', () => {
  it('preserves qualified odd identifiers and ordered composite foreign keys', async () => {
    const query = vi.fn(async (sql: string) => [sql.includes('referential_constraints') ? [
      { tableSchema: 'odd`db', tableName: 'Order Details', constraintName: 'fk_customer', columnName: 'tenant_id', referencedSchema: 'odd`db', referencedTable: 'customers', referencedColumn: 'tenant_id' },
      { tableSchema: 'odd`db', tableName: 'Order Details', constraintName: 'fk_customer', columnName: 'customer_id', referencedSchema: 'odd`db', referencedTable: 'customers', referencedColumn: 'id' }
    ] : [
      { tableSchema: 'odd`db', tableName: 'Order Details', columnName: 'order id', dataType: 'int', isNullable: 'NO', columnKey: 'PRI' },
      { tableSchema: 'odd`db', tableName: 'Order Details', columnName: 'tenant_id', dataType: 'int', isNullable: 'NO', columnKey: '' },
      { tableSchema: 'odd`db', tableName: 'Order Details', columnName: 'customer_id', dataType: 'int', isNullable: 'YES', columnKey: '' }
    ], []]);
    const connector = new MySQLConnector();
    Object.assign(connector, { connection: { query, ping: vi.fn() }, config: { database: 'odd`db', label: 'Fixture' } });
    const schema = await connector.introspect();
    expect(schema.tables[0].qualifiedName).toBe('`odd``db`.`Order Details`');
    expect(schema.tables[0].columns[0].primaryKey).toBe(true);
    expect(schema.tables[0].relationships).toEqual([{
      columns: ['tenant_id', 'customer_id'], referencedSchema: 'odd`db',
      referencedTable: 'customers', referencedColumns: ['tenant_id', 'id']
    }]);
    expect(schema.tables[0].columns[2].foreignKey?.column).toBe('id');
    expect(await connector.getContextForPrompt()).toContain('`odd``db`.`Order Details`');
  });

  it('destroys the in-flight connection when aborted', async () => {
    const destroy = vi.fn();
    const end = vi.fn(async () => undefined);
    const query = vi.fn((sql: string | { sql: string; timeout: number }) => {
      if (typeof sql === 'string') return Promise.resolve([[], []]);
      return new Promise(() => undefined);
    });
    const connector = new MySQLConnector();
    Object.assign(connector, { connection: { query, destroy, ping: vi.fn() }, pool: { end }, config: { database: 'fixture' } });
    const controller = new AbortController();
    const pending = connector.executeQuery('SELECT SLEEP(5)', { signal: controller.signal });
    controller.abort(new DOMException('Stopped.', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(destroy).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    expect(Reflect.get(connector, 'connection')).toBeNull();
    expect(Reflect.get(connector, 'pool')).toBeNull();
    expect(Reflect.get(connector, 'config')).toBeNull();
    await expect(connector.executeQuery('SELECT 1')).rejects.toThrow('No database is connected.');
  });

  it('surfaces rollback failure after a successful query', async () => {
    const query = vi.fn(async (sql: string | { sql: string; timeout: number }) => {
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      if (typeof sql === 'object') return [[{ value: 1 }], []];
      return [[], []];
    });
    const connector = new MySQLConnector();
    Object.assign(connector, { connection: { query, ping: vi.fn() } });
    connector.setSafetyLevel('safe');
    await expect(connector.executeQuery('SELECT 1 AS value')).rejects.toThrow('rollback failed');
  });

  it('preserves the original query error when rollback also fails', async () => {
    const query = vi.fn(async (sql: string | { sql: string; timeout: number }) => {
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      if (typeof sql === 'object') throw new Error('query failed');
      return [[], []];
    });
    const connector = new MySQLConnector();
    Object.assign(connector, { connection: { query, ping: vi.fn() } });
    connector.setSafetyLevel('safe');
    await expect(connector.executeQuery('SELECT 1')).rejects.toThrow('query failed');
  });

  it('normalizes an already-aborted signal before beginning a transaction', async () => {
    const query = vi.fn();
    const connector = new MySQLConnector();
    Object.assign(connector, { connection: { query, ping: vi.fn() } });
    connector.setSafetyLevel('safe');
    const controller = new AbortController();
    controller.abort(new Error('stop now'));
    await expect(connector.executeQuery('SELECT 1', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError', message: 'stop now' });
    expect(query).not.toHaveBeenCalled();
  });
});
