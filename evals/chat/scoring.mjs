function normalized(value) {
  return typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value;
}

function canon(rows) {
  return JSON.stringify(rows.map(row => row.map(normalized)));
}

function isExactScalarExpected(expected) {
  return Array.isArray(expected) && expected.length === 1
    && Array.isArray(expected[0]) && expected[0].length === 1;
}

function isExactScalarResult(result) {
  return result.columns.length === 1 && result.rows.length === 1
    && Object.prototype.hasOwnProperty.call(result.rows[0], result.columns[0]);
}

export function artifactMatchesNumericExpectation(item, artifact) {
  const { result } = artifact;
  if (isExactScalarExpected(item.expected) && isExactScalarResult(result)) {
    return canon([[result.rows[0][result.columns[0]]]]) === canon(item.expected);
  }

  const columns = item.projection
    ? item.projection.columns.map(pattern => result.columns.find(column => new RegExp(pattern, 'i').test(column)))
    : result.columns;
  if (columns.some(column => column === undefined)) return false;

  const projectedRows = result.rows.filter(row => Object.entries(item.projection?.where ?? {})
    .every(([column, value]) => !(column in row) || row[column] === value));
  const rows = projectedRows.map(row => columns.map(column => row[column]));
  return item.expected
    ? canon(rows) === canon(item.expected)
    : item.expectedRows !== undefined
      ? rows.length === item.expectedRows
      : false;
}

export function findMatchingNumericArtifact(item, artifacts) {
  return artifacts.find(artifact => artifactMatchesNumericExpectation(item, artifact));
}
