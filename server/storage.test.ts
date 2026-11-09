import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';
import { createApiMiddleware } from './api.ts';
import { StateStore, validateWorkspace } from './storage.ts';

const KEY = 'stored-provider-secret-for-test';
const workspace = (title = '测试课堂') => ({
  currentId: 'custom-test',
  sources: { 'custom-test': `# ${title}\n这是一段可播放的课堂讲稿。` },
  notes: [
    {
      id: 'note-one',
      lessonId: 'custom-test',
      lessonTitle: title,
      stepTitle: '讲解',
      time: 2,
      body: '课堂笔记。',
      createdAt: '2026-11-09T12:00:00Z',
    },
  ],
});
const settings = () => structuredClone(DEFAULT_SETTINGS);

async function withStore(run: (store: StateStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'gpt-teacher-state-'));
  try {
    await run(new StateStore(directory), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('workspace persists atomically and survives a new server store', async () => {
  await withStore(async (store, directory) => {
    assert.equal(store.getState().workspace, null);
    assert.equal(store.getState().hasWorkspace, false);
    await store.saveWorkspace(workspace());
    assert.deepEqual(new StateStore(directory).getState().workspace, workspace());
    assert.deepEqual(await readdir(directory), ['state.json']);
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.saveWorkspace(workspace(`课程 ${index}`))),
    );
    assert.deepEqual(new StateStore(directory).getState().workspace, workspace('课程 9'));
    assert.deepEqual(await readdir(directory), ['state.json']);
  });
});

test('settings encrypt credentials, never return plaintext, preserve blank edits and bind keys to addresses', async () => {
  await withStore(async (store, directory) => {
    const value = settings();
    value.tts = {
      ...value.tts,
      enabled: true,
      provider: 'custom',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'google/gemini-3.8-flash-lite-tts',
      voice: 'Kore',
      apiKey: KEY,
    };
    const saved = await store.saveSettings(value);
    assert.equal(saved.tts.apiKey, '');
    assert.equal(saved.tts.hasApiKey, true);
    const disk = await readFile(join(directory, 'state.json'), 'utf8');
    assert.doesNotMatch(disk, new RegExp(KEY));
    assert.equal((await readFile(join(directory, 'master.key'))).length, 32);
    const restarted = new StateStore(directory);
    assert.equal(restarted.resolveChannel({}, 'tts').apiKey, KEY);
    assert.equal(restarted.getState().settings.tts.apiKey, '');
    await restarted.saveSettings(saved);
    assert.equal(restarted.resolveChannel({}, 'tts').apiKey, KEY);
    assert.equal(
      restarted.resolveChannel({ baseUrl: 'https://different.example/v1', apiKey: '' }, 'tts')
        .apiKey,
      '',
    );
    assert.equal(restarted.resolveChannel({ provider: 'azure', apiKey: '' }, 'tts').apiKey, '');
    assert.equal(
      restarted.resolveChannel({ apiKey: 'explicit-request-key' }, 'tts').apiKey,
      'explicit-request-key',
    );
    const changed = restarted.getState().settings;
    changed.tts.baseUrl = 'https://different.example/v1';
    await restarted.saveSettings(changed);
    assert.equal(restarted.getState().settings.tts.hasApiKey, false);
    assert.equal(new StateStore(directory).resolveChannel({}, 'tts').apiKey, '');
  });
});

test('clear removes saved keys and one-time import cannot overwrite server information', async () => {
  await withStore(async (store, directory) => {
    const value = settings();
    value.text.apiKey = KEY;
    const first = await store.importOnce({ workspace: workspace(), settings: value });
    assert.equal(first.imported, true);
    const second = await store.importOnce({ workspace: workspace('不应覆盖'), settings: value });
    assert.equal(second.imported, false);
    assert.deepEqual(second.workspace, workspace());
    await store.clearKeys();
    const restarted = new StateStore(directory);
    assert.equal(restarted.getState().settings.text.hasApiKey, false);
    assert.equal(restarted.resolveChannel({}, 'text').apiKey, '');
    assert.equal(
      JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).credentials,
      undefined,
    );
    assert.deepEqual(restarted.getState().workspace, workspace());
  });
});

test('workspace validation rejects invalid course references, scripts, notes and oversized data', async () => {
  await withStore(async (store) => {
    for (const bad of [
      { ...workspace(), currentId: 'missing' },
      { ...workspace(), sources: { 'custom-test': ' ' } },
      { ...workspace(), notes: [{ ...workspace().notes[0], time: -1 }] },
      { ...workspace(), notes: [{ ...workspace().notes[0], body: 'x'.repeat(100_001) }] },
      { ...workspace(), sources: Object.fromEntries([['__proto__', '# 课\n内容。']]) },
    ])
      assert.throws(() => validateWorkspace(bad));
    await assert.rejects(
      store.saveWorkspace({
        ...workspace(),
        sources: { 'custom-test': `# 课\n${'x'.repeat(11 * 1024 * 1024)}` },
      }),
      { code: 'STATE_TOO_LARGE' },
    );
    assert.equal(store.getState().workspace, null);
  });
});

