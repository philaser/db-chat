export type SafetyLevel = 'safe' | 'standard' | 'unrestricted';

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  isWrite?: boolean;
  isDDL?: boolean;
  modifiedQuery?: string;
}

export class QueryValidator {
  static validate(query: string, safetyLevel: SafetyLevel): ValidationResult {
    const normalized = query.trim();

    const isDDL = QueryValidator.isDDL(normalized);
    const isWrite = QueryValidator.isWrite(normalized);

    if (isDDL) {
      if (safetyLevel === 'safe' || safetyLevel === 'standard') {
        return { ok: false, reason: 'DDL statements are not permitted at this safety level.', isDDL: true };
      }
      return { ok: true, isDDL: true };
    }

    if (safetyLevel === 'safe' && isWrite) {
      return { ok: false, reason: 'Write queries are not permitted in Safe mode.', isWrite: true };
    }

    if (isWrite) {
      return { ok: true, isWrite: true };
    }

    return QueryValidator.enforceLimit(normalized);
  }

  private static isDDL(query: string): boolean {
    const ddlPattern = /^\s*(CREATE|DROP|ALTER|TRUNCATE|RENAME|GRANT|REVOKE)\s/i;
    return ddlPattern.test(query);
  }

  private static isWrite(query: string): boolean {
    const writePattern = /^\s*(INSERT|UPDATE|DELETE|REPLACE|MERGE|UPSERT)\s/i;
    return writePattern.test(query);
  }

  private static enforceLimit(query: string): ValidationResult {
    const limitPattern = /\bLIMIT\s+(\d+)\s*$/i;
    const match = limitPattern.exec(query);
    const MAX_LIMIT = 1000;

    if (match) {
      const currentLimit = parseInt(match[1], 10);
      if (currentLimit > MAX_LIMIT) {
        const modified = query.replace(limitPattern, `LIMIT ${MAX_LIMIT}`);
        return { ok: true, modifiedQuery: modified };
      }
      return { ok: true };
    }

    const endPattern = /;?\s*$/;
    const modified = query.replace(endPattern, '') + ` LIMIT ${MAX_LIMIT}`;
    return { ok: true, modifiedQuery: modified };
  }
}
