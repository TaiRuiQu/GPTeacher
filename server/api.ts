import type { IncomingMessage, ServerResponse } from 'node:http';
import { SaxesParser } from 'saxes';
import { parseLesson } from '../src/lib/lesson.ts';
import { ApiError } from './errors.ts';
import { cachedSpeech } from './speech-cache.ts';
import { createPlatformMiddleware } from './platform-api.ts';
import { ANSWER_INSTRUCTIONS, LESSON_FORMAT } from './prompts.ts';
import { getStateStore, STATE_BODY_LIMIT, type StateStore } from './storage.ts';
import {
  chat,
  inputText,
  pcmWave,
  record,
  resolveSettings,
  speech,
  transcribe,
  type Channel,
} from './providers.ts';

const JSON_LIMIT = 300_000;
const AUDIO_LIMIT = 24_000_000;
const MAX_ACTIVE = 8;

function json(res: ServerResponse, status: number, data: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function verifyOrigin(req: IncomingMessage) {
  const host = req.headers.host;
  if (!host) throw new ApiError(403, 'INVALID_HOST', '请求来源不受支持。');
  let expected: URL;
  try {
    expected = new URL(`http://${host}`);
  } catch {
    throw new ApiError(403, 'INVALID_HOST', '请求来源不受支持。');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname))
    throw new ApiError(403, 'INVALID_HOST', '本地课堂服务仅接受 localhost 或本机地址访问。');
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).origin !== expected.origin) throw new Error('Different origin');
    } catch {
      throw new ApiError(403, 'INVALID_ORIGIN', '为保护模型凭据，已拒绝其他网页发起的请求。');
    }
  }
  if (req.headers['sec-fetch-site'] === 'cross-site')
    throw new ApiError(403, 'INVALID_ORIGIN', '为保护模型凭据，已拒绝其他网页发起的请求。');
}

