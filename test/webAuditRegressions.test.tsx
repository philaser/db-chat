import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { AppBar, AssistantContent, ChatWorkspace, DataInspector, draftForConnection, modelMessages, resultLinkLabel } from '../src/web/App.js';
import { buildConnectionPayload } from '../src/web/connectionPayload.js';
import type { ChatMessage, QueryResultArtifact, WebChatSession } from '../src/shared/types.js';

const connection = { id: 'db', label: 'Analytics', kind: 'postgres', status: 'ready' as const, readOnly: true as const, hasSavedSecret: true, createdAt: '2026-09-05', host: 'db.example.test', port: 5544, ssl: false, database: 'analytics', username: 'reader' };
const bootstrap = {
  ready: true, user: { id: 'u', email: 'u@example.test', displayName: 'Audit user', emailVerified: true, createdAt: '2026-09-05' },
  connections: [connection], activeConnectionId: 'db', settings: { provider: 'openrouter' as const, model: 'fixture', effortLevel: 'medium' as const },
  inference: { provider: 'openrouter' as const, model: 'fixture', credentialSource: 'internal' as const, hasUserKey: false, userKeyUiEnabled: false, canChangeModel: false, models: [{ id: 'fixture', name: 'Fixture' }], status: 'ready' as const },
  capabilities: { queryResults: true, csvExport: true, charts: true }, limits: { maxHistoryMessages: 40, maxMessageChars: 8000, maxResultRows: 100, maxResultBytes: 1048576 }
};
const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'First question', createdAt: '2026-09-05T12:00:00Z' },
  { id: 'a1', role: 'assistant', content: 'First answer', createdAt: '2026-09-05T12:00:01Z' }
];
const artifact: QueryResultArtifact = { kind: 'query-result', queryId: 'q1', messageId: 'a1', query: 'SELECT * FROM revenue', result: { columns: ['revenue'], rows: [{ revenue: 20 }], rowCount: 1, elapsedMs: 1 } };
const savedChat: WebChatSession = { id: 'chat1', connectionId: 'db', title: 'First question', messages, artifacts: [artifact], createdAt: '2026-09-05T12:00:00Z', updatedAt: '2026-09-05T12:00:01Z', messageCount: 2, artifactCount: 1 };
class FixtureStream extends EventTarget {
  static CLOSED = 2;
  static streams: FixtureStream[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  constructor(public url: string) { super(); FixtureStream.streams.push(this); }
  close() { this.readyState = 2; }
  emit(type: string, data: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })); }
}
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  FixtureStream.streams = [];
  vi.stubGlobal('EventSource', FixtureStream);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); });

