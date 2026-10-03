import { describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../src/server/accountStore';
import { SupabaseAccountStore } from '../src/server/supabaseAccountStore';
import { SavedDataReadLimitError, SAVED_READ_BYTES, CONTEXT_ARTIFACT_BYTES, isContextRelevant, isContextRetained } from '../src/server/savedDataLimits';
import { conversationContext } from '../src/server/conversationContext';
import { WebSessionStore } from '../src/server/sessionStore';
import type { ChatMessage, QueryResultArtifact } from '../src/shared/types';
const options = { url: 'https://example.supabase.co', publishableKey: 'public', serviceRoleKey: 'private', secretKey: 'fixture-secret-at-least-thirty-two-characters', defaultModel: 'fixture', sessionTtlMs: 60000 };
const header = { id: 'chat', user_id: 'owner', title: 'Saved', message_count: 1001, artifact_count: 1, created_at: '', updated_at: '' };
const json = (body: unknown) => new Response(JSON.stringify(body));
const message = (id: string, content: string, role: ChatMessage['role'] = 'user'): ChatMessage => ({ id, content, role, createdAt: '' });
const artifact = (queryId: string, messageId: string): QueryResultArtifact => ({ kind: 'query-result', queryId, messageId, query: 'SELECT 1', result: { columns: ['n'], rows: [{ n: 1 }], rowCount: 1, elapsedMs: 1 } });
function mock(handler: (url: URL) => Response) { return vi.fn<typeof fetch>(async input => handler(new URL(String(input)))); }
function streamOversize(bytes: number, canceled: () => void) {
  let remaining = bytes;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (!remaining) { controller.close(); return; }
    const size = Math.min(1024 * 1024, remaining); remaining -= size;
    controller.enqueue(new Uint8Array(size).fill(120)); // Invalid JSON: parsing must never precede the byte ceiling.
  }, cancel: canceled }));
}

