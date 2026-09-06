export type AllChartType =
  | 'bar' | 'line' | 'area' | 'pie' | 'scatter'
  | 'radar' | 'radialBar' | 'composed' | 'funnel' | 'treemap' | 'sunburst' | 'slope';

export type ChartCoordinate = string | number;

export interface ChartAnnotation {
  kind: 'label' | 'point' | 'line' | 'range';
  text?: string;
  x?: ChartCoordinate;
  y?: number;
  x1?: ChartCoordinate;
  y1?: number;
  x2?: ChartCoordinate;
  y2?: number;
  color?: string;
  position?: 'top' | 'bottom' | 'left' | 'right' | 'insideTop' | 'insideBottom';
  rowKey?: string;
  valueKey?: string;
  side?: 'start' | 'end';
}

export interface ChartSeries {
  key: string;
  type?: 'bar' | 'line' | 'area';
  name?: string;
}

export interface ChartOptions {
  layout?: 'vertical' | 'horizontal';
  stacked?: boolean;
  donut?: boolean;
  showLegend?: boolean;
  showGrid?: boolean;
  showValueLabels?: boolean;
  startLabel?: string;
  endLabel?: string;
}

export interface ChartSpec {
  chartType: AllChartType;
  title?: string;
  columns: string[];
  rows: Record<string, unknown>[];
  nameKey?: string;
  valueKeys?: string[];
  series?: ChartSeries[];
  options?: ChartOptions;
  annotations?: ChartAnnotation[];
}
