import type {
  AgentEvent,
  EffortLevel,
  ConnectionConfig,
  DatabaseConnector,
  DatabaseSchema,
  ModelChatMessage,
  QueryResultArtifact,
  ConnectionKnowledge,
  SourceSnapshot
} from '../shared/types.js';
import { runAgentLoop, type TurnResult } from './agent/AgentLoop.js';
import { ApprovalManager } from './agent/ApprovalManager.js';
import { MemoryStore } from './agent/MemoryStore.js';
import { PermissionManager } from './agent/PermissionManager.js';
import { createToolRegistry } from './webToolRegistry.js';
import { OpenRouterClient } from './model/OpenRouterClient.js';
import type { InferenceProvider } from './model/providerConfig.js';
import type { AgentModelClient, AgentController } from './agent/types.js';
import type { WebServerConfig } from './config.js';
import { schemaFingerprint } from './conversationContext.js';
import { createConfiguredConnector, WebPolicyConnector } from './connectorFactory.js';
import {
  buildVisualizationInput,
  hasChartMarkup,
  hasVisualizationRequest,
  selectVisualizationArtifact
} from './visualizationEnrichment.js';

export interface WebBootstrap {
  ready: boolean;
  database: {
    label: string;
    kind?: string;
    tableCount: number;
    readOnly: true;
  };
  limits: {
    maxResultRows: number;
    maxResultBytes: number;
  };
  model: string;
}

export interface WebAgentRunContext {
  referencedArtifacts: QueryResultArtifact[];
  knowledge?: ConnectionKnowledge;
  source?: SourceSnapshot;
  onSchema?: (schema: DatabaseSchema) => Promise<void>;
  requestExport?: import('./agent/types.js').ToolContext['requestExport'];
  requestReport?: import('./agent/types.js').ToolContext['requestReport'];
}

export class WebAgentService {
  private connector: DatabaseConnector | null = null;
  private schema: DatabaseSchema | null = null;
  private readyError: string | null = null;
  private readonly memoryStore = new MemoryStore();
  private readonly permissionManager = new PermissionManager();
  private readonly approvalManager = new ApprovalManager();
  private readonly toolRegistry = createToolRegistry();
  private readonly modelClient?: AgentModelClient;
  private readonly injectedConnector?: DatabaseConnector;

  constructor(
    private readonly config: WebServerConfig,
    options: { modelClient?: AgentModelClient; connector?: DatabaseConnector } = {}
  ) {
    this.modelClient = options.modelClient;
    this.injectedConnector = options.connector;
    this.permissionManager.setSafetyLevel('safe');
    this.permissionManager.setAllowedTools(['run_database_query', 'get_schema_info', 'sample_data', 'get_result', 'visualize_data', 'ask_clarification', 'create_report', 'export_data']);
  }

  async initialize(): Promise<void> {
    if (!this.config.database) {
      this.readyError = null;
      return;
    }

    try {
      const rawConnector = this.injectedConnector ?? createConfiguredConnector(this.config.database.kind);
      const connector = new WebPolicyConnector(
        rawConnector,
        this.config.maxResultRows,
        this.config.maxResultBytes
      );
      this.connector = connector;
      await connector.connect(this.config.database);
      connector.setSafetyLevel('safe');
      this.schema = await connector.introspect();
      this.readyError = null;
    } catch (error) {
      this.connector?.close();
      this.connector = null;
      this.schema = null;
      this.readyError = 'The configured database could not be opened.';
      console.error('[dbchat:web] database initialization failed', error);
    }
  }

  getBootstrap(): WebBootstrap {
    return {
      ready: Boolean(this.connector && this.schema && !this.readyError),
      database: {
        label: this.schema?.label ?? this.config.databaseLabel,
        kind: this.schema?.kind,
        tableCount: this.schema?.tables.length ?? 0,
        readOnly: true
      },
      limits: {
        maxResultRows: this.config.maxResultRows,
        maxResultBytes: this.config.maxResultBytes
      },
      model: this.config.model
    };
  }

