import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/server/accountStore';
import { conversationContext, invalidateKnowledge, parseKnowledge } from '../src/server/conversationContext';
import type { ConnectionKnowledge } from '../src/shared/types';
import { DEFAULT_WEB_MODEL } from '../src/server/config';

function store() {
  const store = new AccountStore({ sessionTtlMs: 60_000, defaultModel: 'fixture', secretKey: 'fixture-secret' });
  store.ensureDevelopmentUser();
  return store;
}

describe('durable conversation invariants', () => {
  it('uses the measured default for new settings and preserves an explicit model choice', () => {
    const accounts = new AccountStore({ sessionTtlMs: 60_000, defaultModel: DEFAULT_WEB_MODEL, secretKey: 'fixture-secret' });
    accounts.ensureDevelopmentUser();
    expect(accounts.getSettings('dev-user')).toMatchObject({ model: 'google/gemini-2.5-flash', effortLevel: 'low' });
    accounts.updateSettings('dev-user', { model: 'chosen-model', effortLevel: 'high' });
    accounts.ensureDevelopmentUser();
    expect(accounts.getSettings('dev-user')).toMatchObject({ model: 'chosen-model', effortLevel: 'high' });
  });
  it('recovers a claimed turn as a durable interrupted card and keeps partial evidence', () => {
    const accounts = store();
    const chat = accounts.createChat('dev-user', 'db', { connectionId: 'db', label: 'Historical source', kind: 'sqlite', capturedAt: '2026-09-08T00:00:00Z' });
    accounts.claimTurn('dev-user', 'turn', chat.id, 'request', { id: 'user', role: 'user', content: 'Count distinct customers', createdAt: '2026-09-08T00:00:00Z' }, 'assistant');
    const pending = accounts.getTurn('dev-user', 'turn')!;
    pending.artifacts = [{ kind: 'query-result', queryId: 'result', query: 'SELECT 3 AS count', result: { columns: ['count'], rows: [{ count: 3 }], rowCount: 1, elapsedMs: 1 } }];
    pending.intent = { action: 'rerun', artifactId: 'result', messageId: 'older-answer' };
    accounts.saveTurn('dev-user', pending);
    accounts.interruptPendingTurns();
    const recovered = accounts.getChat('dev-user', chat.id)!;
    expect(recovered.latestTurn).toMatchObject({ id: 'turn', status: 'error', question: 'Count distinct customers' });
    expect(recovered.messages[1]).toMatchObject({ id: 'assistant', turn: { id: 'turn', status: 'error', question: 'Count distinct customers', intent: pending.intent } });
    expect(recovered.artifacts[0].queryId).toBe('result');
    expect(accounts.claimTurn('dev-user', 'duplicate', chat.id, 'request', { id: 'u2', role: 'user', content: 'duplicate', createdAt: '' }, 'a2')).toEqual({ turnId: 'turn', created: false });
    expect(accounts.getTurn('another-owner', 'turn')).toBeNull();
    expect(accounts.getChat('another-owner', chat.id)).toBeNull();
    expect(() => accounts.updateMessageMetadata('another-owner', chat.id, 'assistant', { pinned: true })).toThrow('Answer not found');
    expect(accounts.getChat('dev-user', chat.id)?.messages).toHaveLength(2);
  });

  it('preserves original source after connection deletion and isolates connection knowledge', () => {
    const accounts = store();
    const connection = accounts.createConnection('dev-user', { id: '', kind: 'sqlite', label: 'Original source', databasePath: '/tmp/example.db', createdAt: '' });
    const chat = accounts.createChat('dev-user', connection.id);
    accounts.saveConnectionKnowledge('dev-user', connection.id, { version: 1, glossary: [{ id: 'revenue', term: 'Revenue', definition: 'Gross less refunds', provenance: 'Owner approved', updatedAt: '' }], examples: [], updatedAt: '' });
    expect(accounts.getConnectionKnowledge('another-owner', connection.id).glossary).toEqual([]);
    accounts.deleteConnection('dev-user', connection.id);
    expect(accounts.getChat('dev-user', chat.id)?.source).toMatchObject({ label: 'Original source', kind: 'sqlite', connectionId: connection.id });
    expect(accounts.getConnectionKnowledge('dev-user', connection.id).glossary).toEqual([]);
    expect(() => accounts.updateChat('dev-user', chat.id, { connectionId: 'other' })).toThrow('original source');
  });

  it('retains old user definitions and explicitly selected earlier answers without promoting policy', () => {
    const accounts = store();
    const chat = accounts.createChat('dev-user');
    chat.messages = [
      { id: 'definition', role: 'user', content: 'Use net revenue, excluding refunds, in UTC.', createdAt: '' },
      { id: 'selected', role: 'assistant', content: 'The denominator is 12 customers.', createdAt: '' },
      ...Array.from({ length: 70 }, (_, index) => ({ id: String(index), role: 'user' as const, content: 'Question ' + index, createdAt: '' }))
    ];
    const context = conversationContext(chat, 'Explain the calculation', { action: 'explain', messageId: 'selected' });
    expect(context.some(message => message.content?.includes('excluding refunds'))).toBe(true);
    expect(context.some(message => message.content?.includes('12 customers'))).toBe(true);
    expect(context.every(message => message.role !== 'system')).toBe(true);
    expect(context.at(-1)?.content).toBe('Explain the calculation');
    const target = JSON.parse(context.at(-2)!.content!.split('\n').slice(1).join('\n'));
    expect(target).toMatchObject({ intent: { messageId: 'selected' }, selectedQuestion: 'Use net revenue, excluding refunds, in UTC.', selectedAnswer: 'The denominator is 12 customers.' });
    expect(target.selectedQuestion).not.toBe('Question 69');
  });

  it('loads older referenced evidence with a recent history page without loading unrelated results', () => {
    const accounts = store();
    const chat = accounts.createChat('dev-user');
    const result = (queryId: string, messageId: string) => ({ kind: 'query-result' as const, queryId, messageId, query: 'SELECT 1', result: { columns: ['n'], rows: [{ n: 1 }], rowCount: 1, elapsedMs: 1 } });
    accounts.updateChat('dev-user', chat.id, {
      messages: [{ id: 'old', role: 'assistant', content: 'Old result', createdAt: '' }, { id: 'latest', role: 'assistant', content: '```chart\n{"resultId":"old-result","chartType":"bar"}\n```', createdAt: '' }],
      artifacts: [result('old-result', 'old'), result('unrelated', 'older-unloaded-message')]
    });
    const page = accounts.getChatPage('dev-user', chat.id, { limit: 1 });
    expect(page?.messages.map(message => message.id)).toEqual(['latest']);
    expect(page?.artifacts.map(artifact => artifact.queryId)).toEqual(['old-result']);
  });

  it('requires explicit reverification after schema changes even if a schema returns or glossary is edited', () => {
    const original: ConnectionKnowledge = { version: 1, glossary: [], examples: [{ id: 'count', question: 'Count', query: 'SELECT count(*) FROM users', provenance: 'Owner verified', verifiedAt: 'old', schemaFingerprint: 'schema-a' }], schemaFingerprint: 'schema-a', updatedAt: '' };
    const invalid = invalidateKnowledge(original, 'schema-b');
    const flippedBack = invalidateKnowledge(invalid, 'schema-a');
    expect(flippedBack.examples[0].invalidatedAt).toBeTruthy();
    const edited = parseKnowledge({ glossary: [], examples: flippedBack.examples }, flippedBack);
    expect(edited.examples[0].invalidatedAt).toBe(invalid.examples[0].invalidatedAt);
    expect(parseKnowledge({ glossary: [], examples: [{ ...flippedBack.examples[0], reverify: true }] }, flippedBack).examples[0].invalidatedAt).toBeUndefined();
  });
});
