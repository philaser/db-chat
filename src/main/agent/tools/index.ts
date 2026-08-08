import { runDatabaseQueryTool } from './RunDatabaseQueryTool.js';
import { getSchemaInfoTool } from './GetSchemaInfoTool.js';
import { sampleDataTool } from './SampleDataTool.js';
import { saveMemoryTool } from './SaveMemoryTool.js';
import { visualizeDataTool } from './VisualizeDataTool.js';
import { exportReportTool } from './ExportReportTool.js';
import { searchMemoryTool } from './SearchMemoryTool.js';
import { ToolRegistry } from '../ToolRegistry.js';
import type { Tool } from '../types.js';

export const allTools: Tool[] = [
  runDatabaseQueryTool,
  getSchemaInfoTool,
  sampleDataTool,
  saveMemoryTool,
  visualizeDataTool,
  exportReportTool,
  searchMemoryTool
];

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of allTools) {
    registry.register(tool);
  }
  return registry;
}

export {
  runDatabaseQueryTool,
  getSchemaInfoTool,
  sampleDataTool,
  saveMemoryTool,
  visualizeDataTool,
  exportReportTool,
  searchMemoryTool
};
