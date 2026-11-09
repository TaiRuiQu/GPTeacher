import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ApiError } from './errors.ts';
import { speech, type ServiceSettings } from './providers.ts';
import { getDataDirectory } from './storage.ts';

type Audio = { bytes: Buffer; contentType: string };
type CacheStatus = 'hit' | 'miss' | 'shared';
type CachedAudio = Audio & { cacheStatus: CacheStatus };
type Metadata = { version: 1; contentType: string; size: number; createdAt: number };
type Options = {
  directory: string;
  synthesize?: (settings: ServiceSettings, text: string, signal: AbortSignal) => Promise<Audio>;
  maxBytes?: number;
  maxEntryBytes?: number;
  ttlMs?: number;
  now?: () => number;
};
type Flight = {
  controller: AbortController;
  consumers: number;
  done: boolean;
  promise: Promise<Audio & { cacheStatus: 'hit' | 'miss' }>;
};

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRY = 32 * 1024 * 1024;
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[a-f0-9]{64}$/;

export function speechCacheKey(settings: ServiceSettings, text: string) {
  const credential = createHash('sha256').update(settings.apiKey).digest('hex');
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        provider: settings.provider,
        baseUrl: settings.baseUrl.replace(/\/+$/, ''),
        model: settings.model,
        voice: settings.voice,
        text,
        credential,
      }),
    )
    .digest('hex');
}

