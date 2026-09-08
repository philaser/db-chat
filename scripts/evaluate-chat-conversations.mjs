import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { SYNTHETIC_SQL } from '../evals/chat/fixture.mjs';

const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const root = path.resolve(option('--server-root', 'dist-web-server'));
const requestedModel = option('--model', process.env.DBCHAT_WEB_MODEL);
const effort = option('--effort', 'low');
const wideSchema = args.includes('--wide-schema');
if (!['none', 'low', 'medium', 'high', 'max'].includes(effort)) throw new Error('Invalid effort.');
if (!process.env.DBCHAT_WEB_OPENROUTER_API_KEY) throw new Error('The configured model key is required; only synthetic data is sent.');
const { WebAgentService } = await import(pathToFileURL(path.join(root, 'server/webAgentService.js')));
const { loadWebServerConfig } = await import(pathToFileURL(path.join(root, 'server/config.js')));
const model = requestedModel || loadWebServerConfig({}).model;
const { SQLiteConnector } = await import(pathToFileURL(path.join(root, 'server/connectors/SqliteConnector.js')));
const { conversationContext } = await import(pathToFileURL(path.join(root, 'server/conversationContext.js')));
const work = await mkdtemp(path.join(tmpdir(), 'dbchat-conversation-eval-'));
const dbPath = path.join(work, 'synthetic.sqlite');
const db = new Database(dbPath);
db.exec(SYNTHETIC_SQL);
if (wideSchema) for (let index = 0; index < 60; index++) db.exec(`CREATE TABLE archive_${String(index).padStart(2, '0')}(id INTEGER, note TEXT)`);
db.close();
const database = { id: 'conversation-synthetic', kind: 'sqlite', label: 'Synthetic evaluation', databasePath: dbPath, createdAt: new Date().toISOString() };
const service = new WebAgentService({ ...loadWebServerConfig({}), database, model, openRouterApiKey: process.env.DBCHAT_WEB_OPENROUTER_API_KEY }, { connector: new SQLiteConnector() });
const chat = { id: 'synthetic-chat', title: 'Conversation evaluation', messages: [], artifacts: [] };
const runs = [];
const output = path.resolve(option('--output', 'audit-output/conversation-eval.json'));
const scalar = (artifacts, expected) => artifacts.find(artifact => artifact.result.rows.some(row => Object.values(row).some(value => value !== null && value !== '' && Number(value) === expected)));
const log = console.log;
console.log = (...values) => { if (!String(values[0]).includes('"type":"dbchat.audit"')) log(...values); };
async function record(spec) {
  const turnId = `conversation-${spec.id}`;
  const started = performance.now();
  const toolNames = [];
  const messages = conversationContext(chat, spec.question, spec.intent);
  try {
    const result = await service.run(messages, turnId, event => {
      if (event.type === 'tool-start') toolNames.push(event.data.name ?? event.data.toolName);
    }, undefined, database, undefined, model, effort, { referencedArtifacts: chat.artifacts });
    const numericPass = spec.expected === undefined || Boolean(scalar(result.artifacts, spec.expected));
    const statementPass = !spec.statement || spec.statement.test(result.message.content);
    const reusePass = !spec.noQuery || !toolNames.some(name => ['run_database_query', 'sample_data'].includes(name));
    const pass = numericPass && statementPass && reusePass && result.metrics?.terminalReason === 'completed';
    runs.push({ id: spec.id, pass, checks: { numericPass, statementPass, reusePass }, sourceMessageCount: chat.messages.length, sentMessageCount: messages.length, sentCharacters: messages.reduce((sum, item) => sum + item.content.length, 0), elapsedMs: Math.round(performance.now() - started), toolNames, answer: result.message.content, artifacts: result.artifacts, metrics: result.metrics });
    chat.messages.push({ id: `${turnId}-question`, role: 'user', content: spec.question, createdAt: new Date().toISOString() }, result.message);
    chat.artifacts.push(...result.artifacts);
    log(`${spec.id}: ${pass ? 'PASS' : 'FAIL'} (${runs.at(-1).elapsedMs}ms)`);
    return result;
  } catch (error) {
    runs.push({ id: spec.id, pass: false, error: error instanceof Error ? error.message : String(error), elapsedMs: Math.round(performance.now() - started) });
    log(`${spec.id}: FAIL`);
  }
}
try {
  await service.initialize();
  await record({ id: 'gross', question: 'What is gross revenue across all orders? Define gross revenue as SUM(amount), including canceled orders. Return one total.', expected: 710 });
  const corrected = await record({ id: 'correction', question: 'Correction: from now on revenue means amount minus refund for completed orders only. What is the corrected total across all customers?', expected: 610 });
  await record({ id: 'filter', question: 'Using that corrected revenue definition, include only customers in Ghana. What is their total?', expected: 520 });
  const target = corrected && scalar(corrected.artifacts, 610);
  if (target) await record({ id: 'older-result', question: 'Explain the calculation behind this saved answer, retaining its scope. Do not rerun the database.', intent: { action: 'explain', artifactId: target.queryId, messageId: corrected.message.id }, noQuery: true, statement: /\b610\b/ });
  else runs.push({ id: 'older-result', pass: false, error: 'The preceding corrected answer did not produce the required evidence.' });
  for (let index = 0; index < 500; index++) chat.messages.push(
    { id: `history-q-${index}`, role: 'user', content: 'Continue.', createdAt: new Date().toISOString() },
    { id: `history-a-${index}`, role: 'assistant', content: 'Noted.', createdAt: new Date().toISOString() }
  );
  await record({ id: 'long-history', question: 'Using the corrected revenue definition, give the total across all customers again.', expected: 610 });
  await record({ id: 'missing-date', question: 'For legacy_orders only, compare revenue last month versus the month before. Do not infer a date from another table.', statement: /(?:no|missing|lack|without|not|cannot|unable|unavailable)[\s\S]{0,180}(?:date|time|month)|(?:date|time)[\s\S]{0,100}(?:missing|absent|available|exist)/i });
} finally {
  service.close();
  console.log = log;
  await rm(work, { recursive: true, force: true });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ model, effort, wideSchema, createdAt: new Date().toISOString(), scope: 'Real model with synthetic SQLite and production server context builder. Automatic checks plus manual narrative review required. Filler history tests retention, not production load. Wide-schema mode places the analytical tables outside the initial 40-table prompt.', summary: { passed: runs.filter(run => run.pass).length, total: runs.length }, runs }, null, 2) + '\n');
  log(output);
}
if (runs.some(run => !run.pass)) process.exitCode = 1;
