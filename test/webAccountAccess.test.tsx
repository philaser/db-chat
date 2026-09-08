import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountRecoveryScreen, AuthScreen, ProfileSecurity } from '../src/web/App.js';
function captureDom(name: string) {
  const directory = process.env.DBCHAT_UI_DOM_OUTPUT;
  if (!directory) return;
  fs.mkdirSync(directory, { recursive: true });
  const snapshot = document.body.cloneNode(true) as HTMLElement;
  snapshot.querySelectorAll('input[type="password"]').forEach(input => input.removeAttribute('value'));
  fs.writeFileSync(path.join(directory, name + '.html'), '<!doctype html><html><head><meta charset="utf-8"><title>DB Chat DOM evidence</title></head><body>' + snapshot.innerHTML + '</body></html>');
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); });

describe('email account access', () => {
  it('shows verification pending without retaining passwords after signup', async () => {
    render(<AuthScreen mode="signup" onNavigate={vi.fn()} onComplete={vi.fn(async () => ({ confirmationRequired: true }))} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'reader@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /^Create account/ }));
    expect(await screen.findByText('Check your email')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    captureDom('signup-confirmation');
  });

  it('requests recovery and gives an account-neutral response', async () => {
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => json({ ok: true })); vi.stubGlobal('fetch', fetcher);
    render(<AccountRecoveryScreen mode="forgot" onNavigate={vi.fn()} onVerified={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'reader@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/If an account can receive recovery email/)).toBeInTheDocument();
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/auth/forgot-password');
    captureDom('recovery-requested');
  });

  it('verifies a recovery token once in strict mode and removes it from history', async () => {
    window.history.replaceState({}, '', '/auth/confirm?token_hash=fixture-token&type=recovery');
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => json({ ok: true })); vi.stubGlobal('fetch', fetcher);
    const navigate = vi.fn();
    render(<StrictMode><AccountRecoveryScreen mode="confirm" onNavigate={navigate} onVerified={vi.fn()} /></StrictMode>);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/reset-password'));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(window.location.search).toBe('');
  });

  it('validates confirmation before submitting a new password', async () => {
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => json({ ok: true })); vi.stubGlobal('fetch', fetcher);
    render(<AccountRecoveryScreen mode="reset" onNavigate={vi.fn()} onVerified={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password123' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'different-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));
    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    captureDom('reset-password-validation');
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'new-password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));
    expect(await screen.findByText(/Your password has been updated/)).toBeInTheDocument();
    captureDom('password-reset-success');
  });
  it('requires a password and explicit confirmation before account deletion', async () => {
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => json({ ok: true })); vi.stubGlobal('fetch', fetcher);
    const logout = vi.fn(async () => undefined);
    const bootstrap = {
      ready: true, user: { id: 'fixture', email: 'reader@example.test', displayName: 'Reader', emailVerified: true, createdAt: '2026-09-05' }, connections: [],
      settings: { provider: 'openrouter' as const, model: 'fixture', effortLevel: 'medium' as const },
      inference: { provider: 'openrouter' as const, model: 'fixture', credentialSource: 'internal' as const, hasUserKey: false, userKeyUiEnabled: false, canChangeModel: false, models: [{ id: 'fixture', name: 'Fixture' }], status: 'ready' as const },
      capabilities: { queryResults: true, csvExport: true, charts: true }, limits: { maxHistoryMessages: 40, maxMessageChars: 8000, maxResultRows: 100, maxResultBytes: 1048576 }
    };
    render(<ProfileSecurity bootstrap={bootstrap} onRefresh={vi.fn()} onLogout={logout} />);
    expect(screen.getByRole('button', { name: 'Delete account' })).toBeDisabled();
    captureDom('account-deletion-controls');
    fireEvent.change(screen.getByLabelText('Confirm account password'), { target: { value: 'fixture-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Delete your account?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
    fireEvent.click(screen.getByRole('dialog', { name: 'Delete your account?' }).querySelector('.button-destructive') as HTMLButtonElement);
    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledWith('/api/v1/account', expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ password: 'fixture-password' }) }));
  });

});
