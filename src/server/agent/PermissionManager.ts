import { classifyQuery } from '../connectors/QueryValidator.js';
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
  private allowedTools: Set<string> | null = null;

  constructor() {
    this.rules = [
      { toolName: 'get_schema_info', action: 'allow' },
      { toolName: 'sample_data', action: 'allow' },
      { toolName: 'save_memory', action: 'ask' },
      { toolName: 'run_database_query', action: 'allow' },
      { toolName: 'visualize_data', action: 'allow' },
      { toolName: 'get_result', action: 'allow' },
      { toolName: 'ask_clarification', action: 'allow' },
      { toolName: 'create_report', action: 'allow' },
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

  setAllowedTools(toolNames: Iterable<string>): void {
    this.allowedTools = new Set(toolNames);
  }

  check(toolName: string, input: Record<string, unknown>): PermissionAction {
    if (this.allowedTools && !this.allowedTools.has(toolName)) return 'deny';
    const rule = this.rules.find(r => r.toolName === toolName);
    if (!rule) return 'ask';

    if (toolName === 'run_database_query') {
      const operation = classifyQuery(typeof input.query === 'string' ? input.query : '');
      if (operation === 'unknown') return 'deny';
      if (this.safetyLevel === 'unrestricted') return 'allow';
      if (operation === 'read') return 'allow';
      if (this.safetyLevel === 'safe') return 'deny';
      if (operation === 'ddl') return this.safetyLevel === 'elevated' ? 'ask' : 'deny';
      return this.safetyLevel === 'standard' ? 'ask' : 'allow';
    }

    return rule.action;
  }
}
