import http from 'node:http';
import { pinnedLookup } from './pinnedLookup.js';
import { boundResult, resultLimit } from './resultLimits.js';
import https from 'node:https';
import type {
  ColumnInfo,
  ConnectionConfig,
  DatabaseConnector,
  DatabaseSchema,
  QueryResult,
  TableInfo,
  SafetyLevel
} from '../../shared/types.js';
import {
  parseElasticsearchQuery,
  parseElasticsearchSearchQuery,
  findBlockedKey,
  MAX_SAFE_SIZE
} from './elasticsearchValidation.js';

export class ElasticsearchConnector implements DatabaseConnector {
  private config: ConnectionConfig | null = null;
  private baseUrl: URL | null = null;
  private safetyLevel: SafetyLevel = 'standard';
  private maxRows = MAX_SAFE_SIZE;

  setResultLimit(maxRows: number): void { this.maxRows = resultLimit(maxRows, MAX_SAFE_SIZE); }

  setSafetyLevel(level: SafetyLevel): void {
    this.safetyLevel = level;
  }

  async connect(config: ConnectionConfig): Promise<void> {
    const baseUrl = buildBaseUrl(config);
    if (!/^https?:$/.test(baseUrl.protocol)) {
      throw new Error('Elasticsearch host must use HTTP or HTTPS.');
    }

    this.config = config;
    this.baseUrl = baseUrl;
    await this.request('_cluster/health?filter_path=cluster_name,status');
  }

  async introspect(): Promise<DatabaseSchema> {
    const indices = await this.request<Array<{ index?: string }>>('_cat/indices?format=json&h=index&s=index');
    const visibleIndices = indices
      .map((item) => item.index)
      .filter((index): index is string => Boolean(index && !index.startsWith('.')));

    const tables: TableInfo[] = [];
    for (const index of visibleIndices) {
      const mapping = await this.request<Record<string, { mappings?: ElasticsearchMapping }>>(`${encodeURIComponent(index)}/_mapping`);
      const properties = mapping[index]?.mappings?.properties ?? {};
      tables.push({
        name: index,
        columns: flattenProperties(properties)
      });
    }

    return {
      kind: 'elasticsearch',
      label: this.config?.label ?? 'Elasticsearch cluster',
      tables
    };
  }

  async executeQuery(query: string, options?: { signal?: AbortSignal }): Promise<QueryResult> {
    const parsed = parseElasticsearchQuery(query);
    if ('operation' in parsed) {
      if (this.safetyLevel === 'safe') {
        throw new Error('Elasticsearch write operations are blocked in safe mode.');
      }
      return this.executeDocumentWrite(parsed);
    }

    return this.executeSearch(parsed, options?.signal);
  }

  async *exportQuery(query: string, options?: { signal?: AbortSignal; batchSize?: number }): AsyncIterable<QueryResult> {
    const parsed = parseElasticsearchQuery(query);
    if ('operation' in parsed) throw new Error('Exports require one explicit read-only query.');
    const blockedKey = findBlockedKey(parsed.body);
    if (blockedKey) throw new Error(`Elasticsearch blocked key "${blockedKey}" in search body.`);
    if (parsed.body.aggs || parsed.body.aggregations) {
      throw new Error('Raw Elasticsearch exports do not support aggregations. Use a hits query so every matching document can be exported.');
    }
    const signal = options?.signal;
    const batchSize = exportBatchSize(options?.batchSize);
    signal?.throwIfAborted();
    const requested = typeof parsed.body.size === 'number' && Number.isFinite(parsed.body.size)
      ? Math.max(0, Math.floor(parsed.body.size)) : undefined;
    const started = performance.now();
    if (requested === 0) {
      yield { columns: [], rows: [], rowCount: 0, elapsedMs: 0 };
      return;
    }
    let remaining = requested;
    let scrollId: string | undefined;
    try {
      let response = await this.request<ElasticsearchSearchResponse>(
        `${encodeIndexPattern(parsed.index)}/_search?scroll=1m`,
        { method: 'POST', body: JSON.stringify({ ...parsed.body, size: Math.min(batchSize, remaining ?? batchSize), timeout: '30s' }), signal }
      );
      for (;;) {
        assertCompleteSearchPage(response);
        scrollId = response._scroll_id ?? scrollId;
        let rows = rowsFromExportResponse(response);
        if (remaining !== undefined) rows = rows.slice(0, remaining);
        if (rows.length) {
          const columns = collectColumns(rows);
          yield { columns, rows, rowCount: rows.length, elapsedMs: Math.round(performance.now() - started) };
          if (remaining !== undefined) { remaining -= rows.length; if (remaining <= 0) break; }
        }
        if (!(response.hits?.hits?.length) || !scrollId || response.aggregations) break;
        response = await this.request<ElasticsearchSearchResponse>('_search/scroll', {
          method: 'POST', body: JSON.stringify({ scroll: '1m', scroll_id: scrollId }), signal
        });
      }
    } finally {
      if (scrollId) await this.request('_search/scroll', { method: 'DELETE', body: JSON.stringify({ scroll_id: scrollId }) }).catch(() => undefined);
    }
  }

