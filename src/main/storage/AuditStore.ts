import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AuditEntry } from '../../shared/types.js';

export class AuditStore {
  private filePath: string;
  private entries: AuditEntry[] = [];

  constructor() {
    const userDataPath = app?.getPath?.('userData') ?? process.cwd();
    this.filePath = path.join(userDataPath, 'audit-log.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        this.entries = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch { /* ignore */ }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries.slice(0, 5000), null, 2));
    } catch { /* best effort */ }
  }

  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    this.entries.unshift({
      ...entry,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString()
    });
    if (this.entries.length % 10 === 0) this.save();
  }

  getEntries(limit = 100): AuditEntry[] {
    return this.entries.slice(0, limit);
  }

  flush(): void {
    this.save();
  }
}