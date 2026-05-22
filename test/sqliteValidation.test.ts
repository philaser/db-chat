import { describe, expect, it } from 'vitest';
import { validateSqliteReadOnlyQuery } from '../src/main/connectors/sqliteValidation';

describe('validateSqliteReadOnlyQuery', () => {
  it('allows basic select queries', () => {
    expect(validateSqliteReadOnlyQuery('select * from users limit 10;', 'safe').safe).toBe(true);
  });

  it('allows safe schema pragmas', () => {
    expect(validateSqliteReadOnlyQuery('pragma table_info(users)', 'safe').safe).toBe(true);
  });

  it.each([
    'insert into users(name) values ("Ada")',
    'update users set name = "Ada"',
    'delete from users',
    'drop table users',
    'alter table users add column email text',
    'select * from users; delete from users',
    'with rows as (delete from users returning *) select * from rows'
  ])('blocks unsafe query: %s', (query) => {
    const validation = validateSqliteReadOnlyQuery(query, 'safe');
    expect(validation.safe).toBe(false);
  });

  it.each([
    'insert into users(name) values ("Ada")',
    'update users set name = "Ada" where id = 1',
    'delete from users where id = 1',
    'replace into users(id, name) values (1, "Ada")'
  ])('allows table row writes with SAFE mode off: %s', (query) => {
    expect(validateSqliteReadOnlyQuery(query, 'manual').safe).toBe(true);
  });

  it.each([
    'drop table users',
    'create table backups(id integer)',
    'alter table users add column email text',
    'attach database "other.db" as other',
    'vacuum'
  ])('blocks higher-level operations with SAFE mode off: %s', (query) => {
    expect(validateSqliteReadOnlyQuery(query, 'manual').safe).toBe(false);
  });
});
