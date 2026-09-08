// Disposable embedded PostgreSQL verification. Point DBCHAT_PGLITE_MODULE at an
// installed @electric-sql/pglite module; no remote database or credentials needed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.DBCHAT_PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const query = (sql, args = []) => db.query(sql, args);
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);`);
  for (const file of ['202609050001_dbchat_accounts.sql', '202609080001_conversation_recovery.sql']) {
    await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
  }
  await query('insert into auth.users values ($1),($2)', [owner, other]);
  await query("insert into dbchat_profiles(user_id,email,display_name) values ($1,'one@example.test','One'),($2,'two@example.test','Two')", [owner, other]);
  await query("insert into dbchat_connections(id,user_id,config) values ('source',$1,'{\"label\":\"Original source\",\"kind\":\"sqlite\"}')", [owner]);
  await query("insert into dbchat_chats(id,user_id,connection_id,source) values ('chat',$1,'source','{\"connectionId\":\"source\",\"label\":\"Original source\",\"kind\":\"sqlite\"}')", [owner]);
  const message = { id: 'question', role: 'user', content: 'Count customers', createdAt: '2026-09-08T00:00:00Z' };
  const claim = () => query('select dbchat_claim_turn($1,$2,$3,$4,$5,$6) as result', [owner, 'turn', 'chat', 'request', message, 'answer']);
  assert.equal((await claim()).rows[0].result.created, true);
  assert.equal((await claim()).rows[0].result.created, false);
  await assert.rejects(query('select dbchat_update_chat($1,$2,$3)', [owner, 'chat', { messages: [{ role: 'assistant', content: 'forged' }] }]), /Only title and pinned/);
  await assert.rejects(query('select dbchat_update_chat($1,$2,$3)', [owner, 'chat', { connectionId: 'another-source' }]), /Only title and pinned/);
  await assert.rejects(query('select dbchat_update_chat($1,$2,$3)', [other, 'chat', { title: 'Cross-owner' }]), /Chat not found/);
  const snapshot = (await query("select snapshot from dbchat_turns where id='turn'")).rows[0].snapshot;
  assert.equal(snapshot.question, 'Count customers');
  assert.equal(snapshot.chatId, 'chat');
  const partial = { kind: 'query-result', queryId: 'result', query: 'SELECT 3 AS count', result: { columns: ['count'], rows: [{ count: 3 }], rowCount: 1, elapsedMs: 1 } };
  await query('select dbchat_save_turn($1,$2)', [owner, { ...snapshot, status: 'running', artifacts: [partial], intent: { action: 'rerun', artifactId: 'older-result', messageId: 'older-answer' } }]);
  await db.exec('select dbchat_interrupt_pending_turns()');
  const answer = (await query("select body from dbchat_messages where chat_id='chat' and body->>'role'='assistant'")).rows[0].body;
  assert.equal(answer.turn.status, 'error');
  assert.equal(answer.turn.question, 'Count customers');
  assert.deepEqual(answer.turn.intent, { action: 'rerun', artifactId: 'older-result', messageId: 'older-answer' });
  assert.equal((await query("select count(*)::int as count from dbchat_artifacts where chat_id='chat'")).rows[0].count, 1);
  await query('select dbchat_update_message_metadata($1,$2,$3,$4)', [owner, 'chat', 'answer', { feedback: { rating: 'unhelpful', correction: 'Use distinct customers', updatedAt: '2026-09-08T00:00:00Z' }, pinned: true }]);
  await assert.rejects(query('select dbchat_update_message_metadata($1,$2,$3,$4)', [other, 'chat', 'answer', { pinned: false }]), /Answer not found/);
  await query('select dbchat_update_chat($1,$2,$3)', [owner, 'chat', { title: 'Saved result', pinned: true }]);
  const search = (await query('select dbchat_search_chats($1,$2,$3,$4,$5,$6) as result', [owner, 'customers', 'source', true, 0, 10])).rows[0].result;
  assert.equal(search.total, 1);
  assert.equal(search.chats[0].title, 'Saved result');
  assert.equal((await query('select dbchat_search_chats($1,$2,$3,$4,$5,$6) as result', [other, '', null, false, 0, 10])).rows[0].result.total, 0);
  await assert.rejects(query("insert into dbchat_connection_knowledge values ($1,'source',$2)", [other, { glossary: [], examples: [] }]), /foreign key/);
  await query("insert into dbchat_connection_knowledge values ($1,'source',$2)", [owner, { glossary: [], examples: [] }]);
  await query("delete from dbchat_connections where user_id=$1 and id='source'", [owner]);
  const historical = (await query("select connection_id,source from dbchat_chats where id='chat'")).rows[0];
  assert.equal(historical.connection_id, null);
  assert.equal(historical.source.label, 'Original source');
  assert.equal((await query('select count(*)::int as count from dbchat_connection_knowledge')).rows[0].count, 0);
  // Execute the connector's actual catalog SQL as a restricted source reader.
  await db.exec(`create role schema_reader;
    create schema sales; create schema crm; create schema "Odd.Schema";
    create table crm.customers(tenant_id integer,id integer,primary key(tenant_id,id));
    create table sales.orders(tenant_id integer,customer_id integer,foreign key(tenant_id,customer_id) references crm.customers(tenant_id,id));
    create table sales.private_notes(secret text);
    create table "Odd.Schema"."Case.Table"(id integer primary key);
    grant usage on schema sales,crm,"Odd.Schema" to schema_reader;
    grant select on crm.customers,sales.orders,"Odd.Schema"."Case.Table" to schema_reader;
    set role schema_reader;`);
  const connectorSource = await readFile(new URL('../src/server/connectors/PostgresConnector.ts', import.meta.url), 'utf8');
  const catalogQueries = [...connectorSource.matchAll(/client\.query\(`([\s\S]*?)`\)/g)].map(match => match[1]);
  assert.equal(catalogQueries.length, 2);
  const columns = (await query(catalogQueries[0])).rows;
  assert.ok(columns.some(column => column.table_schema === 'Odd.Schema' && column.table_name === 'Case.Table'));
  assert.ok(!columns.some(column => column.table_name === 'private_notes'));
  assert.equal(columns.find(column => column.table_schema === 'Odd.Schema' && column.column_name === 'id').is_primary_key, true);
  const relationships = (await query(catalogQueries[1])).rows;
  assert.deepEqual(relationships.map(row => [row.column_name, row.referenced_column]), [['tenant_id', 'tenant_id'], ['customer_id', 'id']]);
  await db.exec('reset role');
  await db.exec('set role authenticated');
  await assert.rejects(query('select * from public.dbchat_chats'), /permission denied/);
  await assert.rejects(query('select dbchat_update_chat($1,$2,$3)', [owner, 'chat', { title: 'No access' }]), /permission denied/);
  console.log('PASS: migrations execute; idempotency, recovery, partial evidence, immutable source, metadata, search, owner isolation, client grants, and restricted-reader qualified/composite-FK catalog SQL verified.');
} finally { await db.close(); }
