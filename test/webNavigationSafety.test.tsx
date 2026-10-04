import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { App, ChatWorkspace, ConnectionForm, DataInspector, KnowledgeEditor } from '../src/web/App.js';
import type { ChatMessage, ConnectionKnowledge, WebChatSession } from '../src/shared/types.js';

const connection = { id: 'db', label: 'Analytics', kind: 'postgres', status: 'ready' as const, readOnly: true as const, hasSavedSecret: true, createdAt: '2026-10-03' };
const otherConnection = { ...connection, id: 'other-db', label: 'Other source' };
const bootstrap = {
  ready: true, user: { id: 'u', email: 'u@example.test', displayName: 'Reader', emailVerified: true, createdAt: '2026-10-03' },
  connections: [connection, otherConnection], activeConnectionId: 'other-db', settings: { provider: 'openrouter' as const, model: 'fixture', effortLevel: 'medium' as const },
  inference: { provider: 'openrouter' as const, model: 'fixture', credentialSource: 'internal' as const, hasUserKey: false, userKeyUiEnabled: false, canChangeModel: false, models: [{ id: 'fixture', name: 'Fixture' }], status: 'ready' as const },
  capabilities: { queryResults: true, csvExport: true, charts: true }, limits: { maxHistoryMessages: 40, maxMessageChars: 8000, maxResultRows: 100, maxResultBytes: 1048576 }
};
const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'First question', createdAt: '2026-10-03T12:00:00Z' },
  { id: 'a1', role: 'assistant', content: 'First answer', createdAt: '2026-10-03T12:00:01Z' }
];
const savedChat: WebChatSession = { id: 'chat1', connectionId: 'db', title: 'First question', messages, artifacts: [], createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:01Z', messageCount: 2, artifactCount: 0 };
const props = { bootstrap, onNavigate: vi.fn(), newChatKey: 0, chatId: 'chat1', onCreateChat: vi.fn(), onChatChanged: vi.fn() };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
class FixtureStream extends EventTarget {
  static CLOSED = 2;
  static streams: FixtureStream[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  constructor(public url: string) { super(); FixtureStream.streams.push(this); }
  close() { this.readyState = 2; }
  fail() { this.close(); this.onerror?.(); }
  emit(type: string, data: unknown, eventId: number) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data), lastEventId: String(eventId) })); }
}
function captureDom(name: string) {
  if (!process.env.DBCHAT_UI_DOM_OUTPUT) return;
  fs.mkdirSync(process.env.DBCHAT_UI_DOM_OUTPUT, { recursive: true });
  fs.writeFileSync(path.join(process.env.DBCHAT_UI_DOM_OUTPUT, name + '.html'), document.documentElement.outerHTML);
}
beforeEach(() => {
  FixtureStream.streams = [];
  vi.stubGlobal('EventSource', FixtureStream);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); });

