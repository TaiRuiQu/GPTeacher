export type ModelProvider = 'openai' | 'azure' | 'custom';

export type ChannelSettings = {
  enabled: boolean;
  provider: ModelProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  hasApiKey?: boolean;
};

export type ModelSettingsValue = {
  text: ChannelSettings & { maxOutputTokens: number };
  tts: ChannelSettings & { voice: string };
  stt: ChannelSettings & { language: string };
};

const STORAGE_KEY = 'gpt-teacher:model-settings:v1';
const STORAGE_VERSION = 1;
const CREDENTIALS_KEY = 'gpt-teacher:api-keys:v1';
type ApiKeys = Record<keyof ModelSettingsValue, string>;

export const DEFAULT_SETTINGS: ModelSettingsValue = {
  text: {
    enabled: true,
    provider: 'openai',
    model: 'gpt-6.1-sol',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    maxOutputTokens: 16384,
  },
  tts: {
    enabled: false,
    provider: 'openai',
    model: 'gpt-realtime-2.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    voice: 'marin',
  },
  stt: {
    enabled: false,
    provider: 'openai',
    model: 'gpt-transcribe',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    language: 'zh',
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, fallback: string, limit = 400): string {
  return typeof value === 'string' ? value.slice(0, limit) : fallback;
}

export function readChannel(value: unknown, fallback: ChannelSettings): ChannelSettings {
  if (!isRecord(value)) return { ...fallback };
  const provider =
    value.provider === 'openai' || value.provider === 'azure' || value.provider === 'custom'
      ? value.provider
      : fallback.provider;
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback.enabled,
    provider,
    model: safeText(value.model, fallback.model, 160),
    baseUrl: safeText(value.baseUrl, fallback.baseUrl),
    apiKey: '',
    hasApiKey: value.hasApiKey === true,
  };
}

/** Read only supported configuration fields. Credentials are handled separately. */
export function cleanSettings(value: unknown): ModelSettingsValue {
  const source = isRecord(value) ? value : {};
  const text = isRecord(source.text) ? source.text : {};
  const tts = isRecord(source.tts) ? source.tts : {};
  const stt = isRecord(source.stt) ? source.stt : {};
  return {
    text: {
      ...readChannel(source.text, DEFAULT_SETTINGS.text),
      maxOutputTokens:
        typeof text.maxOutputTokens === 'number' &&
        Number.isInteger(text.maxOutputTokens) &&
        text.maxOutputTokens >= 512 &&
        text.maxOutputTokens <= 65536
          ? text.maxOutputTokens
          : DEFAULT_SETTINGS.text.maxOutputTokens,
    },
    tts: {
      ...readChannel(source.tts, DEFAULT_SETTINGS.tts),
      voice: safeText(tts.voice, DEFAULT_SETTINGS.tts.voice, 80),
    },
    stt: {
      ...readChannel(source.stt, DEFAULT_SETTINGS.stt),
      language: safeText(stt.language, DEFAULT_SETTINGS.stt.language, 40).split(/[-_]/)[0],
    },
  };
}

/** Read the previous browser format once so the server migration can import it. */
export function readLegacySettings(): ModelSettingsValue {
  let settings = cleanSettings(DEFAULT_SETTINGS);
  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const saved: unknown = raw ? JSON.parse(raw) : null;
      if (isRecord(saved) && saved.version === STORAGE_VERSION)
        settings = cleanSettings(saved.settings);
    }
  } catch {
    // A damaged or unavailable store must not prevent the classroom from opening.
  }
  const keys = readStoredKeys();
  for (const channel of ['text', 'tts', 'stt'] as const) settings[channel].apiKey = keys[channel];
  return settings;
}

function readStoredKeys(): ApiKeys {
  const empty = { text: '', tts: '', stt: '' };
  try {
    if (typeof window === 'undefined') return empty;
    const raw = window.localStorage.getItem(CREDENTIALS_KEY);
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (!isRecord(saved) || saved.version !== STORAGE_VERSION || !isRecord(saved.keys))
      return empty;
    return {
      text: safeText(saved.keys.text, '', 4096),
      tts: safeText(saved.keys.tts, '', 4096),
      stt: safeText(saved.keys.stt, '', 4096),
    };
  } catch {
    return empty;
  }
}

/** Compatibility for callers while startup moves to server-owned state. */
export const readSettings = readLegacySettings;
