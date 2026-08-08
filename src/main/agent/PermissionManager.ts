import type { SafetyLevel } from '../../shared/types.js';

export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  toolName: string;
  action: PermissionAction;
  queryPattern?: RegExp;
}

export class PermissionManager {
  private rules: PermissionRule[] = [];
  private safetyLevel: SafetyLevel = 'standard';

  constructor() {
    this.rules = [
      { toolName: 'get_schema_info', action: 'allow' },
      { toolName: 'sample_data', action: 'allow' },
      { toolName: 'save_memory', action: 'ask' },
      { toolName: 'run_database_query', action: 'allow' },
      { toolName: 'visualize_data', action: 'allow' },
      { toolName: 'export_report', action: 'allow' },
      { toolName: 'search_memory', action: 'allow' },
    ];
  }

  setSafetyLevel(level: SafetyLevel): void {
    this.safetyLevel = level;
  }

  getSafetyLevel(): SafetyLevel {
    return this.safetyLevel;
  }

  check(toolName: string, input: Record<string, unknown>): PermissionAction {
    const rule = this.rules.find(r => r.toolName === toolName);
    if (!rule) return 'ask';

    if (toolName === 'run_database_query') {
      if (this.safetyLevel === 'unrestricted') return 'allow';

      const query = (input.query as string) ?? '';
      const isDDL = /^\s*(CREATE|DROP|ALTER|TRUNCATE|RENAME|GRANT|REVOKE)\s/i.test(query.trim());
      const isWrite = /^\s*(INSERT|UPDATE|DELETE|REPLACE|MERGE|UPSERT)\s/i.test(query.trim());

      if (this.safetyLevel === 'elevated') {
        if (isDDL) return 'ask';
        return 'allow';
      }

      if (this.safetyLevel === 'standard') {
        if (isDDL) return 'deny';
        if (isWrite) return 'ask';
        return 'allow';
      }

      // safe
      if (isDDL || isWrite) return 'deny';
      return 'allow';
    }

    return rule.action;
  }
}
