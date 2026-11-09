import { defineConfig, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { posix, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApiMiddleware } from './server/api.ts';
import { loadServerEnvironment } from './server/env.ts';
import { getDataDirectory } from './server/storage.ts';

loadServerEnvironment();

const privateDirectory = normalizePath(getDataDirectory()).toLowerCase();
const projectDirectory = normalizePath(process.cwd()).toLowerCase();
function blockPrivateFiles(req: IncomingMessage, res: ServerResponse, next: () => void) {
  let pathname: string;
  try {
    pathname = (req.url || '/').split(/[?#]/, 1)[0];
    for (let count = 0; count < 2; count += 1) pathname = decodeURIComponent(pathname);
    pathname = posix.normalize(pathname.replace(/\\/g, '/')).toLowerCase();
  } catch {
    res.writeHead(400).end();
    return;
  }
  const file = pathname.startsWith('/@fs/')
    ? pathname.slice('/@fs/'.length)
    : normalizePath(resolve(projectDirectory, `.${pathname}`)).toLowerCase();
  if (
    /(^|\/)\.(?:data|test-data)(\/|$)/.test(pathname) ||
    /(^|\/)master\.key(\/|$)/.test(pathname) ||
    file === privateDirectory ||
    file.startsWith(`${privateDirectory}/`)
  ) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('服务器私有数据不能通过静态文件访问。');
    return;
  }
  next();
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'teacher-api',
      configureServer(server) {
        server.middlewares.use(blockPrivateFiles);
        server.middlewares.use(createApiMiddleware());
      },
      configurePreviewServer(server) {
        server.middlewares.use(blockPrivateFiles);
        server.middlewares.use(createApiMiddleware());
      },
    },
  ],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    strictPort: true,
    fs: {
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc',
        '.yarnrc.yml',
        '**/.git/**',
        '**/.data/**',
        '**/.test-data/**',
        `${normalizePath(getDataDirectory())}/**`,
      ],
    },
    watch: {
      ignored: [
        '**/.agents/**',
        '**/.claude/**',
        '**/.taste-skill/**',
        '**/.npm-cache/**',
        '**/.data/**',
        '**/.test-data/**',
      ],
    },
  },
});
