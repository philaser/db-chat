export interface ApprovalInterruption {
  id: string;
  turnId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  purpose: string;
  risk: 'none' | 'low' | 'medium' | 'high';
  queryPreview?: string;
  timestamp: string;
}

export class ApprovalManager {
  private pending: Map<string, ApprovalInterruption> = new Map();
  private resolveMap: Map<string, (approved: boolean) => void> = new Map();
  private sessionAllowlist: Array<{ toolName: string; pattern: RegExp }> = [];

  createInterruption(
    turnId: string,
    toolName: string,
    input: Record<string, unknown>
  ): ApprovalInterruption {
    const id = crypto.randomUUID();
    const query = (input.query as string) ?? '';
    const isWrite = /^\s*(INSERT|UPDATE|DELETE|REPLACE|MERGE|UPSERT|CREATE|DROP|ALTER)\s/i.test(query.trim());

    const interruption: ApprovalInterruption = {
      id,
      turnId,
      toolName,
      toolInput: input,
      purpose: (input.purpose as string) ?? `Execute ${toolName}`,
      risk: isWrite ? 'medium' : 'low',
      queryPreview: query ? (query.length > 200 ? query.slice(0, 197) + '...' : query) : undefined,
      timestamp: new Date().toISOString()
    };

    this.pending.set(id, interruption);
    return interruption;
  }

  waitForDecision(id: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolveMap.set(id, resolve);
    });
  }

  approve(id: string): void {
    this.pending.delete(id);
    const resolve = this.resolveMap.get(id);
    if (resolve) {
      this.resolveMap.delete(id);
      resolve(true);
    }
  }

  deny(id: string): void {
    this.pending.delete(id);
    const resolve = this.resolveMap.get(id);
    if (resolve) {
      this.resolveMap.delete(id);
      resolve(false);
    }
  }

  getPending(id: string): ApprovalInterruption | undefined {
    return this.pending.get(id);
  }

  addToAllowlist(toolName: string, pattern: RegExp): void {
    this.sessionAllowlist.push({ toolName, pattern });
  }

  isAllowedBySession(toolName: string, input: Record<string, unknown>): boolean {
    const query = (input.query as string) ?? '';
    return this.sessionAllowlist.some(
      entry => entry.toolName === toolName && entry.pattern.test(query)
    );
  }
}
