import { parseMongoDBQuery, findBlockedAggregationStage, findBlockedKey as blockedMongoKey } from './mongodbValidation.js';
import { parseElasticsearchQuery, findBlockedKey as blockedSearchKey } from './elasticsearchValidation.js';

export type SafetyLevel = 'safe' | 'standard' | 'elevated' | 'unrestricted';
export type QueryOperation = 'read' | 'write' | 'ddl' | 'unknown';
export interface ValidationResult {
  ok: boolean;
  reason?: string;
  isWrite?: boolean;
  isDDL?: boolean;
  modifiedQuery?: string;
}

const WRITE = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'UPSERT']);
const DDL = new Set(['CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE']);
const UNSAFE_READ = new Set(['INTO', 'ATTACH', 'DETACH', 'PRAGMA', 'COPY', 'CALL', 'EXEC', 'EXECUTE', 'LOAD_EXTENSION', 'LOAD_FILE', 'OUTFILE', 'DUMPFILE']);

// A deliberately conservative lexer, not a SQL grammar. Unsupported syntax is
// rejected; database read-only handles/transactions are the second boundary.
function sqlStatement(query: string): { sql: string; words: string[] } | null {
  let sql = '';
  const words: string[] = [];
  let ended = false;
  for (let i = 0; i < query.length;) {
    const rest = query.slice(i);
    if (/^\s/.test(rest)) { sql += query[i++]; continue; }
    if (rest.startsWith('--')) {
      const end = query.indexOf('\n', i + 2);
      i = end < 0 ? query.length : end;
      sql += '\n'; continue;
    }
    if (rest.startsWith('/*')) {
      // MySQL executable comments must never be interpreted as ordinary comments.
      if (/^\/\*[!+]/.test(rest)) return null;
      let depth = 1;
      i += 2;
      while (i < query.length && depth) {
        if (query.slice(i, i + 2) === '/*') return null;
        else if (query.slice(i, i + 2) === '*/') { depth--; i += 2; }
        else i++;
      }
      if (depth) return null;
      sql += ' '; continue;
    }
    if (ended) return null;
    const char = query[i];
    if (char === ';') { ended = true; i++; continue; }
    // Dollar quoting, backslash escapes and hash comments vary by SQL mode.
    if (char === '$' || char === '#' || char === '\\') return null;
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const endQuote = char === '[' ? ']' : char;
      const start = i++;
      let closed = false;
      while (i < query.length) {
        if (query[i] === '\\') return null;
        if (query[i++] === endQuote) {
          if (query[i] === endQuote) { i++; continue; }
          closed = true; break;
        }
      }
      if (!closed) return null;
      sql += query.slice(start, i); continue;
    }
    const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest)?.[0];
    if (word) { words.push(word.toUpperCase()); sql += word; i += word.length; }
    else { sql += char; i++; }
  }
  return words.length ? { sql: sql.trim(), words } : null;
}

export function classifyQuery(query: string): QueryOperation {
  if (typeof query !== 'string' || !query.trim()) return 'unknown';
  if (query.trim().startsWith('{')) {
    try {
      const value = JSON.parse(query);
      if ('collection' in value) {
        if ('index' in value || 'operation' in value) return 'unknown';
        const parsed = parseMongoDBQuery(query);
        if (['insertOne', 'updateOne', 'deleteOne'].includes(parsed.method)) return 'write';
        if ('body' in parsed && (blockedMongoKey(parsed.body) ||
          (parsed.method === 'aggregate' && (!Array.isArray(parsed.body.pipeline) || findBlockedAggregationStage(parsed.body.pipeline))))) return 'unknown';
        return 'read';
      }
      if ('method' in value) return 'unknown';
      const parsed = parseElasticsearchQuery(query);
      return 'operation' in parsed ? 'write' : blockedSearchKey(parsed.body) ? 'unknown' : 'read';
    } catch { return 'unknown'; }
  }
  const statement = sqlStatement(query);
  if (!statement) return 'unknown';
  const [first] = statement.words;
  if (DDL.has(first)) return 'ddl';
  if (WRITE.has(first)) return 'write';
  if (first !== 'SELECT' && first !== 'WITH') return 'unknown';
  if (statement.words.some(word => UNSAFE_READ.has(word) || DDL.has(word))) return 'unknown';
  if (statement.words.some(word => WRITE.has(word))) return 'write';
  return 'read';
}

export class QueryValidator {
  static validate(query: string, safetyLevel: SafetyLevel, maxRows = 1000): ValidationResult {
    const operation = classifyQuery(query);
    if (operation === 'unknown') return { ok: false, reason: 'Unsupported or ambiguous query. Use one explicit read or write operation.' };
    if (operation === 'ddl') return safetyLevel === 'safe' || safetyLevel === 'standard'
      ? { ok: false, reason: 'DDL statements are not permitted at this safety level.', isDDL: true }
      : { ok: true, isDDL: true };
    if (operation === 'write') return safetyLevel === 'safe'
      ? { ok: false, reason: 'Write queries are not permitted in Safe mode.', isWrite: true }
      : { ok: true, isWrite: true };
    const statement = sqlStatement(query);
    if (!statement) return { ok: false, reason: 'Expected a SQL statement.' };
    const limit = Math.max(1, Math.min(1000, Math.floor(maxRows)));
    // Wrapping preserves existing LIMIT/OFFSET clauses (including semicolons and
    // comments) and fetches one look-ahead row to report actual truncation.
    return { ok: true, modifiedQuery: `SELECT * FROM (${statement.sql}\n) AS dbchat_bounded LIMIT ${limit + 1}` };
  }
}
