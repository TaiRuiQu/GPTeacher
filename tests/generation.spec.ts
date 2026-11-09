import { expect, test } from './fixtures';

const generatedSource = `# 概率入门
认识概率，用硬币做例子。
:::step id="coin" title="抛一枚硬币" duration="10"
公平硬币正面和反面机会相等，正面概率为二分之一。
\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 450"><circle data-topic="coin" data-label="公平硬币" cx="450" cy="225" r="100" fill="#dbeafe"/><text x="450" y="240" text-anchor="middle" font-size="48">1/2</text></svg>
\`\`\`
:::
:::step id="practice" title="独立练习" duration="12"
掷一枚公平骰子，得到六的概率是多少？答案是六分之一，因为有六个等可能结果。
:::`;

test('saved courses beyond the first thirty survive reload without truncation', async ({
  page,
}) => {
  const sources = Object.fromEntries(
    Array.from({ length: 35 }, (_, index) => [
      `custom-${index}`,
      `# 已保存课程${index + 1}\n这是一段已保存的课程讲稿。`,
    ]),
  );
  await page.request.put('/api/workspace', {
    data: { workspace: { currentId: 'custom-34', sources, notes: [] } },
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '已保存课程35', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '已保存课程35', exact: true })).toBeVisible();
  const state = await (await page.request.get('/api/state')).json();
  expect(Object.keys(state.workspace.sources)).toHaveLength(35);
});

test('topic creates a playable persistent classroom and real-context questions', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let generationBody: Record<string, unknown> | undefined;
  let answerBody: Record<string, unknown> | undefined;
  await page.route('**/api/lesson', async (route) => {
    generationBody = route.request().postDataJSON();
    await route.fulfill({ json: { source: generatedSource } });
  });
  await page.route('**/api/answer', async (route) => {
    answerBody = route.request().postDataJSON();
    await route.fulfill({
      json: { answer: '因为两个结果等可能，所以每个结果的概率都是二分之一。' },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '输入主题，生成课程' }).click();
  await page.getByLabel('想学习什么？').fill('给初中生讲概率');
  await page.getByLabel('学习基础与要求').fill('初中一年级，生活中的例子');
  await page.getByLabel('预计分钟数').fill('3');
  await page.getByRole('button', { name: '生成课程', exact: true }).click();
  await expect(page.getByRole('heading', { name: '概率入门', exact: true })).toBeVisible();
  expect(generationBody).toMatchObject({
    topic: '给初中生讲概率',
    audience: '初中一年级，生活中的例子',
    durationMinutes: 3,
  });
  await expect(page.locator('.chapter-item')).toHaveCount(2);
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect
    .poll(() => page.getByRole('slider', { name: '课堂播放进度' }).getAttribute('aria-valuenow'))
    .not.toBe('0');
  await page
    .frameLocator('iframe')
    .locator('[data-topic="coin"]')
    .click({ position: { x: 45, y: 45 } });
  await page.getByRole('textbox', { name: '向老师提问' }).fill('为什么各占一半？');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(page.locator('.teacher-reply')).toContainText('二分之一');
  expect(answerBody).toMatchObject({
    question: '为什么各占一半？',
    context: {
      lessonTitle: '概率入门',
      stepId: 'coin',
      selection: { id: 'coin', label: '公平硬币' },
    },
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: '概率入门', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('generation errors keep the prompt and allow a successful retry', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/lesson', async (route) => {
    attempts += 1;
    await route.fulfill(
      attempts === 1
        ? { status: 401, json: { error: '请先配置教学模型的 API Key。' } }
        : { json: { source: generatedSource } },
    );
  });
  await page.goto('/');
  await page.getByRole('button', { name: '开启新课堂', exact: true }).click();
  await page.getByLabel('想学习什么？').fill('概率');
  await page.getByRole('button', { name: '生成课程', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('API Key');
  await expect(page.getByLabel('想学习什么？')).toHaveValue('概率');
  await page.getByRole('button', { name: '生成课程', exact: true }).click();
  await expect(page.getByRole('heading', { name: '概率入门', exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});

test('long narration scrolls while playback controls remain usable on a laptop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('**/api/lesson', (route) =>
    route.fulfill({
      json: {
        source: generatedSource.replace(
          '公平硬币正面和反面机会相等，正面概率为二分之一。',
          '公平硬币正面和反面机会相等，正面概率为二分之一。'.repeat(50),
        ),
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '输入主题，生成课程' }).click();
  await page.getByLabel('想学习什么？').fill('详细讲概率');
  await page.getByRole('button', { name: '生成课程', exact: true }).click();
  await expect(page.getByRole('heading', { name: '概率入门', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '播放讲解', exact: true })).toBeInViewport();
  const caption = page.locator('.caption-area');
  expect(await caption.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停讲解', exact: true })).toBeInViewport();
});

test('closing or cancelling generation cannot replace the active course later', async ({
  page,
}) => {
  let finish: (() => void) | undefined;
  let requests = 0;
  const release = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route('**/api/lesson', async (route) => {
    requests += 1;
    await release;
    await route.fulfill({ json: { source: generatedSource } }).catch(() => {});
  });
  await page.goto('/');
  await page.getByRole('button', { name: '开启新课堂', exact: true }).click();
  await page.getByLabel('想学习什么？').fill('概率');
  await page.getByRole('button', { name: '生成课程', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消生成' })).toBeVisible();
  await page.getByRole('button', { name: '取消生成' }).click();
  await expect(page.getByRole('alert')).toContainText('已取消');
  finish?.();
  await expect(page.getByRole('alert')).toContainText('已取消');
  expect(requests).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await expect(page.getByRole('heading', { name: '一元一次方程', exact: true })).toBeVisible();
});

test('failed question restores input, permits retry, and never substitutes a demo answer', async ({
  page,
}) => {
  let attempts = 0;
  await page.route('**/api/answer', async (route) => {
    attempts += 1;
    await route.fulfill(
      attempts === 1
        ? { status: 503, json: { error: '教学服务暂时不可用，请重试。' } }
        : { json: { answer: '这是来自教学模型的真实接口回答。' } },
    );
  });
  await page.goto('/');
  await page.getByRole('textbox', { name: '向老师提问' }).fill('解释等式性质');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('暂时不可用');
  await expect(page.getByRole('textbox', { name: '向老师提问' })).toHaveValue('解释等式性质');
  await expect(page.locator('.teacher-reply')).toHaveCount(0);
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(page.locator('.teacher-reply')).toContainText('真实接口回答');
});