  getReadyError(): string | null {
    return this.readyError;
  }

  async testConnection(connectionConfig: ConnectionConfig): Promise<DatabaseSchema> {
    if (this.injectedConnector && this.config.database?.id === connectionConfig.id) {
      if (!this.connector || !this.schema) throw new Error('The selected connection is not ready.');
      return this.schema;
    }
    const rawConnector = createConfiguredConnector(connectionConfig.kind);
    const connector = new WebPolicyConnector(
      rawConnector,
      this.config.maxResultRows,
      this.config.maxResultBytes
    );
    try {
      await connector.connect(connectionConfig);
      connector.setSafetyLevel('safe');
      return await connector.introspect();
    } finally {
      connector.close();
    }
  }

  async getSchema(connectionConfig: ConnectionConfig): Promise<DatabaseSchema> {
    if (this.config.database?.id === connectionConfig.id && this.connector && this.schema && !this.readyError) {
      return this.schema;
    }
    return this.testConnection(connectionConfig);
  }

  async run(
    messages: ModelChatMessage[],
    turnId: string,
    listener: (event: AgentEvent) => void,
    signal?: AbortSignal,
    connectionConfig?: ConnectionConfig,
    providerApiKey?: string,
    model?: string,
    effortLevel?: EffortLevel,
    runContext: WebAgentRunContext = { referencedArtifacts: [] },
    provider: InferenceProvider = 'openrouter'
  ): Promise<TurnResult> {
    let connector = this.connector;
    let schema = this.schema;
    let ownsConnector = false;

    try {
      signal?.throwIfAborted();
      if (connectionConfig && (!this.config.database || connectionConfig.id !== this.config.database.id || !this.injectedConnector)) {
        const rawConnector = createConfiguredConnector(connectionConfig.kind);
        const scopedConnector = new WebPolicyConnector(
          rawConnector,
          this.config.maxResultRows,
          this.config.maxResultBytes
        );
        connector = scopedConnector;
        ownsConnector = true;
        await scopedConnector.connect(connectionConfig);
        scopedConnector.setSafetyLevel('safe');
        signal?.throwIfAborted();
        schema = await scopedConnector.introspect();
        await runContext.onSchema?.(schema);
      }

      if (!connector || !schema) {
        throw new Error(this.readyError ?? 'The selected connection is not ready.');
      }

      // A managed OpenRouter key must never be sent to a personal provider host.
      const apiKey = provider === 'openrouter'
        ? (providerApiKey ?? this.config.openRouterApiKey)
        : providerApiKey;
      const client = this.modelClient ?? (apiKey
        ? new OpenRouterClient({ apiKey, provider })
        : null);

      if (!client) {
        const message = {
          id: 'msg-' + turnId,
          role: 'assistant' as const,
          content: 'Inference is not configured yet. Add a provider key or ask the service operator to enable managed inference.',
          createdAt: new Date().toISOString()
        };
        listener({
          turnId,
          type: 'status',
          timestamp: new Date().toISOString(),
          data: { message: 'Managed inference is unavailable.' }
        });
        listener({
          turnId,
          type: 'text-delta',
          timestamp: new Date().toISOString(),
          data: { delta: message.content }
        });
        return { message, events: [], artifacts: [], toolCalls: [] };
      }

      const controller: AgentController = {
        getConnector: () => connector!,
        getSchema: () => schema!,
        refreshSchema: async () => {
          schema = await connector!.introspect();
          if (!connectionConfig) this.schema = schema;
          return schema;
        },
        getMemoryStore: () => this.memoryStore,
        getConnectionId: () => connectionConfig?.id ?? this.config.database?.id ?? 'web-configured',
        audit: (entry) => {
          console.log(JSON.stringify({
            type: 'dbchat.audit',
            turnId: entry.turnId,
            connectionId: entry.connectionId,
            toolName: entry.toolName,
            permissionDecision: entry.permissionDecision,
            elapsedMs: entry.elapsedMs
          }));
        }
      };

      const currentFingerprint = schemaFingerprint(schema);
      const knowledge = runContext.knowledge ? {
        ...runContext.knowledge,
        examples: runContext.knowledge.examples.filter((example) => !example.invalidatedAt && example.schemaFingerprint === currentFingerprint)
      } : undefined;

      const result = await runAgentLoop(messages, turnId, listener, {
        model: model || this.config.model,
        effortLevel,
        client,
        controller,
        memoryStore: this.memoryStore,
        toolRegistry: this.toolRegistry,
        permissionManager: this.permissionManager,
        approvalManager: this.approvalManager,
        referencedArtifacts: runContext.referencedArtifacts,
        knowledge,
        requestExport: runContext.requestExport,
        requestReport: runContext.requestReport,
        runtime: {
          currentTimeUtc: new Date().toISOString(),
          timezone: 'unknown; the user or database must establish it when material',
          maxResultRows: this.config.maxResultRows,
          maxResultBytes: this.config.maxResultBytes
        },
        signal,
        maxTurnRounds: 6,
        maxTotalToolCalls: 8,
        permissionDeniedMessage: 'Blocked: this web chat is permanently read-only. Only read queries are allowed.'
      });
      signal?.throwIfAborted();
      const enriched = await this.enrichVisualizationIfNeeded(messages, result, turnId, listener, connector, schema, controller, runContext.referencedArtifacts);
      return {
        ...enriched,
        artifacts: enriched.artifacts.map((artifact) => ({ ...artifact, schema: schema ?? undefined }))
      };
    } finally {
      if (ownsConnector) connector?.close();
    }
  }

