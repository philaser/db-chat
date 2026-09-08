import { describe, expect, it } from 'vitest';
// The evaluator is an executable ESM script, so its scorer stays framework-neutral JavaScript.
// @ts-expect-error This local .mjs helper intentionally has no declaration file.
import { artifactMatchesNumericExpectation } from '../evals/chat/scoring.mjs';

const item = {
  expected: [[610]],
  projection: { columns: ['^(value|net_revenue)$'] }
};

function artifact(columns: string[], rows: Record<string, unknown>[]) {
  return { result: { columns, rows, rowCount: rows.length, elapsedMs: 1 } };
}

describe('chat evaluation numeric scoring', () => {
  it('accepts an exact scalar regardless of its SQL-generated alias', () => {
    expect(artifactMatchesNumericExpectation(
      item,
      artifact(['SUM(amount - refund)'], [{ 'SUM(amount - refund)': 610 }])
    )).toBe(true);
  });

  it('rejects a wrong scalar value or extra result rows', () => {
    expect(artifactMatchesNumericExpectation(item, artifact(['SUM(amount)'], [{ 'SUM(amount)': 609 }]))).toBe(false);
    expect(artifactMatchesNumericExpectation(item, artifact(['SUM(amount)'], [
      { 'SUM(amount)': 610 },
      { 'SUM(amount)': 610 }
    ]))).toBe(false);
  });

  it('does not treat one matching value among diagnostic columns as an exact scalar', () => {
    expect(artifactMatchesNumericExpectation(
      item,
      artifact(['SUM(amount - refund)', 'completed_count'], [{ 'SUM(amount - refund)': 610, completed_count: 4 }])
    )).toBe(false);
  });

  it('preserves projection and ordered-value matching for multi-column evidence', () => {
    const projected = {
      expected: [['Ada', 300], ['Ben', 90]],
      projection: { columns: ['^customer$', '^total$'] }
    };
    const result = artifact(['diagnostic', 'customer', 'total'], [
      { diagnostic: 1, customer: 'Ada', total: 300 },
      { diagnostic: 2, customer: 'Ben', total: 90 }
    ]);
    expect(artifactMatchesNumericExpectation(projected, result)).toBe(true);
    expect(artifactMatchesNumericExpectation(
      projected,
      artifact(result.result.columns, [...result.result.rows].reverse())
    )).toBe(false);
  });
});