  private async executeSearch(parsed: ReturnType<typeof parseElasticsearchSearchQuery>, signal?: AbortSignal): Promise<QueryResult> {
    const blockedKey = findBlockedKey(parsed.body);
    if (blockedKey) {
      throw new Error(`Elasticsearch blocked key "${blockedKey}" in search body.`);
    }
    const requestedSize = typeof parsed.body.size === 'number' && Number.isFinite(parsed.body.size)
      ? Math.max(0, Math.floor(parsed.body.size)) : this.maxRows + 1;
    const body = {
      ...parsed.body,
      size: Math.min(requestedSize, this.maxRows + 1),
      track_total_hits: true,
      timeout: '30s'
    };
    const start = performance.now();
    const response = await this.request<ElasticsearchSearchResponse>(
      `${encodeIndexPattern(parsed.index)}/_search`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        signal
      }
    );
    const elapsedMs = typeof response.took === 'number'
      ? response.took
      : Math.round(performance.now() - start);
    const rows = rowsFromSearchResponse(response);
    const columns = collectColumns(rows);

    const total = response.hits?.total;
    const totalHits = typeof total === 'number' ? total : total?.value;
    return boundResult({
      columns, rows, rowCount: rows.length, elapsedMs,
      ...(requestedSize > this.maxRows && typeof totalHits === 'number' && totalHits > this.maxRows
        ? { truncated: true, rowLimit: this.maxRows } : {})
    }, this.maxRows);
  }

  private async executeDocumentWrite(parsed: Extract<ReturnType<typeof parseElasticsearchQuery>, { operation: string }>): Promise<QueryResult> {
    const start = performance.now();
    if (parsed.body) {
      const blocked = findBlockedKey(parsed.operation === 'update' ? parsed.body.doc : parsed.body);
      if (blocked) {
        throw new Error(`Elasticsearch blocked key "${blocked}" in write body.`);
      }
    }
    const response = parsed.operation === 'delete'
      ? await this.request<ElasticsearchWriteResponse>(
        `${encodeURIComponent(parsed.index)}/_doc/${encodeURIComponent(parsed.id ?? '')}`,
        { method: 'DELETE' }
      )
      : parsed.operation === 'update'
        ? await this.request<ElasticsearchWriteResponse>(
          `${encodeURIComponent(parsed.index)}/_update/${encodeURIComponent(parsed.id ?? '')}`,
          { method: 'POST', body: JSON.stringify(parsed.body) }
        )
        : await this.request<ElasticsearchWriteResponse>(
          parsed.id
            ? `${encodeURIComponent(parsed.index)}/_doc/${encodeURIComponent(parsed.id)}`
            : `${encodeURIComponent(parsed.index)}/_doc`,
          { method: parsed.id ? 'PUT' : 'POST', body: JSON.stringify(parsed.body) }
        );
    const elapsedMs = Math.round(performance.now() - start);
    const row = {
      operation: parsed.operation,
      index: response._index ?? parsed.index,
      id: response._id ?? parsed.id ?? '',
      result: response.result ?? 'acknowledged',
      version: response._version ?? ''
    };

    return {
      columns: Object.keys(row),
      rows: [row],
      rowCount: 1,
      elapsedMs
    };
  }

  async getContextForPrompt(): Promise<string> {
    const schema = await this.introspect();
    if (schema.tables.length === 0) {
      return 'The connected Elasticsearch cluster has no visible indices.';
    }

    return schema.tables
      .map((index) => {
        const fields = index.columns.map((column) => `${column.name} ${column.type}`).join(', ');
        return `Elasticsearch index ${index.name}: ${fields || 'mapping unavailable'}`;
      })
      .join('\n');
  }

  close(): void {
    this.config = null;
    this.baseUrl = null;
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = this.requireBaseUrl();
    const url = new URL(path.replace(/^\/+/, ''), baseUrl.href.endsWith('/') ? baseUrl.href : `${baseUrl.href}/`);
    const initWithHeaders: RequestInit = {
      ...init,
      redirect: 'error',
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000),
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...this.authHeaders(),
        ...init.headers
      }
    };
    let response: Response;
    try {
      response = this.config?.resolvedAddress || (url.protocol === 'https:' && this.config?.elasticsearchVerifyCerts === false)
        ? await requestWithoutCertificateVerification(url, initWithHeaders, this.config?.elasticsearchVerifyCerts !== false, this.config?.resolvedAddress)
        : await fetch(url, initWithHeaders);
    } catch (error) {
      if (init.signal?.aborted) throw abortError(init.signal, 'Elasticsearch query was cancelled.');
      throw new Error(`Could not reach Elasticsearch at ${url.origin}: ${networkErrorMessage(error)}`);
    }

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Elasticsearch request failed (${response.status}): ${message || response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  private authHeaders(): Record<string, string> {
    if (!this.config) {
      return {};
    }

    if (this.config.elasticsearchUsername && this.config.elasticsearchPassword) {
      const credentials = Buffer.from(`${this.config.elasticsearchUsername}:${this.config.elasticsearchPassword}`, 'utf8').toString('base64');
      return { authorization: `Basic ${credentials}` };
    }

    return {};
  }

  private requireBaseUrl(): URL {
    if (!this.baseUrl) {
      throw new Error('No database is connected.');
    }
    return this.baseUrl;
  }
}

