import type { ModelChatMessage, QueryResultArtifact } from '../shared/types.js';
import type { AllChartType } from '../shared/chart.js';

const VISUALIZATION_REQUEST = /\b(?:chart|graph|plot|visuali[sz](?:e|ation)|visualisation)\b/i;
const VISUALIZATION_CONTEXT = /\b(?:trend|over time|distribution|correlation|relationship|quarter[- ]over[- ]quarter)\b/i;

const EXPLICIT_CHART_TYPES: Array<[RegExp, AllChartType]> = [
  [/\bslope\b/i, 'slope'],
  [/\bscatter(?:plot)?\b/i, 'scatter'],
  [/\bradar\b/i, 'radar'],
  [/\bradial(?: bar)?\b/i, 'radialBar'],
  [/\bfunnel\b/i, 'funnel'],
  [/\btreemap\b/i, 'treemap'],
  [/\bsunburst\b/i, 'sunburst'],
  [/\b(?:donut|doughnut|pie)\b/i, 'pie'],
  [/\barea\b/i, 'area'],
  [/\bcomposed\b/i, 'composed'],
  [/\b(?:bar|column)\b/i, 'bar'],
  [/\bline\b/i, 'line']
];

function latestUserQuestion(messages: ModelChatMessage[]): string {
  return [...messages].reverse().find((message) => message.role === 'user')?.content?.trim() ?? '';
}

function isNumeric(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string' || value.trim() === '') return false;
  return Number.isFinite(Number(value));
}

function numericColumns(artifact: QueryResultArtifact): string[] {
  return artifact.result.columns.filter((column) => {
    const values = artifact.result.rows.map((row) => row[column]);
    return values.length > 0 && values.filter(isNumeric).length >= Math.max(1, Math.ceil(values.length * 0.6));
  });
}

function labelColumn(artifact: QueryResultArtifact): string | undefined {
  return artifact.result.columns.find((column) => {
    const values = artifact.result.rows.map((row) => row[column]);
    return values.some((value) => !isNumeric(value)) && new Set(values.map(String)).size > 1;
  }) ?? artifact.result.columns[0];
}

function isTimeLike(column: string, rows: Record<string, unknown>[]): boolean {
  return /(?:date|time|month|quarter|year|week|day|period)/i.test(column)
    || rows.some((row) => typeof row[column] === 'string' && /^\d{4}(?:[-/]\d{1,2})?(?:[-/]\d{1,2})?$/.test(row[column] as string));
}

export function hasVisualizationRequest(messages: ModelChatMessage[]): boolean {
  const question = latestUserQuestion(messages);
  return VISUALIZATION_REQUEST.test(question) || VISUALIZATION_CONTEXT.test(question);
}

export function hasChartMarkup(content: string): boolean {
  return /```\s*chart\b/i.test(content) || /["']chartType["']\s*:\s*["'][a-zA-Z]+["']/.test(content);
}

export function selectVisualizationArtifact(
  artifacts: QueryResultArtifact[]
): { artifact: QueryResultArtifact; nameKey: string; valueKeys: string[] } | null {
  const candidates = artifacts
    .map((artifact, index) => ({ artifact, index, nameKey: labelColumn(artifact), valueKeys: numericColumns(artifact) }))
    .filter(({ artifact, nameKey, valueKeys }) => (
      Boolean(nameKey)
      && artifact.result.rows.length >= 2
      && valueKeys.length > 0
      && valueKeys.some((key) => key !== nameKey)
    ));

  if (candidates.length === 0) return null;

  // The last compatible result is the one produced closest to the final answer.
  // Row count is coverage metadata, not a relevance score.
  candidates.sort((a, b) => b.index - a.index);

  const selected = candidates[0];
  return {
    artifact: selected.artifact,
    nameKey: selected.nameKey!,
    valueKeys: selected.valueKeys.filter((key) => key !== selected.nameKey)
  };
}

export function inferChartType(
  messages: ModelChatMessage[],
  nameKey: string,
  rows: Record<string, unknown>[]
): AllChartType {
  const question = latestUserQuestion(messages);
  for (const [pattern, chartType] of EXPLICIT_CHART_TYPES) {
    if (pattern.test(question)) return chartType;
  }
  return isTimeLike(nameKey, rows) || VISUALIZATION_CONTEXT.test(question) ? 'line' : 'bar';
}

export function buildVisualizationInput(
  messages: ModelChatMessage[],
  selected: { artifact: QueryResultArtifact; nameKey: string; valueKeys: string[] }
): Record<string, unknown> {
  const { artifact, nameKey, valueKeys } = selected;
  const chartType = inferChartType(messages, nameKey, artifact.result.rows);
  const values = chartType === 'pie' || chartType === 'radialBar' || chartType === 'funnel'
    ? valueKeys.slice(0, 1)
    : chartType === 'scatter' || chartType === 'slope'
      ? valueKeys.slice(0, 2)
      : valueKeys;

  return {
    resultId: artifact.queryId,
    chartType,
    nameKey,
    valueKeys: values,
    ...(chartType === 'composed'
      ? { series: values.map((key, index) => ({ key, type: index === 0 ? 'bar' : index === 1 ? 'line' : 'area' })) }
      : {})
  };
}
