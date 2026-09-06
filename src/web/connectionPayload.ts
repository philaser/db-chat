export interface ConnectionDraft {
  label: string;
  kind: string;
  databasePath: string;
  sqliteUploadId?: string;
  sqliteFileName?: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  mongodbUri: string;
  elasticsearchUrl: string;
  elasticsearchVerifyCerts: boolean;
}

export function buildConnectionPayload(draft: ConnectionDraft): Record<string, unknown> {
  const isElasticsearch = draft.kind === 'elasticsearch';
  const base = {
    label: draft.label,
    kind: draft.kind,
    databasePath: draft.kind === 'sqlite' ? undefined : draft.databasePath || undefined,
    sqliteUploadId: draft.kind === 'sqlite' ? draft.sqliteUploadId || undefined : undefined,
    host: draft.host || undefined,
    port: draft.port ? Number(draft.port) : undefined,
    database: draft.database || undefined,
    username: isElasticsearch ? undefined : draft.username || undefined,
    password: isElasticsearch ? undefined : draft.password || undefined,
    ssl: draft.ssl,
    mongodbUri: draft.mongodbUri || undefined,
    elasticsearchUrl: draft.elasticsearchUrl || undefined,
    elasticsearchHost: draft.host || undefined,
    elasticsearchPort: draft.port ? Number(draft.port) : undefined,
    elasticsearchUsername: isElasticsearch ? draft.username || undefined : undefined,
    elasticsearchPassword: isElasticsearch ? draft.password || undefined : undefined,
    elasticsearchUseSsl: isElasticsearch ? draft.ssl : undefined,
    elasticsearchVerifyCerts: draft.elasticsearchVerifyCerts
  };
  return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined));
}
