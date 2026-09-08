import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { AccountStore } from '../src/server/accountStore';
import { WebServer } from '../src/server/server';
import { loadWebServerConfig } from '../src/server/config';
import type { QueryResultArtifact } from '../src/shared/types';
import type { AgentModelClient } from '../src/server/agent/types';

const servers: WebServer[] = [], folders: string[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); await Promise.all(folders.splice(0).map(folder => fs.rm(folder, {recursive:true,force:true}))); });
async function fixture(maxRows = 1_000_000, model?: AgentModelClient) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'dbchat-export-test-')); folders.push(folder);
  const file = path.join(folder, 'source.sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE orders (id INTEGER, amount INTEGER, note TEXT)');
  const insert = db.prepare('INSERT INTO orders VALUES (?, ?, ?)');
  db.transaction(() => { for (let id = 1; id <= 1205; id++) insert.run(id, id * 10, id === 1 ? '=1+1' : 'row ' + id); })(); db.close();
  const accounts = new AccountStore({defaultModel:'fixture',sessionTtlMs:60000,secretKey:'fixture'});
  const owner = accounts.signup('owner@example.test', 'fixture-password');
  accounts.signup('other@example.test', 'fixture-password');
  const connection = accounts.createConnection(owner.user.id, { id:'',kind:'sqlite',label:'Orders',databasePath:file,createdAt:'' }, {ok:true,tableCount:1});
  const chat = accounts.createChat(owner.user.id, connection.id);
  const artifact: QueryResultArtifact = {kind:'query-result',queryId:'saved',query:'SELECT * FROM orders ORDER BY id',purpose:'Orders',source:{connectionId:connection.id,label:'Orders',kind:'sqlite',capturedAt:new Date().toISOString()},result:{columns:['id','amount','note'],rows:[{id:1,amount:10,note:'=1+1'},{id:2,amount:20,note:'row 2'}],rowCount:2,truncated:true,rowLimit:100,elapsedMs:1}};
  accounts.updateChat(owner.user.id, chat.id, { artifacts:[artifact] });
  const server = new WebServer({...loadWebServerConfig({DBCHAT_WEB_AUTH_MODE:'app'}),port:0,exportMaxRows:maxRows,sqliteUploadDir:undefined,openRouterApiKey:'fixture-only-key'}, {accounts, modelClient:model}); servers.push(server);
  const node = await server.listen(); const base = `http://127.0.0.1:${(node.address() as AddressInfo).port}/api/v1`;
  async function login(email: string) { const response = await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'fixture-password'})}); return {'content-type':'application/json',cookie:response.headers.get('set-cookie')!.split(';')[0]}; }
  const headers = await login('owner@example.test'), other = await login('other@example.test');
  async function start(body: unknown, useHeaders=headers) { return fetch(base+'/chats/'+chat.id+'/exports',{method:'POST',headers:useHeaders,body:JSON.stringify(body)}); }
  async function complete(id:string) { let job:any; await vi.waitFor(async()=>{ job=(await (await fetch(base+'/exports/'+id,{headers})).json()).export; expect(['ready','error','cancelled']).toContain(job.status); }); return job; }
  return {server,accounts,owner,connection,chat,artifact,base,headers,other,start,complete};
}

