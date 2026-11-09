import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSpeechCache, speechCacheKey } from './speech-cache.ts';
import type { ServiceSettings } from './providers.ts';

const SETTINGS: ServiceSettings = {
  provider: 'custom',
  baseUrl: 'https://voice.example/v1',
  model: 'voice-model',
  voice: 'Kore',
  apiKey: 'cache-test-credential',
  language: 'zh',
  maxOutputTokens: 16384,
};
const audio = { bytes: Buffer.from('audio-fixture'), contentType: 'audio/wav' };
const signal = () => new AbortController().signal;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gpt-teacher-speech-cache-'));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('generated speech survives cache recreation and stores no credential or prompt metadata', async () => {
  const { directory, cleanup } = await fixture();
  try {
    let calls = 0;
    const first = createSpeechCache({
      directory,
      synthesize: async () => {
        calls += 1;
        return audio;
      },
    });
    assert.equal(
      (await first.get(SETTINGS, 'private lesson narration', signal())).cacheStatus,
      'miss',
    );
    const restarted = createSpeechCache({
      directory,
      synthesize: async () => {
        throw new Error('Disk hit must not call the provider');
      },
    });
    const hit = await restarted.get(SETTINGS, 'private lesson narration', signal());
    assert.equal(hit.cacheStatus, 'hit');
    assert.deepEqual(hit.bytes, audio.bytes);
    assert.equal(hit.contentType, 'audio/wav');
    assert.equal(calls, 1);
    for (const filename of await readdir(directory)) {
      assert.match(filename, /^[a-f0-9]{64}\.(?:bin|json)$/);
      if (filename.endsWith('.json')) {
        const metadata = await readFile(join(directory, filename), 'utf8');
        assert.doesNotMatch(
          metadata,
          /cache-test-credential|private lesson narration|voice\.example/,
        );
      }
    }
  } finally {
    await cleanup();
  }
});

test('voice, model, endpoint, text and credentials isolate cache entries', async () => {
  const { directory, cleanup } = await fixture();
  try {
    let calls = 0;
    const cache = createSpeechCache({
      directory,
      synthesize: async () => {
        calls += 1;
        return audio;
      },
    });
    await cache.get(SETTINGS, 'hello', signal());
    for (const overrides of [
      { voice: 'Zephyr' },
      { model: 'other-model' },
      { baseUrl: 'https://other.example/v1' },
      { apiKey: 'other-credential' },
    ])
      assert.equal(
        (await cache.get({ ...SETTINGS, ...overrides }, 'hello', signal())).cacheStatus,
        'miss',
      );
    assert.equal((await cache.get(SETTINGS, 'different text', signal())).cacheStatus, 'miss');
    assert.equal(calls, 6);
  } finally {
    await cleanup();
  }
});

test('same requests share one synthesis and cancelling one consumer does not abort another', async () => {
  const { directory, cleanup } = await fixture();
  try {
    const started = deferred<void>();
    const result = deferred<typeof audio>();
    let calls = 0;
    let aborted = false;
    const cache = createSpeechCache({
      directory,
      synthesize: async (_settings, _text, upstreamSignal) => {
        calls += 1;
        upstreamSignal.addEventListener('abort', () => {
          aborted = true;
        });
        started.resolve();
        return result.promise;
      },
    });
    const consumer = new AbortController();
    const first = cache.get(SETTINGS, 'shared', consumer.signal);
    const second = cache.get(SETTINGS, 'shared', signal());
    await started.promise;
    consumer.abort();
    await assert.rejects(
      first,
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(aborted, false);
    result.resolve(audio);
    assert.equal((await second).cacheStatus, 'shared');
    assert.equal(calls, 1);
  } finally {
    await cleanup();
  }
});

test('all cancelled consumers abort the provider and leave no successful cached response', async () => {
  const { directory, cleanup } = await fixture();
  try {
    const started = deferred<void>();
    const stopped = deferred<void>();
    let calls = 0;
    const cache = createSpeechCache({
      directory,
      synthesize: async (_settings, _text, upstreamSignal) => {
        calls += 1;
        if (calls > 1) return audio;
        started.resolve();
        return new Promise((_resolve, reject) =>
          upstreamSignal.addEventListener(
            'abort',
            () => {
              stopped.resolve();
              reject(upstreamSignal.reason);
            },
            { once: true },
          ),
        );
      },
    });
    const controller = new AbortController();
    const pending = cache.get(SETTINGS, 'cancelled', controller.signal);
    await started.promise;
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    await stopped.promise;
    assert.equal((await cache.get(SETTINGS, 'cancelled', signal())).cacheStatus, 'miss');
    assert.equal(calls, 2);
  } finally {
    await cleanup();
  }
});

test('provider failures are never cached and corrupt disk entries are regenerated', async () => {
  const { directory, cleanup } = await fixture();
  try {
    let calls = 0;
    const cache = createSpeechCache({
      directory,
      synthesize: async () => {
        calls += 1;
        if (calls === 1) throw new Error('403 provider reason');
        return audio;
      },
    });
    await assert.rejects(cache.get(SETTINGS, 'retry', signal()), /403 provider reason/);
    assert.deepEqual(await readdir(directory).catch(() => []), []);
    const orphan = `${'a'.repeat(64)}.bin`;
    await writeFile(join(directory, orphan), 'interrupted-cache-write');
    assert.equal((await cache.get(SETTINGS, 'retry', signal())).cacheStatus, 'miss');
    assert.equal((await readdir(directory)).includes(orphan), false);
    const key = speechCacheKey(SETTINGS, 'retry');
    await writeFile(join(directory, `${key}.bin`), 'broken');
    assert.equal((await cache.get(SETTINGS, 'retry', signal())).cacheStatus, 'miss');
    assert.equal(calls, 3);
  } finally {
    await cleanup();
  }
});

test('expired entries regenerate and a byte quota evicts least recently used audio', async () => {
  const { directory, cleanup } = await fixture();
  try {
    let clock = Date.now();
    let calls = 0;
    const cache = createSpeechCache({
      directory,
      maxBytes: 4,
      ttlMs: 100,
      now: () => clock,
      synthesize: async () => {
        calls += 1;
        return { bytes: Buffer.from('12'), contentType: 'audio/wav' };
      },
    });
    await cache.get(SETTINGS, 'one', signal());
    clock += 5;
    await cache.get(SETTINGS, 'two', signal());
    clock += 5;
    await cache.get(SETTINGS, 'one', signal());
    clock += 5;
    await cache.get(SETTINGS, 'three', signal());
    const keyTwo = speechCacheKey(SETTINGS, 'two');
    assert.equal(
      (await readdir(directory)).some((filename) => filename.startsWith(keyTwo)),
      false,
    );
    clock += 200;
    assert.equal((await cache.get(SETTINGS, 'one', signal())).cacheStatus, 'miss');
    assert.equal(calls, 4);
    assert.equal(
      (await readdir(directory)).filter((filename) => filename.endsWith('.bin')).length,
      1,
    );
  } finally {
    await cleanup();
  }
});
