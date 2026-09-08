import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import type { QueryResult } from '../../shared/types.js';
import { ExportError, type DataFormat, type ExportRun } from './exportJobs.js';
import { writeXlsxFromNdjson } from './xlsxExport.js';

const jsonReplacer = (_key: string, value: unknown) => typeof value === 'bigint'
  ? value.toString()
  : typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
    ? String(value)
    : value;
const serialize = (value: unknown): string => {
  try { return JSON.stringify(value, jsonReplacer); }
  catch { throw new ExportError('A value could not be serialized. Select scalar fields or remove cyclic objects.'); }
};
const scalar = (value: unknown): string | number | boolean | null => value == null ? null : typeof value === 'bigint' ? value.toString() : value instanceof Date ? value.toISOString() : typeof value === 'object' ? serialize(value) : typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) ? String(value) : typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
export function csvCell(value: unknown): string {
  const normalized = scalar(value);
  let text = normalized == null ? '' : String(normalized);
  if (typeof normalized === 'string' && /^\s*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

async function writeChunk(output: ReturnType<typeof createWriteStream>, text: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!output.write(text)) await once(output, 'drain', { signal });
}

async function writeJsonExport(batches: AsyncIterable<QueryResult>, context: ExportRun): Promise<void> {
  const output = createWriteStream(context.filename, { flags: 'wx', mode: 0o600 });
  const completion = finished(output); void completion.catch(() => undefined);
  const abort = () => output.destroy(new ExportError('Export cancelled.'));
  context.signal.addEventListener('abort', abort, { once: true });
  let count = 0, bytes = 2;
  try {
    await writeChunk(output, '[\n', context.signal);
    for await (const batch of batches) {
      for (const row of batch.rows) {
        if (++count > context.limits.maxRows) throw new ExportError('Export exceeded the row limit. Narrow the query; no partial file was published.');
        const json = serialize(row);
        bytes += Buffer.byteLength(json) + (count === 1 ? 0 : 2);
        if (bytes > context.limits.maxBytes) throw new ExportError('Export exceeded the data-size limit. Select fewer rows or fields; no partial file was published.');
        await writeChunk(output, (count === 1 ? '' : ',\n') + json, context.signal);
      }
      context.progress(count, bytes);
    }
    await writeChunk(output, '\n]\n', context.signal);
    output.end(); await completion;
  } catch (error) { output.destroy(); await completion.catch(() => undefined); throw error; }
  finally { context.signal.removeEventListener('abort', abort); }
}

async function spoolTabularRows(batches: AsyncIterable<QueryResult>, context: ExportRun, spool: string): Promise<{ columns: string[]; count: number; bytes: number }> {
  const output = createWriteStream(spool, { flags: 'wx', mode: 0o600 });
  const completion = finished(output); void completion.catch(() => undefined);
  const abort = () => output.destroy(new ExportError('Export cancelled.'));
  context.signal.addEventListener('abort', abort, { once: true });
  const columns: string[] = [], known = new Set<string>();
  let count = 0, bytes = 0;
  try {
    for await (const batch of batches) {
      if (new Set(batch.columns).size !== batch.columns.length) throw new ExportError('Export requires distinct column names. Give duplicate columns unique aliases.');
      for (const column of batch.columns) if (!known.has(column)) {
        known.add(column); columns.push(column); bytes += Buffer.byteLength(column) + 1;
        if (columns.length > 16_384 || bytes > context.limits.maxBytes) throw new ExportError('Export has too many fields. Select fewer fields and try again.');
      }
      for (const row of batch.rows) {
        for (const column of Object.keys(row)) if (!known.has(column)) {
          known.add(column); columns.push(column); bytes += Buffer.byteLength(column) + 1;
          if (columns.length > 16_384 || bytes > context.limits.maxBytes) throw new ExportError('Export has too many fields. Select fewer fields and try again.');
        }
        if (++count > context.limits.maxRows) throw new ExportError('Export exceeded the row limit. Narrow the query; no partial file was published.');
        const json = serialize(row);
        bytes += Buffer.byteLength(json) + 1;
        if (bytes > context.limits.maxBytes) throw new ExportError('Export exceeded the data-size limit. Select fewer rows or fields; no partial file was published.');
        await writeChunk(output, json + '\n', context.signal);
      }
      context.progress(count, bytes);
    }
    output.end(); await completion;
    return { columns, count, bytes };
  } catch (error) { output.destroy(); await completion.catch(() => undefined); throw error; }
  finally { context.signal.removeEventListener('abort', abort); }
}

async function writeTabularExport(format: 'csv' | 'xlsx', batches: AsyncIterable<QueryResult>, context: ExportRun): Promise<void> {
  const spool = `${context.filename}.rows`;
  try {
    const staged = await spoolTabularRows(batches, context, spool);
    if (format === 'xlsx' && staged.columns.length > 16_384) throw new ExportError('This result exceeds the Excel column limit. Choose JSON or fewer fields.');
    if (format === 'xlsx' && staged.count > 1_048_575) throw new ExportError('This result exceeds the Excel row limit. Choose CSV or JSON.');
    if (format === 'xlsx') {
      await writeXlsxFromNdjson(spool, staged.columns, context);
      context.progress(staged.count, staged.bytes);
      return;
    }
    const output = createWriteStream(context.filename, { flags: 'wx', mode: 0o600 });
    const completion = finished(output); void completion.catch(() => undefined);
    const abort = () => output.destroy(new ExportError('Export cancelled.'));
    context.signal.addEventListener('abort', abort, { once: true });
    let actualBytes = 0, written = 0;
    try {
      const header = staged.columns.map(csvCell).join(',') + '\r\n';
      actualBytes += Buffer.byteLength(header);
      await writeChunk(output, header, context.signal);
      const input = createReadStream(spool);
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          context.signal.throwIfAborted();
          const row = JSON.parse(line) as Record<string, unknown>;
          const values = staged.columns.map(column => scalar(row[column]));
          const encoded = values.map(csvCell).join(',') + '\r\n';
          actualBytes += Buffer.byteLength(encoded);
          if (actualBytes > context.limits.maxBytes) throw new ExportError('Export exceeded the file-size limit. Select fewer rows or fields; no partial file was published.');
          await writeChunk(output, encoded, context.signal);
          written++;
        }
      } finally { lines.close(); input.destroy(); }
      output.end();
      await completion;
      context.progress(written, actualBytes);
    } catch (error) { output.destroy(); await completion.catch(() => undefined); throw error; }
    finally { context.signal.removeEventListener('abort', abort); }
  } finally { await fs.rm(spool, { force: true }).catch(() => undefined); }
}

export async function writeDataExport(format: DataFormat, batches: AsyncIterable<QueryResult>, context: ExportRun): Promise<void> {
  context.signal.throwIfAborted();
  if (format === 'json') return writeJsonExport(batches, context);
  return writeTabularExport(format, batches, context);
}
