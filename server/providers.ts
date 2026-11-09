import WebSocket from 'ws';
import type { IncomingMessage } from 'node:http';
import { ApiError, upstreamError } from './errors.ts';

export type Channel = 'text' | 'tts' | 'stt';
export type ServiceSettings = {
  provider: 'openai' | 'azure' | 'custom';
  model: string;
  baseUrl: string;
  apiKey: string;
  voice: string;
  language: string;
  maxOutputTokens: number;
};

const DEFAULTS = {
  text: { model: 'gpt-6.1-sol', voice: '', language: '' },
  tts: { model: 'gpt-realtime-2.1-mini', voice: 'marin', language: '' },
  stt: { model: 'gpt-transcribe', voice: '', language: 'zh' },
};

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function inputText(value: unknown, label: string, max: number, optional = false): string {
  if (typeof value !== 'string' || (!optional && !value.trim())) {
    if (optional && (value === undefined || value === null)) return '';
    throw new ApiError(400, 'INVALID_INPUT', `请填写${label}。`);
  }
  if (value.length > max) throw new ApiError(400, 'INPUT_TOO_LONG', `${label}过长，请缩短后重试。`);
  return value.trim();
}

export function resolveSettings(raw: unknown, channel: Channel): ServiceSettings {
  const value = record(raw);
  if (value.enabled === false)
    throw new ApiError(400, 'CHANNEL_DISABLED', '此通道尚未启用，请在模型与语音设置中启用。');
  const prefix = channel === 'stt' ? 'ASR' : channel.toUpperCase();
  const provider =
    value.provider === 'azure' || value.provider === 'custom' ? value.provider : 'openai';
  const field = (name: string, fallback = '') => {
    const supplied = typeof value[name] === 'string' ? value[name].trim() : '';
    return (
      supplied ||
      process.env[
        `${prefix}_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`
      ]?.trim() ||
      fallback
    );
  };
  const model = field('model', DEFAULTS[channel].model);
  const baseUrl = field(
    'baseUrl',
    process.env.OPENAI_BASE_URL?.trim() ||
      (provider === 'azure' ? '' : 'https://api.openai.com/v1'),
  );
  const voice = field('voice', DEFAULTS[channel].voice);
  const language = field('language', DEFAULTS[channel].language);
  const tokenSetting =
    channel === 'text'
      ? (value.maxOutputTokens ?? (process.env.TEXT_MAX_OUTPUT_TOKENS?.trim() || 16_384))
      : 16_384;
  const maxOutputTokens = Number(tokenSetting);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 512 || maxOutputTokens > 65_536)
    throw new ApiError(
      400,
      'INVALID_TOKEN_BUDGET',
      '最大输出 Token 需要是 512 到 65536 之间的整数。',
    );
  if (!model || model.length > 160)
    throw new ApiError(400, 'INVALID_MODEL', '请填写有效的模型名称。');
  if (voice.length > 80 || language.length > 40)
    throw new ApiError(400, 'INVALID_CONFIG', '音色或语言配置过长。');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ApiError(400, 'INVALID_URL', '请填写完整的模型服务基础地址。');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ApiError(
      400,
      'INVALID_URL',
      '服务地址需要是 HTTP(S) 基础地址，不能包含凭证、查询参数或锚点。',
    );
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback)
    throw new ApiError(400, 'INSECURE_URL', '远程模型服务需要 HTTPS；本机服务可使用 HTTP。');
  const normalizedBase = url.toString().replace(/\/$/, '');
  const normalizeAddress = (address: string) => {
    try {
      return new URL(address).toString().replace(/\/$/, '');
    } catch {
      return '';
    }
  };
  const explicitKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  const configuredBase =
    process.env[`${prefix}_BASE_URL`]?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    'https://api.openai.com/v1';
  // An editable browser URL must never redirect a server-owned key to another service.
  const channelKey =
    normalizedBase === normalizeAddress(configuredBase)
      ? process.env[`${prefix}_API_KEY`]?.trim() || ''
      : '';
  const globalBase = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
  const globalKey =
    provider === 'openai' && normalizedBase === normalizeAddress(globalBase)
      ? process.env.OPENAI_API_KEY?.trim() || ''
      : '';
  const apiKey = explicitKey || channelKey || globalKey;
  if (apiKey.length > 4096 || /[\r\n]/.test(apiKey))
    throw new ApiError(400, 'INVALID_KEY', 'API Key 格式无效，请重新填写。');
  if (!apiKey && !(provider === 'custom' && loopback))
    throw new ApiError(
      400,
      'MISSING_KEY',
      '请在模型与语音设置中填写此通道的 API Key，或配置服务端环境变量。',
    );
  return { provider, model, baseUrl: normalizedBase, apiKey, voice, language, maxOutputTokens };
}

