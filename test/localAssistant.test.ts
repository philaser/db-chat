import { describe, expect, it } from 'vitest';
import {
  buildLocalAssistantResponse,
  buildResultAnalysisPrompt,
  buildSystemPrompt,
  extractQueryBlock,
  removeSqlBlocks,
  summarizeQueryResult
} from '../src/main/assistant/localAssistant';
import type { DatabaseSchema, QueryResult } from '../src/shared/types';

const sqliteSchema: DatabaseSchema = {
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

const mysqlSchema: DatabaseSchema = {
  kind: 'mysql',
  label: 'mysql-db',
  tables: [
    {
      name: 'orders',
      columns: [
        { name: 'id', type: 'int', nullable: false, primaryKey: true },
        { name: 'total', type: 'decimal', nullable: false, primaryKey: false }
      ]
    }
  ]
};

const postgresSchema: DatabaseSchema = {
  kind: 'postgres',
  label: 'pg-db',
  tables: [
    {
      name: 'users',
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'name', type: 'text', nullable: false, primaryKey: false }
      ]
    }
  ]
};

const mongodbSchema: DatabaseSchema = {
  kind: 'mongodb',
  label: 'mongo-db',
  tables: [
    {
      name: 'orders',
      columns: [
        { name: '_id', type: 'objectid', nullable: true, primaryKey: true },
        { name: 'customer', type: 'string', nullable: true, primaryKey: false },
        { name: 'total', type: 'number', nullable: true, primaryKey: false }
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

  it('guides MySQL with backend-specific instructions', () => {
    const prompt = buildSystemPrompt('Table orders: id int, total decimal', 'mysql');

    expect(prompt).toContain('Generate only read-only MySQL');
    expect(prompt).toContain('include exactly one fenced ```sql block');
  });

  it('guides PostgreSQL with backend-specific instructions', () => {
    const prompt = buildSystemPrompt('Table users: id integer, name text', 'postgres');

    expect(prompt).toContain('Generate only read-only PostgreSQL');
    expect(prompt).toContain('include exactly one fenced ```sql block');
  });

  it('guides MongoDB with JSON instructions', () => {
    const prompt = buildSystemPrompt('MongoDB collection orders: _id objectid, customer string', 'mongodb');

    expect(prompt).toContain('safe MongoDB');
    expect(prompt).toContain('include exactly one fenced ```json block');
    expect(prompt).toContain('"collection"');
    expect(prompt).toContain('"method"');
  });

  it('guides Elasticsearch with JSON instructions', () => {
    const prompt = buildSystemPrompt('Elasticsearch index orders: customer keyword, total double', 'elasticsearch');

    expect(prompt).toContain('safe Elasticsearch search request');
    expect(prompt).toContain('include exactly one fenced ```json block');
    expect(prompt).toContain('Never generate writes, deletes, updates');
  });

  it('extracts sql blocks for relational backends and json blocks for MongoDB/ES', () => {
    const sqlContent = 'Here is the query:\n```sql\nselect * from orders;\n```\nDone.';
    const jsonContent = 'Here is the query:\n```json\n{"collection":"orders","method":"find","body":{"filter":{}}}\n```\nDone.';

    expect(extractQueryBlock(sqlContent, 'mysql')).toBe('select * from orders;');
    expect(extractQueryBlock(sqlContent, 'postgres')).toBe('select * from orders;');
    expect(extractQueryBlock(sqlContent, 'sqlite')).toBe('select * from orders;');
    expect(extractQueryBlock(jsonContent, 'mongodb')).toBe('{"collection":"orders","method":"find","body":{"filter":{}}}');
    expect(extractQueryBlock(jsonContent, 'elasticsearch')).toBe('{"collection":"orders","method":"find","body":{"filter":{}}}');
  });

  it('removes both sql and json blocks from chat text', () => {
    const content = 'Before\n```sql\nselect 1;\n```\nMiddle\n```json\n{"key":"value"}\n```\nAfter';
    const result = removeSqlBlocks(content);
    expect(result).not.toContain('select 1');
    expect(result).not.toContain('{"key":"value"}');
    expect(result).toContain('Before');
    expect(result).toContain('Middle');
    expect(result).toContain('After');
  });

  it('guides result answers to be chatty while keeping SQL/JSON out of chat', () => {
    const prompt = buildResultAnalysisPrompt();

    expect(prompt).toContain('start with the direct takeaway');
    expect(prompt).toContain('trends, outliers, ranking, gaps, caveats, and comparisons');
    expect(prompt).toContain('ending with one natural follow-up');
    expect(prompt).toContain('Do not include SQL, query text, fenced code blocks, JSON, or implementation details');
  });

  it('guides result answers with backend-specific context', () => {
    const mysqlPrompt = buildResultAnalysisPrompt('mysql');
    expect(mysqlPrompt).toContain('read-only MySQL');

    const mongoPrompt = buildResultAnalysisPrompt('mongodb');
    expect(mongoPrompt).toContain('read-only MongoDB');
    expect(mongoPrompt).toContain('MongoDB request JSON out of the chat answer');
  });

  it('allows validated data writes in prompts only when SAFE mode is off', () => {
    const sqlitePrompt = buildSystemPrompt('orders(id, total)', 'sqlite', 'manual');
    expect(sqlitePrompt).toContain('SAFE mode is off');
    expect(sqlitePrompt).toContain('table row inserts, updates, deletes, or replaces');

    const mysqlPrompt = buildSystemPrompt('orders(id, total)', 'mysql', 'manual');
    expect(mysqlPrompt).toContain('SAFE mode is off');
    expect(mysqlPrompt).toContain('table row inserts');

    const mongoPrompt = buildSystemPrompt('MongoDB collection orders: customer string', 'mongodb', 'manual');
    expect(mongoPrompt).toContain('SAFE mode is off');
    expect(mongoPrompt).toContain('insertOne, updateOne, and deleteOne');
  });

  it('gives schema questions a next-question ramp', () => {
    const response = buildLocalAssistantResponse('what tables are available?', sqliteSchema);

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

  it('builds local fallback SQL queries for MySQL', () => {
    const response = buildLocalAssistantResponse('show orders', mysqlSchema);

    expect(response.query?.query).toContain('select * from "orders"');
    expect(response.query?.validation.safe).toBe(true);
  });

  it('builds local fallback SQL queries for PostgreSQL', () => {
    const response = buildLocalAssistantResponse('show users', postgresSchema);

    expect(response.query?.query).toContain('select * from "users"');
    expect(response.query?.validation.safe).toBe(true);
  });

  it('builds local fallback MongoDB queries', () => {
    const response = buildLocalAssistantResponse('show orders', mongodbSchema);

    expect(response.content).toContain('MongoDB');
    expect(response.query?.query).toContain('"collection": "orders"');
    expect(response.query?.query).toContain('"method": "find"');
    expect(response.query?.validation.safe).toBe(true);
  });

  it('builds local fallback MongoDB count query for count prompts', () => {
    const response = buildLocalAssistantResponse('how many orders are there?', mongodbSchema);

    expect(response.query?.query).toContain('"method": "count"');
    expect(response.query?.query).toContain('"collection": "orders"');
    expect(response.query?.query).toContain('"filter": {}');
    expect(response.query?.validation.safe).toBe(true);
  });

  it('builds local fallback Elasticsearch searches', () => {
    const response = buildLocalAssistantResponse('show orders', elasticsearchSchema);

    expect(response.content).toContain('Elasticsearch cluster');
    expect(response.query?.query).toContain('"index": "orders"');
    expect(response.query?.validation.safe).toBe(true);
  });
});