describe('owned export HTTP flow', () => {
  it('exports all 1205 source rows, beyond the preview and old 1000 cap; isolates status and downloads', async () => {
    const f=await fixture();
    const response=await f.start({resultId:'saved',format:'json',scope:'all'}); expect(response.status).toBe(202);
    const job=await f.complete((await response.json()).export.id); expect(job).toMatchObject({status:'ready',rowCount:1205});
    const download=await fetch(f.base+'/exports/'+job.id+'/download',{headers:f.headers});
    expect(download.headers.get('content-disposition')).toContain('attachment');
    const rows=await download.json(); expect(rows).toHaveLength(1205); expect(rows.at(-1).id).toBe(1205);
    for (const route of ['', '/download']) expect((await fetch(f.base+'/exports/'+job.id+route,{headers:f.other})).status).toBe(404);
    expect((await f.start({resultId:'saved',format:'json',scope:'all'}, f.other)).status).toBe(404);
    expect((await fetch(f.base+'/exports/'+job.id)).status).toBe(401);
  });
  it('downloads a real Excel workbook containing every matching row', async () => {
    const f=await fixture();
    const response=await f.start({resultId:'saved',format:'xlsx',scope:'all'});
    const job=await f.complete((await response.json()).export.id); expect(job.status).toBe('ready');
    const download=await fetch(f.base+'/exports/'+job.id+'/download',{headers:f.headers});
    const book=new ExcelJS.Workbook(); await book.xlsx.load(await download.arrayBuffer());
    const sheet=book.worksheets[0]; expect(sheet.rowCount).toBe(1206); expect(sheet.getCell('A1206').value).toBe(1205); expect(sheet.getCell('C2').value).toBe('=1+1');
  });
  it('exports only the requested visible rows, order and columns, without requerying', async () => {
    const f=await fixture();
    const response=await f.start({resultId:'saved',format:'csv',scope:'visible',columns:['note','id'],rowIndices:[1,0]});
    const job=await f.complete((await response.json()).export.id);
    const csv=await (await fetch(f.base+'/exports/'+job.id+'/download',{headers:f.headers})).text();
    expect(csv).toBe('"note","id"\r\n"row 2","2"\r\n"\'=1+1","1"\r\n');
    for (const body of [{columns:['missing']},{rowIndices:[999]},{rowIndices:[0,0]},{columns:['id','id']}]) expect((await f.start({resultId:'saved',format:'json',scope:'visible',...body})).status).toBe(400);
  });
  it('preserves explicit query LIMIT and refuses incomplete full downloads', async () => {
    const f=await fixture(100);
    f.accounts.updateChat(f.owner.user.id,f.chat.id,{artifacts:[{...f.artifact,query:'SELECT * FROM orders ORDER BY id LIMIT 3'}]});
    const limited=await f.start({resultId:'saved',format:'json',scope:'all'}); const small=await f.complete((await limited.json()).export.id); expect(small.rowCount).toBe(3);
    f.accounts.updateChat(f.owner.user.id,f.chat.id,{artifacts:[f.artifact]});
    const response=await f.start({resultId:'saved',format:'json',scope:'all'}); const job=await f.complete((await response.json()).export.id);
    expect(job.status).toBe('error'); expect(job.error).toContain('row limit'); expect(job.downloadUrl).toBeUndefined();
    expect((await fetch(f.base+'/exports/'+job.id+'/download',{headers:f.headers})).status).toBe(409);
  });
  it('rejects writes, mismatched source, arbitrary result IDs and local filters on full exports', async () => {
    const f=await fixture();
    for (const artifact of [{...f.artifact,query:'DELETE FROM orders'}, {...f.artifact,source:{...f.artifact.source!,connectionId:'foreign'}}]) {
      f.accounts.updateChat(f.owner.user.id,f.chat.id,{artifacts:[artifact]});
      expect((await f.start({resultId:'saved',format:'json',scope:'all'})).status).toBe(400);
    }
    expect((await f.start({resultId:'unknown',format:'json',scope:'all'})).status).toBe(404);
    expect((await f.start({resultId:'saved',format:'json',scope:'all',columns:['id']})).status).toBe(400);
  });
  it('generates a downloadable final report with owned evidence through the chat tool', async () => {
    const model:AgentModelClient={async *streamChat(){ yield {toolCalls:[{index:0,id:'report-tool',type:'function',function:{name:'create_report',arguments:JSON.stringify({title:'Orders report',finalize:true,blocks:[{type:'takeaway',text:'This is a saved two-row preview, not the full order population.'},{type:'text',text:'Amounts are recorded units; the time period is unspecified. Do not infer total revenue from this preview.'},{type:'table',resultId:'saved'}]})}}],finishReason:'tool_calls'}; }};
    const f=await fixture(1_000_000,model);
    const submit=await fetch(f.base+'/chat/turns',{method:'POST',headers:f.headers,body:JSON.stringify({chatId:f.chat.id,connectionId:f.connection.id,clientRequestId:'report-turn',userMessageId:'user-report',assistantMessageId:'assistant-report',messages:[{role:'user',content:'Generate a detailed report about these orders with the data.'}]})});
    expect(submit.status).toBe(202); const {turnId}=await submit.json();
    await vi.waitFor(async()=>{ const turn=await (await fetch(f.base+'/chat/turns/'+turnId,{headers:f.headers})).json(); expect(turn.status).toBe('complete'); });
    const content=f.accounts.getChat(f.owner.user.id,f.chat.id)!.messages.at(-1)!.content;
    const id=content.match(/"exportId":"([a-f0-9-]+)"/)![1];
    const job=await f.complete(id); expect(job).toMatchObject({status:'ready',format:'html'});
    const html=await (await fetch(f.base+'/exports/'+id+'/download',{headers:f.headers})).text();
    expect(html).toContain('Orders report'); expect(html).toContain('Sources and query evidence'); expect(html).toContain('SELECT * FROM orders ORDER BY id'); expect(html).toContain('Limited preview'); expect(html).toContain('<table>');
    const listing=await (await fetch(f.base+'/chats/'+f.chat.id+'/exports',{headers:f.headers})).json(); expect(listing.exports.map((job:any)=>job.id)).toContain(id);
    expect((await fetch(f.base+'/exports/'+id,{method:'DELETE',headers:f.headers})).status).toBe(200);
    expect((await fetch(f.base+'/exports/'+id+'/download',{headers:f.headers})).status).toBe(404);
  });
  it('runs the export_data chat tool and persists its downloadable artifact', async () => {
    let round=0;
    const model:AgentModelClient={async *streamChat(){ if(round++===0) yield {toolCalls:[{index:0,id:'export-tool',type:'function',function:{name:'export_data',arguments:JSON.stringify({resultId:'saved',format:'json',title:'All orders'})}}],finishReason:'tool_calls'}; else yield {content:'Your download is being prepared.'}; }};
    const f=await fixture(1_000_000,model);
    const submit=await fetch(f.base+'/chat/turns',{method:'POST',headers:f.headers,body:JSON.stringify({chatId:f.chat.id,connectionId:f.connection.id,clientRequestId:'export-turn',userMessageId:'user-export',assistantMessageId:'assistant-export',messages:[{role:'user',content:'I want all the matching data in JSON.'}]})});
    expect(submit.status).toBe(202); const {turnId}=await submit.json(); let turn:any;
    await vi.waitFor(async()=>{ turn=await (await fetch(f.base+'/chat/turns/'+turnId,{headers:f.headers})).json(); expect(turn.status).toBe('complete'); });
    const content=f.accounts.getChat(f.owner.user.id,f.chat.id)!.messages.at(-1)!.content;
    expect(content).toContain('"type":"download"');
    const id=content.match(/"exportId":"([a-f0-9-]+)"/)![1];
    expect(await f.complete(id)).toMatchObject({status:'ready',rowCount:1205});
  });
});
