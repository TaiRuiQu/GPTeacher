import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './errors.ts';
import { PlatformAgentService } from './platform-agent.ts';
import { PlatformStore } from './platform-store.ts';

function json(response: ServerResponse, status: number, data: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

function sameOrigin(request: IncomingMessage) {
  let host: URL;
  try {
    host = new URL(`http://${request.headers.host || ''}`);
  } catch {
    throw new ApiError(403, 'INVALID_HOST', '请求来源不受支持。');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname))
    throw new ApiError(403, 'INVALID_HOST', '学习工作区仅接受本机地址访问。');
  if (request.headers.origin) {
    let origin: string;
    try {
      origin = new URL(request.headers.origin).origin;
    } catch {
      origin = '';
    }
    if (origin !== host.origin)
      throw new ApiError(403, 'INVALID_ORIGIN', '已拒绝其他网页发起的学习数据请求。');
  }
  if (request.headers['sec-fetch-site'] === 'cross-site')
    throw new ApiError(403, 'INVALID_ORIGIN', '已拒绝跨站请求。');
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw new ApiError(415, 'INVALID_CONTENT_TYPE', '请求需要使用 JSON 格式。');
  const max = 32 * 1024;
  if (Number(request.headers['content-length']) > max) {
    request.resume();
    throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容过长。');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容过长。');
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_JSON', '请求数据无法读取。');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'INVALID_JSON', '请求需要是对象。');
  return value as Record<string, unknown>;
}

/** Separate durable job API. A disconnected browser never cancels an accepted job. */
export function createPlatformMiddleware(
  options: { directory?: string; service?: PlatformAgentService } = {},
) {
  let singleton = options.service;
  let closing = false;
  let shutdown: Promise<void> | undefined;
  const service = () =>
    (singleton ??= new PlatformAgentService(new PlatformStore(options.directory)));
  const middleware = (request: IncomingMessage, response: ServerResponse): boolean => {
    const path = (request.url || '').split('?')[0];
    if (path !== '/api/platform' && !path.startsWith('/api/platform/')) return false;
    void (async () => {
      try {
        sameOrigin(request);
        if (closing) throw new ApiError(503, 'SERVICE_STOPPING', '教学服务正在退出，请稍后重试。');
        const method = request.method;
        const jobMatch = path.match(/^\/api\/platform\/jobs\/([\w-]+)(?:\/(cancel|retry))?$/);
        const noteMatch = path.match(/^\/api\/platform\/notes\/([\w-]+)$/);
        let expected: string | undefined;
        if (
          ['/api/platform', '/api/platform/backends'].includes(path) ||
          (jobMatch && !jobMatch[2])
        )
          expected = 'GET';
        if (
          ['/api/platform/profile', '/api/platform/preferences', '/api/platform/progress'].includes(
            path,
          )
        )
          expected = 'PUT';
        if (['/api/platform/jobs', '/api/platform/notes'].includes(path) || jobMatch?.[2])
          expected = 'POST';
        if (noteMatch) expected = 'DELETE';
        if (!expected) throw new ApiError(404, 'NOT_FOUND', '未找到此学习接口。');
        if (method !== expected) {
          response.setHeader('Allow', expected);
          throw new ApiError(405, 'METHOD_NOT_ALLOWED', `此接口需要 ${expected} 请求。`);
        }
        if (path === '/api/platform') {
          json(response, 200, await service().state());
          return;
        }
        if (path === '/api/platform/backends') {
          json(response, 200, { backends: await service().backends() });
          return;
        }
        if (noteMatch) {
          json(response, 200, await service().deleteNote(noteMatch[1]));
          return;
        }
        if (jobMatch) {
          if (!jobMatch[2]) {
            json(response, 200, { job: await service().getJob(jobMatch[1]) });
            return;
          }
          // Enforce a real same-origin JSON POST even for commands without arguments.
          await body(request);
          json(response, jobMatch[2] === 'retry' ? 202 : 200, {
            job: await (jobMatch[2] === 'cancel'
              ? service().cancel(jobMatch[1])
              : service().retry(jobMatch[1])),
          });
          return;
        }
        const data = await body(request);
        if (path === '/api/platform/jobs') {
          json(response, 202, { job: await service().submit(data) });
          return;
        }
        if (path === '/api/platform/profile') {
          json(response, 200, await service().profile(data.learner));
          return;
        }
        if (path === '/api/platform/preferences') {
          json(response, 200, await service().preferences(data));
          return;
        }
        if (path === '/api/platform/progress') {
          json(response, 200, await service().progress(data));
          return;
        }
        if (path === '/api/platform/notes') {
          json(response, 201, await service().note(data));
          return;
        }
      } catch (error) {
        if (error instanceof ApiError)
          json(response, error.status, { error: error.message, code: error.code });
        else
          json(response, 500, {
            error: '学习数据暂时无法读取或保存。请检查服务器存储后重试；已有数据不会被重置。',
            code: 'PLATFORM_ERROR',
          });
      }
    })();
    return true;
  };
  return Object.assign(middleware, {
    close(): Promise<void> {
      closing = true;
      return (shutdown ??= singleton?.close() ?? Promise.resolve());
    },
  });
}
