import { ToolRegistry } from './agent/ToolRegistry.js';
import { getSchemaInfoTool } from './agent/tools/GetSchemaInfoTool.js';
import { runDatabaseQueryTool } from './agent/tools/RunDatabaseQueryTool.js';
import { sampleDataTool } from './agent/tools/SampleDataTool.js';
import { visualizeDataTool } from './agent/tools/VisualizeDataTool.js';

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(runDatabaseQueryTool);
  registry.register(getSchemaInfoTool);
  registry.register(sampleDataTool);
  registry.register(visualizeDataTool);
  return registry;
}
