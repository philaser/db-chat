import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebServer } from '../src/server/server';
import { loadWebServerConfig } from '../src/server/config';
import { WebSessionStore } from '../src/server/sessionStore';
import type { AgentModelClient } from '../src/server/agent/types';
import type { DatabaseConnector } from '../src/shared/types';
let server: WebServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dbchat-remediation-'));
  const connector: DatabaseConnector = {
    async connect() {}, async introspect() { return { kind: 'sqlite', label: 'Synthetic fixture', tables: [{ name: 'numbers', columns: [{ name: 'n', type: 'integer', primaryKey: false, nullable: false }] }] }; },
    async executeQuery() { return { columns: ['n'], rows: [{ n: 1 }], rowCount: 1, elapsedMs: 1, truncated: true, rowLimit: 1 }; },
    async getContextForPrompt() { return 'numbers(n integer)'; }, setSafetyLevel() {}, close() {}
  };
  const modelClient: AgentModelClient = { async *streamChat(options) {
    if (options.messages.some(message => message.role === 'tool')) yield { content: 'The saved fixture result is 1.' };
    else yield { toolCalls: [{ index: 0, id: 'query', type: 'function', function: { name: 'run_database_query', arguments: JSON.stringify({ query: 'SELECT n FROM numbers', purpose: 'Read the synthetic fixture' }) } }] };
  } };
  server = new WebServer({ ...loadWebServerConfig({ DBCHAT_WEB_DATA_DIR: dir, DBCHAT_WEB_AUTH_MODE: 'dev' }), port: 0, database: { id: 'fixture', kind: 'sqlite', label: 'Synthetic fixture', databasePath: '/tmp/synthetic-fixture.db', createdAt: '' } }, { connector, modelClient });
  const handle = await server.listen();
  return 'http://127.0.0.1:' + (handle.address() as AddressInfo).port + '/api/v1';
}
describe('server remediation contracts', () => {
  it('persists full history and result ownership independently of model context', async () => {
    const url = await setup();
    const create = await fetch(url + '/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: 'fixture' }) });
    const { chat } = await create.json();
    for (let index = 0; index < 21; index++) {
      const response = await fetch(url + '/chat/turns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: chat.id, connectionId: 'fixture', clientRequestId: 'request-' + index, userMessageId: 'user-' + index, assistantMessageId: 'assistant-' + index, question: 'Read fixture ' + index }) });
      expect(response.status).toBe(202);
      const { turnId } = await response.json();
      await (await fetch(url + '/chat/turns/' + turnId + '/events')).text();
    }
    const body = await (await fetch(url + '/chats/' + chat.id)).json();
    expect(body.chat.messages).toHaveLength(42);
    expect(body.chat.artifacts[0].messageId).toBe('assistant-0');
    expect(body.chat.artifacts[0].result.truncated).toBe(true);
    const saved = await fetch(url + '/chats/' + chat.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [], artifacts: [] }) });
    expect(saved.status).toBe(400);
    expect((await (await fetch(url + '/chats/' + chat.id)).json()).chat.messages).toHaveLength(42);
    const messages = body.chat.messages;
    const request = await fetch(url + '/chat/turns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }) });
    expect(request.status).toBe(400);
  });
  it('caps streaming data and prevents later successful completion', () => {
    const sessions = new WebSessionStore(1000);
    const turn = sessions.createTurn({ id: 'fixture', roles: [] }, []);
    sessions.publish(turn, 'text-delta', { text: 'x'.repeat(4 * 1024 * 1024) });
    expect(turn.error).toContain('streaming result budget');
    expect(turn.abortController.signal.aborted).toBe(true);
    expect(turn.events).toEqual([]); // Runner persists the failure before emitting a terminal event.
    sessions.complete(turn, { message: { id: 'a', role: 'assistant', content: 'late', createdAt: '' }, artifacts: [], events: [], toolCalls: [] });
    expect(turn.status).not.toBe('complete');
  });
});
