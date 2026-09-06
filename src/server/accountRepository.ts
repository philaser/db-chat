import type { AccountStore, LoginResult } from './accountStore.js';
import type { WebTurnSnapshot, WebUser } from './types.js';
import type { ChatMessage, QueryResultArtifact } from '../shared/types.js';
export type Awaitable<T> = T | Promise<T>;
type StoreMethods = Omit<AccountStore, 'signup'>;
export type AccountRepository = {
  [K in keyof StoreMethods]: StoreMethods[K] extends (...args: infer A) => infer R
    ? (...args: A) => Awaitable<R> : never;
} & {
  signup(email: string, password: string, displayName?: string): Awaitable<{user: WebUser; sessionId?: string; confirmationRequired?: boolean}>;
  requestPasswordReset?(email: string, redirectTo: string): Promise<void>;
  verifyEmail?(tokenHash: string, type: 'signup' | 'recovery' | 'email'): Promise<LoginResult>;
  resetPassword?(sessionId: string, newPassword: string): Promise<void>;
  deleteAccount?(userId: string): Promise<void>;
  interruptPendingTurns?(): Promise<void>;
  saveTurn?(userId: string, snapshot: WebTurnSnapshot): Promise<void>;
  getTurn?(userId: string, turnId: string): Promise<WebTurnSnapshot | null>;
  claimTurn?(userId: string, turnId: string, chatId: string, requestId: string, userMessage: ChatMessage, assistantMessageId: string): Promise<{turnId: string; created: boolean}>;
  finalizeTurn?(userId: string, snapshot: WebTurnSnapshot, message?: ChatMessage, artifacts?: QueryResultArtifact[]): Promise<void>;
};
