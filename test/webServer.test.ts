import Database from 'better-sqlite3';
import { SupabaseSqliteStorage } from '../src/server/supabaseSqliteStorage.js';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentModelClient } from '../src/server/agent/types.js';
import type {
  ConnectionConfig,
  DatabaseConnector,
  DatabaseSchema,
  QueryResult,
  SafetyLevel
} from '../src/shared/types.js';
import { WebServer } from '../src/server/server.js';
import { AccountStore } from '../src/server/accountStore.js';
import { DEFAULT_WEB_MODEL, loadWebServerConfig, type WebServerConfig } from '../src/server/config.js';
import { createToolRegistry } from '../src/server/webToolRegistry.js';

const testAccountStorePath = path.join(os.tmpdir(), 'dbchat-web-test-accounts.json');
const testSecretKeyPath = path.join(os.tmpdir(), 'dbchat-web-test-secret.key');
const testUploadDir = path.join(os.tmpdir(), 'dbchat-web-test-uploads');

class FixtureConnector implements DatabaseConnector {
  private safetyLevel: SafetyLevel = 'safe';

  async connect(_config: ConnectionConfig): Promise<void> {}

  async introspect(): Promise<DatabaseSchema> {
    return {
      kind: 'sqlite',
      label: 'Fixture database',
      tables: [{
        name: 'users',
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'name', type: 'TEXT', nullable: false, primaryKey: false }
        ]
      }]
    };
  }

  async executeQuery(query: string): Promise<QueryResult> {
    expect(query).toBe('SELECT name FROM users');
    return {
      columns: ['name'],
      rows: [{ name: 'Ada' }],
      rowCount: 1,
      elapsedMs: 2
    };
  }

  async getContextForPrompt(): Promise<string> {
    return 'Table users(id INTEGER PRIMARY KEY, name TEXT)';
  }

  setSafetyLevel(level: SafetyLevel): void {
    this.safetyLevel = level;
    expect(this.safetyLevel).toBe('safe');
  }

  close(): void {}
}

class FixtureModel implements AgentModelClient {
  async *streamChat(options: Parameters<AgentModelClient['streamChat']>[0]) {
    if (options.messages.some((message) => message.role === 'tool')) {
      yield { content: 'I found Ada in the users table.' };
      return;
    }

    yield {
      toolCalls: [{
        index: 0,
        id: 'fixture-call-1',
        type: 'function' as const,
        function: {
          name: 'run_database_query',
          arguments: JSON.stringify({
            query: 'SELECT name FROM users',
            purpose: 'Find the users'
          })
        }
      }]
    };
  }
}

function fixtureConfig(): WebServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    staticDir: '/private/tmp/dbchat-web-test-static',
    authMode: 'dev',
    accountStorePath: testAccountStorePath,
    secretKeyPath: testSecretKeyPath,
    secretKey: 'fixture-secret',
    sessionTtlMs: 60_000,
    sessionAbsoluteTtlMs: 24 * 60 * 60 * 1000,
    turnTimeoutMs: 60_000,
    database: {
      id: 'fixture-db',
      kind: 'sqlite',
      label: 'Fixture database',
      databasePath: '/private/tmp/fixture.db',
      createdAt: '2026-08-08T00:00:00.000Z',
      safetyLevel: 'safe'
    },
    databaseLabel: 'Fixture database',
    model: 'fixture-model',
    maxBodyBytes: 64 * 1024,
    maxHistoryMessages: 10,
    maxMessageChars: 1_000,
    maxResultRows: 100,
    maxResultBytes: 64 * 1024,
    maxSqliteUploadBytes: 1024 * 1024,
    sqliteUploadDir: testUploadDir
  };
}

function appConfig(): WebServerConfig {
  return {
    ...fixtureConfig(),
    authMode: 'app',
    database: undefined,
    databaseLabel: 'No database configured'
  };
}

