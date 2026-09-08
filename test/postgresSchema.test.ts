import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresConnector } from '../src/server/connectors/PostgresConnector';

const pgMock = vi.hoisted(() => ({
  errorHandler: undefined as undefined | (() => void),
  query: vi.fn<(sql: string) => Promise<unknown>>(),
  end: vi.fn<() => Promise<void>>()
}));
vi.mock('pg', () => ({ Client: class {
  on(event: string, handler: () => void) { if (event === 'error') pgMock.errorHandler = handler; }
  async connect() {}
  query(sql: string) { return pgMock.query(sql); }
  end() { return pgMock.end(); }
} }));

describe('PostgreSQL schema identity and relationships', () => {
  beforeEach(() => {
    pgMock.errorHandler = undefined;
    pgMock.query.mockReset();
    pgMock.end.mockReset().mockResolvedValue();
  });

  it('aborts an in-flight query, closes the connection, and permits an explicit reconnect', async () => {
    pgMock.query.mockImplementation(async sql => {
      if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK') return { rows: [], fields: [], command: sql, rowCount: 0 };
      return new Promise(() => undefined);
    });
    const config = { id: 'pg', kind: 'postgres' as const, label: 'Fixture', host: 'localhost', createdAt: '2026-09-08' };
    const connector = new PostgresConnector();
    await connector.connect(config);
    connector.setSafetyLevel('safe');
    const controller = new AbortController();
    const pending = connector.executeQuery('select pg_sleep(5)', { signal: controller.signal });
    await vi.waitFor(() => expect(pgMock.query).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(pgMock.end).toHaveBeenCalledOnce();
    await expect(connector.executeQuery('select 1')).rejects.toThrow('No database is connected.');

    pgMock.query.mockResolvedValue({ rows: [{ connected: 1 }], fields: [{ name: 'connected' }], command: 'SELECT', rowCount: 1 });
    await connector.connect(config);
    expect((await connector.executeQuery('select 1')).rows).toEqual([{ connected: 1 }]);
  });

  it('handles an unexpected driver error and marks the connection closed', async () => {
    const connector = new PostgresConnector();
    await connector.connect({ id: 'pg', kind: 'postgres', label: 'Fixture', host: 'localhost', createdAt: '2026-09-08' });
    expect(pgMock.errorHandler).toBeTypeOf('function');
    expect(() => pgMock.errorHandler?.()).not.toThrow();
    await expect(connector.executeQuery('select 1')).rejects.toThrow('No database is connected.');
  });

  it('preserves qualified quoted identities and pairs composite foreign keys in order', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('con.oid as constraint_id') ? [
      { table_schema: 'sales', table_name: 'Orders', constraint_id: 7, column_name: 'tenant_id', referenced_schema: 'crm', referenced_table: 'Customers', referenced_column: 'tenant_id' },
      { table_schema: 'sales', table_name: 'Orders', constraint_id: 7, column_name: 'customer_id', referenced_schema: 'crm', referenced_table: 'Customers', referenced_column: 'id' }
    ] : [
      { table_schema: 'public', table_name: 'Orders', column_name: 'id', data_type: 'integer', is_nullable: 'NO', is_primary_key: true },
      { table_schema: 'sales', table_name: 'Orders', column_name: 'tenant_id', data_type: 'integer', is_nullable: 'NO' },
      { table_schema: 'sales', table_name: 'Orders', column_name: 'customer_id', data_type: 'integer', is_nullable: 'YES' },
      { table_schema: 'odd.schema', table_name: 'Table"Name', column_name: 'count', data_type: 'integer', is_nullable: 'NO' }
    ] }));
    const connector = new PostgresConnector();
    Object.assign(connector, { client: { query } });
    const schema = await connector.introspect();
    expect(schema.tables.map(table => table.qualifiedName)).toEqual(['"public"."Orders"', '"sales"."Orders"', '"odd.schema"."Table""Name"']);
    expect(schema.tables[1].relationships).toEqual([{ columns: ['tenant_id', 'customer_id'], referencedSchema: 'crm', referencedTable: 'Customers', referencedColumns: ['tenant_id', 'id'] }]);
    expect(schema.tables[1].columns[1].foreignKey?.column).toBe('id');
    expect(query.mock.calls[1][0]).toContain('unnest(con.conkey, con.confkey)');
    expect(query.mock.calls[1][0]).toContain("has_table_privilege(refrel.oid, 'SELECT')");
    expect(await connector.getContextForPrompt()).toContain('"sales"."Orders"');
  });
});
