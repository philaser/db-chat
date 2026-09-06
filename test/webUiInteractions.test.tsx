import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryResultArtifact } from '../src/shared/types.js';
import { AppBar, AuthScreen, ChatSidebarRow, DataInspector, streamActivityText } from '../src/web/App.js';

const bootstrap = {
  ready: true,
  user: {
    id: 'dev-user',
    email: 'dev@dbchat.local',
    displayName: 'Development user',
    emailVerified: true,
    createdAt: '2026-08-09T00:00:00.000Z'
  },
  connections: [],
  settings: {
    provider: 'openrouter' as const,
    model: 'deepseek/deepseek-v4-flash-0731',
    effortLevel: 'medium' as const
  },
  inference: {
    provider: 'openrouter' as const,
    model: 'deepseek/deepseek-v4-flash-0731',
    credentialSource: 'internal' as const,
    hasUserKey: false,
    userKeyUiEnabled: false,
    status: 'ready' as const
  },
  capabilities: { queryResults: true, csvExport: true, charts: true },
  limits: { maxHistoryMessages: 40, maxMessageChars: 8_000, maxResultRows: 100, maxResultBytes: 1_024 * 1_024 }
};

const artifact: QueryResultArtifact = {
  kind: 'query-result',
  queryId: 'query-1',
  query: 'SELECT users.id, users.name FROM users ORDER BY users.name',
  result: {
    columns: ['id', 'name'],
    rows: [{ id: 1, name: 'Ada' }],
    rowCount: 1,
    elapsedMs: 2
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('web app interactions', () => {
  it('maps streamed work events to a compact current-status label', () => {
    expect(streamActivityText('status', { message: 'Preparing the result' })).toBe('Preparing the result');
    expect(streamActivityText('tool-start', { toolName: 'run_database_query', purpose: 'Running a read-only query' })).toBe('Running a read-only query');
    expect(streamActivityText('tool-complete', { summary: 'Query returned 7 rows' })).toBe('Query returned 7 rows');
  });

  it('submits a real account payload and links the privacy acknowledgement', async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const onNavigate = vi.fn();
    render(<AuthScreen mode="signup" onNavigate={onNavigate} onComplete={onComplete} />);

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Local QA' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'local@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'LocalQA123!' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'LocalQA123!' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Create account/ }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({
      displayName: 'Local QA',
      email: 'local@example.com',
      password: 'LocalQA123!'
    }));

    fireEvent.click(screen.getByRole('link', { name: 'privacy and data policy' }));
    expect(onNavigate).toHaveBeenCalledWith('/privacy');
  });

  it('shows login failures without presenting a fake recovery action', async () => {
    const onComplete = vi.fn().mockRejectedValue(new Error('The email or password is incorrect.'));
    render(<AuthScreen mode="login" onNavigate={vi.fn()} onComplete={onComplete} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'missing@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Incorrect123!' } });
    fireEvent.click(screen.getByRole('button', { name: /^Log in/ }));

    expect(await screen.findByText('The email or password is incorrect.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Forgot your password?' })).not.toBeInTheDocument();
  });

  it('dismisses the profile menu when clicking outside or pressing Escape', () => {
    render(<AppBar bootstrap={bootstrap} onNavigate={vi.fn()} onRefresh={vi.fn()} onLogout={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: 'Development user' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('loads fallback schema once for artifacts that do not carry schema', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schema: {
        kind: 'sqlite',
        label: 'Fixture database',
        tables: [{ name: 'users', columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }] }]
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    render(<DataInspector artifact={artifact} connectionId="fixture-db" connectionLabel="Fixture database" inspectorWidth={384} onInspectorWidthChange={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }));
    fireEvent.click(screen.getByRole('button', { name: /Tables/ }));

    expect(screen.getByText('Loading schema…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('users')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Loading schema…')).not.toBeInTheDocument();
  });

  it('renames and confirms deletion from a chat row', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<ChatSidebarRow
      chat={{
        id: 'chat-1',
        title: 'Customer analysis',
        messageCount: 2,
        artifactCount: 1,
        createdAt: '2026-08-09T18:00:00.000Z',
        updatedAt: '2026-08-09T19:00:00.000Z'
      }}
      selected
      onSelect={vi.fn()}
      onRename={onRename}
      onDelete={onDelete}
    />);

    const actions = screen.getByRole('button', { name: 'Actions for Customer analysis' });
    fireEvent.click(actions);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Chat name'), { target: { value: 'Monthly revenue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('Monthly revenue'));

    fireEvent.click(actions);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(screen.getByRole('dialog', { name: 'Delete Customer analysis' })).toHaveTextContent('This cannot be undone.');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledOnce());
  });
});