function abortError(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(fallback, 'AbortError');
}

function buildBaseUrl(config: ConnectionConfig): URL {
  if (config.elasticsearchHost) {
    const host = config.elasticsearchHost.trim();
    if (!host) {
      throw new Error('Elasticsearch connection requires a host.');
    }
    const protocol = config.elasticsearchUseSsl ? 'https' : 'http';
    const port = config.elasticsearchPort ?? 9200;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('Elasticsearch port must be between 1 and 65535.');
    }
    return new URL(`${protocol}://${host}:${port}`);
  }

  if (config.elasticsearchUrl) {
    return new URL(config.elasticsearchUrl);
  }

  throw new Error('Elasticsearch connection requires a host.');
}

function requestWithoutCertificateVerification(url: URL, init: RequestInit, verify = false, address?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https.request : http.request)(url, {
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      rejectUnauthorized: verify,
      ...(address ? { lookup: pinnedLookup(address) } : {}),
      signal: init.signal ?? undefined
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('error', reject);
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) { response.destroy(new Error('Database response exceeded the size limit.')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 500,
          statusText: response.statusMessage,
          headers: response.headers as HeadersInit
        }));
      });
    });
    request.on('error', reject);
    if (typeof init.body === 'string') {
      request.write(init.body);
    }
    request.end();
  });
}

function networkErrorMessage(error: unknown): string {
  const messages = collectNetworkErrorMessages(error);
  return messages.length ? messages.join('; ') : 'network request failed.';
}

function collectNetworkErrorMessages(error: unknown): string[] {
  if (!(error instanceof Error)) {
    return [];
  }

  if (error instanceof AggregateError) {
    const nested = error.errors.flatMap((item) => collectNetworkErrorMessages(item));
    return nested.length ? uniqueMessages(nested) : messageForError(error);
  }

  if (error.cause) {
    const causeMessages = collectNetworkErrorMessages(error.cause);
    if (causeMessages.length) {
      return causeMessages;
    }
  }

  return messageForError(error);
}

function messageForError(error: Error): string[] {
  const nodeError = error as Error & { code?: string; address?: string; port?: number };
  if (nodeError.code && nodeError.address && nodeError.port) {
    return [`${nodeError.code} ${nodeError.address}:${nodeError.port}`];
  }
  return error.message ? [error.message] : [];
}

function uniqueMessages(messages: string[]): string[] {
  return Array.from(new Set(messages));
}

interface ElasticsearchMapping {
  properties?: Record<string, ElasticsearchProperty>;
}

interface ElasticsearchProperty {
  type?: string;
  properties?: Record<string, ElasticsearchProperty>;
  fields?: Record<string, ElasticsearchProperty>;
}

interface ElasticsearchSearchResponse {
  _scroll_id?: string;
  took?: number;
  timed_out?: boolean;
  terminated_early?: boolean;
  _shards?: { failed?: number };
  hits?: {
    total?: number | { value?: number };
    hits?: Array<{
      _id?: string;
      _index?: string;
      _score?: number | null;
      _source?: Record<string, unknown>;
      fields?: Record<string, unknown>;
    }>;
  };
  aggregations?: Record<string, unknown>;
}