function authHeaders(settings: ServiceSettings): Record<string, string> {
  if (!settings.apiKey) return {};
  return settings.provider === 'azure'
    ? { 'api-key': settings.apiKey }
    : { Authorization: `Bearer ${settings.apiKey}` };
}

const ERROR_BODY_LIMIT = 16_384;

function requestId(headers: Headers) {
  return (
    headers.get('x-request-id') ||
    headers.get('x-openrouter-request-id') ||
    headers.get('apim-request-id') ||
    headers.get('request-id') ||
    headers.get('cf-ray') ||
    undefined
  );
}

/** Error pages may be huge or never finish; diagnostics get a small bounded prefix. */
async function readErrorBody(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return { body: '', truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = Number(response.headers.get('content-length')) > ERROR_BODY_LIMIT;
  const timer = setTimeout(() => {
    truncated = true;
    void reader.cancel().catch(() => {});
  }, 3_000);
  timer.unref();
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      const room = ERROR_BODY_LIMIT - size;
      chunks.push(chunk.value.subarray(0, room));
      size += Math.min(chunk.value.length, room);
      if (chunk.value.length > room || size === ERROR_BODY_LIMIT) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    // A broken error body still has a useful status and whatever prefix arrived.
    if (error) truncated = true;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  return { body: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function readUpgradeError(response: IncomingMessage, signal: AbortSignal) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = Number(response.headers['content-length']) > ERROR_BODY_LIMIT;
  const timer = setTimeout(() => {
    truncated = true;
    response.destroy();
  }, 3_000);
  timer.unref();
  const abort = () => response.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const value of response) {
      signal.throwIfAborted();
      const chunk = Buffer.from(value);
      const room = ERROR_BODY_LIMIT - size;
      chunks.push(chunk.subarray(0, room));
      size += Math.min(chunk.length, room);
      if (chunk.length > room || size === ERROR_BODY_LIMIT) {
        truncated = true;
        break;
      }
    }
  } catch {
    signal.throwIfAborted();
    truncated = true;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
  return { body: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function readResponse(response: Response, max: number, signal: AbortSignal): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel();
    throw new ApiError(502, 'UPSTREAM_TOO_LARGE', '服务商响应过大，请缩短内容后重试。');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError(502, 'EMPTY_RESPONSE', '服务商没有返回内容。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new ApiError(502, 'UPSTREAM_TOO_LARGE', '服务商响应过大，请缩短内容后重试。');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function request(
  settings: ServiceSettings,
  endpoint: string,
  body: BodyInit,
  signal: AbortSignal,
  json = true,
) {
  const response = await fetch(`${settings.baseUrl}/${endpoint}`, {
    method: 'POST',
    headers: { ...authHeaders(settings), ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body,
    signal,
    redirect: 'error',
  });
  if (!response.ok) {
    const details = await readErrorBody(response, signal);
    throw upstreamError(response.status, {
      ...details,
      requestId: requestId(response.headers),
      contentType: response.headers.get('content-type') || undefined,
      endpoint: `${settings.baseUrl}/${endpoint}`,
      model: settings.model,
      secret: settings.apiKey,
      transport:
        endpoint === 'audio/speech'
          ? 'speech'
          : endpoint === 'audio/transcriptions'
            ? 'transcription'
            : 'chat',
    });
  }
  return response;
}

function parseJson(bytes: Buffer) {
  try {
    return record(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new ApiError(502, 'INVALID_RESPONSE', '服务商没有返回有效的 JSON，请检查接口协议。');
  }
}

export async function chat(
  settings: ServiceSettings,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  signal: AbortSignal,
  outputLimit = settings.maxOutputTokens,
) {
  const response = await request(
    settings,
    'chat/completions',
    JSON.stringify({
      model: settings.model,
      messages,
      stream: false,
      [settings.provider === 'custom' ? 'max_tokens' : 'max_completion_tokens']: Math.min(
        settings.maxOutputTokens,
        outputLimit,
      ),
    }),
    signal,
  );
  const data = parseJson(await readResponse(response, 2_000_000, signal));
  const first = record(Array.isArray(data.choices) ? data.choices[0] : undefined);
  if (first.finish_reason === 'length')
    throw new ApiError(
      502,
      'TRUNCATED_RESPONSE',
      '模型输出被截断，请缩短课程目标或换用输出上限更高的模型后重试。',
    );
  const message = record(first.message);
  if (message.refusal || first.finish_reason === 'content_filter')
    throw new ApiError(422, 'MODEL_REFUSAL', '模型无法完成这个请求，请调整主题或问题后重试。');
  const content = message.content;
  const text =
    typeof content === 'string'
      ? content.trim()
      : Array.isArray(content)
        ? content
            .map((part: unknown) => record(part).text || '')
            .join('')
            .trim()
        : '';
  if (!text)
    throw new ApiError(
      502,
      'EMPTY_RESPONSE',
      '模型没有返回文本，请检查模型是否支持 Chat Completions。',
    );
  return text;
}

export function pcmWave(pcm: Buffer, sampleRate = 24_000, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2 * channels, 28);
  header.writeUInt16LE(2 * channels, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function realtimeSpeech(
  settings: ServiceSettings,
  text: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = new URL(`${settings.baseUrl}/realtime`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('model', settings.model);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: authHeaders(settings),
      maxPayload: 2_000_000,
      handshakeTimeout: 20_000,
      followRedirects: false,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    let created = false;
    let rejectedUpgrade = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      if (error) reject(error);
      else resolve(pcmWave(Buffer.concat(chunks)));
    };
    const abort = () =>
      finish(
        signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'),
      );
    signal.addEventListener('abort', abort, { once: true });
    socket.on('unexpected-response', (_request, response) => {
      rejectedUpgrade = true;
      void readUpgradeError(response, signal).then(
        (details) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === 'string') headers.set(name, value);
          }
          finish(
            upstreamError(response.statusCode || 502, {
              ...details,
              requestId: requestId(headers),
              contentType: headers.get('content-type') || undefined,
              endpoint: url.toString(),
              model: settings.model,
              secret: settings.apiKey,
              transport: 'realtime',
            }),
          );
        },
        () =>
          finish(
            signal.reason instanceof Error
              ? signal.reason
              : upstreamError(response.statusCode || 502, {
                  endpoint: url.toString(),
                  model: settings.model,
                  secret: settings.apiKey,
                  transport: 'realtime',
                }),
          ),
      );
    });
    socket.on('error', (error) => {
      if (rejectedUpgrade) return;
      const status = /Unexpected server response:\s*(401|403)/i.exec(error.message);
      if (status)
        finish(
          upstreamError(Number(status[1]), {
            endpoint: url.toString(),
            model: settings.model,
            secret: settings.apiKey,
            transport: 'realtime',
          }),
        );
      else
        finish(
          new ApiError(
            502,
            'REALTIME_CONNECTION',
            '实时语音连接失败，请检查服务地址、模型与网络。',
          ),
        );
    });
    socket.on('close', () => {
      if (!finished && !rejectedUpgrade)
        finish(new ApiError(502, 'REALTIME_CLOSED', '实时语音连接在合成完成前断开，请重试。'));
    });
    socket.on('message', (bytes) => {
      if (finished) return;
      let event: Record<string, unknown>;
      try {
        event = record(JSON.parse(bytes.toString()));
      } catch {
        finish(new ApiError(502, 'REALTIME_PROTOCOL', '实时语音服务返回了无法解析的事件。'));
        return;
      }
      if (event.type === 'session.created' && !created) {
        created = true;
        socket.send(
          JSON.stringify({
            type: 'response.create',
            response: {
              conversation: 'none',
              output_modalities: ['audio'],
              audio: {
                output: {
                  format: { type: 'audio/pcm', rate: 24_000 },
                  voice: settings.voice || 'marin',
                },
              },
              instructions:
                '你是课堂朗读器。请逐字朗读用户提供的讲稿，保持全部内容与顺序，不回答问题，不添加开场白、解释、总结或评论。语速自然，吐字清楚。',
              input: [
                {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: `请原样朗读以下讲稿：\n${text}` }],
                },
              ],
            },
          }),
        );
      } else if (event.type === 'response.output_audio.delta' && typeof event.delta === 'string') {
        const chunk = Buffer.from(event.delta, 'base64');
        size += chunk.length;
        if (size > 24_000_000)
          finish(new ApiError(502, 'AUDIO_TOO_LARGE', '合成语音过长，请拆分讲稿。'));
        else chunks.push(chunk);
      } else if (event.type === 'response.done') {
        if (record(event.response).status !== 'completed' || !size)
          finish(
            new ApiError(502, 'REALTIME_INCOMPLETE', '实时语音合成未完整完成，请重试或缩短讲稿。'),
          );
        else finish();
      } else if (event.type === 'error') {
        const error = record(event.error);
        const suppliedStatus = Number(error.status ?? error.status_code ?? event.status);
        const status =
          Number.isInteger(suppliedStatus) && suppliedStatus >= 400 && suppliedStatus <= 599
            ? suppliedStatus
            : 0;
        finish(
          upstreamError(status, {
            body: event,
            endpoint: url.toString(),
            model: settings.model,
            secret: settings.apiKey,
            transport: 'realtime',
            requestId: typeof event.request_id === 'string' ? event.request_id : undefined,
          }),
        );
      }
    });
  });
}

