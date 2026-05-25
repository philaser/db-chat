import { describe, expect, it } from 'vitest';
import { validateMongoDBReadOnlyQuery } from '../src/main/connectors/mongodbValidation';

describe('validateMongoDBReadOnlyQuery', () => {
  it('allows read-only find JSON', () => {
    const validation = validateMongoDBReadOnlyQuery(JSON.stringify({
      collection: 'users',
      method: 'find',
      body: { filter: { name: 'Ada' }, limit: 25 }
    }), 'safe');

    expect(validation.safe).toBe(true);
    expect(validation.normalizedQuery).toContain('"collection": "users"');
  });

  it('allows read-only aggregate JSON', () => {
    const validation = validateMongoDBReadOnlyQuery(JSON.stringify({
      collection: 'orders',
      method: 'aggregate',
      body: { pipeline: [{ $match: { total: { $gt: 100 } } }, { $group: { _id: '$customer', count: { $sum: 1 } } }] }
    }), 'safe');

    expect(validation.safe).toBe(true);
  });

  it('allows read-only count JSON', () => {
    const validation = validateMongoDBReadOnlyQuery(JSON.stringify({
      collection: 'users',
      method: 'count',
      body: { filter: { active: true } }
    }), 'safe');

    expect(validation.safe).toBe(true);
    expect(validation.normalizedQuery).toContain('"method": "count"');
  });

  it('allows count with omitted filter', () => {
    const validation = validateMongoDBReadOnlyQuery(JSON.stringify({
      collection: 'users',
      method: 'count',
      body: {}
    }), 'safe');

    expect(validation.safe).toBe(true);
  });

  it('rejects non-positive find limit', () => {
    const validation = validateMongoDBReadOnlyQuery(JSON.stringify({
      collection: 'users',
      method: 'find',
      body: { filter: {}, limit: 0 }
    }), 'safe');

    expect(validation.safe).toBe(false);
    expect(validation.reason).toContain('positive integer');
  });

  it('allows missing find limit', () => {
    const validation = validateMongoDBReadOnlyQuery(JSON.stringify({
      collection: 'users',
      method: 'find',
      body: { filter: {} }
    }), 'safe');

    expect(validation.safe).toBe(true);
  });

  it('rejects aggregate $limit over 500', () => {
    const validation = validateMongoDBReadOnlyQuery(JSON.stringify({
      collection: 'users',
      method: 'aggregate',
      body: { pipeline: [{ $match: {} }, { $limit: 600 }] }
    }), 'safe');

    expect(validation.safe).toBe(false);
    expect(validation.reason).toContain('500');
  });

  it('rejects aggregate $limit <= 0', () => {
    const validation = validateMongoDBReadOnlyQuery(JSON.stringify({
      collection: 'users',
      method: 'aggregate',
      body: { pipeline: [{ $match: {} }, { $limit: 0 }] }
    }), 'safe');

    expect(validation.safe).toBe(false);
  });

  it('accepts aggregate without $limit', () => {
    const validation = validateMongoDBReadOnlyQuery(JSON.stringify({
      collection: 'users',
      method: 'aggregate',
      body: { pipeline: [{ $match: {} }, { $group: { _id: '$type' } }] }
    }), 'safe');

    expect(validation.safe).toBe(true);
  });

  it.each([
    JSON.stringify({ collection: 'users', method: 'find', body: { limit: 600, filter: {} } }),
    JSON.stringify({ collection: 'users', method: 'aggregate', body: { pipeline: [{ $out: 'exported' }] } }),
    JSON.stringify({ collection: 'users', method: 'aggregate', body: { pipeline: [{ $merge: 'target' }] } }),
    JSON.stringify({ collection: 'users', method: 'aggregate', body: { pipeline: [{ $function: {} }] } }),
    JSON.stringify({ collection: 'users', method: 'aggregate', body: { pipeline: [{ $where: 'true' }] } }),
    JSON.stringify({ path: '/admin', method: 'find', body: {} }),
    JSON.stringify({ collection: 'users', method: 'find', body: { function: 'eval' } }),
    JSON.stringify({ collection: 'users', method: 'find', body: { javascript: 'true' } }),
  ])('blocks unsafe MongoDB query: %s', (query) => {
    expect(validateMongoDBReadOnlyQuery(query, 'safe').safe).toBe(false);
  });

  it('allows count as a read in manual mode', () => {
    const validation = validateMongoDBReadOnlyQuery(JSON.stringify({
      collection: 'users',
      method: 'count',
      body: { filter: { active: true } }
    }), 'manual');

    expect(validation.safe).toBe(true);
    expect(validation.reason).toBe('Validated MongoDB read allowed with SAFE mode off.');
  });

  it.each([
    JSON.stringify({ collection: 'users', method: 'insertOne', document: { name: 'Ada' } }),
    JSON.stringify({ collection: 'users', method: 'updateOne', filter: { _id: '1' }, update: { $set: { name: 'Ada' } } }),
    JSON.stringify({ collection: 'users', method: 'deleteOne', filter: { _id: '1' } })
  ])('allows document writes with SAFE mode off: %s', (query) => {
    expect(validateMongoDBReadOnlyQuery(query, 'manual').safe).toBe(true);
  });

  it.each([
    JSON.stringify({ collection: 'users', method: 'drop', body: {} }),
    JSON.stringify({ collection: 'users', method: 'insertOne', document: { $where: 'true' } }),
    JSON.stringify({ path: '/admin/dropDatabase', method: 'deleteOne', filter: {} }),
  ])('blocks unsafe write shapes with SAFE mode off: %s', (query) => {
    expect(validateMongoDBReadOnlyQuery(query, 'manual').safe).toBe(false);
  });
});
