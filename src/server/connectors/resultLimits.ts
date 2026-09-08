import type { QueryResult } from '../../shared/types.js';

export function resultLimit(value: number, cap = 1000): number {
  if (!Number.isFinite(value) || value < 1) throw new Error('Result limit must be a positive finite number.');
  return Math.min(cap, Math.floor(value));
}

export function boundResult(result: QueryResult, maxRows: number): QueryResult {
  const truncated = result.truncated === true || result.rows.length > maxRows;
  const rows = result.rows.slice(0, maxRows);
  return { ...result, rows, rowCount: rows.length, ...(truncated ? { truncated: true, rowLimit: maxRows, truncationReason: result.truncationReason ?? 'row-limit' } : {}) };
}

export function boundResultBytes(result: QueryResult, maxBytes: number): QueryResult {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new Error('Result byte limit must be a positive finite number.');
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxBytes) return result;

  const base: QueryResult = {
    ...result,
    rows: [],
    rowCount: 0,
    truncated: true,
    byteLimit: Math.floor(maxBytes),
    truncationReason: 'byte-limit'
  };
  let low = 0;
  let high = result.rows.length;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    const candidate = { ...base, rows: result.rows.slice(0, count), rowCount: count };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxBytes) low = count;
    else high = count - 1;
  }
  return { ...base, rows: result.rows.slice(0, low), rowCount: low };
}
