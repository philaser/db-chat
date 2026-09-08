import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionForm } from '../src/web/App.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('connection form', () => {
  it('does not call the API when required connection fields are blank', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const bootstrap = {
      ready: true,
      user: { id: 'fixture', email: 'reader@example.test', displayName: 'Reader', emailVerified: true, createdAt: '2026-09-06' },
      connections: [],
      settings: { provider: 'openrouter' as const, model: 'fixture', effortLevel: 'medium' as const },
      inference: { provider: 'openrouter' as const, model: 'fixture', credentialSource: 'internal' as const, hasUserKey: false, userKeyUiEnabled: false, status: 'ready' as const },
      capabilities: { queryResults: true, csvExport: true, charts: true },
      limits: { maxHistoryMessages: 40, maxMessageChars: 8000, maxResultRows: 100, maxResultBytes: 1048576 }
    };

    render(<ConnectionForm bootstrap={bootstrap} onNavigate={vi.fn()} onRefresh={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save and test' }));

    expect(screen.getByLabelText('Connection name')).toBeInvalid();
    expect(screen.getByLabelText('Host')).toBeInvalid();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
