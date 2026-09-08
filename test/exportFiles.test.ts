import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryResult } from '../src/shared/types.js';
import { writeDataExport } from '../src/server/exports/dataExport.js';
import { buildReportDownload } from '../src/server/exports/reportExport.js';
import { ExportJobs, type ExportRun } from '../src/server/exports/exportJobs.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function destination(extension: string): Promise<{ filename: string; context: ExportRun }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dbchat-export-test-'));
  directories.push(directory);
  const filename = path.join(directory, `result.${extension}`);
  return {
    filename,
    context: {
      filename,
      signal: new AbortController().signal,
      limits: { maxRows: 100, maxBytes: 1024 * 1024, timeoutMs: 10_000, ttlMs: 10_000 },
      progress: () => undefined
    }
  };
}

async function* batches(): AsyncIterable<QueryResult> {
  yield {
    columns: ['name', 'details', 'amount'],
    rows: [
      { name: '=2+2', details: { nested: ['a', { exact: 2 }], enabled: true }, amount: 12.5 },
      { name: '  -1+1', details: { note: '"quoted"' }, amount: null }
    ],
    rowCount: 2,
    elapsedMs: 1
  };
}

describe('export file generation', () => {
  it('limits jobs to one per owner, lists only owned chat jobs, and cancels queued work without running it', async () => {
    const jobs = new ExportJobs({ maxRows: 10, maxBytes: 1024, timeoutMs: 10_000, ttlMs: 10_000 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = jobs.start('owner-a', 'chat-a', { title: 'First', format: 'csv', scope: 'all' }, async context => {
      await firstGate; await writeFile(context.filename, 'ready');
    });
    let queuedRan = false;
    const queued = jobs.start('owner-a', 'chat-a', { title: 'Queued', format: 'json', scope: 'all' }, async context => {
      queuedRan = true; await writeFile(context.filename, '[]');
    });
    const other = jobs.start('owner-b', 'chat-b', { title: 'Other', format: 'csv', scope: 'all' }, async context => {
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    expect(jobs.get('owner-a', first.id)?.status).toBe('running');
    expect(jobs.get('owner-a', queued.id)?.status).toBe('queued');
    expect(jobs.get('owner-b', other.id)?.status).toBe('running');
    expect(jobs.list('owner-a', 'chat-a').map(job => job.id)).toEqual(expect.arrayContaining([first.id, queued.id]));
    expect(jobs.list('owner-b', 'chat-a')).toEqual([]);
    expect((await jobs.cancel('owner-a', queued.id))?.status).toBe('cancelled');
    expect(queuedRan).toBe(false);
    releaseFirst();
    await jobs.cancel('owner-b', other.id);
    await jobs.close();
  });

  it('preserves nested JSON values and neutralizes CSV spreadsheet formulas', async () => {
    const json = await destination('json');
    await writeDataExport('json', batches(), json.context);
    expect(JSON.parse(await readFile(json.filename, 'utf8'))).toEqual([
      { name: '=2+2', details: { nested: ['a', { exact: 2 }], enabled: true }, amount: 12.5 },
      { name: '  -1+1', details: { note: '"quoted"' }, amount: null }
    ]);

    const csv = await destination('csv');
    await writeDataExport('csv', batches(), csv.context);
    const text = await readFile(csv.filename, 'utf8');
    expect(text).toContain('"\'=2+2"');
    expect(text).toContain('"\'  -1+1"');
    expect(text).toContain('"{""nested"":[""a"",{""exact"":2}],""enabled"":true}"');
  });

  it('writes a readable streaming XLSX with plain text formulas and serialized objects', async () => {
    const xlsx = await destination('xlsx');
    await writeDataExport('xlsx', batches(), xlsx.context);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsx.filename);
    const sheet = workbook.getWorksheet('Data')!;
    expect(sheet.getRow(1).values).toEqual([undefined, 'name', 'details', 'amount']);
    expect(sheet.getCell('A2').value).toBe('=2+2');
    expect(sheet.getCell('B2').value).toBe('{"nested":["a",{"exact":2}],"enabled":true}');
    expect(sheet.getCell('C2').value).toBe(12.5);
  });

  it('round-trips OOXML-sensitive text without treating formulas as executable', async () => {
    const xlsx = await destination('xlsx');
    async function* sensitive(): AsyncIterable<QueryResult> {
      yield { columns: ['value'], rows: [
        { value: '=SUM(1,2)' },
        { value: 'ampersand & <tag> "quote"\nnext\rline 😀' },
        { value: 'literal _x0041_' }
      ], rowCount: 3, elapsedMs: 1 };
    }
    await writeDataExport('xlsx', sensitive(), xlsx.context);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(xlsx.filename);
    const sheet = workbook.getWorksheet('Data')!;
    expect(sheet.getCell('A2').value).toBe('=SUM(1,2)');
    expect(sheet.getCell('A2').formula).toBeUndefined();
    expect(sheet.getCell('A3').value).toBe('ampersand & <tag> "quote"\nnext\rline 😀');
    expect(sheet.getCell('A4').value).toBe('literal _x0041_');
  });

  it('rejects invalid Unicode instead of silently changing an Excel cell', async () => {
    const xlsx = await destination('xlsx');
    async function* invalid(): AsyncIterable<QueryResult> {
      yield { columns: ['value'], rows: [{ value: `bad${String.fromCharCode(0xd800)}` }], rowCount: 1, elapsedMs: 1 };
    }
    await expect(writeDataExport('xlsx', invalid(), xlsx.context)).rejects.toThrow('invalid Unicode');
    const control = await destination('xlsx');
    async function* invalidControl(): AsyncIterable<QueryResult> {
      yield { columns: ['value'], rows: [{ value: 'bad\u0001' }], rowCount: 1, elapsedMs: 1 };
    }
    await expect(writeDataExport('xlsx', invalidControl(), control.context)).rejects.toThrow('XML control character');
  });

  it('unions heterogeneous document fields for CSV/XLSX and preserves later keys in JSON', async () => {
    async function* heterogeneous(): AsyncIterable<QueryResult> {
      yield { columns: ['id', 'profile'], rows: [{ id: 1, profile: { name: 'Ada' }, score: Number.POSITIVE_INFINITY }], rowCount: 1, elapsedMs: 1 };
      yield { columns: ['id', 'tags'], rows: [{ id: 2, tags: ['new'], exact: 9007199254740992 }], rowCount: 1, elapsedMs: 1 };
    }
    const json = await destination('json');
    await writeDataExport('json', heterogeneous(), json.context);
    expect(JSON.parse(await readFile(json.filename, 'utf8'))).toEqual([
      { id: 1, profile: { name: 'Ada' }, score: 'Infinity' },
      { id: 2, tags: ['new'], exact: '9007199254740992' }
    ]);

    const csv = await destination('csv');
    await writeDataExport('csv', heterogeneous(), csv.context);
    const rows = (await readFile(csv.filename, 'utf8')).trim().split('\r\n');
    expect(rows[0]).toBe('"id","profile","score","tags","exact"');
    expect(rows[2]).toContain('"[""new""]"');

    const xlsx = await destination('xlsx');
    await writeDataExport('xlsx', heterogeneous(), xlsx.context);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(xlsx.filename);
    expect(workbook.getWorksheet('Data')!.getRow(1).values).toEqual([undefined, 'id', 'profile', 'score', 'tags', 'exact']);
    expect(workbook.getWorksheet('Data')!.getCell('C2').value).toBe('Infinity');
  });

  it('escapes report markup while retaining validated source evidence', () => {
    const artifact = {
      kind: 'query-result' as const,
      queryId: 'owned',
      query: 'SELECT name FROM customers',
      purpose: '<script>alert(1)</script>',
      result: { columns: ['name'], rows: [{ name: '<img src=x onerror=alert(1)>' }], rowCount: 1, elapsedMs: 1 }
    };
    const html = buildReportDownload({
      title: '<script>title</script>', format: 'html', resultIds: ['owned'],
      blocks: [{ type: 'heading', text: '<img src=x>', level: 2 }, { type: 'text', content: 'Finding <script>alert(1)</script>' }, { type: 'table', columns: ['name'], rows: artifact.result.rows }]
    }, [artifact], '2026-09-08T00:00:00.000Z');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('SELECT name FROM customers');
  });
});
