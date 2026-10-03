import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { AccountStore } from '../src/server/accountStore';
import { WebServer } from '../src/server/server';
import { loadWebServerConfig, type WebServerConfig } from '../src/server/config';
import type { ChatMessage, ConnectionConfig, DatabaseConnector, QueryResultArtifact } from '../src/shared/types';
import type { WebTurnSnapshot } from '../src/server/types';
import type { AgentModelClient } from '../src/server/agent/types';
class DurableAccounts extends AccountStore {
  deleteAccount = vi.fn(async (_owner: string) => {});
  finalizeGate?: Promise<void>;
  finalizeStarted = false;
  recoverExpiredTurns = vi.fn(() => super.recoverExpiredTurns());
  async finalizeTurn(owner: string, snapshot: WebTurnSnapshot, message?: ChatMessage, artifacts: QueryResultArtifact[] = [], workerId?: string) {
    this.finalizeStarted = true;
    await this.finalizeGate;
    return super.finalizeTurn(owner, snapshot, message, artifacts, workerId);
  }
}
const connector: DatabaseConnector = {
  async connect() {}, async introspect() { return { kind:'sqlite',label:'Fixture',tables:[{name:'revenue',columns:[{name:'amount',type:'INTEGER',nullable:false,primaryKey:false}]}] }; },
  async executeQuery() { return {columns:['amount'],rows:[{amount:10}],rowCount:1,elapsedMs:1}; },
  async getContextForPrompt() { return 'revenue(amount INTEGER)'; }, setSafetyLevel() {}, close() {}
};
describe('durable web turn integration', () => {
  const servers: WebServer[]=[];
  afterEach(async () => { await Promise.all(servers.splice(0).map(server=>server.close())); });
  async function start(accounts: DurableAccounts, model: AgentModelClient, database?: ConnectionConfig, overrides: Partial<WebServerConfig> = {}) {
    const config={...loadWebServerConfig({DBCHAT_WEB_AUTH_MODE:'app'}),port:0,database,sqliteUploadDir:undefined,openRouterApiKey:'fixture-only-key', ...overrides};
    const server=new WebServer(config,{accounts,modelClient:model,connector,worker:{leaseMs:1000,heartbeatMs:50}}); servers.push(server);
    const node=await server.listen(); return `http://127.0.0.1:${(node.address() as AddressInfo).port}/api/v1`;
  }
  async function fixture(fail=false, overrides: Partial<WebServerConfig> = {}, customModel?: AgentModelClient) {
    const accounts=new DurableAccounts({defaultModel:'fixture',sessionTtlMs:60000,secretKey:'fixture'});
    const auth=accounts.signup('person@example.test','fixture-password');
    const connection=accounts.createConnection(auth.user.id,{id:'',kind:'sqlite',label:'Fixture',databasePath:'/tmp/disposable-fixture.db',createdAt:''},{ok:true,tableCount:1});
    const chat=accounts.createChat(auth.user.id,connection.id); let calls=0;
    const model: AgentModelClient=customModel ?? {async *streamChat() {calls++; if(fail) throw new Error('Synthetic model failure'); yield {content:'An answer'};}};
    const database=accounts.getConnectionConfig(auth.user.id,connection.id)!;
    const base=await start(accounts,model,database,overrides);
    // Cookie name is discovered from the real login endpoint, not coupled to implementation constants.
    const login=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'person@example.test',password:'fixture-password'})});
    const cookie=login.headers.get('set-cookie')!.split(';')[0];
    const headers={'content-type':'application/json',cookie};
    const body={chatId:chat.id,connectionId:connection.id,clientRequestId:'request-one',userMessageId:'user-one',assistantMessageId:'assistant-one',messages:[{role:'user',content:'Question'}]};
    const submit=async()=>{ const response=await fetch(base+'/chat/turns',{method:'POST',headers,body:JSON.stringify(body)}); expect(response.status).toBe(202); return (await response.json()).turnId as string; };
    const snapshot=async(id:string,newBase=base)=>(await fetch(newBase+'/chat/turns/'+id,{headers})).json() as Promise<WebTurnSnapshot>;
    return {accounts,auth,chat,base,model,database,headers,submit,snapshot,body,server:servers.at(-1)!,calls:()=>calls};
  }
  it('does not publish completion until the terminal message has been saved',async()=>{
    const f=await fixture(); let release!:()=>void;
    f.accounts.finalizeGate=new Promise<void>(resolve=>{release=resolve;});
    const id=await f.submit(); await vi.waitFor(()=>expect(f.accounts.finalizeStarted).toBe(true));
    expect((await f.snapshot(id)).status).toBe('running');
    expect(f.accounts.getChat(f.auth.user.id,f.chat.id)?.messages).toHaveLength(1);
    const cancellation = await fetch(f.base+'/chat/turns/'+id+'/abort', {method:'POST',headers:f.headers});
    expect(cancellation.status).toBe(202);
    release(); await vi.waitFor(async()=>expect((await f.snapshot(id)).status).toBe('aborted'));
    expect((await f.snapshot(id)).events.at(-1)?.type).toBe('aborted');
    expect(f.accounts.getChat(f.auth.user.id,f.chat.id)?.messages.at(-1)?.id).toBe('assistant-one');
  });
  it('retries the same request without invoking the model again',async()=>{
    const f=await fixture(); const id=await f.submit(); await vi.waitFor(async()=>expect((await f.snapshot(id)).status).toBe('complete'));
    expect(await f.submit()).toBe(id); expect(f.calls()).toBe(1);
    expect(f.accounts.getChat(f.auth.user.id,f.chat.id)?.messages).toHaveLength(2);
  });
  it('evicts completed saved turns from the local cache while durable GET and SSE replay remain available', async () => {
    const f = await fixture();
    const id = await f.submit();
    await vi.waitFor(async () => expect((await f.snapshot(id)).status).toBe('complete'));
    await vi.waitFor(() => expect(f.server.sessions.getTurnForPrincipal(id, { id: f.auth.user.id, roles: ['user'] })).toBeUndefined());
    expect((await f.snapshot(id)).message?.content).toBe('An answer');
    const replay = await fetch(f.base + '/chat/turns/' + id + '/events', { headers: f.headers });
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain('event: complete');
    expect(await f.submit()).toBe(id);
    expect(f.calls()).toBe(1);
  });
  it('retains earlier artifacts on failure and can retrieve a saved turn after memory loss',async()=>{
    const f=await fixture(true);
    const artifact:QueryResultArtifact={kind:'query-result',queryId:'previous-result',query:'SELECT 1',result:{columns:['one'],rows:[{one:1}],rowCount:1,elapsedMs:1}};
    f.accounts.updateChat(f.auth.user.id,f.chat.id,{artifacts:[artifact]});
    const id=await f.submit(); await vi.waitFor(async()=>expect((await f.snapshot(id)).status).toBe('error'));
    expect(f.accounts.getChat(f.auth.user.id,f.chat.id)?.artifacts).toEqual([artifact]);
    expect(f.accounts.getChat(f.auth.user.id,f.chat.id)?.messages.at(-1)?.metrics).toMatchObject({ terminalReason: 'error', totalMs: expect.any(Number), model: 'google/gemini-2.5-flash' });
    const restartedBase=await start(f.accounts,f.model,f.database);
    const recovered=await f.snapshot(id,restartedBase); expect(recovered.status).toBe('error'); expect(recovered.events.at(-1)?.type).toBe('error');
    expect(f.accounts.recoverExpiredTurns.mock.calls.length).toBeGreaterThanOrEqual(2); expect(f.calls()).toBe(1);
  });

  it('returns a daily allowance error without starting the model, keeps retries idempotent, and allows personal keys', async () => {
    const f = await fixture(false, { managedTurnsPerAccountPerDay: 1 });
    const id = await f.submit();
    await vi.waitFor(async () => expect((await f.snapshot(id)).status).toBe('complete'));
    expect(await f.submit()).toBe(id);
    const nextBody = { ...f.body, clientRequestId: 'next-request', userMessageId: 'next-user', assistantMessageId: 'next-answer' };
    const rejected = await fetch(f.base + '/chat/turns', { method: 'POST', headers: f.headers, body: JSON.stringify(nextBody) });
    expect(rejected.status).toBe(429);
    expect((await rejected.json()).error).toContain('midnight UTC');
    expect(f.calls()).toBe(1);
    expect(f.accounts.getChat(f.auth.user.id, f.chat.id)?.messages).toHaveLength(2);
    f.accounts.setUserProviderKey(f.auth.user.id, 'openai', 'personal-provider-fixture');
    const accepted = await fetch(f.base + '/chat/turns', { method: 'POST', headers: f.headers, body: JSON.stringify(nextBody) });
    expect(accepted.status).toBe(202);
    const nextId = (await accepted.json()).turnId;
    await vi.waitFor(async () => expect((await f.snapshot(nextId)).status).toBe('complete'));
    expect(f.calls()).toBe(2);
  });

  it.each(['/api/v1', '/api'])('requires a saved chat in app mode on %s routes', async prefix => {
    const f = await fixture();
    const base = f.base.replace('/api/v1', prefix);
    const response = await fetch(base + '/chat/turns', { method: 'POST', headers: f.headers, body: JSON.stringify({ connectionId: f.database.id, question: 'Question' }) });
    expect(response.status).toBe(400);
    expect(f.calls()).toBe(0);
  });

  it('finalizes a failed initial running-state save instead of leaving a nonterminal claim', async () => {
    const f = await fixture();
    vi.spyOn(f.accounts, 'saveTurn').mockImplementationOnce(() => { throw new Error('Synthetic save failure'); });
    const id = await f.submit();
    await vi.waitFor(async () => expect((await f.snapshot(id)).status).toBe('error'));
    expect(f.accounts.getTurn(f.auth.user.id, id)?.status).toBe('error');
    expect(f.accounts.getChat(f.auth.user.id, f.chat.id)?.messages.at(-1)?.turn?.status).toBe('error');
    expect(f.calls()).toBe(0);
  });

  it('aborts active work, commits its terminal state and closes SSE during shutdown', async () => {
    let running = false;
    const model: AgentModelClient = { async *streamChat({ signal }) {
      running = true;
      yield { content: 'Partial answer' };
      await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }); });
      signal?.throwIfAborted();
    } };
    const f = await fixture(false, { shutdownGraceMs: 2000 }, model);
    const id = await f.submit();
    await vi.waitFor(() => expect(running).toBe(true));
    const events = await fetch(f.base + '/chat/turns/' + id + '/events', { headers: f.headers });
    const body = events.text();
    await f.server.close();
    expect(await body).toContain('event: aborted');
    expect(f.accounts.getTurn(f.auth.user.id, id)?.status).toBe('aborted');
    expect(f.accounts.getChat(f.auth.user.id, f.chat.id)?.messages.at(-1)?.turn?.status).toBe('aborted');
  });

  it('stops and finalizes the owner turn before deleting an account', async () => {
    let running = false;
    let exportRunning = false;
    let exportAborted = false;
    const model: AgentModelClient = { async *streamChat({ signal }) {
      running = true;
      yield { content: 'Partial answer' };
      await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }); });
      signal?.throwIfAborted();
    } };
    const f = await fixture(false, { shutdownGraceMs: 2000 }, model);
    const id = await f.submit();
    await vi.waitFor(() => expect(running).toBe(true));
    const job = await f.server.exports.start(f.auth.user.id, f.chat.id, { title: 'Pending export', format: 'json', scope: 'visible' }, async ({ signal }) => {
      exportRunning = true;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { exportAborted = true; resolve(); }, { once: true }));
      signal.throwIfAborted();
    });
    await vi.waitFor(() => expect(exportRunning).toBe(true));
    f.accounts.deleteAccount.mockImplementation(async () => {
      expect(f.accounts.getTurn(f.auth.user.id, id)?.status).toBe('aborted');
      expect(f.accounts.getChat(f.auth.user.id, f.chat.id)?.messages.at(-1)?.turn?.status).toBe('aborted');
      expect(exportAborted).toBe(true);
      expect(f.server.exports.get(f.auth.user.id, job.id)).toBeUndefined();
    });
    const response = await fetch(f.base + '/account', { method: 'DELETE', headers: f.headers, body: JSON.stringify({ password: 'fixture-password' }) });
    expect(response.status).toBe(200);
    expect(f.accounts.deleteAccount).toHaveBeenCalledOnce();
  });
  it('keeps an overlapping worker live, streams its persisted progress remotely and cancels it remotely', async () => {
    let running = false;
    const model: AgentModelClient = { async *streamChat({ signal }) {
      running = true;
      yield { reasoning: 'Remote progress' };
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
      signal?.throwIfAborted();
    } };
    const f = await fixture(false, {}, model);
    const id = await f.submit(); await vi.waitFor(() => expect(running).toBe(true));
    const second = await start(f.accounts, f.model, f.database);
    expect((await f.snapshot(id, second)).status).toBe('running');
    const stream = await fetch(second + '/chat/turns/' + id + '/events', { headers: f.headers });
    const streamed = stream.text();
    await vi.waitFor(() => expect(f.accounts.getTurn(f.auth.user.id, id)?.events.some(event => event.type === 'thinking-delta')).toBe(true), { timeout: 2000 });
    const cancel = await fetch(second + '/chat/turns/' + id + '/abort', { method: 'POST', headers: f.headers });
    expect(cancel.status).toBe(202);
    await vi.waitFor(async () => expect((await f.snapshot(id, second)).status).toBe('aborted'));
    const text = await streamed;
    expect(text).toContain('Remote progress'); expect(text).toContain('event: aborted'); expect(text).not.toContain('event: complete');
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
    expect(ids).toEqual([...new Set(ids)].sort((a,b) => a-b));
    const replay = await fetch(f.base + '/chat/turns/' + id + '/events', { headers: { ...f.headers, 'last-event-id': String(ids.at(-2)) } });
    const replayed = await replay.text();
    expect([...replayed.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]))).toEqual([ids.at(-1)]);
  });

  it('enforces accepted-turn capacity across overlapping workers', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const model: AgentModelClient = { async *streamChat() { await gate; yield { content: 'Finished' }; } };
    const f = await fixture(false, { maxActiveTurnsPerUser: 1 }, model);
    const id = await f.submit();
    const second = await start(f.accounts, f.model, f.database, { maxActiveTurnsPerUser: 1 });
    const otherChat = f.accounts.createChat(f.auth.user.id, f.database.id);
    const response = await fetch(second + '/chat/turns', { method: 'POST', headers: f.headers,
      body: JSON.stringify({ ...f.body, chatId: otherChat.id, clientRequestId: 'second', userMessageId: 'second-user', assistantMessageId: 'second-answer' }) });
    expect(response.status).toBe(429);
    const retry = await fetch(second + '/chat/turns', { method: 'POST', headers: f.headers, body: JSON.stringify(f.body) });
    expect(await retry.json()).toEqual({ turnId: id });
    release(); await vi.waitFor(async () => expect((await f.snapshot(id)).status).toBe('complete'));
  });

  it('marks health unavailable and stops model work when worker coordination fails', async () => {
    let aborted = false;
    const model: AgentModelClient = { async *streamChat({ signal }) {
      yield { content: 'Partial' };
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      signal?.throwIfAborted();
    } };
    const f = await fixture(false, {}, model); await f.submit();
    vi.spyOn(f.accounts, 'heartbeatWorker').mockImplementation(() => { throw new Error('Coordination unavailable'); });
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect((await fetch(f.base + '/health')).status).toBe(503);
    expect((await fetch(f.base + '/chat/turns', { method: 'POST', headers: f.headers, body: JSON.stringify(f.body) })).status).toBe(503);
  });

  it('never reports completion when terminal storage rejects it', async () => {
    const f = await fixture();
    vi.spyOn(f.accounts, 'finalizeTurn').mockRejectedValue(new Error('Fenced worker'));
    const id = await f.submit();
    await vi.waitFor(() => expect(f.accounts.finalizeTurn).toHaveBeenCalled());
    expect((await f.snapshot(id)).status).not.toBe('complete');
    expect(f.accounts.getChat(f.auth.user.id, f.chat.id)?.messages).toHaveLength(1);
    expect((await f.snapshot(id)).events.some(event => event.type === 'complete')).toBe(false);
  });
});
