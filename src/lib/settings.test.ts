import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { cleanSettings, DEFAULT_SETTINGS, readLegacySettings, readSettings } from './settings.ts';

const PUBLIC_KEY = 'gpt-teacher:model-settings:v1';
const CREDENTIALS_KEY = 'gpt-teacher:api-keys:v1';

function useStorage(t: TestContext) {
  const data = new Map<string, string>();
  const writes: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string) => {
      writes.push(key);
      throw new Error('Migration must not write browser storage.');
    },
    removeItem: (key: string) => {
      writes.push(key);
      throw new Error('Migration must not delete before server acknowledgement.');
    },
  };
  Object.defineProperty(globalThis, 'window', { value: { localStorage }, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return { data, writes };
}

test('legacy public settings migrate with defaults and reject credentials in the public record', (t) => {
  const { data, writes } = useStorage(t);
  data.set(
    PUBLIC_KEY,
    JSON.stringify({
      version: 1,
      settings: {
        text: {
          provider: 'custom',
          model: 'my-model',
          baseUrl: 'https://provider.example/v1',
          apiKey: 'ignored-public-key',
          maxOutputTokens: 32768,
        },
        stt: { language: 'zh-CN' },
      },
    }),
  );
  const settings = readLegacySettings();
  assert.equal(settings.text.model, 'my-model');
  assert.equal(settings.text.maxOutputTokens, 32768);
  assert.equal(settings.text.apiKey, '');
  assert.equal(settings.text.enabled, true);
  assert.equal(settings.tts.enabled, false);
  assert.equal(settings.stt.language, 'zh');
  assert.deepEqual(writes, []);
  assert.equal(readSettings, readLegacySettings);
});

test('legacy remembered credentials are read only from the independent record for one-time migration', (t) => {
  const { data, writes } = useStorage(t);
  data.set(
    PUBLIC_KEY,
    JSON.stringify({ version: 1, settings: { tts: { enabled: true, voice: 'Kore' } } }),
  );
  data.set(
    CREDENTIALS_KEY,
    JSON.stringify({
      version: 1,
      keys: { text: 'old-text-key', tts: 'old-voice-key', stt: 'old-asr-key' },
    }),
  );
  const settings = readLegacySettings();
  assert.equal(settings.text.apiKey, 'old-text-key');
  assert.equal(settings.tts.apiKey, 'old-voice-key');
  assert.equal(settings.stt.apiKey, 'old-asr-key');
  assert.equal(settings.tts.voice, 'Kore');
  assert.equal(settings.tts.enabled, true);
  assert.deepEqual(writes, []);
  assert.equal(data.has(CREDENTIALS_KEY), true);
});

test('server public settings retain saved-key flags while stripping plaintext credentials', () => {
  const settings = cleanSettings({
    text: {
      ...DEFAULT_SETTINGS.text,
      apiKey: 'must-not-be-read',
      hasApiKey: true,
      maxOutputTokens: 65536,
    },
    tts: { ...DEFAULT_SETTINGS.tts, hasApiKey: false },
    stt: { ...DEFAULT_SETTINGS.stt, hasApiKey: 'yes' },
  });
  assert.equal(settings.text.apiKey, '');
  assert.equal(settings.text.hasApiKey, true);
  assert.equal(settings.text.maxOutputTokens, 65536);
  assert.equal(settings.tts.hasApiKey, false);
  assert.equal(settings.stt.hasApiKey, false);
  assert.equal(cleanSettings({ text: { maxOutputTokens: 511 } }).text.maxOutputTokens, 16384);
});

test('damaged or unavailable legacy storage returns clean defaults without changing storage', (t) => {
  const { data, writes } = useStorage(t);
  data.set(PUBLIC_KEY, '{broken');
  data.set(CREDENTIALS_KEY, '{broken');
  const settings = readLegacySettings();
  assert.equal(settings.text.model, DEFAULT_SETTINGS.text.model);
  assert.equal(settings.text.apiKey, '');
  assert.equal(settings.tts.apiKey, '');
  assert.deepEqual(writes, []);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')!;
  Object.defineProperty(globalThis, 'window', {
    value: {
      localStorage: {
        getItem: () => {
          throw new Error('unavailable');
        },
      },
    },
    configurable: true,
  });
  assert.equal(readLegacySettings().text.apiKey, '');
  Object.defineProperty(globalThis, 'window', descriptor);
});
