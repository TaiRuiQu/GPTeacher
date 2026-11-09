import { test, expect } from './fixtures';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

const COURSE = `# 分数：从一半开始
用平均分理解分子与分母。
:::step id="half" title="把一个整体平均分" duration="20"
把一个整体平均分成两份，其中一份就是二分之一。每一份大小必须相等。
\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 450"><rect width="900" height="450" fill="white"/><g data-topic="half-piece" data-label="平均分成两份中的一份"><rect x="180" y="130" width="240" height="200" fill="#2563eb"/><rect x="420" y="130" width="240" height="200" fill="#e4e4e7"/><text x="180" y="80" font-size="36" fill="#18181b">二分之一</text></g></svg>
\`\`\`
:::
:::step id="practice" title="换成四份试一试" duration="20"
把同一个整体平均分成四份，取其中一份，得到四分之一。分母记录一共平均分成几份。
\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 450"><rect width="900" height="450" fill="white"/><text x="180" y="200" font-size="48" fill="#18181b">四分之一：一共四份，取一份</text></svg>
\`\`\`
:::`;

const SUPPLEMENT = `# 再看平均分
用折纸比较两份的大小。
:::step id="fold" title="把纸对折" duration="15"
将一张长方形纸对折，两边完全重合，说明两份大小相同。
\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 450"><rect width="900" height="450" fill="white"/><rect x="200" y="140" width="360" height="180" fill="#dbeafe"/><path d="M380 140 V320" stroke="#2563eb" stroke-width="4"/><text x="200" y="95" font-size="36" fill="#18181b">对折后两边重合</text></svg>
\`\`\`
:::
:::step id="compare" title="比较这两份" duration="15"
每一份都是整个纸的一半。只有大小相等的两份，才可以把其中一份称为二分之一。
\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 450"><rect width="900" height="450" fill="white"/><text x="180" y="200" font-size="48" fill="#18181b">两份大小相等，才是平均分</text></svg>
\`\`\`
:::`;

type ProviderCall = {
  path: string;
  authorization: string | undefined;
  model: string;
  messages: Array<{ role: string; content: string }>;
};

test.describe('local provider through the real application API', () => {
  test.describe.configure({ mode: 'serial' });
  let provider: Server;
  let baseUrl: string;
  const calls: ProviderCall[] = [];

  test.beforeAll(async () => {
    provider = createServer((req, res) => {
      void (async () => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            model: string;
            messages: Array<{ role: string; content: string }>;
          };
          calls.push({
            path: req.url || '',
            authorization: req.headers.authorization,
            model: body.model,
            messages: body.messages,
          });
          const prompt = body.messages.map((message) => message.content).join('\n');
          const content = prompt.includes('这是连接测试')
            ? '连接成功'
            : prompt.includes('这是暂停后的补讲分支')
              ? SUPPLEMENT
              : prompt.includes('Teacher Markdown')
                ? COURSE
                : '因为只有两份大小相等，才能把其中一份称为整体的二分之一。可以把纸对折，检查两边能否完全重合。';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
            }),
          );
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Local fixture request failed' }));
        }
      })();
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('Local provider did not start');
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => {
      provider.close(() => resolve());
      provider.closeAllConnections();
    });
  });

  test('web configuration, generation, SVG playback, contextual answer and supplement return work end to end', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto('/');
    await page.getByRole('button', { name: /模型与语音/ }).click();
    await page.locator('#ms-text-provider').click();
    await page.getByRole('option', { name: '自定义兼容接口' }).click();
    await page.locator('#ms-text-model').fill('local-teacher-fixture');
    await page.locator('#ms-text-baseUrl').fill(baseUrl);
    await expect(page.locator('#ms-text-apiKey')).toHaveValue('');
    await page.getByRole('button', { name: '测试当前通道' }).click();
    await expect(page.locator('.ms-test-message')).toContainText('教学模型连接成功');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();

    await page.getByRole('button', { name: '输入主题，生成课程', exact: true }).click();
    await page.getByRole('textbox', { name: '想学习什么？' }).fill('从平均分开始理解分数');
    await page
      .getByRole('textbox', { name: '学习基础与要求' })
      .fill('小学三年级，请给出可操作的例子');
    await page.getByRole('spinbutton', { name: '预计分钟数' }).fill('3');
    const generation = page.waitForResponse((response) => response.url().endsWith('/api/lesson'));
    await page.getByRole('button', { name: '生成课程', exact: true }).click();
    expect((await generation).status()).toBe(200);
    await expect(
      page.getByRole('heading', { name: '分数：从一半开始', exact: true }),
    ).toBeVisible();
    const firstScene = page.frameLocator('iframe').locator('[data-topic="half-piece"]');
    await expect(firstScene).toBeVisible();
    await page.getByRole('button', { name: '播放讲解', exact: true }).click();
    const progress = page.getByRole('slider', { name: '课堂播放进度' });
    await expect.poll(() => progress.getAttribute('aria-valuenow')).not.toBe('0');
    await firstScene.click();
    await expect(page.getByRole('button', { name: '播放讲解', exact: true })).toBeVisible();
    await expect(page.locator('.selected-context')).toContainText('平均分成两份中的一份');
    const pausedTime = await progress.getAttribute('aria-valuenow');

    await page.getByRole('textbox', { name: '向老师提问' }).fill('为什么必须大小相等？');
    const answer = page.waitForResponse((response) => response.url().endsWith('/api/answer'));
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    expect((await answer).status()).toBe(200);
    await expect(page.locator('.teacher-reply')).toContainText('把纸对折');

    const supplement = page.waitForResponse((response) =>
      response.url().endsWith('/api/supplement'),
    );
    await page.getByRole('button', { name: '在白板上讲解', exact: true }).click();
    expect((await supplement).status()).toBe(200);
    await expect(page.locator('.branch-banner')).toBeVisible();
    await expect(page.frameLocator('iframe').locator('svg')).toContainText('对折后两边重合');
    await page
      .getByRole('button', { name: /回到原课/ })
      .first()
      .click();
    await expect(page.locator('.branch-banner')).not.toBeVisible();
    await expect(progress).toHaveAttribute('aria-valuenow', pausedTime!);
    await expect(page.locator('.selected-context')).toContainText('平均分成两份中的一份');
    await expect(firstScene).toBeVisible();

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.path).toBe('/v1/chat/completions');
      expect(call.model).toBe('local-teacher-fixture');
      expect(call.authorization).toBeUndefined();
    }
    expect(calls[1].messages.at(-1)?.content).toContain('从平均分开始理解分数');
    expect(calls[2].messages.at(-1)?.content).toContain('平均分成两份中的一份');
    expect(calls[3].messages.at(-1)?.content).toContain('为什么必须大小相等');
    expect(pageErrors).toEqual([]);

    await page.reload();
    await expect(
      page.getByRole('heading', { name: '分数：从一半开始', exact: true }),
    ).toBeVisible();
    const saved = await (await page.request.get('/api/state')).json();
    expect(saved.settings.text.baseUrl).toBe(baseUrl);
    expect(saved.settings.text.provider).toBe('custom');
    expect(saved.settings.text.apiKey).toBe('');
  });
});
