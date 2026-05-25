import { describe, expect, it } from 'vitest';
import { validateMysqlReadOnlyQuery } from '../src/main/connectors/mysqlValidation';

describe('validateMysqlReadOnlyQuery', () => {
  it('allows basic select queries', () => {
    expect(validateMysqlReadOnlyQuery('select * from users limit 10;', 'safe').safe).toBe(true);
  });

  it('allows show and describe queries', () => {
    expect(validateMysqlReadOnlyQuery('show tables', 'safe').safe).toBe(true);
    expect(validateMysqlReadOnlyQuery('show columns from users', 'safe').safe).toBe(true);
    expect(validateMysqlReadOnlyQuery('describe users', 'safe').safe).toBe(true);
    expect(validateMysqlReadOnlyQuery('explain select * from users', 'safe').safe).toBe(true);
  });

  it('allows with statements', () => {
    expect(validateMysqlReadOnlyQuery('with cte as (select 1) select * from cte', 'safe').safe).toBe(true);
  });

  it.each([
    'insert into users(name) values ("Ada")',
    'update users set name = "Ada"',
    'delete from users',
    'drop table users',
    'alter table users add column email text',
    'create table backups(id integer)',
    'grant select on users to user1',
    'truncate users',
    'select * from users; delete from users'
  ])('blocks unsafe query: %s', (query) => {
    const validation = validateMysqlReadOnlyQuery(query, 'safe');
    expect(validation.safe).toBe(false);
  });

  it.each([
    'insert into users(name) values ("Ada")',
    'update users set name = "Ada" where id = 1',
    'delete from users where id = 1',
    'replace into users(id, name) values (1, "Ada")'
  ])('allows table row writes with SAFE mode off: %s', (query) => {
    expect(validateMysqlReadOnlyQuery(query, 'manual').safe).toBe(true);
  });

  it.each([
    'drop table users',
    'create table backups(id integer)',
    'alter table users add column email text',
    'grant select on users to user1',
    'truncate users',
    'rename table users to old_users'
  ])('blocks higher-level operations with SAFE mode off: %s', (query) => {
    expect(validateMysqlReadOnlyQuery(query, 'manual').safe).toBe(false);
  });
});
