import { ToolRegistry } from './agent/ToolRegistry.js';
import { getSchemaInfoTool } from './agent/tools/GetSchemaInfoTool.js';
import { runDatabaseQueryTool } from './agent/tools/RunDatabaseQueryTool.js';
import { sampleDataTool } from './agent/tools/SampleDataTool.js';
import { createVisualizeDataTool } from './agent/tools/VisualizeDataTool.js';
import { getResultTool } from './agent/tools/GetResultTool.js';
import { clarifyTool } from './agent/tools/ClarifyTool.js';
import { createReportTool } from './agent/tools/CreateReportTool.js';
import { exportDataTool } from './agent/tools/ExportDataTool.js';

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(runDatabaseQueryTool);
  registry.register(getSchemaInfoTool);
  registry.register(sampleDataTool);
  registry.register(getResultTool);
  registry.register(createVisualizeDataTool({ requireResultReference: true }));
  registry.register(clarifyTool);
  registry.register(createReportTool());
  registry.register(exportDataTool);
  return registry;
}
