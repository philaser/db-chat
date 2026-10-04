import type { Readable } from 'node:stream';
import type { ExportLimits, ExportRun, ExportSnapshot } from './exportJobs.js';

type Awaitable<T> = T | Promise<T>;
/** Account-owned exports; callers never learn where completed files are stored. */
export interface ExportRepository {
  readonly limits: ExportLimits;
  initialize?(): Promise<void>;
  start(owner: string, chatId: string, details: Pick<ExportSnapshot, 'title' | 'format' | 'scope'>, run: (context: ExportRun) => Promise<void>): Awaitable<ExportSnapshot>;
  get(owner: string, id: string): Awaitable<ExportSnapshot | undefined>;
  list(owner: string, chatId: string): Awaitable<ExportSnapshot[]>;
  chatId(owner: string, id: string): Awaitable<string | undefined>;
  read(owner: string, id: string): Awaitable<Readable | undefined>;
  cancel(owner: string, id: string): Promise<ExportSnapshot | undefined>;
  remove(owner: string, id: string): Promise<void>;
  cancelOwner(owner: string): Promise<void>;
  close(): Promise<void>;
}
