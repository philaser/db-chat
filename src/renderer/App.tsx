import { CheckCircle2, Copy, Database, KeyRound, Loader2, Play, Send, Settings, ShieldCheck } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import type {
  ChatMessage,
  ConnectionConfig,
  DatabaseSchema,
  ModelInfo,
  ModelProviderKind,
  PersistedSettings,
  QueryResult,
  QueryValidationResult
} from '../shared/types';

const fallbackApi = typeof window !== 'undefined' ? window.dbchat : undefined;

function nowMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString()
  };
}

export function App({ api = fallbackApi }: { api?: typeof window.dbchat }) {
  const [connection, setConnection] = useState<ConnectionConfig | null>(null);
  const [schema, setSchema] = useState<DatabaseSchema | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    nowMessage('assistant', 'Connect a SQLite database to start asking questions about your data.')
  ]);
  const [prompt, setPrompt] = useState('');
  const [query, setQuery] = useState('');
  const [validation, setValidation] = useState<QueryValidationResult | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [settings, setSettings] = useState<PersistedSettings & { hasApiKey: boolean }>({
    provider: 'openrouter',
    model: 'openai/gpt-4.1-mini',
    safeMode: true,
    hasApiKey: false
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState('Ready');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!api) {
      setStatus('Desktop app bridge unavailable. Run DB Chat in Electron to connect SQLite databases.');
      return;
    }
    void api.loadSettings().then(setSettings).catch(() => setStatus('Settings are using defaults.'));
  }, [api]);

  useEffect(() => {
    if (!api) {
      setModels([]);
      return;
    }

    let active = true;
    setModelsLoading(true);
    setSettingsStatus('Loading models...');
    void api.listModels(settings.provider)
      .then((nextModels) => {
        if (!active) return;
        setModels(nextModels);
        setSettingsStatus(nextModels.length ? 'Models loaded.' : 'No models returned for this provider.');
        if (nextModels.length && !nextModels.some((model) => model.id === settings.model)) {
          const nextSettings = { ...settings, model: nextModels[0].id };
          setSettings((current) => ({ ...current, model: nextModels[0].id }));
          void api.saveSettings(nextSettings);
        }
      })
      .catch((error: Error) => {
        if (!active) return;
        setModels([]);
        setSettingsStatus(error.message || 'Could not load models.');
      })
      .finally(() => {
        if (active) setModelsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [api, settings.provider]);

  useEffect(() => {
    if (!api || !query) {
      setValidation(null);
      return;
    }
    const timeout = window.setTimeout(() => {
      void api.validateQuery(query, 'safe').then(setValidation).catch((error: Error) => {
        setValidation({ safe: false, reason: error.message, normalizedQuery: query });
      });
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [api, query]);

  const schemaSummary = useMemo(() => {
    if (!schema) {
      return 'No database connected';
    }
    return `${schema.tables.length} table${schema.tables.length === 1 ? '' : 's'} connected`;
  }, [schema]);

  async function connectSqlite() {
    if (!api) {
      setStatus('SQLite connections are available in the Electron desktop app.');
      return;
    }
    setBusy(true);
    setStatus('Opening SQLite file picker...');
    try {
      const config = await api.chooseSqliteFile();
      if (!config) {
        setStatus('Connection canceled.');
        return;
      }
      const nextSchema = await api.connect(config);
      setConnection(config);
      setSchema(nextSchema);
      setMessages((current) => [
        ...current,
        nowMessage('assistant', `Connected to ${config.label}. I found ${nextSchema.tables.length} tables.`)
      ]);
      setStatus(`Connected to ${config.label}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not connect to database.');
    } finally {
      setBusy(false);
    }
  }

  async function sendChat(event: FormEvent) {
    event.preventDefault();
    if (!api || !prompt.trim()) return;

    const userMessage = nowMessage('user', prompt.trim());
    setMessages((current) => [...current, userMessage]);
    setPrompt('');
    setBusy(true);
    setStatus('Thinking...');
    try {
      const response = await api.sendChat(userMessage.content);
      setMessages((current) => [...current, response.message]);
      if (response.generatedQuery) {
        setQuery(response.generatedQuery.query);
        setValidation(response.generatedQuery.validation);
      }
      setStatus('Response ready');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Chat failed.');
    } finally {
      setBusy(false);
    }
  }

  async function runQuery() {
    if (!api || !query.trim()) return;
    setBusy(true);
    setStatus('Running safe query...');
    try {
      const nextResult = await api.executeQuery(query);
      setResult(nextResult);
      setStatus(`Returned ${nextResult.rowCount} rows in ${nextResult.elapsedMs} ms`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Query failed.');
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(next: PersistedSettings) {
    if (!api) return;
    setSettings((current) => ({ ...current, ...next }));
    await api.saveSettings(next);
  }

  async function changeProvider(provider: ModelProviderKind) {
    const fallbackModel = provider === 'openrouter' ? 'openai/gpt-4.1-mini' : 'gpt-4.1-mini';
    const nextSettings = { ...settings, provider, model: fallbackModel };
    setSettings((current) => ({ ...current, provider, model: fallbackModel, hasApiKey: false }));
    setSettingsStatus('Loading models...');
    await api?.saveSettings(nextSettings);
    const loadedSettings = await api?.loadSettings();
    if (loadedSettings) {
      setSettings((current) => ({ ...current, hasApiKey: loadedSettings.hasApiKey }));
    }
  }

  async function changeModel(model: string) {
    const nextSettings = { ...settings, model };
    await saveSettings(nextSettings);
    setSettingsStatus('Model saved.');
  }

  async function saveApiKey() {
    if (!api || !apiKey.trim()) return;
    try {
      await api.saveApiKey(settings.provider, apiKey.trim());
      setSettings((current) => ({ ...current, hasApiKey: true }));
      setApiKey('');
      setSettingsStatus('API key saved successfully.');
      setStatus(`${settings.provider} API key saved locally.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save API key.';
      setSettingsStatus(message);
      setStatus(message);
    }
  }

  return (
    <main className={`app-shell ${settingsOpen ? 'settings-open' : ''}`}>
      <header className="topbar">
        <div>
          <h1>DB Chat</h1>
          <p>{schemaSummary}</p>
        </div>
        <div className="topbar-actions">
          <button type="button" className="secondary-button" onClick={connectSqlite} disabled={busy || !api}>
            <Database size={16} />
            {connection ? connection.label : 'Connect SQLite'}
          </button>
          <label className="safe-toggle">
            <input
              type="checkbox"
              checked={settings.safeMode}
              onChange={(event) => void saveSettings({ ...settings, safeMode: event.target.checked })}
            />
            <ShieldCheck size={16} />
            SAFE
          </label>
          <button
            type="button"
            className="icon-button"
            onClick={() => setSettingsOpen((current) => !current)}
            aria-expanded={settingsOpen}
            aria-label="Open settings"
          >
            <Settings size={17} />
            {settings.hasApiKey && <CheckCircle2 className="settings-saved-dot" size={14} aria-label="API key saved" />}
          </button>
        </div>
      </header>

      {settingsOpen && (
        <section className="settings-panel" aria-label="Settings">
          <div className="settings-grid">
            <label>
              <span>Provider</span>
              <select
                value={settings.provider}
                onChange={(event) => void changeProvider(event.target.value as ModelProviderKind)}
                aria-label="Model provider"
              >
                <option value="openrouter">OpenRouter</option>
                <option value="openai">OpenAI</option>
              </select>
            </label>

            <label>
              <span>Model</span>
              <div className="model-select-wrap">
                <select
                  value={settings.model}
                  onChange={(event) => void changeModel(event.target.value)}
                  disabled={modelsLoading || !models.length}
                  aria-label="Model name"
                >
                  {models.length ? (
                    models.map((model) => (
                      <option value={model.id} key={model.id}>{model.name}</option>
                    ))
                  ) : (
                    <option value={settings.model}>{settings.model}</option>
                  )}
                </select>
                {modelsLoading && <Loader2 className="spin" size={16} aria-label="Loading models" />}
              </div>
            </label>

            <label className="api-key-field">
              <span>{settings.provider} API key</span>
              <div className="api-key-box">
                <KeyRound size={15} />
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={settings.hasApiKey ? 'API key saved' : 'Paste API key'}
                  aria-label="API key"
                />
                <button type="button" onClick={() => void saveApiKey()} disabled={!apiKey.trim()}>
                  Save
                </button>
              </div>
            </label>
          </div>
          <div className={`settings-status ${settings.hasApiKey ? 'saved' : ''}`}>
            {settings.hasApiKey && <CheckCircle2 size={15} />}
            {settingsStatus || (settings.hasApiKey ? 'API key saved.' : 'Settings are stored locally.')}
          </div>
        </section>
      )}

      <section className="workspace">
        <section className="chat-pane" aria-label="Chat">
          <div className="pane-title">Chat</div>
          <div className="messages">
            {messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <div>{message.content}</div>
              </article>
            ))}
          </div>
          <form className="composer" onSubmit={(event) => void sendChat(event)}>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Ask about the connected database..."
              rows={3}
            />
            <button type="submit" disabled={busy || !prompt.trim()} aria-label="Send message">
              <Send size={18} />
            </button>
          </form>
        </section>

        <section className="data-pane" aria-label="Data results">
          <div className="pane-title">Data</div>
          {result ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {result.columns.map((column) => <th key={column}>{column}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, index) => (
                    <tr key={index}>
                      {result.columns.map((column) => <td key={column}>{String(row[column] ?? '')}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">Run a generated query to see rows here.</div>
          )}
        </section>

        <section className="query-pane" aria-label="Query editor">
          <div className="pane-title">Query</div>
          <textarea
            className="query-editor"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Generated SQL will appear here."
            spellCheck={false}
          />
          <div className={`validation ${validation?.safe ? 'safe' : 'blocked'}`}>
            {validation ? validation.reason : 'SAFE mode validation will appear here.'}
          </div>
          <div className="query-actions">
            <button type="button" onClick={() => void navigator.clipboard.writeText(query)} disabled={!query.trim()}>
              <Copy size={16} />
              Copy
            </button>
            <button type="button" className="primary-button" onClick={() => void runQuery()} disabled={busy || !validation?.safe}>
              <Play size={16} />
              Run Safe Query
            </button>
          </div>
        </section>
      </section>

      <footer className="statusbar">{status}</footer>
    </main>
  );
}
