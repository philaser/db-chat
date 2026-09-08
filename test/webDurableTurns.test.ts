import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { AccountStore } from '../src/server/accountStore';
import { WebServer } from '../src/server/server';
import { loadWebServerConfig } from '../src/server/config';
import type { ChatMessage, ConnectionConfig, DatabaseConnector, QueryResultArtifact } from '../src/shared/types';
import type { WebTurnSnapshot } from '../src/server/types';
import type { AgentModelClient } from '../src/server/agent/types';
class DurableAccounts extends AccountStore {
  finalizeGate?: Promise<void>;
  finalizeStarted = false;
  interruptPendingTurns = vi.fn(() => super.interruptPendingTurns());
  async finalizeTurn(owner: string, snapshot: WebTurnSnapshot, message?: ChatMessage, artifacts: QueryResultArtifact[] = []) {
    this.finalizeStarted = true;
    await this.finalizeGate;
    super.finalizeTurn(owner, snapshot, message, artifacts);
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
  async function start(accounts: DurableAccounts, model: AgentModelClient, database?: ConnectionConfig) {
    const config={...loadWebServerConfig({DBCHAT_WEB_AUTH_MODE:'app'}),port:0,database,sqliteUploadDir:undefined,openRouterApiKey:'fixture-only-key'};
    const server=new WebServer(config,{accounts,modelClient:model,connector}); servers.push(server);
    const node=await server.listen(); return `http://127.0.0.1:${(node.address() as AddressInfo).port}/api/v1`;
  }
  async function fixture(fail=false) {
    const accounts=new DurableAccounts({defaultModel:'fixture',sessionTtlMs:60000,secretKey:'fixture'});
    const auth=accounts.signup('person@example.test','fixture-password');
    const connection=accounts.createConnection(auth.user.id,{id:'',kind:'sqlite',label:'Fixture',databasePath:'/tmp/disposable-fixture.db',createdAt:''},{ok:true,tableCount:1});
    const chat=accounts.createChat(auth.user.id,connection.id); let calls=0;
    const model: AgentModelClient={async *streamChat() {calls++; if(fail) throw new Error('Synthetic model failure'); yield {content:'An answer'};}};
    const database=accounts.getConnectionConfig(auth.user.id,connection.id)!;
    const base=await start(accounts,model,database);
    // Cookie name is discovered from the real login endpoint, not coupled to implementation constants.
    const login=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'person@example.test',password:'fixture-password'})});
    const cookie=login.headers.get('set-cookie')!.split(';')[0];
    const headers={'content-type':'application/json',cookie};
    const body={chatId:chat.id,connectionId:connection.id,clientRequestId:'request-one',userMessageId:'user-one',assistantMessageId:'assistant-one',messages:[{role:'user',content:'Question'}]};
    const submit=async()=>{ const response=await fetch(base+'/chat/turns',{method:'POST',headers,body:JSON.stringify(body)}); expect(response.status).toBe(202); return (await response.json()).turnId as string; };
    const snapshot=async(id:string,newBase=base)=>(await fetch(newBase+'/chat/turns/'+id,{headers})).json() as Promise<WebTurnSnapshot>;
    return {accounts,auth,chat,base,model,database,headers,submit,snapshot,calls:()=>calls};
  }
  it('does not publish completion until the terminal message has been saved',async()=>{
    const f=await fixture(); let release!:()=>void;
    f.accounts.finalizeGate=new Promise<void>(resolve=>{release=resolve;});
    const id=await f.submit(); await vi.waitFor(()=>expect(f.accounts.finalizeStarted).toBe(true));
    expect((await f.snapshot(id)).status).toBe('running');
    expect(f.accounts.getChat(f.auth.user.id,f.chat.id)?.messages).toHaveLength(1);
    const cancellation = await fetch(f.base+'/chat/turns/'+id+'/abort', {method:'POST',headers:f.headers});
    expect(cancellation.status).toBe(202);
    release(); await vi.waitFor(async()=>expect((await f.snapshot(id)).status).toBe('complete'));
    expect((await f.snapshot(id)).events.at(-1)?.type).toBe('complete');
    expect(f.accounts.getChat(f.auth.user.id,f.chat.id)?.messages.at(-1)?.id).toBe('assistant-one');
  });
  it('retries the same request without invoking the model again',async()=>{
    const f=await fixture(); const id=await f.submit(); await vi.waitFor(async()=>expect((await f.snapshot(id)).status).toBe('complete'));
    expect(await f.submit()).toBe(id); expect(f.calls()).toBe(1);
    expect(f.accounts.getChat(f.auth.user.id,f.chat.id)?.messages).toHaveLength(2);
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
    expect(f.accounts.interruptPendingTurns).toHaveBeenCalledTimes(2); expect(f.calls()).toBe(1);
  });
});
