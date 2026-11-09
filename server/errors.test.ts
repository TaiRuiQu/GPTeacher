import assert from 'node:assert/strict';
import test from 'node:test';
import { redactDiagnostics, upstreamError } from './errors.ts';
import { pcmWave, resolveSettings, speech } from './providers.ts';

test('403 diagnostics distinguish region, model access, network policy and unknown refusals', () => {
  for (const [body, expected] of [
    [
      {
        error: {
          code: 'unsupported_country_region_territory',
          message: 'Country is not supported',
        },
      },
      'UPSTREAM_REGION',
    ],
    [
      { error: { code: 'model_access_denied', message: 'No access to this model' } },
      'UPSTREAM_MODEL_ACCESS',
    ],
    [{ error: { message: 'IP address is not allowed by this resource.' } }, 'UPSTREAM_IP_POLICY'],
    [{ error: { code: 403, message: 'Provider refused the request.' } }, 'UPSTREAM_FORBIDDEN'],
  ] as const) {
    const error = upstreamError(403, {
      body,
      transport: 'speech',
      endpoint: 'https://provider.example/v1/audio/speech',
      model: 'voice-model',
    });
    assert.equal(error.code, expected);
    assert.equal(error.diagnostics?.upstreamStatus, 403);
    assert.equal(error.diagnostics?.providerMessage, body.error.message);
    assert.match(error.message, /Speech/);
    assert.match(error.message, /服务商说明/);
  }
  assert.equal(upstreamError(401).code, 'UPSTREAM_AUTH');
  assert.equal(upstreamError(403).code, 'UPSTREAM_FORBIDDEN');
});

test('quota and rate limits remain separate and HTML firewall pages retain safe diagnostics', () => {
  assert.equal(
    upstreamError(429, { body: { error: { code: 'insufficient_quota' } } }).code,
    'UPSTREAM_QUOTA',
  );
  assert.equal(
    upstreamError(429, { body: { error: { code: 'rate_limit_exceeded' } } }).code,
    'UPSTREAM_RATE_LIMIT',
  );
  const error = upstreamError(403, {
    body: '<!doctype html><html>Firewall block reference 123</html>',
    contentType: 'text/html',
    transport: 'realtime',
  });
  assert.equal(error.code, 'UPSTREAM_GATEWAY');
  assert.match(error.message, /不能|无法据此/);
  assert.match(error.message, /Realtime\/WebSocket/);
  assert.match(error.diagnostics?.responseBody || '', /Firewall block reference 123/);
});

test('original provider reasons and metadata survive while credentials in every field are redacted', () => {
  const key = 'current-secret-value';
  const body = {
    error: {
      code: 403,
      message: `Provider denied the request for ${key}, Authorization: Bearer another-secret`,
      metadata: {
        provider_name: 'Example upstream',
        raw: 'Reason: permission scope is missing; api_key=other-secret&password=not-public',
      },
    },
  };
  const error = upstreamError(403, {
    body,
    secret: key,
    requestId: `request-${key}`,
    endpoint: `https://provider.example/v1/audio/speech?api_key=${key}`,
    model: `model-${key}`,
    transport: 'speech',
  });
  const result = JSON.stringify(error);
  assert.doesNotMatch(result, /current-secret-value|another-secret|other-secret|not-public/);
  assert.match(error.diagnostics?.responseBody || '', /Example upstream/);
  assert.match(error.diagnostics?.responseBody || '', /permission scope is missing/);
  assert.match(error.diagnostics?.providerMessage || '', /Provider denied the request/);
  assert.match(error.diagnostics?.requestId || '', /已隐藏/);
});

test('large upstream diagnostic bodies stay bounded and truncated credential tails are removed', () => {
  const key = 'a-private-key-value';
  const error = upstreamError(403, { body: 'x'.repeat(20_000), secret: key, truncated: true });
  assert.ok((error.diagnostics?.responseBody || '').length <= 16_384);
  assert.equal(error.diagnostics?.truncated, true);
  assert.equal(redactDiagnostics('reason: a-private-', key), 'reason: [已隐藏]');
  assert.doesNotMatch(
    redactDiagnostics('sk-privatevalue123 Bearer access123 "password":"value123"', key),
    /privatevalue123|access123|value123/,
  );
  const nested = JSON.stringify({
    error: {
      metadata: {
        raw: JSON.stringify({
          api_key: 'upstream-private-key',
          password: 'upstream-private-password',
          reason: 'Scope is missing',
        }),
      },
    },
  });
  const redacted = redactDiagnostics(nested, key);
  assert.doesNotMatch(redacted, /upstream-private-key|upstream-private-password/);
  assert.match(redacted, /Scope is missing/);
  assert.doesNotMatch(redactDiagnostics('api_key%3Durl-private', key), /url-private/);
});

