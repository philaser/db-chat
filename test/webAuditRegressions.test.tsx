import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { AppBar, ChatWorkspace, DataInspector, draftForConnection, modelMessages } from '../src/web/App.js';
import { buildConnectionPayload } from '../src/web/connectionPayload.js';
import type { ChatMessage, QueryResultArtifact, WebChatSession } from '../src/shared/types.js';

const connection = { id: 'db', label: 'Analytics', kind: 'postgres', status: 'ready' as const, readOnly: true as const, hasSavedSecret: true, createdAt: '2026-09-05', host: 'db.example.test', port: 5544, ssl: false, database: 'analytics', username: 'reader' };
const bootstrap = {
  ready: true, user: { id: 'u', email: 'u@example.test', displayName: 'Audit user', emailVerified: true, createdAt: '2026-09-05' },
  connections: [connection], activeConnectionId: 'db', settings: { provider: 'openrouter' as const, model: 'fixture', effortLevel: 'medium' as const },
  inference: { provider: 'openrouter' as const, model: 'fixture', credentialSource: 'internal' as const, hasUserKey: false, userKeyUiEnabled: false, status: 'ready' as const },
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
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close data inspector' }), { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    expect(origin).toHaveFocus(); origin.remove();
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

});
