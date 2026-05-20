import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelProviderKind, PersistedSettings } from '../../shared/types.js';
import { normalizeApiKey } from '../model/apiKeys.js';

interface StoreData {
  settings: PersistedSettings;
  encryptedApiKeys: Partial<Record<ModelProviderKind, string>>;
}

const DEFAULT_SETTINGS: PersistedSettings = {
  provider: 'openrouter',
  model: 'openai/gpt-4.1-mini',
  safeMode: true
};

export class AppStore {
  private readonly filePath: string;

  constructor(filePath = path.join(app.getPath('userData'), 'db-chat-store.json')) {
    this.filePath = filePath;
  }

  loadSettings(): PersistedSettings {
    return this.read().settings;
  }

  saveSettings(settings: PersistedSettings): void {
    const data = this.read();
    this.write({ ...data, settings: this.normalizeSettings(settings) });
  }

  saveApiKey(provider: ModelProviderKind, apiKey: string): void {
    const data = this.read();
    const encryptedApiKeys = {
      ...data.encryptedApiKeys,
      [provider]: this.encrypt(normalizeApiKey(apiKey))
    };
    this.write({ ...data, encryptedApiKeys });
  }

  getApiKey(provider: ModelProviderKind): string | null {
    const encrypted = this.read().encryptedApiKeys[provider];
    if (!encrypted) {
      return null;
    }
    return this.decrypt(encrypted);
  }

  hasApiKey(provider: ModelProviderKind): boolean {
    return Boolean(this.read().encryptedApiKeys[provider]);
  }

  private read(): StoreData {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      return {
        settings: this.normalizeSettings({ ...DEFAULT_SETTINGS, ...parsed.settings }),
        encryptedApiKeys: parsed.encryptedApiKeys ?? {}
      };
    } catch {
      return {
        settings: DEFAULT_SETTINGS,
        encryptedApiKeys: {}
      };
    }
  }

  private write(data: StoreData): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  private normalizeSettings(settings: PersistedSettings): PersistedSettings {
    return {
      provider: settings.provider,
      model: settings.model,
      safeMode: settings.safeMode
    };
  }

  private encrypt(value: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return `safe:${safeStorage.encryptString(value).toString('base64')}`;
    }
    return `plain:${Buffer.from(value, 'utf8').toString('base64')}`;
  }

  private decrypt(value: string): string {
    const [prefix, payload] = value.split(':', 2);
    if (prefix === 'safe') {
      return safeStorage.decryptString(Buffer.from(payload, 'base64'));
    }
    return Buffer.from(payload, 'base64').toString('utf8');
  }
}