test('corrupt existing files are reported without replacing saved state', async () => {
  await withStore(async (store, directory) => {
    await store.saveWorkspace(workspace());
    await writeFile(join(directory, 'state.json'), '{broken');
    const restarted = new StateStore(directory);
    assert.throws(() => restarted.getState(), { code: 'STORAGE_READ_ERROR' });
    await assert.rejects(restarted.saveWorkspace(workspace('replacement')), {
      code: 'STORAGE_READ_ERROR',
    });
    assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), '{broken');
  });
});

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

test('state reads wait for an accepted workspace write before returning a navigation snapshot', async () => {
  await withStore(async (store, directory) => {
    await store.saveWorkspace(workspace('旧内容'));
    const writable = store as unknown as { persist: (state: unknown) => Promise<void> };
    const original = writable.persist.bind(store);
    let notifyWrite!: () => void;
    let releaseWrite!: () => void;
    let notifyRead!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      notifyWrite = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      notifyRead = resolve;
    });
    let firstWrite = true;
    writable.persist = async (state) => {
      if (firstWrite) {
        firstWrite = false;
        notifyWrite();
        await writeGate;
      }
      await original(state);
    };
    const api = createApiMiddleware({ store });
    const server = createServer((req, res) => {
      if (req.url === '/api/state') notifyRead();
      api(req, res);
    });
    const base = await listen(server);
    try {
      const pendingWrite = fetch(`${base}/api/workspace`, {
        method: 'PUT',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: workspace('刚输入的新内容') }),
      });
      await writeStarted;
      let readFinished = false;
      const pendingRead = fetch(`${base}/api/state`).then(async (response) => {
        const value = await response.json();
        readFinished = true;
        return value;
      });
      await readStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(readFinished, false, 'GET must wait for the pending atomic commit');
      releaseWrite();
      assert.equal((await pendingWrite).status, 200);
      const reloaded = await pendingRead;
      assert.deepEqual(reloaded.workspace, workspace('刚输入的新内容'));
      await store.saveWorkspace(reloaded.workspace);
      assert.deepEqual(new StateStore(directory).getState().workspace, workspace('刚输入的新内容'));
    } finally {
      releaseWrite();
      await close(server);
    }
  });
});

test('state API persists server settings and supplies saved credentials without sending them back to the browser', async () => {
  await withStore(async (store) => {
    let received = '';
    const upstream = createServer((req, res) => {
      received = req.headers.authorization || '';
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '模型连接成功。' } }],
        }),
      );
    });
    const upstreamBase = await listen(upstream);
    const server = createServer(createApiMiddleware({ store }));
    const base = await listen(server);
    const send = (path: string, method: string, body?: unknown) =>
      fetch(`${base}/api/${path}`, {
        method,
        headers: {
          Origin: base,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      assert.equal((await (await send('state', 'GET')).json()).hasWorkspace, false);
      assert.equal((await send('workspace', 'PUT', { workspace: workspace() })).status, 200);
      const value = settings();
      value.text = {
        ...value.text,
        provider: 'custom',
        baseUrl: `${upstreamBase}/v1`,
        model: 'local-test',
        apiKey: KEY,
      };
      const saved = await (await send('settings', 'PUT', { settings: value })).json();
      assert.equal(saved.settings.text.apiKey, '');
      assert.equal(saved.settings.text.hasApiKey, true);
      const response = await send('test', 'POST', { channel: 'text' });
      assert.equal(response.status, 200);
      assert.equal(received, `Bearer ${KEY}`);
      const fetched = await (await send('state', 'GET')).json();
      assert.deepEqual(fetched.workspace, workspace());
      assert.doesNotMatch(JSON.stringify(fetched), new RegExp(KEY));
      const foreign = await fetch(`${base}/api/settings/keys`, {
        method: 'DELETE',
        headers: { Origin: 'https://foreign.example' },
      });
      assert.equal(foreign.status, 403);
      assert.equal((await send('state', 'PUT', {})).status, 405);
      const cleared = await (await send('settings/keys', 'DELETE')).json();
      assert.equal(cleared.settings.text.hasApiKey, false);
      const bad = await send('workspace', 'PUT', {
        workspace: { ...workspace(), currentId: 'missing' },
      });
      assert.equal(bad.status, 400);
      assert.deepEqual((await (await send('state', 'GET')).json()).workspace, workspace());
    } finally {
      await close(server);
      await close(upstream);
    }
  });
});