describe('chat navigation safety', () => {
  it('sends follow-ups to the chat source even when another connection is active', async () => {
    const fetcher = vi.fn(async (url: string) => url === '/api/v1/chat/turns' ? json({ turnId: 'turn' }) : json({ chat: savedChat }));
    vi.stubGlobal('fetch', fetcher);
    render(<ChatWorkspace {...props} />);
    await screen.findByText('First answer');
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Follow-up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send question' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/v1/chat/turns', expect.objectContaining({ body: expect.stringContaining('"connectionId":"db"') })));
    captureDom('chat-bound-source');
  });

  it('detaches navigation without aborting an accepted durable turn and clears root history', async () => {
    const fetcher = vi.fn(async (url: string) => url === '/api/v1/chat/turns' ? json({ turnId: 'turn' }) : json({ chat: savedChat }));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<ChatWorkspace {...props} />);
    await screen.findByText('First answer');
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Still working' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send question' }));
    await waitFor(() => expect(FixtureStream.streams).toHaveLength(1));
    view.rerender(<ChatWorkspace {...props} newChatKey={1} chatId={undefined} />);
    expect(FixtureStream.streams[0].readyState).toBe(FixtureStream.CLOSED);
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/abort'))).toBe(false);
    expect(screen.queryByText('First answer')).not.toBeInTheDocument();
    expect(screen.queryByText('Still working')).not.toBeInTheDocument();
    captureDom('new-chat-detached');
  });

  it('honors an explicit Stop while the submission response is pending', async () => {
    const accepted = deferred<Response>();
    const fetcher = vi.fn(async (url: string) => url === '/api/v1/chat/turns' ? accepted.promise : url.endsWith('/abort') ? json({ ok: true }) : json({ chat: savedChat }));
    vi.stubGlobal('fetch', fetcher);
    render(<ChatWorkspace {...props} />);
    await screen.findByText('First answer');
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Cancel this question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send question' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }));
    await act(async () => accepted.resolve(json({ turnId: 'accepted' })));
    expect(fetcher).toHaveBeenCalledWith('/api/v1/chat/turns/accepted/abort', expect.objectContaining({ method: 'POST' }));
    expect(FixtureStream.streams).toHaveLength(0);
  });

  it('does not merge an earlier history page into a different chat', async () => {
    const older = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('before=') ? older.promise : json({ chat: url.includes('chat2') ? { ...savedChat, id: 'chat2', messages: [{ ...messages[1], id: 'a2', content: 'Second chat answer' }] } : { ...savedChat, historyHasMore: true, historyCursor: 'u1' } })));
    const view = render(<ChatWorkspace {...props} />);
    await screen.findByText('First answer');
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    view.rerender(<ChatWorkspace {...props} chatId="chat2" />);
    await screen.findByText('Second chat answer');
    await act(async () => older.resolve(json({ chat: { ...savedChat, messages: [{ ...messages[0], id: 'old', content: 'Old chat history' }] } })));
    expect(screen.queryByText('Old chat history')).not.toBeInTheDocument();
    expect(screen.getByText('Second chat answer')).toBeInTheDocument();
  });

  it('reduces oversized initial and older pages while keeping messages, artifacts and the returned cursor', async () => {
    const result = (queryId: string, messageId: string, purpose: string) => ({ kind: 'query-result' as const, queryId, messageId, purpose, query: 'SELECT 1', result: { columns: ['n'], rows: [{ n: 1 }], rowCount: 1, elapsedMs: 1 } });
    const requests: URL[] = [];
    const fetcher = vi.fn(async (path: string) => {
      const url = new URL(path, 'http://localhost'); requests.push(url);
      if (url.searchParams.has('before')) {
        if (Number(url.searchParams.get('limit')) > 10) return json({ error: 'Saved page is too large.' }, 413);
        return json({ chat: { ...savedChat, messages: [{ ...messages[0], id: 'old-question', content: 'Earlier question' }, { ...messages[1], id: 'old-answer', content: 'Earlier answer' }], artifacts: [result('older-result', 'old-answer', 'Earlier result')], historyHasMore: true, historyCursor: 'old-question' } });
      }
      if (Number(url.searchParams.get('limit')) > 12) return json({ error: 'Saved page is too large.' }, 413);
      return json({ chat: { ...savedChat, artifacts: [result('current-result', 'a1', 'Current result')], historyHasMore: true, historyCursor: 'u1' } });
    });
    vi.stubGlobal('fetch', fetcher);
    render(<ChatWorkspace {...props} />);
    await screen.findByText('First answer');
    expect(requests.map(url => url.searchParams.get('limit'))).toEqual(['50', '25', '12']);
    expect(screen.getByRole('button', { name: /Current result/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await screen.findByText('Earlier answer');
    expect(screen.getByText('First answer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Earlier result/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Current result/ })).toBeInTheDocument();
    expect(requests.slice(3).map(url => [url.searchParams.get('before'), url.searchParams.get('limit')])).toEqual([['u1', '40'], ['u1', '20'], ['u1', '10']]);
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await waitFor(() => expect(requests.at(-1)?.searchParams.get('before')).toBe('old-question'));
    expect(screen.queryByText('Saved page is too large.')).not.toBeInTheDocument();
  });

  it('stops size backoff at one message and displays the saved-data error', async () => {
    const fetcher = vi.fn(async (_url: string) => json({ error: 'This saved result is too large. Select a specific result or start a new chat.' }, 413));
    vi.stubGlobal('fetch', fetcher);
    render(<ChatWorkspace {...props} />);
    await screen.findByText('This saved result is too large. Select a specific result or start a new chat.');
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url), 'http://localhost').searchParams.get('limit'))).toEqual(['50', '25', '12', '6', '3', '1']);
  });

  it.each([404, 429, 503])('does not retry a history error with status %s', async (status) => {
    const fetcher = vi.fn(async () => json({ error: 'The saved chat is unavailable.' }, status));
    vi.stubGlobal('fetch', fetcher);
    render(<ChatWorkspace {...props} />);
    await screen.findByText('The saved chat is unavailable.');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not retry an initial oversized page after navigation changes its owner', async () => {
    const stale = deferred<Response>();
    const fetcher = vi.fn(async (url: string) => url.includes('chat1') ? stale.promise : json({ chat: { ...savedChat, id: 'chat2', messages: [{ ...messages[1], id: 'a2', content: 'Second chat answer' }] } }));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<ChatWorkspace {...props} />);
    view.rerender(<ChatWorkspace {...props} chatId="chat2" />);
    await screen.findByText('Second chat answer');
    await act(async () => stale.resolve(json({ error: 'Old page is too large.' }, 413)));
    expect(fetcher.mock.calls.filter(([url]) => url.includes('chat1'))).toHaveLength(1);
    expect(screen.queryByText('Old page is too large.')).not.toBeInTheDocument();
    expect(screen.getByText('Second chat answer')).toBeInTheDocument();
  });

  it('stops older-page size retries when its navigation generation changes', async () => {
    const stale = deferred<Response>();
    const fetcher = vi.fn(async (url: string) => url.includes('before=') ? stale.promise : json({ chat: url.includes('chat2') ? { ...savedChat, id: 'chat2', messages: [{ ...messages[1], id: 'a2', content: 'Second chat answer' }] } : { ...savedChat, historyHasMore: true, historyCursor: 'u1' } }));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<ChatWorkspace {...props} />);
    await screen.findByText('First answer');
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    view.rerender(<ChatWorkspace {...props} chatId="chat2" />);
    await screen.findByText('Second chat answer');
    await act(async () => stale.resolve(json({ error: 'Old page is too large.' }, 413)));
    expect(fetcher.mock.calls.filter(([url]) => url.includes('before='))).toHaveLength(1);
    expect(screen.queryByText('Old page is too large.')).not.toBeInTheDocument();
  });

  it('reduces a terminal refresh page and adopts its new history cursor', async () => {
    const turn = { id: 'active', assistantMessageId: 'active-answer', status: 'running', events: [] };
    let refresh = false;
    const requests: URL[] = [];
    const fetcher = vi.fn(async (path: string) => {
      const url = new URL(path, 'http://localhost'); requests.push(url);
      if (url.searchParams.has('before')) return json({ chat: { ...savedChat, historyHasMore: false } });
      if (!refresh) return json({ chat: { ...savedChat, latestTurn: turn } });
      if (url.searchParams.get('limit') === '50') return json({ error: 'Refresh page is too large.' }, 413);
      return json({ chat: { ...savedChat, messages: [{ ...messages[1], id: 'active-answer', content: 'Saved completed answer' }], historyHasMore: true, historyCursor: 'active-answer' } });
    });
    vi.stubGlobal('fetch', fetcher);
    render(<ChatWorkspace {...props} />);
    await waitFor(() => expect(FixtureStream.streams).toHaveLength(1));
    refresh = true;
    act(() => FixtureStream.streams[0].emit('complete', { message: { ...messages[1], id: 'active-answer', content: 'Streamed completed answer' }, artifacts: [] }, 1));
    await screen.findByText('Saved completed answer');
    expect(requests.map(url => url.searchParams.get('limit'))).toEqual(['50', '50', '25']);
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await waitFor(() => expect(requests.at(-1)?.searchParams.get('before')).toBe('active-answer'));
    await screen.findByText('First answer');
    expect(screen.getByText('Saved completed answer')).toBeInTheDocument();
  });

  it('does not show old feedback failures after navigating away', async () => {
    const feedback = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/feedback') ? feedback.promise : json({ chat: savedChat })));
    const view = render(<ChatWorkspace {...props} />);
    await screen.findByText('First answer');
    fireEvent.click(screen.getByRole('button', { name: 'Helpful answer' }));
    view.rerender(<ChatWorkspace {...props} chatId={undefined} />);
    await act(async () => feedback.resolve(json({ error: 'Old feedback failed' }, 500)));
    expect(screen.queryByText('Old feedback failed')).not.toBeInTheDocument();
  });

  it('reconnects a closed stream and discards replayed deltas', async () => {
    const turn = { id: 'active', assistantMessageId: 'active-answer', status: 'running', events: [] };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/chat/turns/active') ? json(turn) : json({ chat: { ...savedChat, latestTurn: turn } })));
    render(<ChatWorkspace {...props} />);
    await waitFor(() => expect(FixtureStream.streams).toHaveLength(1));
    act(() => FixtureStream.streams[0].emit('text-delta', { delta: 'Hello' }, 1));
    vi.useFakeTimers();
    act(() => FixtureStream.streams[0].fail());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(FixtureStream.streams).toHaveLength(2);
    act(() => {
      FixtureStream.streams[1].emit('text-delta', { delta: 'Hello' }, 1);
      FixtureStream.streams[1].emit('text-delta', { delta: ' world' }, 2);
    });
    expect(screen.getByText('Hello world')).toBeInTheDocument();
    expect(screen.queryByText('HelloHello world')).not.toBeInTheDocument();
    captureDom('stream-recovered');
  });

  it('ignores a pending stream recovery snapshot after opening another chat', async () => {
    const recovery = deferred<Response>();
    const turn = { id: 'active', assistantMessageId: 'active-answer', status: 'running', events: [] };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/chat/turns/active') ? recovery.promise : json({ chat: { ...savedChat, latestTurn: turn } })));
    const view = render(<ChatWorkspace {...props} />);
    await waitFor(() => expect(FixtureStream.streams).toHaveLength(1));
    vi.useFakeTimers();
    act(() => FixtureStream.streams[0].fail());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    view.rerender(<ChatWorkspace {...props} chatId={undefined} />);
    await act(async () => recovery.resolve(json({ ...turn, status: 'error', error: 'Old stream failure' })));
    expect(screen.queryByText('Old stream failure')).not.toBeInTheDocument();
    expect(FixtureStream.streams).toHaveLength(1);
  });
});

