import type { ChatMessage, QueryResultArtifact } from '../shared/types.js';

export interface Principal {
  id: string;
  displayName?: string;
  email?: string;
  emailVerified?: boolean;
  roles: string[];
}

export interface WebUser {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface WebAccountSettings {
  provider: 'openrouter';
  model: string;
  effortLevel: 'none' | 'low' | 'medium' | 'high' | 'max';
  activeConnectionId?: string;
}

export type WebConnectionStatus = 'ready' | 'testing' | 'needs_test' | 'unavailable' | 'needs_attention';

export interface WebConnectionSummary {
  id: string;
  label: string;
  kind: string;
  status: WebConnectionStatus;
  readOnly: true;
  safeHost?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  ssl?: boolean;
  elasticsearchUrl?: string;
  elasticsearchVerifyCerts?: boolean;
  sqliteFileName?: string;
  hasSavedSecret: boolean;
  lastTestedAt?: string;
  tableCount?: number;
  lastError?: string;
  createdAt: string;
}

export interface WebTurnEvent {
  id: number;
  turnId: string;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export type WebTurnStatus = 'queued' | 'running' | 'complete' | 'error' | 'aborted';

export interface WebTurnSnapshot {
  id: string;
  connectionId?: string;
  status: WebTurnStatus;
  events: WebTurnEvent[];
  message?: ChatMessage;
  artifacts?: QueryResultArtifact[];
  error?: string;
}