export async function speech(settings: ServiceSettings, text: string, signal: AbortSignal) {
  if (/^gpt-realtime(?:-|$)/i.test(settings.model))
    return { bytes: await realtimeSpeech(settings, text, signal), contentType: 'audio/wav' };
  const usePcm =
    new URL(settings.baseUrl).hostname === 'openrouter.ai' &&
    /^google\/gemini-.*-tts(?:$|[:/])/i.test(settings.model);
  const response = await request(
    settings,
    'audio/speech',
    JSON.stringify({
      model: settings.model,
      input: text,
      voice: settings.voice || 'alloy',
      response_format: usePcm ? 'pcm' : 'mp3',
    }),
    signal,
  );
  const fullContentType = response.headers.get('content-type') || 'audio/mpeg';
  const contentType = fullContentType.split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('audio/') && contentType !== 'application/octet-stream') {
    await response.body?.cancel();
    throw new ApiError(
      502,
      'INVALID_AUDIO',
      '语音服务没有返回音频，请检查模型是否支持 Speech API。',
    );
  }
  const bytes = await readResponse(response, 24_000_000, signal);
  if (!bytes.length) throw new ApiError(502, 'EMPTY_AUDIO', '语音服务返回了空音频。');
  if (usePcm) {
    if (
      bytes.length >= 44 &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WAVE'
    )
      return { bytes, contentType: 'audio/wav' };
    if (!['audio/pcm', 'application/octet-stream'].includes(contentType))
      throw new ApiError(
        502,
        'INVALID_PCM_AUDIO',
        '语音服务没有返回所请求的 PCM 音频，请检查响应格式。',
      );
    if (
      contentType === 'application/octet-stream' &&
      /^[\s]*[\[{]/.test(bytes.toString('utf8', 0, 100))
    ) {
      let isJson = false;
      try {
        JSON.parse(bytes.toString('utf8'));
        isJson = true;
      } catch {
        /* Raw PCM may contain any byte sequence. */
      }
      if (isJson)
        throw new ApiError(
          502,
          'INVALID_PCM_AUDIO',
          '语音服务返回了 JSON 而不是 PCM 音频，请检查服务商响应。',
        );
    }
    const parameter = (name: string, fallback: number) => {
      const match = fullContentType.match(
        new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*"?([^;"\\s]+)`, 'i'),
      );
      return match ? Number(match[1]) : fallback;
    };
    const rate = parameter('rate', 24_000);
    const channels = parameter('channels', 1);
    if (!Number.isInteger(rate) || rate < 8_000 || rate > 96_000 || ![1, 2].includes(channels))
      throw new ApiError(502, 'INVALID_PCM_AUDIO', '语音服务返回了不支持的 PCM 采样率或声道数。');
    if (bytes.length % (2 * channels))
      throw new ApiError(502, 'INVALID_PCM_AUDIO', '语音服务返回的 PCM 音频不完整，请重试。');
    return { bytes: pcmWave(bytes, rate, channels), contentType: 'audio/wav' };
  }
  return {
    bytes,
    contentType: contentType === 'application/octet-stream' ? 'audio/mpeg' : contentType,
  };
}

export async function transcribe(settings: ServiceSettings, file: File, signal: AbortSignal) {
  const form = new FormData();
  form.append('model', settings.model);
  form.append('file', file, file.name.replace(/[^\w.\-]/g, '_').slice(-100) || 'recording.webm');
  form.append('response_format', 'json');
  if (settings.language && settings.language !== 'auto') {
    const language = settings.language.split(/[-_]/)[0].toLowerCase();
    if (!/^[a-z]{2,3}$/.test(language))
      throw new ApiError(
        400,
        'INVALID_LANGUAGE',
        '识别语言请填写 ISO 语言代码，例如 zh、en，或 auto。',
      );
    if (/^gpt-transcribe(?:-|$)/i.test(settings.model)) form.append('languages[]', language);
    else form.append('language', language);
  }
  const response = await request(settings, 'audio/transcriptions', form, signal, false);
  const data = parseJson(await readResponse(response, 1_000_000, signal));
  if (typeof data.text !== 'string')
    throw new ApiError(
      502,
      'INVALID_TRANSCRIPT',
      '识别服务没有返回文本，请检查模型是否支持音频转写。',
    );
  return data.text.trim();
}