describe('connection knowledge and export isolation', () => {
  const knowledge: ConnectionKnowledge = { version: 1, glossary: [{ id: 'term', term: 'Revenue', definition: 'Definition for source A', provenance: 'user', updatedAt: '2026-10-03' }], examples: [], updatedAt: '2026-10-03' };
  it('removes old definitions when the next connection fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/other-db/') ? json({ error: 'Knowledge unavailable' }, 500) : json({ knowledge })));
    render(<KnowledgeEditor connections={bootstrap.connections} initialConnectionId="db" />);
    await screen.findByDisplayValue('Definition for source A');
    fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'other-db' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Knowledge unavailable');
    expect(screen.queryByDisplayValue('Definition for source A')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save connection knowledge' })).not.toBeInTheDocument();
    captureDom('knowledge-load-failure');
  });

  it('holds connection and fields steady during save and surfaces reverify errors', async () => {
    const save = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => options?.method === 'PUT' ? save.promise : json({ knowledge: { ...knowledge, examples: [{ id: 'e1', question: 'Revenue?', query: 'select 1', provenance: 'user', verifiedAt: '2026-10-01', invalidatedAt: '2026-10-02' }] } })));
    render(<KnowledgeEditor connections={bootstrap.connections} initialConnectionId="db" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Verify again' }));
    expect(screen.getByLabelText('Connection')).toBeDisabled();
    expect(screen.getByLabelText('Term 1')).toBeDisabled();
    await act(async () => save.resolve(json({ error: 'Schema unavailable' }, 503)));
    expect(screen.getByRole('status')).toHaveTextContent('Schema unavailable');
    expect(screen.getByLabelText('Connection')).toBeEnabled();
    expect(screen.getByLabelText('Term 1')).toBeEnabled();
  });

  it('does not attach a late export to another result', async () => {
    const exportResponse = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => options?.method === 'POST' ? exportResponse.promise : json({ exports: [] })));
    const artifact = { kind: 'query-result' as const, queryId: 'q1', query: 'SELECT 1', result: { columns: ['count'], rows: [{ count: 1 }], rowCount: 1, elapsedMs: 1 } };
    const inspectorProps = { chatId: 'chat1', artifact, connectionId: 'db', connectionLabel: 'Analytics', inspectorWidth: 400, onInspectorWidthChange: vi.fn(), onClose: vi.fn() };
    const view = render(<DataInspector {...inspectorProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    view.rerender(<DataInspector {...inspectorProps} chatId="chat2" artifact={{ ...artifact, queryId: 'q2' }} />);
    await act(async () => exportResponse.resolve(json({ export: { id: 'export-old', title: 'Previous result export', status: 'ready', format: 'csv' } })));
    expect(screen.queryByRole('link', { name: 'Download CSV' })).not.toBeInTheDocument();
    expect(screen.queryByText('Previous result export')).not.toBeInTheDocument();
  });
});