describe('bounded saved data reads', () => {
  it('cancels an oversized streamed response before attempting JSON parsing', async () => {
    const cancel = vi.fn();
    const fetch = mock(url => url.pathname.endsWith('dbchat_chats') ? json([header]) : streamOversize(SAVED_READ_BYTES + 1, cancel));
    await expect(new SupabaseAccountStore({ ...options, fetch }).getChat('owner', 'chat')).rejects.toBeInstanceOf(SavedDataReadLimitError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('requires retention tables and maps only the fixed saved-read SQL marker', async () => {
    const fetch = mock(url => url.pathname.endsWith('dbchat_retained_usage') ? new Response('missing', { status: 404 }) : json([]));
    await expect(new SupabaseAccountStore({ ...options, fetch }).assertStorageReady()).rejects.toThrow('Apply all DB Chat migrations');
    expect(fetch.mock.calls.some(([url]) => String(url).includes('dbchat_retained_usage'))).toBe(true);
    const limited = new SupabaseAccountStore({ ...options, fetch: mock(() => new Response(JSON.stringify({ message: 'DBCHAT_SAVED_READ_LIMIT' }), { status: 400 })) });
    await expect(limited.saveTurn('owner', { id: 'turn', status: 'running', events: [] }, 'worker')).rejects.toBeInstanceOf(SavedDataReadLimitError);
  });

  it('shares the full-chat ceiling across independently small pagination responses', async () => {
    const offsets: string[] = [];
    const page = Array.from({ length: 500 }, (_, id) => ({ body: message(String(id), 'x'.repeat(18000)) }));
    const fetch = mock(url => {
      if (url.pathname.endsWith('dbchat_chats')) return json([header]);
      if (url.pathname.endsWith('dbchat_messages')) { offsets.push(url.searchParams.get('offset')!); return json(page); }
      return json([]);
    });
    await expect(new SupabaseAccountStore({ ...options, fetch }).getChat('owner', 'chat')).rejects.toBeInstanceOf(SavedDataReadLimitError);
    expect(offsets).toEqual(['0', '500']);
  });

  it('continues to read 1001 small historical messages across all pages', async () => {
    const fetch = mock(url => {
      if (url.pathname.endsWith('dbchat_chats')) return json([header]);
      if (url.pathname.endsWith('dbchat_messages')) {
        const offset = Number(url.searchParams.get('offset'));
        return json(Array.from({ length: Math.min(500, 1001 - offset) }, (_, n) => ({ body: message(String(offset + n), 'hello') })));
      }
      return json([]);
    });
    expect((await new SupabaseAccountStore({ ...options, fetch }).getChat('owner', 'chat'))?.messages).toHaveLength(1001);
  });

  it('rejects oversized page artifacts without returning a silently incomplete page', async () => {
    const fetch = mock(url => {
      if (url.pathname.endsWith('dbchat_chats')) return json([header]);
      if (url.pathname.endsWith('dbchat_messages')) return json([{ body: message('answer', 'answer', 'assistant') }]);
      if (url.pathname.endsWith('dbchat_artifacts')) return streamOversize(CONTEXT_ARTIFACT_BYTES + 1, () => {});
      return json([]);
    });
    await expect(new SupabaseAccountStore({ ...options, fetch }).getChatPage('owner', 'chat', { limit: 1 })).rejects.toThrow('Reduce the history page size');
  });

  it('reads only the changed metadata message and summary after an old-answer edit', async () => {
    const urls: URL[] = [];
    const fetch = mock(url => { urls.push(url);
      if (url.pathname.endsWith('dbchat_chats')) return json([header]);
      if (url.pathname.endsWith('dbchat_messages')) return json([{ body: { ...message('old', 'saved', 'assistant'), pinned: true } }]);
      return json(null);
    });
    const store = new SupabaseAccountStore({ ...options, fetch });
    expect((await store.updateMessageMetadata('owner', 'chat', 'old', { pinned: true })).messages).toEqual([expect.objectContaining({ id: 'old', pinned: true })]);
    expect(urls.find(url => url.pathname.endsWith('dbchat_messages'))?.searchParams.get('body->>id')).toBe('eq.old');
    expect(urls.some(url => url.pathname.endsWith('dbchat_artifacts'))).toBe(false);
    urls.length = 0;
    expect(await store.updateChat('owner', 'chat', { pinned: true })).toMatchObject({ messages: [], artifacts: [] });
    expect(urls.some(url => url.pathname.endsWith('dbchat_messages'))).toBe(false);
  });

  it('preserves selected old answers, their preceding questions, definitions and pins with projected reads', async () => {
    const messages = [message('definition', 'Use net revenue in UTC.'), message('question', 'How many in France?'), { ...message('selected', 'Twelve.', 'assistant'), turn: { id: 'legacy-turn', status: 'complete' as const, question: undefined! } }, { ...message('pinned', 'A saved answer', 'assistant'), pinned: true }, ...Array.from({ length: 70 }, (_, n) => message('recent' + n, 'Question ' + n))];
    const result = artifact('result', 'selected');
    const urls: URL[] = [];
    const fetch = mock(url => { urls.push(url);
      expect(url.searchParams.get('user_id')).toBe('eq.owner');
      if (url.pathname.endsWith('dbchat_chats')) return json([header]);
      if (url.pathname.endsWith('dbchat_turns')) return json([]);
      if (url.pathname.endsWith('dbchat_artifacts')) {
        if (url.searchParams.get('select') === 'messageId:body->>messageId') return json([{ messageId: 'selected' }]);
        return json([{ body: result }]);
      }
      let rows = messages.map((body, position) => ({ ...body, position }));
      if (url.searchParams.has('body->>id')) rows = rows.filter(row => 'eq.' + row.id === url.searchParams.get('body->>id'));
      else if (url.searchParams.has('position')) rows = rows.filter(row => row.role === 'user' && row.position <= Number(url.searchParams.get('position')!.slice(4)));
      else rows = rows.filter(isContextRelevant).filter(row => !url.searchParams.get('and')?.includes('imatch') || isContextRetained(row));
      return json(rows.reverse().slice(0, Number(url.searchParams.get('limit'))).map(({turn,...row}) => ({...row,turnId:turn?.id,turnStatus:turn?.status,turnQuestion:turn?.question})));
    });
    const context = (await new SupabaseAccountStore({ ...options, fetch }).getChatContext('owner', 'chat', { messageId: 'selected', artifactId: 'result' }))!;
    const intent = { action: 'rerun' as const, messageId: 'selected', artifactId: 'result' };
    expect(conversationContext(context, 'Again', intent)).toEqual(conversationContext({ ...context, messages, artifacts: [result] }, 'Again', intent));
    expect(context.messages.some(item => item.id === 'recent0')).toBe(false);
    for (const url of urls.filter(url => url.pathname.endsWith('dbchat_messages'))) {
      expect(url.searchParams.get('select')).not.toContain('turn:body->turn');
      expect(url.searchParams.get('limit')).not.toBe('500');
    }
    expect(urls.filter(url => url.pathname.endsWith('dbchat_artifacts')).every(url => url.searchParams.has('body->>queryId') || url.searchParams.has('body->>messageId'))).toBe(true);
  });

  it('keeps legacy saved artifacts without message linkage available to context tools in both stores', async () => {
    const legacy = { ...artifact('legacy', 'unused'), messageId: undefined };
    const calls: URL[] = [];
    const fetch = mock(url => { calls.push(url);
      if (url.pathname.endsWith('dbchat_chats')) return json([header]);
      if (url.pathname.endsWith('dbchat_artifacts') && url.searchParams.get('body->>messageId') === 'is.null') return json([{ body: legacy }]);
      return json([]);
    });
    expect((await new SupabaseAccountStore({ ...options, fetch }).getChatContext('owner', 'chat'))?.artifacts).toEqual([legacy]);
    const query = calls.find(url => url.pathname.endsWith('dbchat_artifacts'))!;
    expect(query.searchParams.get('user_id')).toBe('eq.owner');
    expect(query.searchParams.get('chat_id')).toBe('eq.chat');
    const local = new AccountStore(options); local.ensureDevelopmentUser();
    const chat = local.createChat('dev-user'); local.updateChat('dev-user', chat.id, { artifacts: [legacy] });
    expect(local.getChatContext('dev-user', chat.id)?.artifacts).toEqual([legacy]);
  });

  it('shares the artifact byte ceiling between linked and legacy unlinked context results', async () => {
    const fetch = mock(url => {
      if (url.pathname.endsWith('dbchat_chats')) return json([header]);
      if (url.pathname.endsWith('dbchat_messages')) return json([{ ...message('answer', 'Saved answer', 'assistant'), position: 1 }]);
      if (url.pathname.endsWith('dbchat_artifacts')) {
        const unlinked = url.searchParams.get('body->>messageId') === 'is.null';
        return json([{ body: { ...artifact(unlinked ? 'old' : 'linked', 'answer'), query: 'x'.repeat((unlinked ? 4 : 5) * 1024 * 1024), ...(unlinked ? { messageId: undefined } : {}) } }]);
      }
      return json([]);
    });
    await expect(new SupabaseAccountStore({ ...options, fetch }).getChatContext('owner', 'chat')).rejects.toBeInstanceOf(SavedDataReadLimitError);
  });

  it('scopes a live-result fallback to the owned chat and never loads the entire snapshot', async () => {
    const urls: URL[] = [];
    const fetch = mock(url => { urls.push(url);
      if (url.searchParams.get('user_id') !== 'eq.owner') return json([]);
      if (url.pathname.endsWith('dbchat_chats')) return json([header]);
      if (url.pathname.endsWith('dbchat_turns')) return json([{ artifacts: [artifact('live', 'answer')] }]);
      return json([]);
    });
    const store = new SupabaseAccountStore({ ...options, fetch });
    expect(await store.getChatArtifact('owner', 'chat', 'live')).toMatchObject({ queryId: 'live' });
    expect(urls.find(url => url.pathname.endsWith('dbchat_turns'))?.searchParams.get('select')).toBe('artifacts:snapshot->artifacts');
    expect(urls.find(url => url.pathname.endsWith('dbchat_turns'))?.searchParams.get('chat_id')).toBe('eq.chat');
    expect(await store.getChatArtifact('other', 'chat', 'live')).toBeNull();
    expect(await store.hasChat('other', 'chat')).toBe(false);
    expect(await store.getChatSummary('other', 'chat')).toBeNull();
  });

  it('preserves local context semantics and fails explicitly when old short definitions exceed candidate capacity', () => {
    const store = new AccountStore({ ...options }); store.ensureDevelopmentUser();
    const chat = store.createChat('dev-user');
    const messages = [message('definition', 'x'.repeat(8001) + ' definition'), message('question', 'Earlier scope?'), message('answer', 'Earlier answer', 'assistant'), ...Array.from({ length: 70 }, (_, n) => message(String(n), 'Question ' + n))];
    const full = store.updateChat('dev-user', chat.id, { messages, artifacts: [artifact('saved', 'answer')] });
    const context = store.getChatContext('dev-user', chat.id, { messageId: 'answer', artifactId: 'saved' })!;
    const intent = { action: 'rerun' as const, messageId: 'answer', artifactId: 'saved' };
    expect(conversationContext(context, 'Again', intent)).toEqual(conversationContext(full, 'Again', intent));
    expect(store.getChatContext('other', chat.id)).toBeNull();
    store.updateChat('dev-user', chat.id, { messages: Array.from({ length: 129 }, (_, n) => message(String(n), 'Use UTC')) });
    expect(() => store.getChatContext('dev-user', chat.id)).toThrow(SavedDataReadLimitError);
  });
});

describe('legacy viewer handle bounds', () => {
  it('reuses one handle when a principal repeatedly omits its cookie and caps cached viewers', () => {
    const store = new WebSessionStore(60000);
    try {
      const principal = { id: 'owner', roles: [] };
      const first = store.getOrCreateSession(principal);
      for (let n = 0; n < 100; n++) expect(store.getOrCreateSession(principal)).toEqual(first);
      expect(store.getOrCreateSession(principal, first.id)).toEqual({ id: first.id, isNew: false });
      for (let n = 0; n < 10000; n++) store.getOrCreateSession({ id: 'p' + n, roles: [] });
      expect(store.getOrCreateSession(principal).id).not.toBe(first.id);
    } finally { store.close(); }
  });
});
