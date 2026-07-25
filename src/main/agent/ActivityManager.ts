import type { WebContents } from 'electron';
import type { AgentEvent } from '../../shared/types.js';

export class ActivityManager {
  private events: AgentEvent[] = [];

  constructor(
    private turnId: string,
    private webContents?: WebContents
  ) {}

  emit(type: AgentEvent['type'], data?: Record<string, unknown>): void {
    const event: AgentEvent = {
      turnId: this.turnId,
      type,
      timestamp: new Date().toISOString(),
      data: data ?? {}
    };

    this.events.push(event);

    if (this.webContents && !this.webContents.isDestroyed()) {
      this.webContents.send(`dbchat:agent-event:${this.turnId}`, event);
    }
  }

  textDelta(delta: string): void {
    this.emit('text-delta', { delta });
  }

  toolStart(toolName: string, purpose?: string): void {
    this.emit('tool-start', { toolName, purpose });
  }

  toolComplete(toolName: string, summary: string): void {
    this.emit('tool-complete', { toolName, summary });
  }

  thinkingStart(): void {
    this.emit('thinking-start', {});
  }

  thinkingDelta(delta: string): void {
    this.emit('thinking-delta', { delta });
  }

  status(message: string): void {
    this.emit('status', { message });
  }

  complete(message: Record<string, unknown>): void {
    this.emit('complete', { message });
  }

  error(message: string): void {
    this.emit('error', { message });
  }

  aborted(): void {
    this.emit('aborted');
  }

  approvalRequired(interruption: Record<string, unknown>): void {
    this.emit('approval-required', interruption);
  }

  approvalResolved(interruptionId: string, approved: boolean): void {
    this.emit('approval-resolved', { interruptionId, approved });
  }

  getEvents(): AgentEvent[] {
    return [...this.events];
  }
}