describe('web server', () => {
  let server: WebServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await rm(testAccountStorePath, { force: true });
    await rm(testSecretKeyPath, { force: true });
    await rm(testUploadDir, { recursive: true, force: true });
  });

  it('persists cloud SQLite connections across server restarts and deletes their objects', async () => {
    const objects = new Map<string, Uint8Array>();
    const storageFetch: typeof fetch = async (url, init) => {
      const route = new URL(String(url)).pathname;
      if (init?.method === 'DELETE') {
        for (const key of JSON.parse(String(init.body)).prefixes) objects.delete(key);
        return Response.json({});
      }
      const key = route.split('/dbchat-sqlite/')[1];
      if (init?.method === 'POST') { objects.set(key, init.body as Uint8Array); return Response.json({}); }
      const bytes = objects.get(key);
      return bytes ? new Response(Buffer.from(bytes)) : new Response('', { status: 404 });
    };
    const start = async () => {
      server = new WebServer(appConfig(), { modelClient: new FixtureModel(), sqliteStorage: new SupabaseSqliteStorage({ url: 'https://storage.example', key: 'sb_secret_fixture', maxBytes: 1024 * 1024, fetch: storageFetch }) });
      const address = (await server.listen()).address() as AddressInfo;
      return `http://127.0.0.1:${address.port}/api/v1`;
    };
    let base = await start();
    const signup = await fetch(base + '/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'storage@example.com', password: 'HostedQA123!', displayName: 'Storage' }) });
    expect(signup.status).toBe(201);
    const owner = (await signup.json()).user.id;
    const Cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const db = new Database(':memory:');
    db.exec("create table users (id integer primary key, name text); insert into users values (1, 'Ada')");
    const bytes = db.serialize(); db.close();
    const upload = await fetch(base + '/sqlite-files', { method: 'POST', headers: { Cookie, 'X-DBChat-Filename': 'customer.sqlite' }, body: new Uint8Array(bytes) });
    expect(upload.status).toBe(201);
    const { uploadId } = await upload.json();
    const created = await fetch(base + '/connections', { method: 'POST', headers: { Cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'sqlite', label: 'Customer', sqliteUploadId: uploadId }) });
    expect(created.status).toBe(201);
    const { connection } = await created.json();
    const saved = await server!.accounts.getConnectionConfig(owner, connection.id);
    expect(saved?.sqliteObjectKey).toMatch(new RegExp('^' + owner + '/'));
    expect(saved?.databasePath).toBeFalsy();
    expect(objects.size).toBe(1);
    await server!.close();
    base = await start();
    const schema = await fetch(base + '/connections/' + connection.id + '/schema', { headers: { Cookie } });
    expect(schema.status).toBe(200);
    expect((await schema.json()).schema.tables).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'users' })]));
    expect((await server!.accounts.getConnectionConfig(owner, connection.id))?.databasePath).toBeFalsy();
    const deleted = await fetch(base + '/connections/' + connection.id, { method: 'DELETE', headers: { Cookie } });
    expect(deleted.status).toBe(200); expect(objects.size).toBe(0);
  });

  it('requires proxy authentication in production', () => {
    expect(loadWebServerConfig({}).authMode).toBe('app');
    expect(() => loadWebServerConfig({
      NODE_ENV: 'production',
      DBCHAT_WEB_AUTH_MODE: 'dev'
    })).toThrow('DBCHAT_WEB_AUTH_MODE must be app in production.');
    expect(() => loadWebServerConfig({
      DBCHAT_WEB_AUTH_MODE: 'header'
    })).toThrow('Unsupported DBCHAT_WEB_AUTH_MODE: header');
  });

  it('uses Render origin unless explicitly overridden and rejects invalid origins', () => {
    expect(loadWebServerConfig({ RENDER_EXTERNAL_URL: 'https://example.onrender.com' }).allowedOrigin).toBe('https://example.onrender.com');
    expect(loadWebServerConfig({ RENDER_EXTERNAL_URL: 'https://example.onrender.com', DBCHAT_WEB_ALLOWED_ORIGIN: 'https://custom.example' }).allowedOrigin).toBe('https://custom.example');
    expect(() => loadWebServerConfig({ RENDER_EXTERNAL_URL: 'https://example.onrender.com/path' })).toThrow('public app origin');
  });

  it('uses the DeepSeek V4 Flash 0731 model by default', () => {
    expect(loadWebServerConfig({}).model).toBe(DEFAULT_WEB_MODEL);
    expect(loadWebServerConfig({ DBCHAT_WEB_MODEL: 'custom/model' }).model).toBe('custom/model');
  });

  it('exposes visualization generation to the web harness', () => {
    const registry = createToolRegistry();
    expect(registry.has('visualize_data')).toBe(true);
    expect(registry.getOpenAiTools().some((tool) => tool.function.name === 'visualize_data')).toBe(true);
  });

  it('streams a read-only query result through the web chat API', async () => {
    server = new WebServer(fixtureConfig(), {
      connector: new FixtureConnector(),
      modelClient: new FixtureModel()
    });
    const httpServer = await server.listen();
    const address = httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`);
    expect(bootstrapResponse.status).toBe(200);
    expect(await bootstrapResponse.json()).toMatchObject({
      ready: true,
      database: { label: 'Fixture database', tableCount: 1, readOnly: true },
      capabilities: { charts: true }
    });

    const turnResponse = await fetch(`${baseUrl}/api/chat/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Who is in the users table?' }] })
    });
    expect(turnResponse.status).toBe(202);
    const { turnId } = await turnResponse.json() as { turnId: string };

    const eventsResponse = await fetch(`${baseUrl}/api/chat/turns/${turnId}/events`);
    expect(eventsResponse.status).toBe(200);
    const eventsText = await eventsResponse.text();
    const events = [...eventsText.matchAll(/event: ([^\n]+)\ndata: ([^\n]+)/g)]
      .map((match) => ({ type: match[1], data: JSON.parse(match[2]) as Record<string, unknown> }));

    expect(events.map((event) => event.type)).toContain('result');
    expect(events.at(-1)?.type).toBe('complete');
    expect(events.find((event) => event.type === 'result')?.data).toMatchObject({
      artifact: {
        kind: 'query-result',
        query: 'SELECT name FROM users',
        result: { columns: ['name'], rows: [{ name: 'Ada' }], rowCount: 1 }
      }
    });
    expect(events.at(-1)?.data).toMatchObject({
      message: { content: 'I found Ada in the users table.' },
      artifactIds: [expect.stringContaining(`${turnId}-query-1`)]
    });
  });

  it('persists chat history and serves the selected connection schema', async () => {
    server = new WebServer(fixtureConfig(), { connector: new FixtureConnector() });
    const httpServer = await server.listen();
    const address = httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const createResponse = await fetch(`${baseUrl}/api/v1/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: 'fixture-db' })
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { chat: { id: string; title: string } };
    expect(created.chat.title).toBe('New chat');

    const chatId = created.chat.id;
    const saveResponse = await fetch(`${baseUrl}/api/v1/chats/${chatId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: 'user-1', role: 'user', content: 'Who is in users?', createdAt: '2026-08-09T19:00:00.000Z' }],
        artifacts: [{
          kind: 'query-result',
          queryId: 'query-1',
          query: 'SELECT name FROM users',
          result: { columns: ['name'], rows: [{ name: 'Ada' }], rowCount: 1, elapsedMs: 2 }
        }]
      })
    });
    expect(saveResponse.status).toBe(200);
    expect(await saveResponse.json()).toMatchObject({
      chat: { id: chatId, title: 'Who is in users?', messageCount: 1, artifactCount: 1 }
    });

    const renameResponse = await fetch(`${baseUrl}/api/v1/chats/${chatId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '  User directory analysis  ' })
    });
    expect(renameResponse.status).toBe(200);
    expect(await renameResponse.json()).toMatchObject({ chat: { id: chatId, title: 'User directory analysis' } });

    const autosaveResponse = await fetch(`${baseUrl}/api/v1/chats/${chatId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: 'user-2', role: 'user', content: 'This autosave must not replace the custom title', createdAt: '2026-08-09T19:01:00.000Z' }]
      })
    });
    expect(await autosaveResponse.json()).toMatchObject({ chat: { id: chatId, title: 'User directory analysis' } });

    const listResponse = await fetch(`${baseUrl}/api/v1/chats`);
    expect(await listResponse.json()).toMatchObject({ chats: [expect.objectContaining({ id: chatId, title: 'User directory analysis' })] });

    const reloadedAccounts = new AccountStore({
      sessionTtlMs: 60_000,
      defaultModel: 'deepseek/deepseek-v4-flash-0731',
      storePath: fixtureConfig().accountStorePath,
      secretKeyPath: fixtureConfig().secretKeyPath
    });
    expect(reloadedAccounts.getChat('dev-user', chatId)).toMatchObject({ title: 'User directory analysis' });

    const schemaResponse = await fetch(`${baseUrl}/api/v1/connections/fixture-db/schema`);
    expect(schemaResponse.status).toBe(200);
    expect(await schemaResponse.json()).toMatchObject({
      schema: { label: 'Fixture database', tables: [{ name: 'users', columns: [{ name: 'id' }, { name: 'name' }] }] }
    });

    const deleteResponse = await fetch(`${baseUrl}/api/v1/chats/${chatId}`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({ ok: true });
    expect((await fetch(`${baseUrl}/api/v1/chats/${chatId}`)).status).toBe(404);
  });

  it('supports hosted accounts, hidden provider keys, and user-owned connections', async () => {
    server = new WebServer(appConfig(), { modelClient: new FixtureModel() });
    const httpServer = await server.listen();
    const address = httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const signupResponse = await fetch(`${baseUrl}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'hosted@example.com',
        password: 'HostedQA123!',
        displayName: 'Hosted QA'
      })
    });
    expect(signupResponse.status).toBe(201);
    const signupBody = await signupResponse.json() as { user: { id: string; emailVerified: boolean } };
    expect(signupBody.user.emailVerified).toBe(false);
    const cookie = signupResponse.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toMatch(/^dbchat_auth_session=/);

    const uploadResponse = await fetch(`${baseUrl}/api/v1/sqlite-files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-DBChat-Filename': encodeURIComponent('hosted-qa.sqlite'),
        Cookie: cookie!
      },
      body: Buffer.from('sqlite fixture bytes')
    });
    expect(uploadResponse.status).toBe(201);
    const uploadBody = await uploadResponse.json() as { uploadId: string; fileName: string };
    expect(uploadBody.fileName).toBe('hosted-qa.sqlite');

    const bootstrapResponse = await fetch(`${baseUrl}/api/v1/bootstrap`, {
      headers: { Cookie: cookie! }
    });
    expect(bootstrapResponse.status).toBe(200);
    expect(await bootstrapResponse.json()).toMatchObject({
      ready: false,
      user: { email: 'hosted@example.com', displayName: 'Hosted QA' },
      connections: [],
      inference: {
        credentialSource: 'none',
        hasUserKey: false,
        userKeyUiEnabled: false,
        status: 'unavailable'
      }
    });

    const connectionResponse = await fetch(`${baseUrl}/api/v1/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie! },
      body: JSON.stringify({
        label: 'Hosted QA SQLite',
        kind: 'sqlite',
        sqliteUploadId: uploadBody.uploadId
      })
    });
    expect(connectionResponse.status).toBe(201);
    const connectionBody = await connectionResponse.json() as { connection: { id: string; status: string; hasSavedSecret: boolean } };
    expect(connectionBody.connection).toMatchObject({ status: 'unavailable', hasSavedSecret: false });
    expect(path.basename((await server.accounts.getConnectionConfig(signupBody.user.id, connectionBody.connection.id))?.databasePath ?? '')).toBe('hosted-qa.sqlite');

    const elasticsearchResponse = await fetch(`${baseUrl}/api/v1/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie! },
      body: JSON.stringify({
        label: 'Hosted QA Elasticsearch',
        kind: 'elasticsearch',
        host: 'search.example.com',
        elasticsearchHost: 'search.example.com',
        elasticsearchPort: 9243,
        elasticsearchUsername: 'readonly-user',
        elasticsearchPassword: 'not-a-real-secret',
        elasticsearchUseSsl: true,
        elasticsearchVerifyCerts: true
      })
    });
    expect(elasticsearchResponse.status).toBe(201);
    const elasticsearchBody = await elasticsearchResponse.json() as { connection: { id: string; hasSavedSecret: boolean } };
    expect(elasticsearchBody.connection).toMatchObject({ hasSavedSecret: true });
    expect(await server.accounts.getConnectionConfig(signupBody.user.id, elasticsearchBody.connection.id)).toMatchObject({
      elasticsearchHost: 'search.example.com',
      elasticsearchPort: 9243,
      elasticsearchUsername: 'readonly-user',
      elasticsearchPassword: 'not-a-real-secret',
      elasticsearchUseSsl: true,
      elasticsearchVerifyCerts: true
    });

    const keyResponse = await fetch(`${baseUrl}/api/v1/settings/openrouter-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie! },
      body: JSON.stringify({ apiKey: 'sk-or-v1-test-secret' })
    });
    expect(keyResponse.status).toBe(202);
    expect(await keyResponse.json()).not.toHaveProperty('apiKey');

    const readyBootstrapResponse = await fetch(`${baseUrl}/api/v1/bootstrap`, {
      headers: { Cookie: cookie! }
    });
    expect(await readyBootstrapResponse.json()).toMatchObject({
      activeConnectionId: connectionBody.connection.id,
      connections: expect.arrayContaining([
        expect.objectContaining({ id: connectionBody.connection.id, status: 'unavailable' }),
        expect.objectContaining({ id: elasticsearchBody.connection.id, status: 'unavailable' })
      ]),
      inference: { credentialSource: 'user', hasUserKey: true }
    });

    const logoutResponse = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie! }
    });
    expect(logoutResponse.status).toBe(200);

    const protectedResponse = await fetch(`${baseUrl}/api/v1/bootstrap`, {
      headers: { Cookie: cookie! }
    });
    expect(protectedResponse.status).toBe(401);

    const unauthorizedConnectionResponse = await fetch(`${baseUrl}/api/v1/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie! },
      body: JSON.stringify({ label: 'Should not be stored', kind: 'sqlite', databasePath: '/private/tmp/nope.sqlite' })
    });
    expect(unauthorizedConnectionResponse.status).toBe(401);
    expect(await unauthorizedConnectionResponse.json()).toEqual({ error: 'Authentication required.' });
  });

  it('persists only hashed authentication sessions and restores them after restart', async () => {
    server = new WebServer(appConfig());
    let httpServer = await server.listen();
    let address = httpServer.address() as AddressInfo;
    let baseUrl = `http://127.0.0.1:${address.port}`;

    const signupResponse = await fetch(`${baseUrl}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'restart@example.com', password: 'RestartQA123!' })
    });
    expect(signupResponse.status).toBe(201);
    const cookie = signupResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const rawToken = cookie?.split('=', 2)[1];
    expect(cookie).toMatch(/^dbchat_auth_session=/);
    expect(rawToken).toBeTruthy();

    const persisted = await readFile(testAccountStorePath, 'utf8');
    expect(persisted).toContain('"sessions"');
    expect(persisted).not.toContain(rawToken!);

    await server.close();
    server = new WebServer(appConfig());
    httpServer = await server.listen();
    address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const restored = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Cookie: cookie! } });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      authenticated: true,
      user: { email: 'restart@example.com' }
    });

    const logout = await fetch(`${baseUrl}/api/v1/auth/logout`, { method: 'POST', headers: { Cookie: cookie! } });
    expect(logout.status).toBe(200);
    expect(await fetch(`${baseUrl}/api/v1/bootstrap`, { headers: { Cookie: cookie! } })).toHaveProperty('status', 401);
  });

  it('returns useful authentication errors and rate limits repeated failures', async () => {
    server = new WebServer(appConfig());
    const httpServer = await server.listen();
    const address = httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const invalidSignup = await fetch(`${baseUrl}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invalid', password: 'short' })
    });
    expect(invalidSignup.status).toBe(400);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'missing@example.com', password: 'Incorrect123!' })
      });
      expect(response.status).toBe(401);
    }
    const limited = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'missing@example.com', password: 'Incorrect123!' })
    });
    expect(limited.status).toBe(429);
  });

  it('persists hosted accounts, settings, connections, and encrypted connection config across restarts', async () => {
    const first = new WebServer(appConfig());
    await first.accounts.ensureDevelopmentUser();
    const connection = await first.accounts.createConnection('dev-user', {
      id: 'fixture-connection',
      kind: 'sqlite',
      label: 'Chinook',
      databasePath: '/private/tmp/chinook.sqlite',
      createdAt: '2026-08-08T00:00:00.000Z',
      safetyLevel: 'safe'
    }, { ok: true, tableCount: 11 });
    await first.accounts.updateSettings('dev-user', { displayName: 'Saved User', activeConnectionId: connection.id });
    await first.close();

    const second = new WebServer(appConfig());
    await second.accounts.ensureDevelopmentUser();
    expect(await second.accounts.getUser('dev-user')).toMatchObject({ displayName: 'Saved User' });
    expect(await second.accounts.listConnections('dev-user')).toMatchObject([{
      label: 'Chinook',
      status: 'ready',
      tableCount: 11
    }]);
    expect((await second.accounts.getSettings('dev-user')).activeConnectionId).toBe(connection.id);
    expect(await second.accounts.getConnectionConfig('dev-user', connection.id)).toMatchObject({
      databasePath: '/private/tmp/chinook.sqlite',
      safetyLevel: 'safe'
    });
    await second.close();
  });
});
