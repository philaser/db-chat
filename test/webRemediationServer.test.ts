import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebServer } from '../src/server/server';
import { loadWebServerConfig } from '../src/server/config';
import { WebSessionStore } from '../src/server/sessionStore';
let server: WebServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dbchat-remediation-'));
  server = new WebServer({ ...loadWebServerConfig({ DBCHAT_WEB_DATA_DIR: dir, DBCHAT_WEB_AUTH_MODE: 'dev' }), port: 0 });
  const handle = await server.listen();
  return 'http://127.0.0.1:' + (handle.address() as AddressInfo).port + '/api/v1';
}
describe('server remediation contracts', () => {
  it('persists full history and result ownership independently of model context', async () => {
    const url = await setup();
    const create = await fetch(url + '/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const { chat } = await create.json();
    const messages = Array.from({ length: 42 }, (_, id) => ({ id: String(id), role: id % 2 ? 'assistant' : 'user', content: 'Fixture', createdAt: new Date().toISOString() }));
    const artifacts = [{ kind: 'query-result', queryId: 'q', messageId: '1', query: 'SELECT 1', result: { columns: ['n'], rows: [{ n: 1 }], rowCount: 1, elapsedMs: 1, truncated: true, rowLimit: 1 } }];
    const saved = await fetch(url + '/chats/' + chat.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages, artifacts }) });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.chat.messages).toHaveLength(42);
    expect(body.chat.artifacts[0].messageId).toBe('1');
    expect(body.chat.artifacts[0].result.truncated).toBe(true);
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
