const REQUEST_TIMEOUT = 180_000;

export type ApiDiagnostics = {
  upstreamStatus: number;
  endpoint: string;
  model: string;
  requestId?: string;
  contentType?: string;
  providerCode?: string | number;
  providerType?: string;
  providerMessage?: string;
  responseBody?: string;
  truncated?: boolean;
  transport?: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly diagnostics?: ApiDiagnostics;

  constructor(message: string, status = 0, code = 'request_failed', diagnostics?: ApiDiagnostics) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function redactText(value: string, secret?: string): string {
  let text = secret ? value.replaceAll(secret, '[已隐藏]') : value;
  text = text.replace(/\bBearer\s+[^\s"'<>;,}]+/gi, 'Bearer [已隐藏]');
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[已隐藏]');
  text = text.replace(
    /(["']?(?:authorization|api[_-]?key|access[_-]?token|password|secret)["']?\s*[:=]\s*)(["']?)([^\r\n"',}&<>]+)\2/gi,
    '$1[已隐藏]',
  );
  return text;
}

function cleanMessage(value: unknown, secret?: string): string {
  if (typeof value !== 'string') return '';
  let message = value
    .replace(/<[^>]*>/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  message = redactText(message, secret);
  return message.slice(0, 500);
}

function readDiagnostics(value: unknown, secret?: string): ApiDiagnostics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.upstreamStatus !== 'number' || !Number.isInteger(source.upstreamStatus))
    return undefined;
  const text = (name: string, limit = 1000) =>
    typeof source[name] === 'string' ? redactText(source[name], secret).slice(0, limit) : undefined;
  const body = text('responseBody', 16_384);
  return {
    upstreamStatus: source.upstreamStatus,
    endpoint: text('endpoint', 2000) ?? '',
    model: text('model', 160) ?? '',
    requestId: text('requestId', 200),
    contentType: text('contentType', 200),
    providerCode:
      typeof source.providerCode === 'number' ? source.providerCode : text('providerCode', 200),
    providerType: text('providerType', 200),
    providerMessage: text('providerMessage', 4000),
    responseBody: body,
    truncated:
      source.truncated === true ||
      (typeof source.responseBody === 'string' && source.responseBody.length > 16_384),
    transport: text('transport', 100),
  };
}

function bodySecret(body: unknown): string | undefined {
  if (body instanceof FormData) {
    const raw = body.get('settings');
    if (typeof raw !== 'string') return undefined;
    try {
      return bodySecret({ settings: JSON.parse(raw) });
    } catch {
      return undefined;
    }
  }
  if (!body || typeof body !== 'object' || !('settings' in body)) return undefined;
  const settings = body.settings;
  if (!settings || typeof settings !== 'object' || !('apiKey' in settings)) return undefined;
  return typeof settings.apiKey === 'string' ? settings.apiKey : undefined;
}

async function request<T>(
  path: string,
  body: unknown,
  decode: (response: Response) => Promise<T>,
  signal?: AbortSignal,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'POST',
): Promise<T> {
  if (!path.startsWith('/api/')) throw new ApiError('无效的服务请求地址。');
  if (signal?.aborted) throw new DOMException('请求已取消。', 'AbortError');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT);
  const multipart = body instanceof FormData;
  try {
    const response = await fetch(path, {
      method,
      headers: multipart || method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : multipart ? body : JSON.stringify(body),
      signal: controller.signal,
      credentials: 'same-origin',
      redirect: 'error',
    });
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        // Errors from this server are JSON. Provider bodies live in bounded diagnostics.
      }
      const data = payload && typeof payload === 'object' ? payload : {};
      const error = 'error' in data ? data.error : undefined;
      const candidate =
        typeof error === 'string'
          ? error
          : error && typeof error === 'object' && 'message' in error
            ? error.message
            : 'message' in data
              ? data.message
              : undefined;
      const secret = bodySecret(body);
      const code =
        'code' in data && typeof data.code === 'string'
          ? redactText(data.code, secret).slice(0, 160)
          : 'request_failed';
      throw new ApiError(
        cleanMessage(candidate, secret) ||
          `服务请求失败（${response.status}），请检查接口配置后重试。`,
        response.status,
        code,
        readDiagnostics('diagnostics' in data ? data.diagnostics : undefined, secret),
      );
    }
    return await decode(response);
  } catch (error) {
    if (timedOut) throw new ApiError('请求超时，请检查服务连接后重试。', 0, 'timeout');
    if (signal?.aborted || isAbortError(error))
      throw new DOMException('请求已取消。', 'AbortError');
    if (error instanceof ApiError) throw error;
    throw new ApiError('暂时无法连接课堂服务，请确认服务正在运行后重试。', 0, 'network_error');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function apiJson<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'POST',
): Promise<T> {
  return request(
    path,
    body,
    async (response) => {
      try {
        return (await response.json()) as T;
      } catch {
        throw new ApiError(
          '服务返回了无效的数据，请检查接口配置。',
          response.status,
          'invalid_response',
        );
      }
    },
    signal,
    method,
  );
}

export function apiAudio(path: string, body: unknown, signal?: AbortSignal): Promise<Blob> {
  return request(
    path,
    body,
    async (response) => {
      const type = response.headers.get('Content-Type')?.split(';')[0] ?? '';
      if (type && !type.startsWith('audio/') && type !== 'application/octet-stream')
        throw new ApiError('语音服务没有返回音频，请检查 TTS 模型与接口地址。');
      const blob = await response.blob();
      if (!blob.size) throw new ApiError('语音服务返回了空音频，请重试。');
      if (blob.size > 32 * 1024 * 1024) throw new ApiError('这段音频过大，请缩短讲解片段后重试。');
      return blob;
    },
    signal,
  );
}
