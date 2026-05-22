import { describe, expect, it } from 'vitest';
import {
  buildLocalAssistantResponse,
  buildResultAnalysisPrompt,
  buildSystemPrompt,
  summarizeQueryResult
} from '../src/main/assistant/localAssistant';
import type { DatabaseSchema, QueryResult } from '../src/shared/types';

const schema: DatabaseSchema = {
  kind: 'sqlite',
  label: 'sample.db',
  tables: [
    {
      name: 'orders',
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'created_at', type: 'TEXT', nullable: false, primaryKey: false },
        { name: 'customer_id', type: 'INTEGER', nullable: false, primaryKey: false },
        { name: 'total', type: 'REAL', nullable: false, primaryKey: false }
      ]
    }
  ]
};

const elasticsearchSchema: DatabaseSchema = {
  kind: 'elasticsearch',
  label: 'local-es',
  tables: [
    {
      name: 'orders',
      columns: [
        { name: 'customer', type: 'keyword', nullable: true, primaryKey: false },
        { name: 'total', type: 'double', nullable: true, primaryKey: false }
      ]
    }
  ]
};

describe('local assistant prompt shaping', () => {
  it('guides provider models toward conversational, safe, complex data analysis', () => {
    const prompt = buildSystemPrompt('orders(id, created_at, customer_id, total)');

    expect(prompt).toContain('conversational data analyst');
    expect(prompt).toContain('joins, grouping, filtering, date bucketing, ranking, comparisons, cohorts, and summary statistics');
    expect(prompt).toContain('Generate only read-only SQLite');
    expect(prompt).toContain('include exactly one fenced ```sql block');
    expect(prompt).toContain('suggest one or two good next questions');
  });

  it('guides result answers to be chatty while keeping SQL out of chat', () => {
    const prompt = buildResultAnalysisPrompt();

    expect(prompt).toContain('start with the direct takeaway');
    expect(prompt).toContain('trends, outliers, ranking, gaps, caveats, and comparisons');
    expect(prompt).toContain('ending with one natural follow-up');
    expect(prompt).toContain('Do not include SQL, query text, fenced code blocks, JSON, or implementation details');
  });

  it('guides provider models toward safe Elasticsearch searches when connected to Elasticsearch', () => {
    const prompt = buildSystemPrompt('Elasticsearch index orders: customer keyword, total double', 'elasticsearch');

    expect(prompt).toContain('safe Elasticsearch search request');
    expect(prompt).toContain('include exactly one fenced ```json block');
    expect(prompt).toContain('Never generate writes, deletes, updates');
  });

  it('allows validated data writes in prompts only when SAFE mode is off', () => {
    const sqlitePrompt = buildSystemPrompt('orders(id, total)', 'sqlite', 'manual');
    const elasticsearchPrompt = buildSystemPrompt('Elasticsearch index orders: customer keyword', 'elasticsearch', 'manual');

    expect(sqlitePrompt).toContain('SAFE mode is off');
    expect(sqlitePrompt).toContain('table row inserts, updates, deletes, or replaces');
    expect(sqlitePrompt).toContain('Never generate schema changes');
    expect(elasticsearchPrompt).toContain('document index, update, and delete requests');
    expect(elasticsearchPrompt).toContain('Never generate index deletion');
  });

  it('gives schema questions a next-question ramp', () => {
    const response = buildLocalAssistantResponse('what tables are available?', schema);

    expect(response.content).toContain('Here is what I can see');
    expect(response.content).toContain('A good next question could be');
  });

  it('adds a next-step ramp to local result summaries', () => {
    const result: QueryResult = {
      columns: ['customer_id', 'total'],
      rows: [{ customer_id: 1, total: 120 }],
      rowCount: 1,
      elapsedMs: 2
    };

    expect(summarizeQueryResult(result)).toContain('A useful next step would be');
  });

  it('builds local fallback Elasticsearch searches', () => {
    const response = buildLocalAssistantResponse('show orders', elasticsearchSchema);

    expect(response.content).toContain('Elasticsearch cluster');
    expect(response.query?.query).toContain('"index": "orders"');
    expect(response.query?.validation.safe).toBe(true);
  });
});
