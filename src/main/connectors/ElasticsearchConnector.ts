import https from 'node:https';
import type {
  ColumnInfo,
  ConnectionConfig,
  DatabaseConnector,
  DatabaseSchema,
  QueryExecutionMode,
  QueryResult,
  QueryValidationResult,
  TableInfo
} from '../../shared/types.js';
import {
  parseElasticsearchSearchQuery,
  validateElasticsearchReadOnlyQuery
} from './elasticsearchValidation.js';

export class ElasticsearchConnector implements DatabaseConnector {
  private config: ConnectionConfig | null = null;
  private baseUrl: URL | null = null;

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
      .filter((index): index is string => Boolean(index && !index.startsWith('.')))
      .slice(0, 50);

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

  validateQuery(query: string, mode: QueryExecutionMode): QueryValidationResult {
    return validateElasticsearchReadOnlyQuery(query, mode);
  }

  async executeQuery(query: string): Promise<QueryResult> {
    const validation = this.validateQuery(query, 'safe');
    if (!validation.safe) {
      throw new Error(validation.reason);
    }

    const parsed = parseElasticsearchSearchQuery(validation.normalizedQuery);
    const body = {
      size: 50,
      track_total_hits: true,
      ...parsed.body
    };
    const start = performance.now();
    const response = await this.request<ElasticsearchSearchResponse>(
      `${encodeIndexPattern(parsed.index)}/_search`,
      {
        method: 'POST',
        body: JSON.stringify(body)
      }
    );
    const elapsedMs = typeof response.took === 'number'
      ? response.took
      : Math.round(performance.now() - start);
    const rows = rowsFromSearchResponse(response);
    const columns = collectColumns(rows);

    return {
      columns,
      rows,
      rowCount: rows.length,
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
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...this.authHeaders(),
        ...init.headers
      }
    };
    let response: Response;
    try {
      response = url.protocol === 'https:' && this.config?.elasticsearchVerifyCerts === false
        ? await requestWithoutCertificateVerification(url, initWithHeaders)
        : await fetch(url, initWithHeaders);
    } catch (error) {
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

function requestWithoutCertificateVerification(url: URL, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      rejectUnauthorized: false
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
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
  took?: number;
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
