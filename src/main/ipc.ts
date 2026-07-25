import { BrowserWindow, dialog, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ConnectionConfig,
  ConnectionHistoryItem,
  DatabaseConnector,
  DatabaseSchema,
  GeneratedQuery,
  ChatActivityStep,
  ModelChatMessage,
  ModelProvider,
  ModelProviderKind,
  ModelTool,
  ModelToolCall,
  PersistedChatSession,
  PersistedSettings,
  QueryExecutionMode,
  QueryResult
} from '../shared/types.js';
import type { OpenDialogOptions } from 'electron';
import { ElasticsearchConnector } from './connectors/ElasticsearchConnector.js';
import { MongoDBConnector } from './connectors/MongoDBConnector.js';
import { MySQLConnector } from './connectors/MySQLConnector.js';
import { PostgresConnector } from './connectors/PostgresConnector.js';
import { SQLiteConnector } from './connectors/SQLiteConnector.js';
import {
  buildLocalAssistantResponse,
  buildResultAnalysisPrompt,
  buildSystemPrompt,
  extractQueryBlock,
  removeSqlBlocks,
  summarizeQueryResult
} from './assistant/localAssistant.js';
import { modelProviders } from './model/providers.js';
import { AppStore } from './storage/AppStore.js';

const MAX_MODEL_ROUNDS = 5;
const MAX_QUERY_CALLS = 8;
const MAX_PARALLEL_QUERIES = 3;

function logActivityDebug(message: string, detail?: unknown) {
  if (process.env.DBCHAT_ACTIVITY_DEBUG === '1') {
    console.log(`[dbchat:activity:main] ${message}`, detail);
  }
}

const runDatabaseQueryTool: ModelTool = {
  type: 'function',
  function: {
    name: 'run_database_query',
    description: 'Validate and run one database query against the connected DB Chat database. Use this for any data lookup needed to answer the user.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The exact SQL or connector JSON request to validate and run.'
        },
        purpose: {
          type: 'string',
          description: 'A brief user-visible reason for running this query.'
        }
      },
      required: ['query', 'purpose'],
      additionalProperties: false
    }
  }
};

interface ToolQueryExecutionResult {
  toolCallId: string;
  content: string;
  generatedQuery?: GeneratedQuery;
  queryResult?: QueryResult;
}

export class IpcController {
  private connector: DatabaseConnector | null = null;
  private schema: DatabaseSchema | null = null;

  constructor(private readonly store: AppStore) {}

  async chooseSqliteFile(): Promise<ConnectionConfig | null> {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const dialogOptions: OpenDialogOptions = {
      title: 'Choose SQLite Database',
      properties: ['openFile'],
      filters: [
        { name: 'SQLite databases', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: 'All files', extensions: ['*'] }
      ]
    };
    const result = window
      ? await dialog.showOpenDialog(window, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) {
      return null;
    }

    return {
      id: crypto.randomUUID(),
      kind: 'sqlite',
      label: path.basename(filePath),
      databasePath: filePath,
      createdAt: new Date().toISOString()
    };
  }

  async connect(config: ConnectionConfig): Promise<DatabaseSchema> {
    const hydratedConfig = this.store.hydrateConnectionSecrets(config);
    this.connector?.close();
    const connector = createConnector(hydratedConfig.kind);
    await connector.connect(hydratedConfig);
    this.connector = connector;
    this.schema = await connector.introspect();
    this.store.saveConnection(hydratedConfig);
    return this.schema;
  }

  async getSchema(): Promise<DatabaseSchema | null> {
    return this.schema;
  }

