import type { QueryResult } from '../../shared/types.js';

export function resultLimit(value: number, cap = 1000): number {
  if (!Number.isFinite(value) || value < 1) throw new Error('Result limit must be a positive finite number.');
  return Math.min(cap, Math.floor(value));
}

export function boundResult(result: QueryResult, maxRows: number): QueryResult {
  const truncated = result.truncated === true || result.rows.length > maxRows;
  const rows = result.rows.slice(0, maxRows);
  return { ...result, rows, rowCount: rows.length, ...(truncated ? { truncated: true, rowLimit: maxRows } : {}) };
}
