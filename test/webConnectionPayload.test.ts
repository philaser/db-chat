import { describe, expect, it } from 'vitest';
import { buildConnectionPayload, type ConnectionDraft } from '../src/web/connectionPayload.js';

function elasticsearchDraft(ssl: boolean): ConnectionDraft {
  return {
    label: 'Production search',
    kind: 'elasticsearch',
    databasePath: '',
    host: 'search.example.com',
    port: '9243',
    database: 'events',
    username: 'readonly-user',
    password: 'not-a-real-secret',
    ssl,
    mongodbUri: '',
    elasticsearchUrl: '',
    elasticsearchVerifyCerts: true
  };
}

describe('web connection payloads', () => {
  it('sends an uploaded SQLite file token instead of a local filesystem path', () => {
    const payload = buildConnectionPayload({
      label: 'Local analytics',
      kind: 'sqlite',
      databasePath: '/Users/example/analytics.sqlite',
      sqliteUploadId: 'upload_test',
      sqliteFileName: 'analytics.sqlite',
      host: '',
      port: '',
      database: '',
      username: '',
      password: '',
      ssl: true,
      mongodbUri: '',
      elasticsearchUrl: '',
      elasticsearchVerifyCerts: true
    });

    expect(payload).toMatchObject({ kind: 'sqlite', sqliteUploadId: 'upload_test' });
    expect(payload).not.toHaveProperty('databasePath');
  });

  it('sends Elasticsearch TLS and credentials using the connector fields', () => {
    expect(buildConnectionPayload(elasticsearchDraft(true))).toMatchObject({
      elasticsearchHost: 'search.example.com',
      elasticsearchPort: 9243,
      elasticsearchUsername: 'readonly-user',
      elasticsearchPassword: 'not-a-real-secret',
      elasticsearchUseSsl: true,
      elasticsearchVerifyCerts: true
    });
  });

  it('preserves an explicit HTTP selection', () => {
    expect(buildConnectionPayload(elasticsearchDraft(false))).toMatchObject({
      elasticsearchUseSsl: false
    });
  });
});
