export class ApiError extends Error {
  status: number;
  code: string;
  diagnostics?: UpstreamDiagnostics;

  constructor(status: number, code: string, message: string, diagnostics?: UpstreamDiagnostics) {
    super(message);
    this.status = status;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export type UpstreamDiagnostics = {
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

type ErrorTransport = 'chat' | 'speech' | 'transcription' | 'realtime';
type ErrorContext = {
  body?: unknown;
  contentType?: string;
  requestId?: string;
  secret?: string;
  transport?: ErrorTransport;
  endpoint?: string;
  model?: string;
  truncated?: boolean;
};

const KNOWN_CODES = new Map([
  ['unsupported_country_region_territory', 'region'],
  ['country_not_supported', 'region'],
  ['region_not_supported', 'region'],
  ['invalid_api_key', 'auth'],
  ['invalid_authentication', 'auth'],
  ['authentication_error', 'auth'],
  ['permission_denied', 'permission'],
  ['permission_error', 'permission'],
  ['insufficient_permissions', 'permission'],
  ['access_denied', 'permission'],
  ['model_not_found', 'model'],
  ['model_not_allowed', 'model'],
  ['model_access_denied', 'model'],
  ['insufficient_quota', 'quota'],
  ['billing_hard_limit_reached', 'quota'],
  ['billing_not_active', 'quota'],
  ['quota_exceeded', 'quota'],
  ['rate_limit_exceeded', 'rate'],
  ['rate_limit_error', 'rate'],
  ['ip_not_allowed', 'ip'],
  ['ip_access_denied', 'ip'],
  ['ip_forbidden', 'ip'],
  ['invalid_request_error', 'config'],
  ['unsupported_parameter', 'config'],
  ['invalid_value', 'config'],
]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function redactDiagnostics(value: string, secret?: string): string {
  let text = secret ? value.replaceAll(secret, '[已隐藏]') : value;
  text = text.replace(/\bBearer\s+[^\s"'<>;,]+/gi, 'Bearer [已隐藏]');
  text = text.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[已隐藏]');
  text = text.replace(
    /((?:api[_-]?key|apikey|password|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)(?:\\?["'])?\s*[:=]\s*)(?:\\?"(?:(?!\\?").)*\\?"|\\?'(?:(?!\\?').)*\\?'|[^\s&,;<>]+)/gi,
    '$1"[已隐藏]"',
  );
  text = text.replace(
    /((?:api(?:_|%5f|-)?key|password|access(?:_|%5f|-)?token|refresh(?:_|%5f|-)?token|client(?:_|%5f|-)?secret|authorization)%3d)[^&\s"'<>]+/gi,
    '$1[已隐藏]',
  );
  // A bounded prefix may end halfway through a credential instead of containing its full value.
  if (secret) {
    for (let length = Math.min(secret.length - 1, text.length); length >= 6; length -= 1) {
      if (text.endsWith(secret.slice(0, length))) {
        text = `${text.slice(0, -length)}[已隐藏]`;
        break;
      }
    }
  }
  return text;
}

/** Preserve useful provider details for the requesting user, after credential redaction. */
export function upstreamError(status: number, context: ErrorContext = {}): ApiError {
  let raw: unknown = context.body;
  const fullText = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw);
  const rawText = fullText.slice(0, 16_384);
  if (typeof raw === 'string' && rawText) {
    try {
      raw = JSON.parse(rawText);
    } catch {
      raw = undefined;
    }
  }
  const root = object(raw);
  const error = Object.keys(object(root.error)).length ? object(root.error) : root;
  const code = typeof error.code === 'string' ? error.code.toLowerCase() : '';
  const type = typeof error.type === 'string' ? error.type.toLowerCase() : '';
  const knownCode = KNOWN_CODES.has(code) ? code : KNOWN_CODES.has(type) ? type : '';
  let category = KNOWN_CODES.get(knownCode) || '';
  // Match known failure categories; retain the separately redacted text in diagnostics.
  const sourceMessage =
    typeof error.message === 'string'
      ? error.message.slice(0, 16_384)
      : typeof root.error === 'string'
        ? root.error.slice(0, 16_384)
        : '';
  const message = context.secret ? sourceMessage.replaceAll(context.secret, '') : sourceMessage;
  if (!category) {
    if (
      /unsupported.{0,30}(?:country|region|territor)|(?:country|region|territor).{0,40}(?:not supported|not available)|地区.{0,12}(?:不支持|不可用)/i.test(
        message,
      )
    )
      category = 'region';
    else if (
      /(?:insufficient|exhausted).{0,20}(?:quota|credit|balance)|(?:billing|monthly|spend).{0,20}(?:limit|inactive|not active)|余额不足|额度不足/i.test(
        message,
      )
    )
      category = 'quota';
    else if (/rate[_ -]?limit|too many requests|requests per minute|请求过于频繁/i.test(message))
      category = 'rate';
    else if (
      /(?:ip address|ip range|ip whitelist|ip allowlist|network access).{0,60}(?:denied|blocked|not allowed|not permitted)|(?:firewall|virtual network).{0,60}(?:denied|blocked)|IP.{0,12}(?:白名单|不允许|拒绝)/i.test(
        message,
      )
    )
      category = 'ip';
    else if (
      /(?:model|deployment).{0,80}(?:not found|does not exist|do not have access|not allowed|not authorized|not permitted)|(?:do not have access|not authorized).{0,60}(?:model|deployment)/i.test(
        message,
      )
    )
      category = 'model';
    else if (
      /insufficient.{0,20}permission|permission denied|not authorized|does not have access|do not have access|access denied/i.test(
        message,
      )
    )
      category = 'permission';
  }
  const html =
    /text\/html/i.test(context.contentType || '') ||
    /^\s*(?:<!doctype\s+html|<html\b)/i.test(rawText);
  const prefix = status ? `服务商返回 HTTP ${status}` : '实时语音服务返回错误';
  const requestId = context.requestId
    ? redactDiagnostics(context.requestId.slice(0, 200), context.secret)
    : '';
  const providerMessage = sourceMessage ? redactDiagnostics(sourceMessage, context.secret) : '';
  const diagnostics: UpstreamDiagnostics = {
    upstreamStatus: status,
    endpoint: redactDiagnostics(context.endpoint || '', context.secret),
    model: redactDiagnostics(context.model || '', context.secret),
    ...(requestId ? { requestId } : {}),
    ...(context.contentType
      ? { contentType: redactDiagnostics(context.contentType.slice(0, 200), context.secret) }
      : {}),
    ...(typeof error.code === 'string' || typeof error.code === 'number'
      ? {
          providerCode:
            typeof error.code === 'string'
              ? redactDiagnostics(error.code.slice(0, 200), context.secret)
              : error.code,
        }
      : {}),
    ...(typeof error.type === 'string'
      ? { providerType: redactDiagnostics(error.type.slice(0, 200), context.secret) }
      : {}),
    ...(providerMessage ? { providerMessage } : {}),
    ...(rawText
      ? { responseBody: redactDiagnostics(rawText, context.secret).slice(0, 16_384) }
      : {}),
    ...(context.truncated || fullText.length > 16_384 ? { truncated: true } : {}),
    ...(context.transport ? { transport: context.transport } : {}),
  };
  const suffix = `${providerMessage ? ` 服务商说明：${providerMessage.slice(0, 500)}` : ''}${knownCode ? `（错误代码：${knownCode}）` : ''}${requestId ? `（请求 ID：${requestId}）` : ''}`;
  const transport =
    context.transport === 'realtime'
      ? '这是 Realtime/WebSocket 请求；请确认该模型和服务商支持实时语音。'
      : context.transport === 'speech'
        ? '这是 Speech 语音合成接口请求。'
        : context.transport === 'transcription'
          ? '这是音频转写接口请求。'
          : '';
  const make = (code: string, text: string, httpStatus = 502) =>
    new ApiError(httpStatus, code, `${prefix}：${text}${transport}${suffix}`, diagnostics);
  if (category === 'region')
    return make('UPSTREAM_REGION', '服务商提示当前国家或地区不受支持，请核对其服务可用范围。');
  if (category === 'quota')
    return make(
      'UPSTREAM_QUOTA',
      '服务商提示余额、额度或计费上限不足，请检查该 API 账户的计费设置。',
      429,
    );
  if (category === 'rate')
    return make('UPSTREAM_RATE_LIMIT', '服务商提示请求速率达到限制，请稍后重试或降低并发。', 429);
  if (category === 'ip')
    return make(
      'UPSTREAM_IP_POLICY',
      '服务商提示来源 IP 或网络访问策略拒绝请求，请检查其 IP 白名单与防火墙配置。',
    );
  if (category === 'model')
    return make(
      'UPSTREAM_MODEL_ACCESS',
      '服务商提示当前模型或部署不可用，或此账户没有访问权限，请核对模型名称与授权。',
    );
  if (status === 401 || category === 'auth')
    return make('UPSTREAM_AUTH', '请求未通过身份验证，请核对当前通道的密钥与鉴权方式。');
  if (category === 'permission')
    return make(
      'UPSTREAM_PERMISSION',
      '服务商提示权限不足，请核对项目、账户以及当前模型或接口的访问权限。',
    );
  if (html && (status === 403 || status === 503))
    return make(
      'UPSTREAM_GATEWAY',
      '返回的是网关或防火墙的 HTML 页面，无法据此判断密钥是否有效。请核对 API 基础地址及服务商的访问策略。',
    );
  if (status === 403)
    return make(
      'UPSTREAM_FORBIDDEN',
      '访问被拒绝，服务商未提供可识别的具体原因；请核对接口支持情况、账户权限及访问策略，不能仅凭此状态判定密钥错误。',
    );
  if (status === 429)
    return make(
      'UPSTREAM_LIMIT',
      '服务商未明确区分额度与速率限制，请检查账户用量并稍后重试。',
      429,
    );
  if (status === 404)
    return make('UPSTREAM_NOT_FOUND', '请检查基础地址、模型名称或 Azure 部署名称。');
  if (status === 400 || status === 422 || category === 'config')
    return make('UPSTREAM_CONFIG', '请检查模型是否支持当前功能，以及音色、语言和接口协议。');
  return make('UPSTREAM_ERROR', '服务暂时不可用，请稍后重试。');
}