describe('web audit regressions', () => {
  it('renders prose soft line breaks while leaving Markdown list structure intact', () => {
    const { container } = render(<AssistantContent content={'Ada: 300\nCara: 240\nBen: 170\n\n- one\n- two'} />);
    expect(container.querySelector('p')).toHaveTextContent('Ada: 300Cara: 240Ben: 170');
    expect(container.querySelectorAll('p br')).toHaveLength(2);
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('uses a neutral result label unless the server supplies a concise purpose', () => {
    expect(resultLinkLabel({ ...artifact, result: { ...artifact.result, columns: ['customer', 'country', 'total_spend'] } })).toBe('View results');
    expect(resultLinkLabel({ ...artifact, purpose: 'Customer spending by total.' })).toBe('View results: Customer spending by total');
  });

  it('preserves port/TLS and nonsecret connection fields when renaming', () => {
    const draft = draftForConnection(connection);
    draft.label = 'Renamed';
    expect(buildConnectionPayload(draft)).toMatchObject({ label: 'Renamed', host: connection.host, port: 5544, ssl: false, database: 'analytics', username: 'reader' });
    expect(buildConnectionPayload(draft)).not.toHaveProperty('password');
  });

  it('bounds model history without discarding the durable transcript or leading with an orphan answer', () => {
    const history = Array.from({ length: 43 }, (_, index): ChatMessage => ({ id: String(index), role: index % 2 ? 'assistant' : 'user', content: 'abcdefgh', createdAt: '2026-09-05' }));
    const context = modelMessages(history, 40, 5);
    expect(context).toHaveLength(39);
    expect(context[0].role).toBe('user');
    expect(context.at(-1)).toEqual({ role: 'user', content: 'abcde' });
    expect(history).toHaveLength(43);
    expect(history[0].content).toBe('abcdefgh');
  });

  it('keeps a name for the compact account control and exposes the existing navigation toggle', () => {
    const toggle = vi.fn();
    render(<AppBar bootstrap={bootstrap} onNavigate={vi.fn()} onRefresh={vi.fn()} onLogout={vi.fn()} onToggleNavigation={toggle} navigationOpen />);
    expect(screen.getByRole('button', { name: 'Audit user' })).toHaveAttribute('aria-label', 'Audit user');
    fireEvent.click(screen.getByRole('button', { name: 'Workspace navigation' }));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('disables exports for empty rows and closes the inspector with Escape, restoring focus', () => {
    const close = vi.fn();
    const origin = document.createElement('button');
    document.body.append(origin); origin.focus();
    const view = render(<DataInspector artifact={{ ...artifact, result: { ...artifact.result, rows: [], rowCount: 0 } }} connectionId="db" connectionLabel="Analytics" inspectorWidth={384} onInspectorWidthChange={vi.fn()} onClose={close} />);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
    const expand = screen.getByRole('button', { name: 'Expand data inspector' });
    fireEvent.click(expand);
    expect(screen.getByRole('button', { name: 'Restore data inspector width' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Data inspector')).toHaveClass('inspector-expanded');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close data inspector' }), { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    expect(origin).toHaveFocus(); origin.remove();
  });

  it('exports filtered and sorted visible rows by their saved indices, or all matching rows', async () => {
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => url.endsWith('/exports') && !options?.method ? response({ exports: [] }) : response({ export: { id: 'export-1', title: 'Result export', format: 'csv', status: 'ready', rowCount: 2, byteCount: 30 } }));
    vi.stubGlobal('fetch', fetcher);
    const rows = [{ name: 'Ada', amount: 2 }, { name: 'Ben', amount: 1 }, { name: 'Cara', amount: 3 }];
    render(<DataInspector chatId="chat1" artifact={{ ...artifact, result: { ...artifact.result, columns: ['name', 'amount'], rows, rowCount: 3 } }} connectionId="db" connectionLabel="Analytics" inspectorWidth={384} onInspectorWidthChange={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Filter loaded rows'), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Amount' }));
    fireEvent.change(screen.getByLabelText('Export format'), { target: { value: 'json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/v1/chats/chat1/exports', expect.objectContaining({ body: JSON.stringify({ resultId: 'q1', format: 'json', scope: 'visible', columns: ['name', 'amount'], rowIndices: [0, 2] }) })));
    expect(await screen.findByRole('link', { name: 'Download CSV' })).toHaveAttribute('href', '/api/v1/exports/export-1/download');

    fireEvent.change(screen.getByLabelText('Export rows'), { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith('/api/v1/chats/chat1/exports', expect.objectContaining({ body: JSON.stringify({ resultId: 'q1', format: 'json', scope: 'all' }) })));
  });

  it('keeps export progress, cancellation, and recoverable errors keyboard accessible', async () => {
    let creates = 0;
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/exports') && !options?.method) return response({ exports: [] });
      if (url.endsWith('/cancel')) return response({ export: { id: 'export-2', title: 'Export', format: 'csv', status: 'cancelled' } });
      creates += 1;
      return creates === 1 ? response({ export: { id: 'export-2', title: 'Export', format: 'csv', status: 'running' } }) : new Response(JSON.stringify({ error: 'Export limit exceeded. Narrow the result and try again.' }), { status: 413, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetcher);
    render(<DataInspector chatId="chat1" artifact={artifact} connectionId="db" connectionLabel="Analytics" inspectorWidth={384} onInspectorWidthChange={vi.fn()} onClose={vi.fn()} />);
    const start = screen.getByRole('button', { name: 'Export' });
    start.focus();
    fireEvent.keyDown(start, { key: 'Enter' });
    fireEvent.click(start);
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    expect(cancel).not.toHaveAttribute('tabindex', '-1');
    fireEvent.click(cancel);
    expect(await screen.findByText('Export cancelled.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Export limit exceeded. Narrow the result and try again.');
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
  });

  it('routes aggregate drill-through into a row-level follow-up and explains byte-limited previews', () => {
    const ask = vi.fn();
    render(<DataInspector chatId="chat1" artifact={{ ...artifact, query: 'SELECT country, COUNT(*) FROM customers GROUP BY country', result: { ...artifact.result, truncated: true, truncationReason: 'byte-limit', byteLimit: 1000 } }} connectionId="db" connectionLabel="Analytics" inspectorWidth={384} onInspectorWidthChange={vi.fn()} onClose={vi.fn()} onAskUnderlyingRecords={ask} />);
    expect(screen.getByRole('status')).toHaveTextContent('large cell values reached the preview size limit');
    fireEvent.click(screen.getByRole('button', { name: 'Ask for underlying records' }));
    expect(ask).toHaveBeenCalledWith('Show the underlying row-level records for this result, using the same definitions and filters.');
  });

  it('retains earlier result ownership through success, failure, save and reload without idle autosave loops', async () => {
    let persisted = structuredClone(savedChat);
    let requestBody: { assistantMessageId: string; userMessageId: string; clientRequestId: string; chatId: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> };
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes('/chat/turns')) {
        requestBody = JSON.parse(options?.body as string);
        expect(requestBody.chatId).toBe('chat1');
        expect(requestBody.clientRequestId).toBeTruthy();
        persisted.messages.push({ id: requestBody.userMessageId, role: 'user', content: requestBody.messages.at(-1)!.content, createdAt: '2026-09-05' });
        return response({ turnId: 'turn' + FixtureStream.streams.length });
      }
      return response({ chat: persisted });
    }));
    function Harness() {
      const [, setRevision] = useState(0);
      return <ChatWorkspace bootstrap={bootstrap} onNavigate={vi.fn()} newChatKey={0} chatId="chat1" onCreateChat={vi.fn()} onChatChanged={() => setRevision((value) => value + 1)} />;
    }
    const view = render(<Harness />);
    await screen.findByText('First answer');
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Second question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send question' }));
    await waitFor(() => expect(FixtureStream.streams).toHaveLength(1));
    const second = { ...artifact, queryId: 'q2', messageId: undefined, result: { ...artifact.result, rows: [], rowCount: 0 } };
    persisted.messages.push({ ...messages[1], id: requestBody!.assistantMessageId, content: 'Second answer' });
    persisted.artifacts.push({ ...second, messageId: requestBody!.assistantMessageId });
    act(() => FixtureStream.streams[0].emit('complete', { message: { ...messages[1], id: 'server-generated', content: 'Second answer' }, artifacts: [second] }));
    await screen.findByText('Second answer');
    expect(vi.mocked(fetch).mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
    expect(persisted.artifacts).toHaveLength(2);
    expect(persisted.artifacts[0].messageId).toBe('a1');
    expect(persisted.artifacts[1].messageId).toBe(persisted.messages[3].id);
    const firstRow = screen.getByText('First answer').closest('article')!;
    expect(within(firstRow).getByRole('button', { name: /1 row/ })).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 850)));
    expect(vi.mocked(fetch).mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Third question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send question' }));
    await waitFor(() => expect(FixtureStream.streams).toHaveLength(2));
    persisted.messages.push({ ...messages[1], id: requestBody!.assistantMessageId, content: 'The answer was interrupted.' });
    act(() => FixtureStream.streams[1].emit('error', { message: 'Fixture failure' }));
    await screen.findByText('The answer was interrupted.');
    expect(vi.mocked(fetch).mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
    expect(persisted.artifacts).toHaveLength(2);
    view.unmount();
    render(<Harness />);
    await screen.findByText('First answer');
    expect(within(screen.getByText('First answer').closest('article')!).getByRole('button', { name: /1 row/ })).toBeInTheDocument();
  });
  it('keeps a saved mobile answer visible until its result is explicitly opened', async () => {
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('fetch', vi.fn(async () => response({ chat: savedChat })));
    render(<ChatWorkspace bootstrap={bootstrap} onNavigate={vi.fn()} newChatKey={0} chatId="chat1" onCreateChat={vi.fn()} onChatChanged={vi.fn()} />);

    await screen.findByText('First answer');
    expect(screen.queryByLabelText('Data inspector')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /View results.*1 row/ }));
    expect(screen.getByLabelText('Data inspector')).toBeInTheDocument();
  });

  it('reuses submission identity after a transport failure without duplicating the question', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes('/chat/turns')) {
        bodies.push(JSON.parse(options?.body as string));
        if (bodies.length === 1) throw new TypeError('Network unavailable');
        return response({ turnId: 'retry-turn' });
      }
      return response({ chat: savedChat });
    }));
    render(<ChatWorkspace bootstrap={bootstrap} onNavigate={vi.fn()} newChatKey={0} chatId="chat1" onCreateChat={vi.fn()} onChatChanged={vi.fn()} />);
    await screen.findByText('First answer');
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Retry this question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send question' }));
    await screen.findByText('Network unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Send question' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual(bodies[0]);
    expect((bodies[1].messages as Array<unknown>)).toHaveLength(3);
    expect(screen.getAllByText('Retry this question')).toHaveLength(1);
  });

  it('resumes the latest active turn when a saved chat is reloaded', async () => {
    const activeChat = { ...savedChat, latestTurn: { id: 'turn-active', chatId: 'chat1', connectionId: 'db', assistantMessageId: 'a-active', question: 'Still working?', status: 'running' as const, events: [] } };
    vi.stubGlobal('fetch', vi.fn(async () => response({ chat: activeChat })));
    render(<ChatWorkspace bootstrap={bootstrap} onNavigate={vi.fn()} newChatKey={0} chatId="chat1" onCreateChat={vi.fn()} onChatChanged={vi.fn()} />);
    await waitFor(() => expect(FixtureStream.streams).toHaveLength(1));
    expect(FixtureStream.streams[0].url).toContain('/chat/turns/turn-active/events');
    expect(screen.getByText('Recovering active work…')).toBeInTheDocument();
    expect(screen.getByText('Preparing an answer…')).toBeInTheDocument();
  });

  it('does not abort an accepted turn when navigation wins the POST race', async () => {
    let accept!: (value: Response) => void;
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      calls.push({ url, method: options?.method });
      if (url.includes('/chat/turns')) return new Promise<Response>((resolve) => { accept = resolve; });
      return response({ chat: savedChat });
    }));
    const view = render(<ChatWorkspace bootstrap={bootstrap} onNavigate={vi.fn()} newChatKey={0} chatId="chat1" onCreateChat={vi.fn()} onChatChanged={vi.fn()} />);
    await screen.findByText('First answer');
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Long question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send question' }));
    await waitFor(() => expect(typeof accept).toBe('function'));
    view.rerender(<ChatWorkspace bootstrap={bootstrap} onNavigate={vi.fn()} newChatKey={1} chatId={undefined} onCreateChat={vi.fn()} onChatChanged={vi.fn()} />);
    accept(response({ turnId: 'accepted-turn' }));
    await act(() => Promise.resolve());
    expect(calls.some((call) => call.url.includes('/accepted-turn/abort'))).toBe(false);
  });

  it('keeps a filter bound to the selected result while the user writes the condition', async () => {
    const bodies: Array<Record<string, any>> = [];
    const filterArtifact = { ...artifact, result: { ...artifact.result, rows: [{ revenue: 20 }, { revenue: 5 }], rowCount: 2 } };
    const filterChat = { ...savedChat, artifacts: [filterArtifact] };
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes('/chat/turns')) { bodies.push(JSON.parse(options?.body as string)); return response({ turnId: 'filtered-turn' }); }
      return response({ chat: filterChat });
    }));
    render(<ChatWorkspace bootstrap={bootstrap} onNavigate={vi.fn()} newChatKey={0} chatId="chat1" onCreateChat={vi.fn()} onChatChanged={vi.fn()} />);
    await screen.findByText('First answer');
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const composer = screen.getByLabelText('Question');
    expect(composer).toHaveValue('Filter this result to ');
    fireEvent.change(composer, { target: { value: 'Filter this result to revenue above 10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send question' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].intent).toMatchObject({ action: 'filter', artifactId: 'q1', messageId: 'a1' });
    expect(bodies[0].question).toBe('Filter this result to revenue above 10');
  });

  it('keeps scalar answer controls compact and moves secondary refinements into More actions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ chat: savedChat })));
    render(<ChatWorkspace bootstrap={bootstrap} onNavigate={vi.fn()} newChatKey={0} chatId="chat1" onCreateChat={vi.fn()} onChatChanged={vi.fn()} />);
    await screen.findByText('First answer');
    expect(screen.getByRole('button', { name: /Explain/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Filter this result/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('More actions'));
    expect(screen.getByRole('menuitem', { name: /Rerun with fresh data/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Compare values/ })).not.toBeInTheDocument();
  });

  it('restores recovery actions from an aborted assistant turn and preserves edit attempt context', async () => {
    const bodies: Array<Record<string, any>> = [];
    const abortedChat: WebChatSession = {
      ...savedChat,
      messages: [
        messages[0],
        {
          id: 'assistant-aborted',
          role: 'assistant',
          content: 'The run was stopped.',
          createdAt: '2026-09-05T12:00:01Z',
          turn: { id: 'turn-aborted', status: 'aborted', question: 'First question' }
        }
      ],
      artifacts: []
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes('/chat/turns')) {
        bodies.push(JSON.parse(options?.body as string));
        return response({ turnId: 'edited-retry' });
      }
      return response({ chat: abortedChat });
    }));
    render(<ChatWorkspace bootstrap={bootstrap} onNavigate={vi.fn()} newChatKey={0} chatId="chat1" onCreateChat={vi.fn()} onChatChanged={vi.fn()} />);
    const recovery = await screen.findByRole('group', { name: 'Cancelled question recovery' });
    expect(within(recovery).getByRole('button', { name: /Retry/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Explain/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Save$/ })).not.toBeInTheDocument();
    fireEvent.click(within(recovery).getByRole('button', { name: /Edit question/ }));
    const composer = screen.getByLabelText('Question');
    await waitFor(() => expect(composer).toHaveFocus());
    expect(composer).toHaveValue('First question');
    fireEvent.change(composer, { target: { value: 'First question, limited to this month' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send question' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      question: 'First question, limited to this month',
      attemptOf: 'turn-aborted',
      intent: { action: 'rerun', messageId: 'assistant-aborted' }
    });
  });

  it('keeps actions available on an earlier result after a later turn is aborted', async () => {
    const bodies: Array<Record<string, any>> = [];
    const chat: WebChatSession = {
      ...savedChat,
      messages: [
        ...messages,
        { id: 'u2', role: 'user', content: 'Follow-up question', createdAt: '2026-09-05T12:01:00Z' },
        {
          id: 'assistant-aborted',
          role: 'assistant',
          content: 'The run was stopped.',
          createdAt: '2026-09-05T12:01:01Z',
          turn: { id: 'turn-aborted', status: 'aborted', question: 'Rerun this analysis with fresh data.', intent: { action: 'rerun', artifactId: 'q1', messageId: 'a1' } }
        }
      ]
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes('/chat/turns')) { bodies.push(JSON.parse(options?.body as string)); return response({ turnId: 'retried-turn' }); }
      return response({ chat });
    }));
    render(<ChatWorkspace bootstrap={bootstrap} onNavigate={vi.fn()} newChatKey={0} chatId="chat1" onCreateChat={vi.fn()} onChatChanged={vi.fn()} />);
    const earlierAnswer = (await screen.findByText('First answer')).closest('article')!;
    expect(within(earlierAnswer).getByRole('button', { name: /Explain/ })).toBeInTheDocument();
    expect(within(earlierAnswer).getByText('Export')).toBeInTheDocument();
    const recovery = await screen.findByRole('group', { name: 'Cancelled question recovery' });
    fireEvent.click(within(recovery).getByRole('button', { name: /Edit question/ }));
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Rerun this for the current month.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send question' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ attemptOf: 'turn-aborted', intent: { action: 'rerun', artifactId: 'q1', messageId: 'a1' } });
  });

  it('bounds a 1000-message chat and prepends an older page without duplicates or a scroll jump', async () => {
    const makeMessage = (index: number): ChatMessage => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${index}`,
      createdAt: new Date(Date.UTC(2026, 8, 5, 12, 0, index % 60)).toISOString()
    });
    const initial = Array.from({ length: 50 }, (_, index) => makeMessage(950 + index));
    const older = [...Array.from({ length: 39 }, (_, index) => makeMessage(911 + index)), makeMessage(950)];
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('before=message-950')) return response({ chat: { ...savedChat, messages: older, artifacts: [], messageCount: 1000, historyHasMore: true, historyCursor: 'message-911' } });
      return response({ chat: { ...savedChat, messages: initial, artifacts: [], messageCount: 1000, historyHasMore: true, historyCursor: 'message-950' } });
    }));
    const view = render(<ChatWorkspace bootstrap={bootstrap} onNavigate={vi.fn()} newChatKey={0} chatId="chat1" onCreateChat={vi.fn()} onChatChanged={vi.fn()} />);
    await screen.findByText('Message 999');
    expect(view.container.querySelectorAll('article.message-row')).toHaveLength(50);
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView);
    scrollIntoView.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await screen.findByText('Message 911');
    const mountedIds = [...view.container.querySelectorAll<HTMLElement>('article.message-row')].map((row) => row.dataset.messageId);
    expect(mountedIds).toHaveLength(89);
    expect(new Set(mountedIds).size).toBe(89);
    expect(urls.some((url) => url.includes('before=message-950') && url.includes('limit=40'))).toBe(true);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

});
