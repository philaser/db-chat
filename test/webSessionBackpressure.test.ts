// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { WebSessionStore } from '../src/server/sessionStore';

function response() {
  const value = Object.assign(new EventEmitter(), {
    writableLength: 0, destroyed: false,
    write: vi.fn(() => true), end: vi.fn(),
    destroy: vi.fn(() => { value.destroyed = true; value.emit('close'); })
  });
  return value;
}

describe('stream subscriber budgets', () => {
  it('disconnects a stalled subscriber without preventing a healthy subscriber from receiving events', () => {
    const store = new WebSessionStore(1000);
    try {
      const turn = store.createTurn({ id: 'owner', roles: [] }, []);
      const stalled = response();
      const healthy = response();
      store.subscribe(turn, stalled as unknown as ServerResponse, 0);
      store.subscribe(turn, healthy as unknown as ServerResponse, 0);
      stalled.writableLength = 4 * 1024 * 1024 + 1;
      store.publish(turn, 'text-delta', { text: 'Answer' });
      expect(stalled.destroy).toHaveBeenCalledOnce();
      expect(healthy.write).toHaveBeenLastCalledWith(expect.stringContaining('Answer'));
      expect(turn.subscribers.size).toBe(1);
      expect(turn.abortController.signal.aborted).toBe(false);
    } finally { store.close(); }
  });

  it('ends all outstanding event streams when the server closes', () => {
    const store = new WebSessionStore(1000);
    const turn = store.createTurn({ id: 'owner', roles: [] }, []);
    const stream = response();
    store.subscribe(turn, stream as unknown as ServerResponse, 0);
    store.close();
    expect(stream.end).toHaveBeenCalledOnce();
    stream.emit('close');
    expect(store.activeTurnCount()).toBe(0);
  });
});