/** Files contain only audio and public media metadata; prompts and keys never reach disk. */
export function createSpeechCache(options: Options) {
  const directory = resolve(options.directory);
  const synthesize = options.synthesize ?? speech;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL;
  const now = options.now ?? Date.now;
  const flights = new Map<string, Flight>();
  let pruning: Promise<void> = Promise.resolve();
  const paths = (key: string) => ({
    audio: join(directory, `${key}.bin`),
    metadata: join(directory, `${key}.json`),
  });

  async function remove(key: string) {
    const entry = paths(key);
    await Promise.all([rm(entry.audio, { force: true }), rm(entry.metadata, { force: true })]);
  }

  function metadata(value: unknown): value is Metadata {
    if (!value || typeof value !== 'object') return false;
    const item = value as Metadata;
    return (
      item.version === 1 &&
      typeof item.contentType === 'string' &&
      /^audio\/[a-z0-9.+-]+$/i.test(item.contentType) &&
      Number.isInteger(item.size) &&
      item.size > 0 &&
      item.size <= maxEntryBytes &&
      Number.isFinite(item.createdAt) &&
      item.createdAt > 0
    );
  }

  async function read(key: string, signal: AbortSignal): Promise<Audio | null> {
    const entry = paths(key);
    try {
      const descriptor = await stat(entry.metadata);
      if (!descriptor.isFile() || descriptor.size > 4096) {
        await remove(key);
        return null;
      }
      const meta: unknown = JSON.parse(await readFile(entry.metadata, 'utf8'));
      if (!metadata(meta) || now() - meta.createdAt > ttlMs) {
        await remove(key);
        return null;
      }
      const audioStat = await stat(entry.audio);
      if (!audioStat.isFile() || audioStat.size !== meta.size) {
        await remove(key);
        return null;
      }
      signal.throwIfAborted();
      const bytes = await readFile(entry.audio);
      signal.throwIfAborted();
      if (bytes.length !== meta.size) {
        await remove(key);
        return null;
      }
      await utimes(entry.metadata, new Date(now()), new Date(now())).catch(() => {});
      return { bytes, contentType: meta.contentType };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      await remove(key).catch(() => {});
      return null;
    }
  }

  async function write(key: string, audio: Audio, signal: AbortSignal) {
    if (!audio.bytes.length || audio.bytes.length > maxEntryBytes || audio.bytes.length > maxBytes)
      throw new ApiError(
        502,
        'AUDIO_CACHE_SIZE',
        '合成音频超过服务器缓存的单段上限，请缩短讲解片段。',
      );
    if (!/^audio\/[a-z0-9.+-]+$/i.test(audio.contentType))
      throw new ApiError(502, 'AUDIO_CACHE_TYPE', '语音服务没有返回可缓存的音频类型。');
    const entry = paths(key);
    const suffix = `.tmp-${randomUUID()}`;
    const audioTemp = `${entry.audio}${suffix}`;
    const metadataTemp = `${entry.metadata}${suffix}`;
    try {
      await mkdir(directory, { recursive: true });
      signal.throwIfAborted();
      const meta: Metadata = {
        version: 1,
        contentType: audio.contentType,
        size: audio.bytes.length,
        createdAt: now(),
      };
      await writeFile(audioTemp, audio.bytes, { flag: 'wx', mode: 0o600 });
      await writeFile(metadataTemp, JSON.stringify(meta), { flag: 'wx', mode: 0o600 });
      signal.throwIfAborted();
      await rename(audioTemp, entry.audio);
      await rename(metadataTemp, entry.metadata);
      await utimes(entry.metadata, new Date(now()), new Date(now()));
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        500,
        'AUDIO_CACHE_WRITE',
        '无法保存服务器语音缓存，请检查数据目录的磁盘空间和写入权限。',
      );
    } finally {
      await Promise.all([rm(audioTemp, { force: true }), rm(metadataTemp, { force: true })]).catch(
        () => {},
      );
    }
  }

  async function prune(protectedKey: string) {
    const entries: Array<{ key: string; size: number; accessed: number }> = [];
    const files = await readdir(directory);
    const names = new Set(files);
    for (const file of files) {
      const orphanKey = file.endsWith('.bin') ? file.slice(0, -4) : '';
      if (
        KEY_PATTERN.test(orphanKey) &&
        !names.has(`${orphanKey}.json`) &&
        !flights.has(orphanKey)
      ) {
        await rm(join(directory, file), { force: true });
        continue;
      }
      if (/^[a-f0-9]{64}\.(?:bin|json)\.tmp-[a-f0-9-]+$/.test(file)) {
        const temporary = join(directory, file);
        const info = await stat(temporary).catch(() => null);
        if (info && now() - info.mtimeMs > 60 * 60 * 1000) await rm(temporary, { force: true });
        continue;
      }
      const key = file.endsWith('.json') ? file.slice(0, -5) : '';
      if (!KEY_PATTERN.test(key)) continue;
      const entry = paths(key);
      try {
        const meta: unknown = JSON.parse(await readFile(entry.metadata, 'utf8'));
        if (!metadata(meta) || now() - meta.createdAt > ttlMs) {
          await remove(key);
          continue;
        }
        const fileStat = await stat(entry.metadata);
        const audioStat = await stat(entry.audio);
        if (audioStat.size !== meta.size) {
          await remove(key);
          continue;
        }
        entries.push({ key, size: meta.size, accessed: fileStat.mtimeMs });
      } catch {
        await remove(key).catch(() => {});
      }
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries.sort((a, b) => a.accessed - b.accessed)) {
      if (total <= maxBytes) break;
      if (entry.key === protectedKey) continue;
      await remove(entry.key);
      total -= entry.size;
    }
  }

  function get(settings: ServiceSettings, text: string, signal: AbortSignal): Promise<CachedAudio> {
    if (signal.aborted)
      return Promise.reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const key = speechCacheKey(settings, text);
    let flight = flights.get(key);
    const shared = Boolean(flight);
    if (!flight) {
      const controller = new AbortController();
      const created: Flight = {
        controller,
        consumers: 0,
        done: false,
        promise: Promise.resolve(null as never),
      };
      flights.set(key, created);
      created.promise = (async () => {
        const cached = await read(key, controller.signal);
        if (cached) return { ...cached, cacheStatus: 'hit' as const };
        controller.signal.throwIfAborted();
        const audio = await synthesize(settings, text, controller.signal);
        controller.signal.throwIfAborted();
        await write(key, audio, controller.signal);
        pruning = pruning.catch(() => {}).then(() => prune(key));
        await pruning;
        return { ...audio, cacheStatus: 'miss' as const };
      })();
      void created.promise
        .finally(() => {
          created.done = true;
          if (flights.get(key) === created) flights.delete(key);
        })
        .catch(() => {});
      flight = created;
    }
    const current = flight;
    current.consumers += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = () => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener('abort', abort);
        current.consumers -= 1;
        if (!current.consumers && !current.done) {
          current.controller.abort();
          if (flights.get(key) === current) flights.delete(key);
        }
        return true;
      };
      const abort = () => {
        if (release()) reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      current.promise.then(
        (audio) => {
          if (release())
            resolve({
              ...audio,
              cacheStatus: audio.cacheStatus === 'hit' ? 'hit' : shared ? 'shared' : 'miss',
            });
        },
        (error: unknown) => {
          if (release()) reject(error);
        },
      );
    });
  }

  return { get };
}

const caches = new Map<string, ReturnType<typeof createSpeechCache>>();

export function cachedSpeech(
  settings: ServiceSettings,
  text: string,
  signal: AbortSignal,
  dataDirectory = getDataDirectory(),
) {
  const directory = resolve(dataDirectory, 'tts');
  let cache = caches.get(directory);
  if (!cache) {
    cache = createSpeechCache({ directory });
    caches.set(directory, cache);
  }
  return cache.get(settings, text, signal);
}
