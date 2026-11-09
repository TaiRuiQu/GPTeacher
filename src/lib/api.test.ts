import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { ApiError, apiAudio, apiJson, isAbortError } from './api.ts';

afterEach(() => mock.restoreAll());

test('JSON requests go through same-origin API and preserve caller cancellation', async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    assert.equal(path, '/api/lesson');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.redirect, 'error');
    assert.equal(init.body, JSON.stringify({ topic: '等式' }));
    requestSignal = init.signal as AbortSignal;
    return Response.json({ source: '# 等式' });
  });
  assert.deepEqual(await apiJson('/api/lesson', { topic: '等式' }, controller.signal), {
    source: '# 等式',
  });
  assert.equal(requestSignal?.aborted, false);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(apiJson('/api/lesson', {}, aborted.signal), isAbortError);
});

test('failed responses show safe actionable errors without credentials or HTML', async () => {
  const secret = 'private-provider-token';
  mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: `<b>密钥 ${secret} 无效</b>`, code: 'unauthorized' }, { status: 401 }),
  );
  await assert.rejects(
    apiJson('/api/lesson', { settings: { apiKey: secret } }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 401);
      assert.equal(error.code, 'unauthorized');
      assert.equal(error.message, '密钥 [已隐藏] 无效');
      return true;
    },
  );
});

test('transcription uses multipart and also hides its channel credential in errors', async () => {
  const data = new FormData();
  data.append('settings', JSON.stringify({ apiKey: 'voice-secret' }));
  data.append('file', new Blob(['audio'], { type: 'audio/webm' }), 'question.webm');
  mock.method(globalThis, 'fetch', async (_path: string, init: RequestInit) => {
    assert.equal(init.headers, undefined);
    assert.equal(init.body, data);
    return Response.json({ error: 'voice-secret is invalid' }, { status: 403 });
  });
  await assert.rejects(apiJson('/api/transcribe', data), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.message, '[已隐藏] is invalid');
    return true;
  });
});

test('provider diagnostics keep the error body and request metadata with credentials redacted', async () => {
  const secret = 'private-openrouter-token';
  mock.method(globalThis, 'fetch', async () =>
    Response.json(
      {
        error: `Provider returned error: model unavailable (${secret})`,
        code: 'UPSTREAM_FORBIDDEN',
        diagnostics: {
          upstreamStatus: 403,
          endpoint: 'https://openrouter.ai/api/v1/audio/speech',
          model: 'google/gemini-test-tts',
          requestId: 'req-tts-403',
          contentType: 'application/json',
          providerCode: 403,
          providerType: 'permission_error',
          providerMessage: `API model is unavailable for ${secret}`,
          responseBody: JSON.stringify({
            error: {
              message: 'Provider returned error',
              metadata: {
                raw: 'Model unavailable in region',
                provider_name: 'Test Provider',
                token: secret,
                Authorization: 'Bearer another-provider-token',
                api_key: 'other-private-key',
              },
            },
          }),
          transport: 'Speech HTTP',
          truncated: false,
          unsafeExtra: secret,
        },
      },
      { status: 502 },
    ),
  );
  await assert.rejects(
    apiAudio('/api/speech', { settings: { apiKey: secret } }),
    (reason: unknown) => {
      assert.ok(reason instanceof ApiError);
      assert.equal(reason.status, 502);
      assert.equal(reason.diagnostics?.upstreamStatus, 403);
      assert.equal(reason.diagnostics?.requestId, 'req-tts-403');
      assert.equal(reason.diagnostics?.model, 'google/gemini-test-tts');
      assert.equal(reason.diagnostics?.endpoint, 'https://openrouter.ai/api/v1/audio/speech');
      assert.match(reason.diagnostics?.responseBody ?? '', /Model unavailable in region/);
      assert.match(reason.diagnostics?.responseBody ?? '', /Test Provider/);
      assert.doesNotMatch(
        JSON.stringify(reason),
        /private-openrouter-token|another-provider-token|other-private-key|unsafeExtra/,
      );
      assert.doesNotMatch(reason.message, /private-openrouter-token/);
      return true;
    },
  );
});

test('diagnostic HTML remains plain text and oversized response bodies have a bounded preview', async () => {
  mock.method(globalThis, 'fetch', async () =>
    Response.json(
      {
        error: 'Provider denied the request',
        diagnostics: {
          upstreamStatus: 403,
          endpoint: 'https://provider.example/v1/audio/speech',
          model: 'tts-test',
          responseBody:
            '<html><script>malicious()</script>Access denied</html>' + 'x'.repeat(20_000),
        },
      },
      { status: 502 },
    ),
  );
  await assert.rejects(apiAudio('/api/speech', {}), (reason: unknown) => {
    assert.ok(reason instanceof ApiError);
    assert.match(
      reason.diagnostics?.responseBody ?? '',
      /<html><script>malicious\(\)<\/script>Access denied/,
    );
    assert.ok((reason.diagnostics?.responseBody?.length ?? 0) <= 16_384);
    assert.equal(reason.diagnostics?.truncated, true);
    return true;
  });
});

test('audio requests accept playable bytes and reject empty or JSON responses', async () => {
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/wav' } }),
  );
  const audio = await apiAudio('/api/speech', {});
  assert.equal(audio.type, 'audio/wav');
  assert.equal(audio.size, 3);
  fetchMock.mock.mockImplementation(async () => Response.json({ text: 'wrong endpoint' }));
  await assert.rejects(apiAudio('/api/speech', {}), /没有返回音频/);
  fetchMock.mock.mockImplementation(
    async () => new Response('', { headers: { 'Content-Type': 'audio/mpeg' } }),
  );
  await assert.rejects(apiAudio('/api/speech', {}), /空音频/);
});

test('network and malformed JSON errors are explicit and do not expose raw payloads', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw new Error('raw internal secret');
  });
  await assert.rejects(apiJson('/api/lesson', {}), /无法连接课堂服务/);
  fetchMock.mock.mockImplementation(async () => new Response('<html>proxy</html>'));
  await assert.rejects(apiJson('/api/lesson', {}), /无效的数据/);
  await assert.rejects(apiJson('https://example.com/api/lesson', {}), /无效的服务请求地址/);
});
