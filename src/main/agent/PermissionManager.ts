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
    ];
  }

  setSafetyLevel(level: SafetyLevel): void {
    this.safetyLevel = level;
  }

  check(toolName: string, input: Record<string, unknown>): PermissionAction {
    const rule = this.rules.find(r => r.toolName === toolName);
    if (!rule) return 'ask';

    if (toolName === 'run_database_query') {
      const query = (input.query as string) ?? '';
      if (this.safetyLevel === 'unrestricted') return 'ask';

      const writePattern = /^\s*(INSERT|UPDATE|DELETE|REPLACE|MERGE|UPSERT|CREATE|DROP|ALTER|TRUNCATE|RENAME|GRANT|REVOKE)\s/i;
      if (writePattern.test(query.trim())) {
        if (this.safetyLevel === 'safe') return 'deny';
        return 'ask';
      }

      return 'allow';
    }

    return rule.action;
  }
}
