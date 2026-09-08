import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/server/server';
import { loadWebServerConfig } from '../src/server/config';
import { PERSONAL_PROVIDER_MODELS } from '../src/server/model/providers';

let server: WebServer;
let dir: string;
afterEach(async () => { await server?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });
async function setup() {
  dir = await mkdtemp(path.join(tmpdir(), 'dbchat-inference-policy-'));
  const validateProviderKey = vi.fn(async (_provider: string, key: string) => { if (key === 'invalid-key-secret') throw new Error('Rejected provider secret'); });
  server = new WebServer({ ...loadWebServerConfig({ DBCHAT_WEB_DATA_DIR: dir, DBCHAT_WEB_AUTH_MODE: 'dev' }), port: 0, openRouterApiKey: 'managed-secret', database: { id: 'fixture', kind: 'sqlite', label: 'Fixture', databasePath: '/tmp/fixture.sqlite', createdAt: '' } }, {
    validateProviderKey,
    connector: { async connect() {}, async introspect() { return {kind:'sqlite',label:'Fixture',tables:[]}; }, async executeQuery() { return {columns:[],rows:[],rowCount:0,elapsedMs:0}; }, async getContextForPrompt() { return ''; }, setSafetyLevel() {}, close() {} },
    modelClient: { async *streamChat() { yield { content:'A fixture answer.', finishReason:'stop' }; } }
  });
  const handle = await server.listen();
  const url = 'http://127.0.0.1:' + (handle.address() as AddressInfo).port + '/api/v1';
  const request = (route: string, method='GET', body?: unknown) => fetch(url + route, { method, headers: {'Content-Type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
  return { request, validateProviderKey };
}

describe('managed inference and direct personal providers', () => {
  it('overrides legacy stored models for bootstrap, settings, and actual managed turns', async () => {
    const {request} = await setup();
    await server.accounts.updateSettings('dev-user', { model:'deepseek/deepseek-v4-flash-0731', effortLevel:'high' });
    await server.accounts.setUserKey('dev-user', 'legacy-openrouter-secret');
    for (const route of ['/bootstrap','/settings']) {
      const body = await (await request(route)).json();
      expect(body.settings).toMatchObject({provider:'openrouter',model:'google/gemini-2.5-flash',effortLevel:'low'});
      expect(body.inference).toMatchObject({canChangeModel:false,credentialSource:'internal',hasUserKey:false});
      expect(JSON.stringify(body)).not.toContain('secret');
    }
    for (const patch of [{model:'gpt-4.1'},{effortLevel:'high'},{provider:'openai'}]) expect((await request('/settings','PATCH',patch)).status).toBe(403);
    expect((await request('/settings','PATCH',{displayName:'Updated name'})).status).toBe(200);
    const run = vi.spyOn(server.service,'run');
    const response = await request('/chat/turns','POST',{question:'Explain this database.',connectionId:'fixture',model:'openai/expensive-model',effortLevel:'max'});
    expect(response.status).toBe(202);
    const {turnId}=await response.json();
    await (await request('/chat/turns/'+turnId+'/events')).text();
    expect(run.mock.calls[0][5]).toBe('managed-secret');
    expect(run.mock.calls[0][6]).toBe('google/gemini-2.5-flash');
    expect(run.mock.calls[0][7]).toBe('low');
    expect(run.mock.calls[0][9]).toBe('openrouter');
  });

  it.each(['openai','deepseek'] as const)('unlocks only %s models after validating its key, then resets on removal', async provider => {
    const {request,validateProviderKey}=await setup();
    const save=await request('/settings/provider-key','POST',{provider,apiKey:'personal-key-secret'});
    expect(save.status).toBe(202);
    expect(validateProviderKey).toHaveBeenCalledWith(provider,'personal-key-secret');
    const body=await save.json();
    expect(body.inference).toMatchObject({provider,canChangeModel:true,hasUserKey:true,credentialSource:'user'});
    expect(JSON.stringify(body)).not.toContain('personal-key-secret');
    const model=PERSONAL_PROVIDER_MODELS[provider].at(-1)!.id;
    expect((await request('/settings','PATCH',{model})).status).toBe(200);
    expect((await request('/settings','PATCH',{model:'google/gemini-2.5-flash'})).status).toBe(400);
    const run=vi.spyOn(server.service,'run');
    const {turnId}=await (await request('/chat/turns','POST',{question:'Explain this database.',connectionId:'fixture'})).json();
    await (await request('/chat/turns/'+turnId+'/events')).text();
    expect(run.mock.calls[0][5]).toBe('personal-key-secret');
    expect(run.mock.calls[0][6]).toBe(model);
    expect(run.mock.calls[0][9]).toBe(provider);
    const removed=await (await request('/settings/provider-key','DELETE')).json();
    expect(removed.settings).toMatchObject({provider:'openrouter',model:'google/gemini-2.5-flash',effortLevel:'low'});
    expect(removed.inference.canChangeModel).toBe(false);
    expect((await request('/settings','PATCH',{model})).status).toBe(403);
  });

  it('rejects invalid keys and the legacy OpenRouter route without changing account state', async () => {
    const {request}=await setup();
    expect((await request('/settings/openrouter-key','POST',{apiKey:'legacy-key-secret'})).status).toBe(410);
    expect((await request('/settings/provider-key','POST',{provider:'openrouter',apiKey:'legacy-key-secret'})).status).toBe(400);
    const rejected=await request('/settings/provider-key','POST',{provider:'openai',apiKey:'invalid-key-secret'});
    expect(rejected.status).toBe(422);
    expect(await rejected.text()).not.toContain('invalid-key-secret');
    expect(await server.accounts.hasUserKey('dev-user')).toBe(false);
  });
});
