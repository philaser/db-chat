import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebPolicyConnector } from '../src/server/connectorFactory';
import type { DatabaseConnector } from '../src/shared/types';

afterEach(() => vi.useRealTimers());

describe('hosted schema discovery deadline', () => {
  it('closes a connector whose multi-query discovery stalls beyond its total deadline', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const inner: DatabaseConnector = { connect: async () => {}, introspect: () => new Promise(() => {}), executeQuery: vi.fn(), getContextForPrompt: async () => '', setSafetyLevel() {}, close };
    const pending = new WebPolicyConnector(inner, 100, 1024).introspect();
    const failed = expect(pending).rejects.toThrow(/schema discovery exceeded/);
    await vi.advanceTimersByTimeAsync(35_000);
    await failed;
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
