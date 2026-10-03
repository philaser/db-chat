import type { ChatMessage } from '../shared/types.js';
export const SAVED_READ_BYTES = 16 * 1024 * 1024;
export const CONTEXT_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const CONTEXT_MESSAGE_BYTES = 4 * 1024 * 1024;
export const CONTEXT_CANDIDATES = 128;
export class SavedDataReadLimitError extends Error {
  constructor() { super('This saved data is too large for one read. Reduce the history page size, select a specific result, or start a new chat. Your saved data is unchanged.'); }
}
export interface SavedReadBudget { remaining: number; parent?: SavedReadBudget }
export interface ChatContextSelection { messageId?: string; artifactId?: string }
export interface ContextMessageRow { position: number; body: ChatMessage }
export const DEFINITION_WORDS = 'define|definition|means?|use|exclude|include|timezone|denominator|correction|actually|instead|remember|revenue|conversion|active|filter|metric|utc';
export const LIMITATION_WORDS = 'unknown|unavailable|missing|cannot determine|no date|not present';
export const isContextRelevant = (message: ChatMessage) => message.role === 'user' || (message.role === 'assistant' && (!message.turn || message.turn.status === 'complete'));
export const isContextRetained = (message: ChatMessage) => Boolean(message.pinned)
  || (message.role === 'user' && new RegExp('\\b(' + DEFINITION_WORDS + ')\\b', 'i').test(message.content))
  || (message.role === 'assistant' && new RegExp('\\b(' + LIMITATION_WORDS + ')\\b', 'i').test(message.content));
export function compactContextMessage(message: ChatMessage): ChatMessage {
  return { id: message.id, role: message.role, content: message.content.slice(0, 8000), createdAt: message.createdAt,
    ...(message.pinned ? { pinned: true } : {}), ...(message.turn ? { turn: { id: message.turn.id, status: message.turn.status,
      question: message.turn.question?.slice(0, 8000)!, attemptOf: message.turn.attemptOf, intent: message.turn.intent } } : {}) };
}
/** Input candidates are bounded by the reader; keep their order and evidence semantics. */
export function boundedContextMessages(rows: ContextMessageRow[]): ChatMessage[] {
  return [...new Map(rows.map(row => [row.body.id, row])).values()]
    .sort((a, b) => a.position - b.position)
    .map(row => {
      const message = compactContextMessage(row.body);
      // The defining word may occur after the per-message text window. Preserve
      // its eligibility after truncation without copying the remaining content.
      if (isContextRetained(row.body)) message.pinned = true;
      return message;
    });
}
export function spendReadBudget(budget: SavedReadBudget | undefined, bytes: number): void {
  if (!budget) return;
  for (let current: SavedReadBudget | undefined=budget; current; current=current.parent) if (bytes>current.remaining) throw new SavedDataReadLimitError();
  for (let current: SavedReadBudget | undefined=budget; current; current=current.parent) current.remaining-=bytes;
}