  async sendChat(messages: ModelChatMessage[], turnId?: string, webContents?: WebContents) {
    const settings = this.store.loadSettings();
    const executionMode = settings.safeMode ? 'safe' : 'manual';
    const apiKey = this.store.getApiKey(settings.provider);
    const schemaContext = this.connector ? await this.connector.getContextForPrompt() : 'No database is connected.';
    const chatHistory = messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ ...message, content: removeSqlBlocks(message.content) }))
      .slice(-16);
    const prompt = [...chatHistory].reverse().find((message) => message.role === 'user')?.content ?? '';

    if (!apiKey) {
      const local = buildLocalAssistantResponse(prompt, this.schema);
      const queryResult = local.query && this.connector && local.query.validation.safe
        ? await this.connector.executeQuery(local.query.query, executionMode)
        : undefined;
      return {
        message: {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: queryResult ? summarizeQueryResult(queryResult) : removeSqlBlocks(local.content),
          createdAt: new Date().toISOString()
        },
        generatedQuery: local.query,
        queryResult
      };
    }

    const provider = modelProviders[settings.provider];
    const activity: ChatActivityStep[] = [];
    const emitActivity = (step: Omit<ChatActivityStep, 'id' | 'createdAt'>) => {
      const nextStep: ChatActivityStep = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        ...step
      };
      upsertActivityStep(activity, nextStep);
      if (turnId && webContents && !webContents.isDestroyed()) {
        logActivityDebug('emit', {
          turnId,
          channel: `dbchat:chat-progress:${turnId}`,
          stepId: nextStep.id,
          queryId: nextStep.queryId,
          status: nextStep.status,
          title: nextStep.title,
          activityCount: activity.length
        });
        webContents.send(`dbchat:chat-progress:${turnId}`, { turnId, step: nextStep });
      } else {
        logActivityDebug('skip emit', {
          turnId,
          hasWebContents: Boolean(webContents),
          destroyed: webContents?.isDestroyed()
        });
      }
      return nextStep;
    };
    const toolResponse = this.connector
      ? await this.runToolQueryLoop({
        provider,
        model: settings.model || provider.defaultModel,
        apiKey,
        chatHistory,
        schemaContext,
        executionMode,
        emitActivity
      })
      : null;
    if (toolResponse) {
      return {
        ...toolResponse,
        activity
      };
    }

    const content = await provider.sendChat([
      { role: 'system', content: buildSystemPrompt(schemaContext, this.schema?.kind ?? 'sqlite', executionMode) },
      ...chatHistory
    ], {
      model: settings.model || provider.defaultModel,
      apiKey,
      temperature: 0.2
    });
    const query = extractQueryBlock(content, this.schema?.kind ?? 'sqlite');
    let generatedQuery: GeneratedQuery | undefined;
    let queryResult: QueryResult | undefined;
    if (query && this.connector) {
      const queryId = crypto.randomUUID();
      emitActivity({
        queryId,
        status: 'validating',
        title: 'Validating generated query',
        query
      });
      const validation = this.connector.validateQuery(query, executionMode);
      generatedQuery = {
        query,
        explanation: 'Generated by the selected model provider.',
        validation
      };
      if (validation.safe) {
        emitActivity({
          queryId,
          status: 'running',
          title: 'Running generated query',
          query: validation.normalizedQuery,
          validation
        });
        try {
          queryResult = await this.connector.executeQuery(generatedQuery.query, executionMode);
          emitActivity({
            queryId,
            status: 'success',
            title: 'Generated query complete',
            detail: `${queryResult.rowCount} row${queryResult.rowCount === 1 ? '' : 's'} returned.`,
            query: validation.normalizedQuery,
            validation,
            rowCount: queryResult.rowCount,
            elapsedMs: queryResult.elapsedMs
          });
        } catch (error) {
          emitActivity({
            queryId,
            status: 'error',
            title: 'Generated query failed',
            detail: error instanceof Error ? error.message : 'Query execution failed.',
            query: validation.normalizedQuery,
            validation
          });
          throw error;
        }
      } else {
        emitActivity({
          queryId,
          status: 'blocked',
          title: 'Generated query blocked',
          detail: validation.reason,
          query,
          validation
        });
      }
    }
    const responseContent = queryResult && generatedQuery
      ? await this.buildResultAwareResponse(provider, settings.model || provider.defaultModel, apiKey, chatHistory, generatedQuery.query, queryResult)
      : generatedQuery && !generatedQuery.validation.safe
        ? `I found a query for that, but validation did not allow it: ${generatedQuery.validation.reason}`
        : removeSqlBlocks(content);

    return {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: responseContent,
        createdAt: new Date().toISOString()
      },
      generatedQuery,
      queryResult,
      generatedQueries: generatedQuery ? [generatedQuery] : undefined,
      queryResults: queryResult ? [queryResult] : undefined,
      activity
    };
  }

  private async runToolQueryLoop({
    provider,
    model,
    apiKey,
    chatHistory,
    schemaContext,
    executionMode,
    emitActivity
  }: {
    provider: ModelProvider;
    model: string;
    apiKey: string;
    chatHistory: ModelChatMessage[];
    schemaContext: string;
    executionMode: QueryExecutionMode;
    emitActivity: (step: Omit<ChatActivityStep, 'id' | 'createdAt'>) => ChatActivityStep;
  }) {
    if (!this.connector) {
      return null;
    }

    const messages: ModelChatMessage[] = [
      {
        role: 'system',
        content: [
          buildSystemPrompt(schemaContext, this.schema?.kind ?? 'sqlite', executionMode)
            .replace(/include exactly one fenced ```(?:sql|json) block/gi, 'call the run_database_query tool'),
          'Use run_database_query for each data lookup you need. You may call it multiple times.',
          `Limits: at most ${MAX_QUERY_CALLS} total queries, ${MAX_PARALLEL_QUERIES} independent queries in one round, and ${MAX_MODEL_ROUNDS} model rounds.`,
          'When multiple queries are independent, call them together. When a query depends on earlier results, wait for those results before calling the next query.',
          'Do not reveal private chain-of-thought. Return a concise final answer after the needed tool results are available.'
        ].join('\n\n')
      },
      ...chatHistory
    ];
    const generatedQueries: GeneratedQuery[] = [];
    const queryResults: QueryResult[] = [];
    let totalQueries = 0;

    for (let round = 1; round <= MAX_MODEL_ROUNDS; round += 1) {
      emitActivity({
        status: 'thinking',
        title: `Planning step ${round}`,
        detail: round === 1 ? 'Checking whether the answer needs database queries.' : 'Reviewing query results for the next step.'
      });
      let response;
      try {
        response = await provider.sendChatWithTools(messages, {
          model,
          apiKey,
          temperature: 0.2,
          tools: [runDatabaseQueryTool],
          toolChoice: 'auto',
          parallelToolCalls: true
        });
      } catch (error) {
        if (round === 1 && generatedQueries.length === 0) {
          emitActivity({
            status: 'blocked',
            title: 'Tool calling unavailable',
            detail: 'Falling back to the standard single-query chat path.'
          });
          return null;
        }
        throw error;
      }
      if (!response.toolCalls?.length) {
        const fallbackQuery = extractQueryBlock(response.content, this.schema?.kind ?? 'sqlite');
        if (fallbackQuery) {
          const queryId = crypto.randomUUID();
          emitActivity({
            queryId,
            status: 'validating',
            title: 'Validating generated query',
            query: fallbackQuery
          });
          const validation = this.connector.validateQuery(fallbackQuery, executionMode);
          const generatedQuery: GeneratedQuery = {
            query: fallbackQuery,
            explanation: 'Generated by the selected model provider.',
            validation
          };
          generatedQueries.push(generatedQuery);
          if (!validation.safe) {
            emitActivity({
              queryId,
              status: 'blocked',
              title: 'Query blocked',
              detail: validation.reason,
              query: fallbackQuery,
              validation
            });
            return {
              message: {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                content: `I found a query for that, but validation did not allow it: ${validation.reason}`,
                createdAt: new Date().toISOString()
              },
              generatedQuery,
              generatedQueries
            };
          }
          emitActivity({
            queryId,
            status: 'running',
            title: 'Running generated query',
            query: validation.normalizedQuery,
            validation
          });
          const queryResult = await this.connector.executeQuery(generatedQuery.query, executionMode);
          queryResults.push(queryResult);
          emitActivity({
            queryId,
            status: 'success',
            title: 'Generated query complete',
            detail: `${queryResult.rowCount} row${queryResult.rowCount === 1 ? '' : 's'} returned.`,
            query: validation.normalizedQuery,
            validation,
            rowCount: queryResult.rowCount,
            elapsedMs: queryResult.elapsedMs
          });
          const content = await this.buildResultAwareResponse(provider, model, apiKey, chatHistory, fallbackQuery, queryResult);
          return {
            message: {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              content,
              createdAt: new Date().toISOString()
            },
            generatedQuery,
            queryResult,
            generatedQueries,
            queryResults
          };
        }
        const content = removeSqlBlocks(response.content);
        if (!content) {
          return null;
        }
        emitActivity({
          status: 'complete',
          title: generatedQueries.length ? `Checked ${generatedQueries.length} queries` : 'No database query needed',
          detail: generatedQueries.length ? 'Final answer is ready.' : 'The model answered without running a query.'
        });
        return {
          message: {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content,
            createdAt: new Date().toISOString()
          },
          generatedQuery: generatedQueries.at(-1),
          queryResult: queryResults.at(-1),
          generatedQueries: generatedQueries.length ? generatedQueries : undefined,
          queryResults: queryResults.length ? queryResults : undefined
        };
      }

      const toolCalls = response.toolCalls.slice(0, MAX_PARALLEL_QUERIES);
      if (response.toolCalls.length > MAX_PARALLEL_QUERIES) {
        emitActivity({
          status: 'blocked',
          title: 'Parallel query limit reached',
          detail: `DB Chat will run ${MAX_PARALLEL_QUERIES} queries from this step and ask the model to continue if more are needed.`
        });
      }
      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: toolCalls
      });

      const settled = await Promise.allSettled(toolCalls.map(async (toolCall) => {
        if (totalQueries >= MAX_QUERY_CALLS) {
          emitActivity({
            status: 'blocked',
            title: 'Query limit reached',
            detail: `DB Chat stopped query execution after ${MAX_QUERY_CALLS} queries.`
          });
          return this.queryLimitToolResult(toolCall);
        }
        totalQueries += 1;
        return this.executeToolQuery(toolCall, executionMode, emitActivity);
      }));

      for (const item of settled) {
        const result = item.status === 'fulfilled'
          ? item.value
          : {
            toolCallId: crypto.randomUUID(),
            content: JSON.stringify({ ok: false, error: item.reason instanceof Error ? item.reason.message : 'Query execution failed.' })
          };
        if (result.generatedQuery) {
          generatedQueries.push(result.generatedQuery);
        }
        if (result.queryResult) {
          queryResults.push(result.queryResult);
        }
        messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: result.content
        });
      }
    }

    emitActivity({
      status: 'blocked',
      title: 'Model step limit reached',
      detail: `Stopped after ${MAX_MODEL_ROUNDS} planning steps.`
    });
    return {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        content: queryResults.length
          ? summarizeQueryResult(queryResults.at(-1) as QueryResult)
          : 'I started checking the data, but hit the multi-step limit before I could finish safely.',
        createdAt: new Date().toISOString()
      },
      generatedQuery: generatedQueries.at(-1),
      queryResult: queryResults.at(-1),
      generatedQueries: generatedQueries.length ? generatedQueries : undefined,
      queryResults: queryResults.length ? queryResults : undefined
    };
  }

  private async executeToolQuery(
    toolCall: ModelToolCall,
    executionMode: QueryExecutionMode,
    emitActivity: (step: Omit<ChatActivityStep, 'id' | 'createdAt'>) => ChatActivityStep
  ): Promise<ToolQueryExecutionResult> {
    if (!this.connector) {
      throw new Error('No database is connected.');
    }
    const args = parseToolArguments(toolCall.function.arguments);
    const queryId = crypto.randomUUID();
    emitActivity({
      queryId,
      status: 'validating',
      title: args.purpose || 'Validating query',
      query: args.query
    });
    const validation = this.connector.validateQuery(args.query, executionMode);
    const generatedQuery: GeneratedQuery = {
      query: args.query,
      explanation: args.purpose || 'Generated by the selected model provider.',
      validation
    };
    if (!validation.safe) {
      emitActivity({
        queryId,
        status: 'blocked',
        title: args.purpose || 'Query blocked',
        detail: validation.reason,
        query: args.query,
        validation
      });
      return {
        toolCallId: toolCall.id,
        generatedQuery,
        content: JSON.stringify({
          ok: false,
          blocked: true,
          reason: validation.reason,
          query: args.query
        })
      };
    }

    emitActivity({
      queryId,
      status: 'running',
      title: args.purpose || 'Running query',
      query: validation.normalizedQuery,
      validation
    });
    try {
      const queryResult = await this.connector.executeQuery(args.query, executionMode);
      emitActivity({
        queryId,
        status: 'success',
        title: args.purpose || 'Query complete',
        detail: `${queryResult.rowCount} row${queryResult.rowCount === 1 ? '' : 's'} returned.`,
        query: validation.normalizedQuery,
        validation,
        rowCount: queryResult.rowCount,
        elapsedMs: queryResult.elapsedMs
      });
      return {
        toolCallId: toolCall.id,
        generatedQuery,
        queryResult,
        content: JSON.stringify({
          ok: true,
          columns: queryResult.columns,
          rowCount: queryResult.rowCount,
          elapsedMs: queryResult.elapsedMs,
          rows: queryResult.rows.slice(0, 25)
        })
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Query execution failed.';
      emitActivity({
        queryId,
        status: 'error',
        title: args.purpose || 'Query failed',
        detail: message,
        query: validation.normalizedQuery,
        validation
      });
      return {
        toolCallId: toolCall.id,
        generatedQuery,
        content: JSON.stringify({ ok: false, error: message, query: args.query })
      };
    }
  }

  private queryLimitToolResult(toolCall: ModelToolCall): ToolQueryExecutionResult {
    return {
      toolCallId: toolCall.id,
      content: JSON.stringify({
        ok: false,
        blocked: true,
        reason: `DB Chat stopped query execution after ${MAX_QUERY_CALLS} queries.`
      })
    };
  }

  private async buildResultAwareResponse(
    provider: ModelProvider,
    model: string,
    apiKey: string,
    chatHistory: ModelChatMessage[],
    query: string,
    result: QueryResult
  ): Promise<string> {
    const resultContext = JSON.stringify({
      columns: result.columns,
      rowCount: result.rowCount,
      elapsedMs: result.elapsedMs,
      rows: result.rows.slice(0, 25)
    }, null, 2);

    try {
      const content = await provider.sendChat([
        {
          role: 'system',
          content: buildResultAnalysisPrompt(this.schema?.kind ?? 'sqlite', this.store.loadSettings().safeMode ? 'safe' : 'manual')
        },
        ...chatHistory,
        {
          role: 'assistant',
          content: [
            'Executed query:',
            query,
            '',
            'Query result JSON:',
            resultContext
          ].join('\n')
        }
      ], {
        model,
        apiKey,
        temperature: 0.2
      });

      return removeSqlBlocks(content) || summarizeQueryResult(result);
    } catch {
      return summarizeQueryResult(result);
    }
  }

  loadSettings(): PersistedSettings & { hasApiKey: boolean } {
    const settings = this.store.loadSettings();
    return {
      ...settings,
      hasApiKey: this.store.hasApiKey(settings.provider)
    };
  }

  saveSettings(settings: PersistedSettings): void {
    this.store.saveSettings(settings);
  }

  saveApiKey(provider: ModelProviderKind, apiKey: string): void {
    this.store.saveApiKey(provider, apiKey);
  }

  async listModels(provider: ModelProviderKind) {
    return modelProviders[provider].listModels(this.store.getApiKey(provider) ?? undefined);
  }

  listChatSessions(): PersistedChatSession[] {
    return this.store.listChatSessions();
  }

  saveChatSession(session: PersistedChatSession): PersistedChatSession {
    return this.store.saveChatSession(session);
  }

  deleteChatSession(id: string): void {
    this.store.deleteChatSession(id);
  }

  clearChatSessions(): void {
    this.store.clearChatSessions();
  }

  listConnections(): ConnectionHistoryItem[] {
    return this.store.listConnections();
  }

  deleteConnection(id: string): void {
    this.store.deleteConnection(id);
  }

  requireConnector(): DatabaseConnector {
    if (!this.connector) {
      throw new Error('No database is connected.');
    }
    return this.connector;
  }

  async saveCsvFile(request: { content: string; defaultName: string }): Promise<void> {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showSaveDialog(window, {
      title: 'Export CSV',
      defaultPath: request.defaultName,
      filters: [
        { name: 'CSV files', extensions: ['csv'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePath) {
      return;
    }
    await fs.promises.writeFile(result.filePath, request.content, 'utf-8');
  }
}

function createConnector(kind: string): DatabaseConnector {
  switch (kind) {
    case 'elasticsearch':
      return new ElasticsearchConnector();
    case 'mysql':
      return new MySQLConnector();
    case 'postgres':
      return new PostgresConnector();
    case 'mongodb':
      return new MongoDBConnector();
    case 'sqlite':
      return new SQLiteConnector();
    default:
      throw new Error(`Unsupported database kind: ${kind}`);
  }
}

function parseToolArguments(rawArguments: string): { query: string; purpose: string } {
  const parsed = JSON.parse(rawArguments) as unknown;
  if (!isRecord(parsed) || typeof parsed.query !== 'string' || typeof parsed.purpose !== 'string') {
    throw new Error('Model query tool arguments were invalid.');
  }
  return {
    query: parsed.query,
    purpose: parsed.purpose
  };
}

function upsertActivityStep(activity: ChatActivityStep[], step: ChatActivityStep): void {
  const existingIndex = step.queryId
    ? activity.findIndex((current) => current.queryId === step.queryId)
    : -1;
  if (existingIndex >= 0) {
    activity[existingIndex] = {
      ...activity[existingIndex],
      ...step
    };
    return;
  }
  activity.push(step);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
