import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createApiMiddleware } from './api.ts';
import { loadServerEnvironment } from './env.ts';

loadServerEnvironment();
const root = resolve(process.cwd(), 'dist');
const api = createApiMiddleware();
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  if ((req.url || '').startsWith('/api/')) {
    api(req, res);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }
  void (async () => {
    try {
      const pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
      const candidate = resolve(root, `.${pathname}`);
      if (candidate !== root && !candidate.startsWith(`${root}${sep}`))
        throw new Error('Outside dist');
      let file = candidate;
      try {
        if (!(await stat(file)).isFile()) file = resolve(root, 'index.html');
      } catch {
        file = resolve(root, 'index.html');
      }
      const actual = await realpath(file);
      const actualRoot = await realpath(root);
      if (!actual.startsWith(`${actualRoot}${sep}`)) throw new Error('Outside dist');
      const info = await stat(actual);
      res.writeHead(200, {
        'Content-Type': types[extname(actual)] || 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': pathname.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') res.end();
      else
        createReadStream(actual)
          .on('error', () => res.destroy())
          .pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('页面未找到。请先运行 npm run build。');
    }
  })();
});
const port = Number(process.env.PORT || 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be between 1 and 65535');
server.listen(port, '127.0.0.1', () =>
  process.stdout.write(`GPT Teacher: http://127.0.0.1:${port}\n`),
);
server.on('error', (error: NodeJS.ErrnoException) => {
  process.stderr.write(
    error.code === 'EADDRINUSE'
      ? '端口已被占用，请停止已有服务或设置 PORT。\n'
      : '无法启动本地服务。\n',
  );
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Stop accepting new requests first; current agent CLI processes must be killed and
  // their checkpoints committed before the HTTP server can finish shutting down.
  const deadline = setTimeout(() => {
    process.stderr.write('服务退出等待超时，正在关闭剩余连接。\n');
    server.closeAllConnections();
    process.exit(1);
  }, 10_000);
  try {
    const closed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await api.close();
    server.closeIdleConnections();
    server.closeAllConnections();
    await closed;
    clearTimeout(deadline);
    process.exit(0);
  } catch {
    clearTimeout(deadline);
    process.stderr.write('服务退出时未能完整保存任务状态，请保留数据目录后重启恢复。\n');
    server.closeAllConnections();
    process.exit(1);
  }
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
