import { describe, expect, it } from 'vitest';
import { validatePostgresqlReadOnlyQuery } from '../src/main/connectors/postgresqlValidation';

describe('validatePostgresqlReadOnlyQuery', () => {
  it('allows basic select queries', () => {
    expect(validatePostgresqlReadOnlyQuery('select * from users limit 10;', 'safe').safe).toBe(true);
  });

  it('allows show and explain queries', () => {
    expect(validatePostgresqlReadOnlyQuery('explain select * from users', 'safe').safe).toBe(true);
    expect(validatePostgresqlReadOnlyQuery('show search_path', 'safe').safe).toBe(true);
  });

  it('allows with statements', () => {
    expect(validatePostgresqlReadOnlyQuery('with cte as (select 1) select * from cte', 'safe').safe).toBe(true);
  });

  it.each([
    'insert into users(name) values (\'Ada\')',
    'update users set name = \'Ada\'',
    'delete from users',
    'drop table users',
    'alter table users add column email text',
    'create table backups(id integer)',
    'grant select on users to user1',
    'truncate users',
    'vacuum users',
    'select * from users; delete from users'
  ])('blocks unsafe query: %s', (query) => {
    const validation = validatePostgresqlReadOnlyQuery(query, 'safe');
    expect(validation.safe).toBe(false);
  });

  it.each([
    'insert into users(name) values (\'Ada\')',
    'update users set name = \'Ada\' where id = 1',
    'delete from users where id = 1'
  ])('allows table row writes with SAFE mode off: %s', (query) => {
    expect(validatePostgresqlReadOnlyQuery(query, 'manual').safe).toBe(true);
  });

  it.each([
    'drop table users',
    'create table backups(id integer)',
    'alter table users add column email text',
    'grant select on users to user1',
    'truncate users',
    'vacuum users'
  ])('blocks higher-level operations with SAFE mode off: %s', (query) => {
    expect(validatePostgresqlReadOnlyQuery(query, 'manual').safe).toBe(false);
  });
});
