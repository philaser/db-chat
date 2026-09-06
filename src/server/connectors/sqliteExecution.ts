import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import type { QueryResult } from '../../shared/types.js';

const databaseModule = createRequire(import.meta.url).resolve('better-sqlite3');
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

// A process boundary is intentional: terminating a JS worker does not reliably
// interrupt a native SQLite call. OS termination also releases SQLite locks.
const childProgram = String.raw`
const { readFileSync } = require('node:fs');
const input = JSON.parse(readFileSync(0, 'utf8'));
const Database = require(input.databaseModule);
let db;
try {
  db = new Database(input.databasePath, { fileMustExist: true, readonly: input.readonly });
  const statement = db.prepare(input.query);
  if (input.readonly && !statement.readonly) throw new Error('Safe mode requires a read-only SQLite statement.');
  const rows = [];
  let bytes = 0;
  if (statement.reader) {
    for (const row of statement.iterate()) {
      bytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
      if (bytes > input.maxBytes) throw new Error('The query result is too large. Select fewer or smaller columns.');
      rows.push(row);
      if (rows.length > input.maxRows) break;
    }
  } else {
    const result = statement.run();
    rows.push({ changes: result.changes, lastInsertRowid: String(result.lastInsertRowid) });
  }
  const columns = statement.reader ? statement.columns().map(column => column.name) : Object.keys(rows[0]);
  process.stdout.write(JSON.stringify({ ok: true, columns, rows }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
} finally { if (db) db.close(); }
`;

export class SQLiteExecution {
  private readonly active = new Set<ChildProcessWithoutNullStreams>();

  execute(databasePath: string, query: string, readonly: boolean, maxRows: number, timeoutMs: number, signal?: AbortSignal): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const start = performance.now();
      const child = spawn(process.execPath, ['-e', childProgram], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      this.active.add(child);
      let output = '';
      let stderr = '';
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        child.kill('SIGKILL');
        reject(error);
      };
      const abort = () => fail(new DOMException('SQLite query was cancelled.', 'AbortError'));
      const timer = setTimeout(() => fail(new Error(`SQLite query exceeded its ${timeoutMs} ms deadline and was stopped.`)), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES + 65536) fail(new Error('SQLite result exceeded the output budget.'));
      });
      child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString('utf8'); });
      child.on('close', (_code, exitSignal) => {
        this.active.delete(child);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (settled) return;
        settled = true;
        if (exitSignal) { reject(new Error('SQLite query was stopped.')); return; }
        try {
          const result = JSON.parse(output) as { ok: boolean; error?: string; columns: string[]; rows: Record<string, unknown>[] };
          if (!result.ok) { reject(new Error(result.error ?? 'SQLite query failed.')); return; }
          resolve({ columns: result.columns, rows: result.rows, rowCount: result.rows.length, elapsedMs: Math.round(performance.now() - start) });
        } catch { reject(new Error(`SQLite query process failed${stderr ? `: ${stderr.trim()}` : '.'}`)); }
      });
      child.stdin.end(JSON.stringify({ databaseModule, databasePath, query, readonly, maxRows, maxBytes: MAX_OUTPUT_BYTES }));
    });
  }

  close(): void {
    for (const child of this.active) child.kill('SIGKILL');
  }
}