  private async enrichVisualizationIfNeeded(
    messages: ModelChatMessage[],
    result: TurnResult,
    turnId: string,
    listener: (event: AgentEvent) => void,
    connector: DatabaseConnector,
    schema: DatabaseSchema,
    controller: AgentController,
    referencedArtifacts: QueryResultArtifact[]
  ): Promise<TurnResult> {
    if (!hasVisualizationRequest(messages) || hasChartMarkup(result.message.content)) return result;

    const selected = selectVisualizationArtifact(result.artifacts);
    if (!selected) return result;

    const input = buildVisualizationInput(messages, selected);
    listener({
      turnId,
      type: 'status',
      timestamp: new Date().toISOString(),
      data: { message: 'Preparing visualization' }
    });

    const startedAt = performance.now();
    const chartResult = await this.toolRegistry.execute('visualize_data', input, {
      turnId,
      controller,
      connector,
      schema,
      resolveArtifact: (resultId) => [...result.artifacts, ...referencedArtifacts].find((artifact) => artifact.queryId === resultId),
      emitEvent: () => undefined
    });
    controller.audit({
      turnId,
      connectionId: controller.getConnectionId(),
      toolName: 'visualize_data',
      toolInput: input,
      permissionDecision: 'allow',
      elapsedMs: Math.round(performance.now() - startedAt)
    });

    if (!chartResult.ok || !chartResult.data) return result;

    if (result.metrics) {
      result.metrics.toolCallCount += 1;
      result.metrics.phaseDurationsMs.tools = (result.metrics.phaseDurationsMs.tools ?? 0) + Math.round(performance.now() - startedAt);
    }

    const existingContent = result.message.content.trim();
    const prefix = existingContent === 'Analysis complete.' || existingContent === 'I analyzed the data but could not produce a result.'
      ? ''
      : existingContent;
    const chartBlock = '```chart\n' + JSON.stringify(chartResult.data) + '\n```';
    return {
      ...result,
      message: {
        ...result.message,
        content: prefix ? `${prefix}\n\n${chartBlock}` : chartBlock
      }
    };
  }

  close(): void {
    this.connector?.close();
  }
}
