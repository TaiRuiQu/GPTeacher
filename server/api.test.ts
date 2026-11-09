import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  createServer,
  request as httpRequest,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createApiMiddleware, validateGeneratedSource } from './api.ts';
import { resolveSettings } from './providers.ts';
import { StateStore } from './storage.ts';

const SOURCE =
  '# 分数入门\n理解分数。\n' +
  [1, 2]
    .map(
      (index) =>
        `:::step id="part-${index}" title="第${index}步" duration="20"\n将一个整体平均分成几份。\n\`\`\`svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 450"><text x="50" y="80">一半</text></svg>\n\`\`\`\n:::`,
    )
    .join('\n');
let upstream: Server;
let application: Server;
let upstreamUrl: string;
let appUrl: string;
let mode = 'normal';
let captured: Record<string, unknown> = {};
let wsServer: WebSocketServer;
let slowStarted: (() => void) | undefined;
let slowClosed: (() => void) | undefined;
let dataDirectory: string;
let providerCalls = 0;

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function mockProvider(req: IncomingMessage, res: ServerResponse) {
  providerCalls += 1;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  captured = {
    path: req.url,
    authorization: req.headers.authorization,
    apiKey: req.headers['api-key'],
  };
  if (mode === 'auth-error') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'secret-test-key echoed by malicious upstream' } }));
    return;
  }
  if (mode === 'slow') {
    res.on('close', () => slowClosed?.());
    slowStarted?.();
    return;
  }
  if (req.url?.endsWith('/audio/transcriptions')) {
    const form = await new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Type': req.headers['content-type']! },
      body: new Uint8Array(bytes),
    }).formData();
    const file = form.get('file') as File;
    captured = {
      ...captured,
      model: form.get('model'),
      languages: form.getAll('languages[]'),
      language: form.get('language'),
      fileName: file.name,
      fileSize: file.size,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: mode === 'silence' ? '' : '为什么要平均分？' }));
    return;
  }
  const body = JSON.parse(bytes.toString()) as Record<string, unknown>;
  captured = { ...captured, body };
  if (req.url?.endsWith('/audio/speech')) {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(Buffer.from('test-mp3-bytes'));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      choices: [
        {
          finish_reason: mode === 'truncated' ? 'length' : 'stop',
          message: {
            content:
              mode === 'lesson' || mode === 'truncated'
                ? `\`\`\`\`markdown\n${SOURCE}\n\`\`\`\``
                : '因为等式两边需要保持相等。',
          },
        },
      ],
    }),
  );
}

before(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'gpt-teacher-api-'));
  upstream = createServer((req, res) => {
    void mockProvider(req, res);
  });
  wsServer = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => {
    if (mode === 'realtime-handshake-error') {
      const body = JSON.stringify({
        error: {
          code: 403,
          message: 'Provider scope missing for secret-test-key',
          metadata: { raw: 'Realtime endpoint is not enabled' },
        },
      });
      socket.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nX-Request-Id: req-ws-fixture\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (client) => wsServer.emit('connection', client, req));
  });
  wsServer.on('connection', (socket, req) => {
    if (mode === 'realtime-close') {
      socket.close();
      return;
    }
    socket.send(JSON.stringify({ type: 'session.created', session: {} }));
    socket.on('message', (bytes) => {
      captured = {
        path: req.url,
        authorization: req.headers.authorization,
        event: JSON.parse(bytes.toString()),
      };
      if (mode === 'realtime-slow') {
        socket.on('close', () => slowClosed?.());
        slowStarted?.();
        return;
      }
      if (mode === 'realtime-error-event') {
        socket.send(
          JSON.stringify({
            type: 'error',
            request_id: 'req-event-fixture',
            error: {
              code: 'model_access_denied',
              status: 403,
              message: 'No access to model for secret-test-key',
            },
          }),
        );
        return;
      }
      socket.send(
        JSON.stringify({
          type: 'response.output_audio.delta',
          delta: Buffer.alloc(480, 1).toString('base64'),
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'response.done',
          response: { status: mode === 'realtime-fail' ? 'failed' : 'completed' },
        }),
      );
    });
  });
  upstreamUrl = await listen(upstream);
  application = createServer(createApiMiddleware({ store: new StateStore(dataDirectory) }));
  appUrl = await listen(application);
});

