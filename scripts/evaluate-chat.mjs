import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { SYNTHETIC_SQL } from '../evals/chat/fixture.mjs';
import { findMatchingNumericArtifact } from '../evals/chat/scoring.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const live = args.includes('--live');
const effort = option('--effort', undefined);
if (effort && !['none', 'low', 'medium', 'high', 'max'].includes(effort)) throw new Error('Invalid --effort value.');
const root = path.resolve(option('--server-root', 'dist-web-server'));
const { WebAgentService } = await import(pathToFileURL(path.join(root, 'server/webAgentService.js')));
const { loadWebServerConfig } = await import(pathToFileURL(path.join(root, 'server/config.js')));
const { SQLiteConnector } = await import(pathToFileURL(path.join(root, 'server/connectors/SqliteConnector.js')));
const cases = JSON.parse(await readFile(new URL('../evals/chat/cases.json', import.meta.url), 'utf8'));
const filter = option('--cases', '').split(',').filter(Boolean);
const limit = Number(option('--limit', live ? '6' : String(cases.length)));
const repeats = Math.min(5, Math.max(1, Number(option('--repeats', '1'))));
const selected = cases.filter(item => !filter.length || filter.includes(item.id)).slice(0, limit);
if (live && !process.env.DBCHAT_WEB_OPENROUTER_API_KEY) throw new Error('Live evaluation requires DBCHAT_WEB_OPENROUTER_API_KEY in the environment.');
const work = await mkdtemp(path.join(tmpdir(), 'dbchat-eval-'));
const dbPath = path.join(work, 'synthetic.sqlite');
const db = new Database(dbPath);
db.exec(SYNTHETIC_SQL);
db.close();
const database = { id: 'eval-synthetic', kind: 'sqlite', label: 'Synthetic evaluation', databasePath: dbPath, createdAt: new Date().toISOString() };
const defaults = loadWebServerConfig({});
const config = { ...defaults, database, maxResultRows: 100, model: option('--model', process.env.DBCHAT_WEB_MODEL || defaults.model), openRouterApiKey: live ? process.env.DBCHAT_WEB_OPENROUTER_API_KEY : undefined };
const runs = [];
const originalLog = console.log;
console.log = (...values) => { if (!String(values[0]).includes('"type":"dbchat.audit"')) originalLog(...values); };
try {
  for (const item of selected) for (let repeat = 1; repeat <= repeats; repeat++) {
    if (!live && !item.sql) { runs.push({ id:item.id,repeat,skipped:'Semantic behavior requires --live; not a deterministic tool test.' }); continue; }
    let round = 0;
    const scripted = { async *streamChat(options) {
      if (round++ === 0) yield { toolCalls: [{ index:0,id:'query-call',function:{name:'run_database_query',arguments:JSON.stringify({query:item.sql,purpose:item.question})} }] };
      else yield { content:'The requested query evidence is available. This scripted response does not evaluate model reasoning.' };
    } };
    const service = new WebAgentService(config, { connector: new SQLiteConnector(), ...(live ? {} : { modelClient: scripted }) });
    const started = performance.now(); let firstUsefulMs; const toolNames = [];
    try {
      await service.initialize();
      const result = await service.run([{role:'user',content:item.question}],`eval-${item.id}-${repeat}`, event => {
        if (firstUsefulMs===undefined && (event.type==='text-delta'||event.type==='result')) firstUsefulMs=performance.now()-started;
        if (event.type==='tool-start') toolNames.push(event.data.name ?? event.data.toolName ?? 'unknown');
      }, undefined, database, undefined, undefined, effort);
      const artifacts = result.artifacts;
      const matching = findMatchingNumericArtifact(item, artifacts);
      const numericPass = item.expected || item.expectedRows!==undefined ? Boolean(matching) : true;
      const statementPass = !item.statement || new RegExp(item.statement,'is').test(result.message.content);
      const truncationPass = !item.truncated || matching?.result.truncated===true;
      const structuredBlocks=[...result.message.content.matchAll(/```(?:chart|blocks)\s*\n([\s\S]*?)```/g)].flatMap(match=>{try {const value=JSON.parse(match[1]);return Array.isArray(value)?value:[value];}catch{return [];}});
      const chartBlocks=structuredBlocks.filter(block=>block.chartType||block.type==='chart');
      const chartPass = !item.chart || chartBlocks.some(chart=>chart.rows?.length===item.expectedRows);
      const reportPass = !item.report || (toolNames.includes('create_report') && structuredBlocks.some(block=>block.type==='kpi'&&Number(block.value)===item.expectedKpi) && structuredBlocks.some(block=>block.type==='table'&&block.rows?.length>0) && chartBlocks.some(block=>block.rows?.length>0));
      const narrativeWords=result.message.content.replace(/```[\s\S]*?```/g,'').trim().split(/\s+/).filter(Boolean).length;
      const stylePass=!live || ((!item.forbiddenStatement || !new RegExp(item.forbiddenStatement,'i').test(result.message.content)) && (!item.maxNarrativeWords || narrativeWords<=item.maxNarrativeWords));
      runs.push({id:item.id,repeat,pass:numericPass&&statementPass&&truncationPass&&chartPass&&reportPass&&stylePass,checks:{numericPass,statementPass,truncationPass,chartPass,reportPass,stylePass},narrativeWords,elapsedMs:Math.round(performance.now()-started),firstUsefulMs:firstUsefulMs===undefined?null:Math.round(firstUsefulMs),toolCalls:toolNames.length,toolNames,answer:result.message.content,artifacts,metrics:result.metrics??result.message.metrics,requiresNarrativeReview:live});
    } catch(error) { runs.push({id:item.id,repeat,pass:false,error:error instanceof Error?error.message:String(error),elapsedMs:Math.round(performance.now()-started)}); }
    finally { service.close(); }
    originalLog(`${item.id} ${repeat}: ${runs.at(-1).pass?'PASS':'FAIL'} (${runs.at(-1).elapsedMs}ms)`);
  }
} finally { console.log=originalLog; await rm(work,{recursive:true,force:true}); }
const graded=runs.filter(run=>!run.skipped);
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)]:null;
const report={mode:live?'live-model':'scripted-tool-contracts',model:live?config.model:'scripted',effort:effort??'provider-default',createdAt:new Date().toISOString(),scope:'Synthetic SQLite only. Numeric/result checks are automated; live narrative/coherence needs human review. Scripted tests do not measure model quality.',summary:{passed:graded.filter(run=>run.pass).length,total:graded.length,skipped:runs.length-graded.length,p50Ms:percentile(graded.map(run=>run.elapsedMs),.5),p95Ms:percentile(graded.map(run=>run.elapsedMs),.95)},runs};
const output=path.resolve(option('--output',path.join('audit-output','chat-eval-'+(live?'live':'contracts')+'.json')));
await mkdir(path.dirname(output),{recursive:true}); await writeFile(output,JSON.stringify(report,null,2)+'\n');
originalLog(JSON.stringify(report.summary)); originalLog(output);
if (graded.some(run=>!run.pass)) process.exitCode=1;