function assertCompleteSearchPage(response: ElasticsearchSearchResponse): void {
  if (response.timed_out) throw new Error('Elasticsearch export timed out before all matching documents were returned.');
  if (response.terminated_early) throw new Error('Elasticsearch export terminated early before all matching documents were returned.');
  if ((response._shards?.failed ?? 0) > 0) throw new Error(`Elasticsearch export failed on ${response._shards!.failed} shard(s).`);
  if ((response.hits?.hits?.length ?? 0) > 0 && !response._scroll_id) {
    throw new Error('Elasticsearch export did not receive a scroll cursor for the remaining matching documents.');
  }
}

function exportBatchSize(value = 500): number {
  if (!Number.isFinite(value) || value < 1) throw new Error('Export batch size must be a positive finite number.');
  return Math.min(MAX_SAFE_SIZE, Math.floor(value));
}

interface ElasticsearchWriteResponse {
  _id?: string;
  _index?: string;
  _version?: number;
  result?: string;
}

function flattenProperties(properties: Record<string, ElasticsearchProperty>, prefix = ''): ColumnInfo[] {
  return Object.entries(properties).flatMap(([name, property]) => {
    const fieldName = prefix ? `${prefix}.${name}` : name;
    const current: ColumnInfo[] = [{
      name: fieldName,
      type: property.type ?? (property.properties ? 'object' : 'unknown'),
      nullable: true,
      primaryKey: false
    }];
    const nested = property.properties ? flattenProperties(property.properties, fieldName) : [];
    const multifields = property.fields ? flattenProperties(property.fields, fieldName) : [];
    return [...current, ...nested, ...multifields];
  });
}

function encodeIndexPattern(index: string): string {
  return index.split(',').map((part) => encodeURIComponent(part.trim())).join(',');
}

function rowsFromSearchResponse(response: ElasticsearchSearchResponse): Record<string, unknown>[] {
  const aggregationRows = response.aggregations ? rowsFromAggregations(response.aggregations) : [];
  if (aggregationRows.length) {
    return aggregationRows;
  }

  const hits = response.hits?.hits ?? [];
  if (hits.length) {
    return hits.map((hit) => ({
      _index: hit._index,
      _id: hit._id,
      _score: hit._score,
      ...flattenValue(hit._source ?? {}),
      ...flattenValue(hit.fields ?? {})
    }));
  }

  const total = response.hits?.total;
  const totalHits = typeof total === 'number' ? total : total?.value;
  return typeof totalHits === 'number' ? [{ total_hits: totalHits }] : [];
}

function rowsFromExportResponse(response: ElasticsearchSearchResponse): Record<string, unknown>[] {
  const aggregationRows = response.aggregations ? rowsFromAggregations(response.aggregations) : [];
  if (aggregationRows.length) return aggregationRows;
  return (response.hits?.hits ?? []).map(hit => ({
    _index: hit._index,
    _id: hit._id,
    _score: hit._score,
    ...flattenValue(hit._source ?? {}),
    ...flattenValue(hit.fields ?? {})
  }));
}

function rowsFromAggregations(aggregations: Record<string, unknown>, prefix = ''): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const [name, value] of Object.entries(aggregations)) {
    if (!isRecord(value)) {
      continue;
    }

    const buckets = value.buckets;
    if (Array.isArray(buckets)) {
      for (const bucket of buckets) {
        if (!isRecord(bucket)) continue;
        rows.push(flattenValue(bucket, prefix ? `${prefix}.${name}` : name));
      }
      continue;
    }

    rows.push(flattenValue(value, prefix ? `${prefix}.${name}` : name));
  }
  return rows;
}

function flattenValue(value: unknown, prefix = ''): Record<string, unknown> {
  if (!isRecord(value)) {
    return prefix ? { [prefix]: formatCell(value) } : {};
  }

  const row: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const column = prefix ? `${prefix}.${key}` : key;
    if (isRecord(child)) {
      Object.assign(row, flattenValue(child, column));
    } else {
      row[column] = formatCell(child);
    }
  }
  return row;
}

function formatCell(value: unknown): unknown {
  return Array.isArray(value) ? JSON.stringify(value) : value;
}

function collectColumns(rows: Record<string, unknown>[]): string[] {
  return Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