describe('session state', () => {
  it('opens saved history after its connection is removed without selecting that connection', async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith('/auth/me') ? json({ authenticated: true }) : url.endsWith('/bootstrap') ? json({ ...bootstrap, connections: [otherConnection] }) : url.includes('/chats/chat1') ? json({ chat: { ...savedChat, sourceAvailable: false, source: { connectionId: 'db', label: 'Removed source', kind: 'postgres', capturedAt: '2026-10-03' } } }) : url.endsWith('/chats') ? json({ chats: [savedChat] }) : json({ suggestions: [] }));
    vi.stubGlobal('fetch', fetcher);
    render(<App />);
    fireEvent.click(await screen.findByTitle('First question'));
    await screen.findByText('First answer');
    expect(screen.getByText('Removed source is no longer available.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Question')).not.toBeInTheDocument();
    expect(fetcher.mock.calls.some(([url]) => url === '/api/v1/settings')).toBe(false);
    captureDom('removed-source-history');
  });

  it('shows a fresh login form after signup requires email confirmation', async () => {
    window.history.replaceState({}, '', '/signup');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? json({ authenticated: false }) : json({ confirmationRequired: true })));
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'reader@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'fixture-password' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'fixture-password' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /^Create account/ }));
    await screen.findByText('Check your email');
    fireEvent.click(screen.getAllByRole('button', { name: 'Log in' })[0]);
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.queryByText('Check your email')).not.toBeInTheDocument();
  });

  it('does not restore an old authenticated bootstrap after session expiry', async () => {
    let loads = 0;
    const oldBootstrap = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? json({ authenticated: true }) : url.endsWith('/bootstrap') ? ++loads === 1 ? json(bootstrap) : oldBootstrap.promise : json({ chats: [] })));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reader' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh workspace' }));
    act(() => window.dispatchEvent(new Event('dbchat:auth-required')));
    expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    await act(async () => oldBootstrap.resolve(json(bootstrap)));
    expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reader' })).not.toBeInTheDocument();
  });

  it('does not redirect or change another connection form after a late save', async () => {
    const pendingSave = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pendingSave.promise));
    const navigate = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const view = render(<ConnectionForm bootstrap={bootstrap} connection={connection} onNavigate={navigate} onRefresh={refresh} />);
    fireEvent.submit(screen.getByRole('button', { name: 'Save and test' }).closest('form')!);
    view.rerender(<ConnectionForm bootstrap={bootstrap} connection={otherConnection} onNavigate={navigate} onRefresh={refresh} />);
    await act(async () => pendingSave.resolve(json({ connection })));
    expect(screen.getByLabelText('Connection name')).toHaveValue('Other source');
    expect(screen.getByRole('button', { name: 'Save and test' })).toBeEnabled();
    expect(navigate).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(['/api/v1/auth/me', '/api/v1/bootstrap', '/api/v1/chats'])('keeps startup failure at %s retryable without claiming sign-out', async (failedRoute) => {
    window.history.replaceState({}, '', '/chat/chat1');
    let fail = true;
    const fetcher = vi.fn(async (url: string) => {
      if (url === failedRoute && fail) return json({ error: 'The service is temporarily unavailable.' }, 503);
      if (url.endsWith('/auth/me')) return json({ authenticated: true });
      if (url.endsWith('/bootstrap')) return json(bootstrap);
      if (url.endsWith('/chats')) return json({ chats: [savedChat] });
      return json({ chat: savedChat });
    });
    vi.stubGlobal('fetch', fetcher);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Workspace unavailable' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The service is temporarily unavailable.');
    expect(screen.queryByRole('heading', { name: 'Log in' })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/chat/chat1');
    captureDom('workspace-startup-failure');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('First answer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reader' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/chat/chat1');
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/auth/logout'))).toBe(false);
  });

  it('retains the authenticated view and shows an error when logout fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? json({ authenticated: true }) : url.endsWith('/bootstrap') ? json(bootstrap) : url.endsWith('/auth/logout') ? json({ error: 'Logout is temporarily unavailable. Try again.' }, 503) : json({ chats: [] })));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reader' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Logout is temporarily unavailable');
    expect(screen.getByRole('button', { name: 'Reader' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
    captureDom('logout-failure');
  });
});
