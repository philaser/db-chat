import type { DbChatApi } from '../shared/types';

declare global {
  interface Window {
    dbchat: DbChatApi;
  }
}

export {};