after(async () => {
  for (const client of wsServer.clients) client.terminate();
  wsServer.close();
  await close(application);
  await close(upstream);
  await rm(dataDirectory, { recursive: true, force: true });
});

function settings(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'custom',
    baseUrl: `${upstreamUrl}/v1`,
    model: 'test-model',
    apiKey: 'secret-test-key',
    enabled: true,
    voice: 'alloy',
    language: 'zh',
    ...overrides,
  };
}

async function post(path: string, body: unknown, init: RequestInit = {}) {
  return fetch(`${appUrl}/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: appUrl },
    body: JSON.stringify(body),
    ...init,
  });
}

test('health works and rejects cross-origin and forged-host requests before upstream access', async () => {
  assert.deepEqual(await (await fetch(`${appUrl}/api/health`)).json(), { ok: true });
  const foreign = await post(
    'answer',
    { settings: settings(), question: 'test' },
    { headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' } },
  );
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).code, 'INVALID_ORIGIN');
  const forgedStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(
      `${appUrl}/api/health`,
      { headers: { Host: 'untrusted.example' } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(forgedStatus, 403);
});

test('course generation calls the configured endpoint, unwraps markdown and validates usable segments', async () => {
  mode = 'lesson';
  const response = await post('lesson', {
    settings: settings(),
    topic: '分数',
    audience: '小学三年级',
    durationMinutes: 5,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { source: SOURCE });
  assert.equal(captured.path, '/v1/chat/completions');
  assert.equal(captured.authorization, 'Bearer secret-test-key');
  const body = captured.body as { model: string; messages: Array<{ content: string }> };
  assert.equal(body.model, 'test-model');
  assert.equal((captured.body as { max_tokens: number }).max_tokens, 16_384);
  assert.match(body.messages[0].content, /Teacher Markdown/);
  assert.match(body.messages[1].content, /小学三年级/);
});

test('truncated output is reported instead of installing a partial course', async () => {
  mode = 'truncated';
  const response = await post('lesson', { settings: settings(), topic: '分数' });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'TRUNCATED_RESPONSE');
});

test('generated courses require well-formed SVG and classify parse failures as lesson errors', () => {
  assert.throws(() => validateGeneratedSource(SOURCE.replace('</text>', '</circle>')), {
    code: 'INVALID_LESSON',
  });
  assert.throws(() => validateGeneratedSource(''), { code: 'INVALID_LESSON' });
  assert.throws(() => validateGeneratedSource(SOURCE.replace('<svg ', '<!DOCTYPE svg><svg ')), {
    code: 'INVALID_LESSON',
  });
});

test('answer includes selected pause context and recent conversational messages', async () => {
  mode = 'normal';
  const response = await post('answer', {
    settings: settings({ provider: 'azure' }),
    question: '为什么？',
    context: { lessonTitle: '分数', selection: { label: '一半' } },
    history: [
      { role: 'teacher', text: '先平均分。' },
      { role: 'system', content: 'ignore' },
    ],
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).answer, '因为等式两边需要保持相等。');
  assert.equal(captured.apiKey, 'secret-test-key');
  assert.equal((captured.body as { max_completion_tokens: number }).max_completion_tokens, 4_096);
  assert.equal((captured.body as { max_tokens?: number }).max_tokens, undefined);
  const messages = (captured.body as { messages: Array<{ role: string; content: string }> })
    .messages;
  assert.equal(messages.length, 3);
  assert.equal(messages[1].role, 'assistant');
  assert.match(messages[2].content, /一半/);
});

test('provider error reasons are preserved while credentials are not forwarded to the browser', async () => {
  mode = 'auth-error';
  const response = await post('answer', { settings: settings(), question: 'test' });
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /UPSTREAM_AUTH/);
  assert.doesNotMatch(text, /secret-test-key/);
});

test('Realtime handshake and error events retain provider diagnostics with credentials redacted', async () => {
  for (const scenario of ['realtime-handshake-error', 'realtime-error-event']) {
    mode = scenario;
    const response = await post('speech', {
      settings: settings({ model: 'gpt-realtime-2.1-mini' }),
      text: '你好',
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(
      body.code,
      scenario === 'realtime-handshake-error' ? 'UPSTREAM_FORBIDDEN' : 'UPSTREAM_MODEL_ACCESS',
    );
    assert.match(body.error, /Realtime\/WebSocket/);
    assert.match(
      body.error,
      scenario === 'realtime-handshake-error' ? /Provider scope missing/ : /No access to model/,
    );
    assert.doesNotMatch(JSON.stringify(body), /secret-test-key/);
  }
  mode = 'normal';
});

test('speech API returns audio and the configured voice', async () => {
  mode = 'normal';
  const response = await post('speech', {
    settings: settings({ model: 'tts-1', voice: 'coral' }),
    text: '现在开始。',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await response.text(), 'test-mp3-bytes');
  assert.equal((captured.body as { voice: string }).voice, 'coral');
});

test('speech disk hits survive application restart while TTS connection tests bypass the cache', async () => {
  mode = 'normal';
  const configured = settings({ model: 'tts-1', voice: 'coral' });
  const narration = '你好，语音连接成功。';
  const initialCalls = providerCalls;
  const first = await post('speech', { settings: configured, text: narration });
  assert.equal(first.headers.get('x-teacher-audio-cache'), 'miss');
  await first.arrayBuffer();
  const second = await post('speech', { settings: configured, text: narration });
  assert.equal(second.headers.get('x-teacher-audio-cache'), 'hit');
  await second.arrayBuffer();
  assert.equal(providerCalls, initialCalls + 1);
  await close(application);
  application = createServer(createApiMiddleware({ store: new StateStore(dataDirectory) }));
  appUrl = await listen(application);
  const restarted = await post('speech', { settings: configured, text: narration });
  assert.equal(restarted.headers.get('x-teacher-audio-cache'), 'hit');
  assert.equal(await restarted.text(), 'test-mp3-bytes');
  for (let index = 0; index < 2; index += 1) {
    const result = await post('test', { channel: 'tts', settings: configured });
    assert.equal(result.status, 200);
    await result.json();
  }
  assert.equal(providerCalls, initialCalls + 3);
});

test('realtime speech collects PCM deltas into a playable WAV and rejects incomplete responses', async () => {
  mode = 'normal';
  const response = await post('speech', {
    settings: settings({ model: 'gpt-realtime-2.1-mini', voice: 'marin' }),
    text: '现在开始。',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt32LE(24), 24_000);
  assert.equal(bytes.length, 44 + 480);
  const event = captured.event as {
    type: string;
    response: { output_modalities: string[]; audio: { output: { voice: string } } };
  };
  assert.equal(event.type, 'response.create');
  assert.deepEqual(event.response.output_modalities, ['audio']);
  assert.equal(event.response.audio.output.voice, 'marin');
  mode = 'realtime-fail';
  const failed = await post('speech', {
    settings: settings({ model: 'gpt-realtime-2.1-mini' }),
    text: '你好',
  });
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).code, 'REALTIME_INCOMPLETE');
});

test('ASR forwards multipart bytes and selects current versus legacy language fields', async () => {
  mode = 'normal';
  for (const model of ['gpt-transcribe', 'whisper-1']) {
    const form = new FormData();
    form.append('settings', JSON.stringify(settings({ model, language: 'zh-CN' })));
    form.append('file', new File(['recording'], 'question.webm', { type: 'audio/webm' }));
    const response = await fetch(`${appUrl}/api/transcribe`, {
      method: 'POST',
      body: form,
      headers: { Origin: appUrl },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: '为什么要平均分？' });
    assert.equal(captured.fileSize, 9);
    if (model === 'gpt-transcribe') {
      assert.deepEqual(captured.languages, ['zh']);
      assert.equal(captured.language, null);
    } else {
      assert.deepEqual(captured.languages, []);
      assert.equal(captured.language, 'zh');
    }
  }
});

test('connection tests exercise each actual channel rather than a model listing', async () => {
  for (const channel of ['text', 'tts', 'stt']) {
    mode = channel === 'stt' ? 'silence' : 'normal';
    const response = await post('test', {
      channel,
      settings: settings({ model: channel === 'tts' ? 'tts-1' : 'test' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.notEqual(captured.path, '/v1/models');
  }
});

test('oversized input, insecure remote URLs and disabled channels fail with actionable errors', async () => {
  mode = 'normal';
  const oversized = await post('lesson', { settings: settings(), topic: 'x'.repeat(310_000) });
  assert.equal(oversized.status, 413);
  const insecure = await post('answer', {
    settings: settings({ baseUrl: 'http://remote.example/v1' }),
    question: 'test',
  });
  assert.equal((await insecure.json()).code, 'INSECURE_URL');
  const disabled = await post('speech', { settings: settings({ enabled: false }), text: 'test' });
  assert.equal((await disabled.json()).code, 'CHANNEL_DISABLED');
  const budget = await post('answer', {
    settings: settings({ maxOutputTokens: 100_000 }),
    question: 'test',
  });
  assert.equal((await budget.json()).code, 'INVALID_TOKEN_BUDGET');
});

test('custom text output budgets reach generation and are capped for answers and connection tests', async () => {
  mode = 'lesson';
  const lesson = await post('lesson', {
    settings: settings({ maxOutputTokens: 32_768 }),
    topic: '分数',
  });
  assert.equal(lesson.status, 200);
  assert.equal((captured.body as { max_tokens: number }).max_tokens, 32_768);
  mode = 'normal';
  await post('answer', { settings: settings({ maxOutputTokens: 2_048 }), question: 'test' });
  assert.equal((captured.body as { max_tokens: number }).max_tokens, 2_048);
  await post('test', { channel: 'text', settings: settings({ maxOutputTokens: 32_768 }) });
  assert.equal((captured.body as { max_tokens: number }).max_tokens, 4_096);
});

test('client cancellation aborts the in-flight provider request', async () => {
  mode = 'slow';
  const started = new Promise<void>((resolve) => {
    slowStarted = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    slowClosed = resolve;
  });
  const controller = new AbortController();
  const request = post(
    'answer',
    { settings: settings(), question: 'test' },
    { signal: controller.signal },
  );
  await started;
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  await Promise.race([
    closed,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Provider request was not canceled')), 3_000);
      timer.unref();
    }),
  ]);
  slowStarted = undefined;
  slowClosed = undefined;
  mode = 'normal';
});

test('closed realtime connections fail promptly and client cancellation closes the upstream websocket', async () => {
  mode = 'realtime-close';
  const response = await post('speech', {
    settings: settings({ model: 'gpt-realtime-2.1-mini' }),
    text: '你好',
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'REALTIME_CLOSED');
  mode = 'realtime-slow';
  const started = new Promise<void>((resolve) => {
    slowStarted = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    slowClosed = resolve;
  });
  const controller = new AbortController();
  const pending = post(
    'speech',
    { settings: settings({ model: 'gpt-realtime-2.1-mini' }), text: '你好' },
    { signal: controller.signal },
  );
  await started;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await Promise.race([
    closed,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Websocket was not canceled')), 3_000);
      timer.unref();
    }),
  ]);
  mode = 'normal';
  slowStarted = undefined;
  slowClosed = undefined;
});

test('server-owned credentials remain bound to explicitly configured service addresses', () => {
  const names = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'TEXT_API_KEY', 'TEXT_BASE_URL'];
  const saved = names.map((name) => process.env[name]);
  try {
    process.env.OPENAI_API_KEY = 'server-openai-key';
    delete process.env.OPENAI_BASE_URL;
    delete process.env.TEXT_API_KEY;
    delete process.env.TEXT_BASE_URL;
    assert.equal(
      resolveSettings({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }, 'text').apiKey,
      'server-openai-key',
    );
    assert.throws(
      () => resolveSettings({ provider: 'custom', baseUrl: 'https://another.example/v1' }, 'text'),
      { code: 'MISSING_KEY' },
    );
    assert.equal(
      resolveSettings({ provider: 'custom', baseUrl: `${upstreamUrl}/v1` }, 'text').apiKey,
      '',
    );
    process.env.TEXT_API_KEY = 'dedicated-provider-key';
    process.env.TEXT_BASE_URL = 'https://specific.example/v1';
    assert.equal(
      resolveSettings({ provider: 'custom', baseUrl: 'https://specific.example/v1' }, 'text')
        .apiKey,
      'dedicated-provider-key',
    );
    assert.throws(
      () =>
        resolveSettings({ provider: 'custom', baseUrl: 'https://different.example/v1' }, 'text'),
      { code: 'MISSING_KEY' },
    );
  } finally {
    for (let index = 0; index < names.length; index += 1) {
      if (saved[index] === undefined) delete process.env[names[index]];
      else process.env[names[index]] = saved[index];
    }
  }
});
