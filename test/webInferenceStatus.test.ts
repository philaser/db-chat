import { describe, expect, it } from 'vitest';
import { getInferenceCallout } from '../src/web/App.js';

describe('web inference status copy', () => {
  it('reports managed inference only when an internal key is ready', () => {
    expect(getInferenceCallout({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash-0731',
      credentialSource: 'internal',
      hasUserKey: false,
      userKeyUiEnabled: false,
      canChangeModel: false,
      models: [{ id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' }],
      status: 'ready'
    })).toEqual({
      available: true,
      title: 'Managed inference ready',
      description: 'DB Chat uses the shared managed model.'
    });
  });

  it('does not claim managed inference is active without a key', () => {
    expect(getInferenceCallout({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash-0731',
      credentialSource: 'none',
      hasUserKey: false,
      userKeyUiEnabled: false,
      canChangeModel: false,
      models: [{ id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' }],
      status: 'unavailable'
    })).toEqual({
      available: false,
      title: 'Inference unavailable',
      description: 'Answers are temporarily unavailable. Your connections and saved chats are still accessible.'
    });
  });

  it('reports a stored user key separately', () => {
    expect(getInferenceCallout({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash-0731',
      credentialSource: 'user',
      hasUserKey: true,
      userKeyUiEnabled: false,
      canChangeModel: true,
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      status: 'ready'
    })).toMatchObject({
      available: true,
      title: 'Provider key ready'
    });
  });
});
