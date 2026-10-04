import type { FollowUpIntent } from '../shared/types.js';

export interface TurnClaimOptions {
  workerId?: string;
  accountActiveLimit?: number;
  globalActiveLimit?: number;
  managed?: boolean;
  accountDailyLimit?: number;
  globalDailyLimit?: number;
  attemptOf?: string;
  intent?: FollowUpIntent;
}

export class ManagedTurnQuotaError extends Error {
  constructor(readonly scope: 'account' | 'global') {
    super(scope === 'account'
      ? 'Your daily managed answer limit has been reached. Try again after midnight UTC.'
      : 'The daily managed answer limit has been reached. Try again after midnight UTC.');
  }
}

export interface UploadAllowance {
  accountCount: number;
  globalCount: number;
  accountBytes: number;
  globalBytes: number;
}

export class UploadQuotaError extends Error {
  constructor() { super('The daily SQLite upload allowance has been reached. Try again after midnight UTC.'); }
}
