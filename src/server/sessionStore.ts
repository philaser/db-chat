import type { ServerResponse } from 'node:http';
import type { AgentEvent, ChatMessage, ModelChatMessage, QueryResultArtifact } from '../shared/types.js';
import type { Principal, WebTurnEvent, WebTurnSnapshot, WebTurnStatus } from './types.js';
import type { TurnResult } from './agent/AgentLoop.js';

interface SessionRecord {
  id: string;
  principalId: string;
  expiresAt: number;
}

export interface WebTurnRecord {
  id: string;
  principalId: string;
  connectionId?: string;
  chatId?: string;
  metrics?: import('../shared/types.js').TurnMetrics;
  question?: string;
  attemptOf?: string;
  intent?: import('../shared/types.js').FollowUpIntent;
  referencedArtifacts?: QueryResultArtifact[];
  assistantMessageId?: string;
  messages: ModelChatMessage[];
  status: WebTurnStatus;
  events: WebTurnEvent[];
  eventBytes: number;
  executing?: boolean;
  committing?: boolean;
  persistence?: Promise<void>;
  message?: ChatMessage;
  artifacts?: QueryResultArtifact[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  abortController: AbortController;
  subscribers: Set<ServerResponse>;
}

function sse(event: WebTurnEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export class WebSessionStore {
  private readonly durableSubscribers = new Map<ServerResponse, { owner: string; turn: string; refresh: () => Promise<void> }>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly turns = new Map<string, WebTurnRecord>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly ttlMs: number) {
    this.cleanupTimer = setInterval(() => this.cleanup(), Math.min(ttlMs, 60_000));
    this.cleanupTimer.unref?.();
  }

  getOrCreateSession(principal: Principal, existingId?: string): { id: string; isNew: boolean } {
    const now = Date.now();
    const existing = this.sessions.get(principal.id);
    if (existing && existing.expiresAt > now) {
      existing.expiresAt = now + this.ttlMs;
      // Refresh insertion order so the bounded cache evicts the least recent viewer.
      this.sessions.delete(principal.id);
      this.sessions.set(principal.id, existing);
      return { id: existing.id, isNew: existingId !== existing.id };
    }
    const id = crypto.randomUUID();
    if (this.sessions.size >= 10_000) this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(principal.id, { id, principalId: principal.id, expiresAt: now + this.ttlMs });
    return { id, isNew: true };
  }

  activeTurnCount(principalId?: string): number {
    return [...this.turns.values()].filter((turn) =>
      (turn.executing || turn.status === 'queued' || turn.status === 'running') && (!principalId || turn.principalId === principalId)
    ).length;
  }

  createTurn(principal: Principal, messages: ModelChatMessage[], connectionId?: string): WebTurnRecord {
    const now = new Date().toISOString();
    const record: WebTurnRecord = {
      id: crypto.randomUUID(),
      principalId: principal.id,
      connectionId,
      messages,
      status: 'queued',
      events: [],
      eventBytes: 0,
      createdAt: now,
      updatedAt: now,
      abortController: new AbortController(),
      subscribers: new Set()
    };
    this.turns.set(record.id, record);
    return record;
  }

  discard(turn: WebTurnRecord): void { this.turns.delete(turn.id); }

  getTurnForPrincipal(id: string, principal: Principal): WebTurnRecord | undefined {
    const turn = this.turns.get(id);
    return turn?.principalId === principal.id ? turn : undefined;
  }

  setStatus(turn: WebTurnRecord, status: WebTurnStatus): void {
    turn.status = status;
    turn.updatedAt = new Date().toISOString();
  }

  publishAgentEvent(turn: WebTurnRecord, event: AgentEvent): void {
    // The run promise owns terminal failure; tool-level errors may be recoverable.
    if (event.type === 'aborted') return;
    this.publish(turn, event.type === 'error' ? 'status' : event.type, event.data);
  }

  publish(turn: WebTurnRecord, type: string, data: Record<string, unknown>): void {
    const event: WebTurnEvent = {
      id: turn.events.length + 1,
      turnId: turn.id,
      type,
      timestamp: new Date().toISOString(),
      data
    };
    const encoded = sse(event);
    const bytes = Buffer.byteLength(encoded);
    if (!['error', 'aborted'].includes(type) && (turn.events.length >= 10000 || turn.eventBytes + bytes > 4 * 1024 * 1024)) {
      turn.abortController.abort();
      turn.error = 'The answer exceeded the streaming result budget. Ask for a smaller result.';
      return;
    }
    turn.eventBytes += bytes;
    turn.events.push(event);
    turn.updatedAt = event.timestamp;
    for (const subscriber of turn.subscribers) {
      if (subscriber.destroyed) {
        turn.subscribers.delete(subscriber);
        continue;
      }
      // A slow client can reconnect using Last-Event-ID. Do not let a stalled
      // socket grow an unbounded queue while the model keeps producing events.
      subscriber.write(encoded);
      if (subscriber.writableLength > 4 * 1024 * 1024) { subscriber.destroy(); turn.subscribers.delete(subscriber); }
    }
  }

  complete(turn: WebTurnRecord, result: TurnResult): void {
    if (turn.abortController.signal.aborted || turn.status === 'aborted' || turn.status === 'error') return;
    turn.message = result.message;
    turn.artifacts = result.artifacts;
    this.setStatus(turn, 'complete');
    this.publish(turn, 'complete', {
      message: result.message,
      artifactIds: result.artifacts.map((artifact) => artifact.queryId),
      artifacts: result.artifacts
    });
    this.closeSubscribers(turn);
  }

  fail(turn: WebTurnRecord, message: string): void {
    if (turn.status === 'aborted' || turn.status === 'error') return;
    turn.error = message;
    this.setStatus(turn, 'error');
    this.publish(turn, 'error', { message });
    this.closeSubscribers(turn);
  }

  abort(turn: WebTurnRecord): void {
    if (turn.status === 'complete' || turn.status === 'error' || turn.status === 'aborted') return;
    turn.abortController.abort();
    this.setStatus(turn, 'aborted');
    this.publish(turn, 'aborted', { message: 'Turn cancelled.' });
    this.closeSubscribers(turn);
  }

  subscribe(turn: WebTurnRecord, response: ServerResponse, lastEventId: number): void {
    response.write(': connected\n\n');
    for (const event of turn.events) {
      if (event.id > lastEventId) response.write(sse(event));
      if (response.writableLength > 4 * 1024 * 1024) { response.destroy(); return; }
    }
    if (turn.status === 'complete' || turn.status === 'error' || turn.status === 'aborted') {
      response.end();
      return;
    }
    if (turn.subscribers.size >= 4) { response.end(); return; }
    turn.subscribers.add(response);
    const heartbeat = setInterval(() => {
      if (response.destroyed) {
        clearInterval(heartbeat);
        turn.subscribers.delete(response);
        return;
      }
      response.write(': heartbeat\n\n');
      if (response.writableLength > 4 * 1024 * 1024) { response.destroy(); clearInterval(heartbeat); turn.subscribers.delete(response); }
    }, 15_000);
    heartbeat.unref?.();
    response.on('close', () => {
      clearInterval(heartbeat);
      turn.subscribers.delete(response);
    });
  }

  /** Streams only committed snapshots, so any worker can replay the same event IDs. */
  subscribeDurable(owner: string, initial: WebTurnSnapshot, response: ServerResponse, lastEventId: number,
    read: () => Promise<WebTurnSnapshot | null>): void {
    if ([...this.durableSubscribers.values()].filter(s => s.owner === owner).length >= 8) { response.end(); return; }
    let busy = false;
    const write = (snapshot: WebTurnSnapshot | null) => {
      if (!snapshot || response.destroyed) { response.end(); return; }
      for (const event of snapshot.events) if (event.id > lastEventId) {
        response.write(sse(event)); lastEventId = event.id;
        if (response.writableLength > 4 * 1024 * 1024) { response.destroy(); return; }
      }
      if (!['queued', 'running'].includes(snapshot.status)) response.end();
    };
    const refresh = async () => {
      if (busy || response.destroyed || response.writableEnded) return;
      busy = true;
      try { write(await read()); } catch { response.destroy(); } finally { busy = false; }
    };
    response.write(': connected\n\n');
    write(initial);
    if (response.writableEnded || response.destroyed) return;
    const poll = setInterval(() => { void refresh(); }, 500); poll.unref?.();
    const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n'); }, 15_000); heartbeat.unref?.();
    this.durableSubscribers.set(response, { owner, turn: initial.id, refresh });
    response.on('close', () => { clearInterval(poll); clearInterval(heartbeat); this.durableSubscribers.delete(response); });
  }

  acceptPersisted(turn: WebTurnRecord, snapshot: WebTurnSnapshot): void {
    Object.assign(turn, snapshot);
    for (const subscriber of this.durableSubscribers.values()) if (subscriber.turn === turn.id) void subscriber.refresh();
  }

  async flushDurable(): Promise<void> { await Promise.all([...this.durableSubscribers.values()].map(s => s.refresh())); }

  snapshot(turn: WebTurnRecord): WebTurnSnapshot {
    return {
      id: turn.id,
      chatId: turn.chatId,
      metrics: turn.metrics,
      question: turn.question,
      attemptOf: turn.attemptOf,
      intent: turn.intent,
      assistantMessageId: turn.assistantMessageId,
      createdAt: turn.createdAt,
      connectionId: turn.connectionId,
      status: turn.status,
      events: turn.events,
      message: turn.message,
      artifacts: turn.artifacts,
      error: turn.error
    };
  }

  private closeSubscribers(turn: WebTurnRecord): void {
    for (const subscriber of turn.subscribers) {
      if (!subscriber.destroyed) subscriber.end();
    }
    turn.subscribers.clear();
  }

  close(): void {
    clearInterval(this.cleanupTimer);
    for (const turn of this.turns.values()) this.closeSubscribers(turn);
    for (const response of this.durableSubscribers.keys()) response.end();
    this.durableSubscribers.clear();
    this.sessions.clear();
    this.turns.clear();
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt < Date.now()) this.sessions.delete(id);
    }
    for (const [id, turn] of this.turns) {
      if (!turn.executing && Date.parse(turn.updatedAt) < cutoff && turn.subscribers.size === 0) {
        if (turn.status === 'running' || turn.status === 'queued') turn.abortController.abort();
        this.turns.delete(id);
      }
    }
  }
}
