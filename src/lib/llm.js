import { invoke } from './bridge.js';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export function providerConfig(settings) {
  return {
    kind: 'openai',
    baseUrl: OPENROUTER_BASE,
    model: settings.model,
    apiKey: settings.apiKey,
    temperature: settings.temperature ?? 0.7,
    maxTokens: 8000,
  };
}

export async function chat({ settings, system, user, images = [] }) {
  const reply = await invoke('chat_completion', {
    request: {
      provider: providerConfig(settings),
      system,
      user,
      images,
    },
  });
  return reply;
}

export async function listModels() {
  return invoke('list_models');
}

export async function verifyKey(apiKey) {
  return invoke('verify_openrouter', { apiKey });
}
