import { expect, test } from './fixtures';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

const SOURCE =
  '# 服务器语音课堂\n:::step id="one" title="第一个概念" duration="8"\n先从生活中的例子认识这个概念。\n:::\n:::step id="two" title="第二个概念" duration="8"\n再用另一个例子检查刚刚的理解。\n:::';
function wave() {
  const data = Buffer.alloc(44 + 8000 * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24);
  data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(data.length - 44, 40);
  return data;
}

test.describe('server-owned courses, credentials and audio cache', () => {
  let provider: Server;
  let baseUrl: string;
  let syntheses = 0;
  let authorized = true;
  test.beforeAll(async () => {
    provider = createServer((req, res) => {
      req.resume();
      if (req.url !== '/v1/audio/speech') {
        res.writeHead(404);
        res.end();
        return;
      }
      syntheses += 1;
      authorized &&= req.headers.authorization === 'Bearer saved-server-test-key';
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(wave());
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('No local provider address.');
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });
  test.afterAll(async () => {
    await new Promise<void>((resolve) => {
      provider.close(() => resolve());
      provider.closeAllConnections();
    });
  });

  test('a fresh browser restores server state and reuses disk audio without another synthesis', async ({
    page,
    browser,
  }) => {
    const common = { enabled: true, provider: 'custom', model: 'fixture-voice', baseUrl };
    const configuration = await page.request.put('/api/settings', {
      data: {
        settings: {
          text: common,
          tts: { ...common, voice: 'Kore', apiKey: 'saved-server-test-key' },
          stt: { ...common, enabled: false, language: 'zh' },
        },
      },
    });
    expect(configuration.ok()).toBe(true);
    await page.request.put('/api/workspace', {
      data: {
        workspace: {
          currentId: 'server-course',
          sources: { 'server-course': SOURCE },
          notes: [
            {
              id: 'note-one',
              lessonId: 'server-course',
              lessonTitle: '服务器语音课堂',
              stepTitle: '第一个概念',
              time: 0,
              body: '保存在服务器的笔记',
              createdAt: '2026-11-09T00:00:00.000Z',
            },
          ],
        },
      },
    });
    const initialStatuses: string[] = [];
    page.on('response', (response) => {
      if (response.url().endsWith('/api/speech'))
        initialStatuses.push(response.headers()['x-teacher-audio-cache']);
    });
    await page.goto('/');
    await expect(page.locator('.narration-status')).toContainText('2/2');
    expect(syntheses).toBe(2);
    expect(initialStatuses).toEqual(['miss', 'miss']);
    await page.getByRole('button', { name: '课堂笔记', exact: true }).click();
    await page.locator('.note-card textarea').fill('换浏览器也能恢复的笔记');
    await expect(page.getByLabel('服务器保存状态')).toHaveText('已保存');
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.startsWith('gpt-teacher:')),
      ),
    ).toEqual([]);

    const fresh = await browser.newPage();
    try {
      const cacheStatuses: string[] = [];
      const requestKeys: unknown[] = [];
      fresh.on('response', (response) => {
        if (response.url().endsWith('/api/speech'))
          cacheStatuses.push(response.headers()['x-teacher-audio-cache']);
      });
      fresh.on('request', (request) => {
        if (request.url().endsWith('/api/speech'))
          requestKeys.push(request.postDataJSON().settings.apiKey);
      });
      await fresh.goto(page.url());
      await expect(
        fresh.getByRole('heading', { name: '服务器语音课堂', exact: true }),
      ).toBeVisible();
      await expect(fresh.locator('.narration-status')).toContainText('2/2');
      expect(cacheStatuses).toEqual(['hit', 'hit']);
      expect(syntheses).toBe(2);
      expect(authorized).toBe(true);
      expect(requestKeys).toEqual(['', '']);
      await fresh.getByRole('button', { name: '课堂笔记', exact: true }).click();
      await expect(fresh.locator('.note-card textarea')).toHaveValue('换浏览器也能恢复的笔记');
      const state = await (await page.request.get('/api/state')).json();
      expect(state.settings.tts.hasApiKey).toBe(true);
      expect(state.settings.tts.apiKey).toBe('');
      expect(JSON.stringify(state)).not.toContain('saved-server-test-key');
    } finally {
      await fresh.close();
    }
  });

  test('server data and master key files are blocked by the development server', async ({
    request,
  }) => {
    for (const path of [
      '/.data/state.json',
      '/.data/master.key',
      '/.test-data/state.json',
      '/@fs/C:/data/master.key',
    ]) {
      const response = await request.get(path);
      expect([403, 404]).toContain(response.status());
      expect(await response.text()).not.toContain('saved-server-test-key');
    }
  });
});
