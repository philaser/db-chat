import { runDatabaseQueryTool } from './RunDatabaseQueryTool';
import { getSchemaInfoTool } from './GetSchemaInfoTool';
import { sampleDataTool } from './SampleDataTool';
import { saveMemoryTool } from './SaveMemoryTool';
import { ToolRegistry } from '../ToolRegistry';
import type { Tool } from '../types';

export const allTools: Tool[] = [
  runDatabaseQueryTool,
  getSchemaInfoTool,
  sampleDataTool,
  saveMemoryTool
];

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of allTools) {
    registry.register(tool);
  }
  return registry;
}

export { runDatabaseQueryTool, getSchemaInfoTool, sampleDataTool, saveMemoryTool };