test('OpenRouter Gemini TTS requests PCM and returns a playable WAV without changing the voice', async (context) => {
  let captured: Record<string, unknown> = {};
  context.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    captured = { url: input, headers: init.headers, body: JSON.parse(init.body as string) };
    return new Response(new Uint8Array([1, 0, 2, 0]), {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  });
  const settings = resolveSettings(
    {
      provider: 'custom',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'google/gemini-3.8-flash-lite-tts',
      apiKey: 'test-router-key',
      voice: 'Kore',
    },
    'tts',
  );
  const result = await speech(settings, '你好', new AbortController().signal);
  assert.equal(captured.url, 'https://openrouter.ai/api/v1/audio/speech');
  assert.equal(
    (captured.headers as Record<string, string>).Authorization,
    'Bearer test-router-key',
  );
  assert.equal((captured.body as Record<string, string>).response_format, 'pcm');
  assert.equal((captured.body as Record<string, string>).voice, 'Kore');
  assert.equal(result.contentType, 'audio/wav');
  assert.equal(result.bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(result.bytes.readUInt32LE(24), 24_000);
  assert.equal(result.bytes.readUInt16LE(22), 1);
  assert.equal(result.bytes.readUInt16LE(34), 16);
  assert.equal(result.bytes.length, 48);
});

test('HTTP provider failures preserve bounded raw reasons and request IDs without exposing keys', async (context) => {
  context.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: 'Provider permission denied for current-secret',
            metadata: { provider_name: 'upstream-test', raw: 'Permission scope is missing' },
          },
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-fixture-123' },
        },
      ),
  );
  const settings = resolveSettings(
    {
      provider: 'custom',
      baseUrl: 'https://provider.example/v1',
      model: 'voice-model',
      apiKey: 'current-secret',
      voice: 'Kore',
    },
    'tts',
  );
  await assert.rejects(
    () => speech(settings, '你好', new AbortController().signal),
    (error: unknown) => {
      const failure = error as ReturnType<typeof upstreamError>;
      assert.equal(failure.code, 'UPSTREAM_PERMISSION');
      assert.equal(failure.diagnostics?.requestId, 'req-fixture-123');
      assert.equal(failure.diagnostics?.endpoint, 'https://provider.example/v1/audio/speech');
      assert.match(failure.diagnostics?.responseBody || '', /Permission scope is missing/);
      assert.doesNotMatch(JSON.stringify(failure), /current-secret/);
      return true;
    },
  );
});

test('PCM metadata sets WAV timing and existing WAVs are not wrapped twice', async (context) => {
  let mode = 'metadata';
  const wave = pcmWave(Buffer.from([1, 0, 2, 0]), 16_000, 2);
  context.mock.method(globalThis, 'fetch', async () => {
    if (mode === 'wave')
      return new Response(new Uint8Array(wave), { headers: { 'Content-Type': 'audio/wav' } });
    if (mode === 'json')
      return new Response('{"error":"not audio"}', {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    return new Response(new Uint8Array([1, 0, 2, 0]), {
      headers: {
        'Content-Type':
          mode === 'invalid' ? 'audio/pcm;rate=abc;channels=1' : 'audio/pcm;rate=48000;channels=2',
      },
    });
  });
  const settings = resolveSettings(
    {
      provider: 'custom',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'google/gemini-3.8-flash-lite-tts',
      apiKey: 'test-router-key',
      voice: 'Kore',
    },
    'tts',
  );
  const result = await speech(settings, '你好', new AbortController().signal);
  assert.equal(result.bytes.readUInt32LE(24), 48_000);
  assert.equal(result.bytes.readUInt16LE(22), 2);
  assert.equal(result.bytes.readUInt32LE(28), 192_000);
  mode = 'wave';
  const existing = await speech(settings, '你好', new AbortController().signal);
  assert.deepEqual(existing.bytes, wave);
  for (const value of ['json', 'invalid']) {
    mode = value;
    await assert.rejects(() => speech(settings, '你好', new AbortController().signal), {
      code: 'INVALID_PCM_AUDIO',
    });
  }
});

test('upstream HTML error bodies are capped before being exposed as diagnostics', async (context) => {
  context.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('<!doctype html><html>' + 'firewall '.repeat(10_000), {
        status: 403,
        headers: { 'Content-Type': 'text/html', 'X-Request-Id': 'req-firewall' },
      }),
  );
  const settings = resolveSettings(
    {
      provider: 'custom',
      baseUrl: 'https://provider.example/v1',
      model: 'voice-model',
      apiKey: 'current-secret',
      voice: 'Kore',
    },
    'tts',
  );
  await assert.rejects(
    () => speech(settings, '你好', new AbortController().signal),
    (error: unknown) => {
      const failure = error as ReturnType<typeof upstreamError>;
      assert.equal(failure.code, 'UPSTREAM_GATEWAY');
      assert.equal(failure.diagnostics?.truncated, true);
      assert.ok((failure.diagnostics?.responseBody || '').length <= 16_384);
      return true;
    },
  );
});