function readBody(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) {
    req.resume();
    throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大，请缩短文本或上传较小的录音。');
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', data);
      req.off('end', end);
      req.off('error', error);
      signal.removeEventListener('abort', abort);
    };
    const error = (reason: unknown) => {
      cleanup();
      reject(reason);
    };
    const abort = () => {
      cleanup();
      req.resume();
      reject(signal.reason);
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        error(new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大，请缩短文本或上传较小的录音。'));
        req.resume();
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    req.on('data', data);
    req.on('end', end);
    req.on('error', error);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function contextText(value: unknown) {
  const text = JSON.stringify(record(value));
  if (text.length > 100_000)
    throw new ApiError(400, 'CONTEXT_TOO_LONG', '暂停上下文过长，请缩短讲稿后重试。');
  return text;
}

/** Accept a model's outer markdown fence, but never pass partial lessons to the player. */
export function validateGeneratedSource(text: string): string {
  let source = text.trim();
  const outerFence = source.match(/^(`{3,}|~{3,})(?:markdown|md|text)?\s*\n([\s\S]*?)\n\1\s*$/i);
  if (outerFence) source = outerFence[2].trim();
  let lesson;
  try {
    lesson = parseLesson(source);
  } catch {
    throw new ApiError(502, 'INVALID_LESSON', '模型返回的课程无法读取，请重试或缩短课程目标。');
  }
  if (
    !/^#\s+\S/m.test(source) ||
    lesson.steps.length < 2 ||
    lesson.warnings.length ||
    lesson.steps.some((step) => !step.narration || !validSvg(step.svg))
  )
    throw new ApiError(
      502,
      'INVALID_LESSON',
      '模型返回的课程不完整，需要包含标题、至少两个讲解片段及各段完整 SVG。请重试或换用更擅长长文本的模型。',
    );
  return source;
}

function validSvg(svg: string): boolean {
  if (!svg || /<!DOCTYPE|<!ENTITY/i.test(svg)) return false;
  let rootSeen = false;
  let valid = true;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('error', () => {
    valid = false;
  });
  parser.on('opentag', (tag) => {
    if (!rootSeen) {
      rootSeen = true;
      if (tag.local !== 'svg' || (tag.uri && tag.uri !== 'http://www.w3.org/2000/svg'))
        valid = false;
    }
  });
  try {
    parser.write(svg).close();
  } catch {
    valid = false;
  }
  return rootSeen && valid;
}

async function handleJson(
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  store: StateStore,
) {
  const configured = (raw: unknown, channel: Channel) =>
    resolveSettings(store.resolveChannel(raw, channel), channel);
  if (path === '/api/speech') {
    const settings = configured(body.settings, 'tts');
    const text = inputText(body.text, '朗读文本', 4_000);
    return { audio: await cachedSpeech(settings, text, signal, store.directory) };
  }
  if (path === '/api/test') {
    const channel = body.channel;
    if (channel !== 'text' && channel !== 'tts' && channel !== 'stt')
      throw new ApiError(400, 'INVALID_CHANNEL', '请选择有效的模型通道。');
    const settings = configured(body.settings, channel);
    if (channel === 'text')
      await chat(
        settings,
        [{ role: 'user', content: '这是连接测试，请只回复“连接成功”。' }],
        signal,
        4_096,
      );
    else if (channel === 'tts') await speech(settings, '你好，语音连接成功。', signal);
    else {
      const wave = pcmWave(Buffer.alloc(16_000 * 2), 16_000);
      await transcribe(
        settings,
        new File([new Uint8Array(wave)], 'connection-test.wav', { type: 'audio/wav' }),
        signal,
      );
    }
    return {
      data: {
        ok: true,
        message:
          channel === 'stt'
            ? '转写接口已接受测试音频。实际识别效果请用麦克风录音测试。'
            : `${channel === 'text' ? '教学模型' : '语音合成'}连接成功。`,
      },
    };
  }
  const settings = configured(body.settings, 'text');
  if (path === '/api/lesson') {
    const topic = inputText(body.topic, '课程主题', 1_000);
    const audience = inputText(body.audience, '学习基础', 500, true) || '初学者';
    const duration = body.durationMinutes === undefined ? 8 : Number(body.durationMinutes);
    if (!Number.isFinite(duration) || duration < 1 || duration > 30)
      throw new ApiError(400, 'INVALID_DURATION', '课程时长需要在 1 到 30 分钟之间。');
    const source = await chat(
      settings,
      [
        { role: 'system', content: LESSON_FORMAT },
        {
          role: 'user',
          content: `请围绕以下学习需求生成一节完整课程。\n主题：${topic}\n学习基础：${audience}\n目标总时长约 ${duration} 分钟。围绕一个适合此时长的具体目标，不要铺开成整本教材。`,
        },
      ],
      signal,
    );
    return { data: { source: validateGeneratedSource(source) } };
  }
  const question = inputText(body.question, '问题', 4_000);
  const context = contextText(body.context);
  if (path === '/api/supplement') {
    const source = await chat(
      settings,
      [
        {
          role: 'system',
          content: `${LESSON_FORMAT}\n这是暂停后的补讲分支，输出 2-4 段，换一种表示或例子直接解决这个问题，不重讲整堂课。`,
        },
        { role: 'user', content: `学生的问题：${question}\n暂停上下文：${context}` },
      ],
      signal,
    );
    return { data: { source: validateGeneratedSource(source) } };
  }
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: ANSWER_INSTRUCTIONS },
  ];
  if (Array.isArray(body.history)) {
    for (const item of body.history.slice(-12)) {
      const message = record(item);
      if (!['user', 'assistant', 'teacher'].includes(String(message.role))) continue;
      const content =
        typeof message.content === 'string'
          ? message.content
          : typeof message.text === 'string'
            ? message.text
            : '';
      if (content)
        messages.push({
          role: message.role === 'user' ? 'user' : 'assistant',
          content: content.slice(0, 8_000),
        });
    }
  }
  messages.push({ role: 'user', content: `暂停上下文：${context}\n\n学生的问题：${question}` });
  return { data: { answer: await chat(settings, messages, signal, 4_096) } };
}

const POST_PATHS = new Set([
  '/api/lesson',
  '/api/answer',
  '/api/supplement',
  '/api/speech',
  '/api/transcribe',
  '/api/test',
]);

const STATE_METHODS: Record<string, string> = {
  '/api/state': 'GET',
  '/api/workspace': 'PUT',
  '/api/settings': 'PUT',
  '/api/settings/keys': 'DELETE',
  '/api/import': 'POST',
};

export function createApiMiddleware(options: { store?: StateStore } = {}) {
  let active = 0;
  const platform = createPlatformMiddleware({ directory: options.store?.directory });
  const storage = () => options.store ?? getStateStore();
  const middleware = (req: IncomingMessage, res: ServerResponse, next?: () => void) => {
    if (platform(req, res)) return;
    const path = (req.url || '/').split('?')[0];
    if (!path.startsWith('/api/')) {
      if (next) next();
      else json(res, 404, { error: '未找到此接口。', code: 'NOT_FOUND' });
      return;
    }
    void (async () => {
      let counted = false;
      const controller = new AbortController();
      const disconnect = () => {
        if (!res.writableEnded)
          controller.abort(new DOMException('Client disconnected', 'AbortError'));
      };
      req.on('aborted', disconnect);
      res.on('close', disconnect);
      const timer = setTimeout(
        () => controller.abort(new DOMException('Request timeout', 'TimeoutError')),
        180_000,
      );
      timer.unref();
      try {
        verifyOrigin(req);
        if (path === '/api/health' && req.method === 'GET') {
          json(res, 200, { ok: true });
          return;
        }
        const stateMethod = STATE_METHODS[path];
        if (!POST_PATHS.has(path) && !stateMethod)
          throw new ApiError(404, 'NOT_FOUND', '未找到此接口。');
        const expectedMethod = stateMethod || 'POST';
        if (req.method !== expectedMethod) {
          res.setHeader('Allow', expectedMethod);
          throw new ApiError(405, 'METHOD_NOT_ALLOWED', `此接口需要 ${expectedMethod} 请求。`);
        }
        if (path === '/api/state') {
          await storage().flush();
          json(res, 200, storage().getState());
          return;
        }
        if (path === '/api/settings/keys') {
          json(res, 200, { settings: await storage().clearKeys() });
          return;
        }
        if (active >= MAX_ACTIVE)
          throw new ApiError(429, 'BUSY', '当前任务较多，请等待现有任务完成后重试。');
        active += 1;
        counted = true;
        if (path === '/api/transcribe') {
          const contentType = req.headers['content-type'] || '';
          if (!contentType.startsWith('multipart/form-data;'))
            throw new ApiError(415, 'INVALID_CONTENT_TYPE', '语音识别需要上传音频文件。');
          const bytes = await readBody(req, AUDIO_LIMIT + 100_000, controller.signal);
          let form: FormData;
          try {
            form = await new Request('http://localhost/upload', {
              method: 'POST',
              headers: { 'Content-Type': contentType },
              body: new Uint8Array(bytes),
            }).formData();
          } catch {
            throw new ApiError(400, 'INVALID_FORM', '无法读取上传的录音，请重新录制。');
          }
          const settingsText = form.get('settings');
          let rawSettings: unknown;
          try {
            rawSettings = JSON.parse(typeof settingsText === 'string' ? settingsText : '{}');
          } catch {
            throw new ApiError(400, 'INVALID_CONFIG', '语音识别配置无法读取。');
          }
          const file = form.get('file');
          if (!(file instanceof File) || !file.size || file.size > AUDIO_LIMIT)
            throw new ApiError(400, 'INVALID_AUDIO_FILE', '请上传非空且小于 24 MB 的录音。');
          if (
            !/^(?:audio\/|video\/(?:webm|mp4))/.test(file.type) &&
            !/\.(?:webm|mp3|mp4|m4a|wav|ogg|flac|mpeg|mpga)$/i.test(file.name)
          )
            throw new ApiError(
              400,
              'INVALID_AUDIO_FILE',
              '请上传 WebM、MP3、MP4、M4A、WAV、OGG 或 FLAC 录音。',
            );
          const text = await transcribe(
            resolveSettings(storage().resolveChannel(rawSettings, 'stt'), 'stt'),
            file,
            controller.signal,
          );
          json(res, 200, { text });
          return;
        }
        if (!req.headers['content-type']?.startsWith('application/json'))
          throw new ApiError(415, 'INVALID_CONTENT_TYPE', '请求需要使用 JSON 格式。');
        const bytes = await readBody(
          req,
          stateMethod ? STATE_BODY_LIMIT : JSON_LIMIT,
          controller.signal,
        );
        let body: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(bytes.toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('Invalid body');
          body = record(parsed);
        } catch {
          throw new ApiError(400, 'INVALID_JSON', '请求数据无法读取，请重试。');
        }
        if (path === '/api/workspace') {
          await storage().saveWorkspace(body.workspace);
          json(res, 200, { ok: true });
          return;
        }
        if (path === '/api/settings') {
          if (body.clearApiKeys !== undefined && typeof body.clearApiKeys !== 'boolean')
            throw new ApiError(400, 'INVALID_SETTINGS', '清除密钥开关格式无效。');
          json(res, 200, {
            settings: await storage().saveSettings(body.settings, body.clearApiKeys === true),
          });
          return;
        }
        if (path === '/api/import') {
          json(res, 200, await storage().importOnce(body));
          return;
        }
        const result = await handleJson(path, body, controller.signal, storage());
        if ('audio' in result && result.audio) {
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, {
            'Content-Type': result.audio.contentType,
            'Content-Length': result.audio.bytes.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...('cacheStatus' in result.audio
              ? { 'X-Teacher-Audio-Cache': result.audio.cacheStatus }
              : {}),
          });
          res.end(result.audio.bytes);
        } else json(res, 200, result.data);
      } catch (error) {
        if (controller.signal.aborted) {
          if (controller.signal.reason?.name === 'TimeoutError')
            json(res, 504, { error: '模型服务响应超时，请稍后重试或缩短课程。', code: 'TIMEOUT' });
        } else if (error instanceof ApiError)
          json(res, error.status, {
            error: error.message,
            code: error.code,
            ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
          });
        else
          json(res, 502, {
            error: '无法连接模型服务，请检查服务地址和网络后重试。',
            code: 'CONNECTION_ERROR',
          });
      } finally {
        if (counted) active -= 1;
        clearTimeout(timer);
        req.off('aborted', disconnect);
        res.off('close', disconnect);
      }
    })();
  };
  return Object.assign(middleware, { close: () => platform.close() });
}

export type { Channel };
