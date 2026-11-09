import { test, expect } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/answer', (route) =>
    route.fulfill({
      json: { answer: '等式的两边做了相同的运算，才能保持平衡。两边同时减去 3，得到 2x = 4。' },
    }),
  );
  await page.route('**/api/supplement', (route) =>
    route.fulfill({
      json: {
        source:
          '# 再看一次平衡\n:::step id="balance" title="两边同时拿走三个" duration="10"\n两边一起减去三，天平仍然平衡。\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 450"><text x="100" y="220" font-size="48">2x = 4</text></svg>\n```\n:::',
      },
    }),
  );
});

test('classroom playback, visual selection, questions, supplement and notes work together', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '一元一次方程', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '隐藏字幕' }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: '显示字幕' })).toBeVisible();
  await expect(page.getByRole('button', { name: '播放讲解', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '显示字幕' }).click();
  const board = page.frameLocator('iframe').locator('svg');
  await expect(board).toBeVisible();
  await expect(board.locator('animateTransform')).toHaveCount(1);
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停讲解', exact: true })).toBeVisible();
  await expect
    .poll(() => page.getByRole('slider', { name: '课堂播放进度' }).getAttribute('aria-valuenow'))
    .not.toBe('0');
  await board.locator('[data-topic="constant-three"]').click();
  await expect(page.getByRole('button', { name: '播放讲解', exact: true })).toBeVisible();
  await expect(page.locator('.selected-context')).toContainText('左边的 +3');
  await page.getByRole('textbox', { name: '向老师提问' }).fill('为什么两边都要减 3？');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(page.locator('.teacher-reply')).toContainText('两边做了相同的运算');
  const paused = await page
    .getByRole('slider', { name: '课堂播放进度' })
    .getAttribute('aria-valuenow');
  await page.getByRole('button', { name: '跳转到两边同时减 3' }).click();
  await page.getByRole('button', { name: '在白板上讲解' }).click();
  await expect(page.locator('.branch-banner')).toBeVisible();
  await page
    .getByRole('button', { name: /回到原课/ })
    .first()
    .click();
  await expect(page.getByRole('slider', { name: '课堂播放进度' })).toHaveAttribute(
    'aria-valuenow',
    paused!,
  );
  await expect(page.locator('.selected-context')).toContainText('左边的 +3');
  await page.getByRole('button', { name: '保存当前讲解到笔记' }).click();
  await page.getByRole('button', { name: /课堂笔记/ }).click();
  await expect(page.locator('.note-card')).toHaveCount(1);
  await page.locator('.note-card textarea').fill('等式的两边做相同运算，平衡才会保持。');
  await expect(page.getByLabel('服务器保存状态')).toHaveText('已保存');
  await page.reload();
  await page.getByRole('button', { name: /课堂笔记/ }).click();
  await expect(page.locator('.note-card textarea')).toHaveValue(
    '等式的两边做相同运算，平衡才会保持。',
  );
  expect(errors).toEqual([]);
});

test('model preferences persist independently for all three channels', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /模型与语音/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('#ms-text-model').fill('my-teaching-model');
  await page.getByRole('tab', { name: /文字转语音/ }).click();
  await page.locator('#ms-tts-model').fill('my-voice-model');
  await page.getByRole('tab', { name: /语音转文字/ }).click();
  await page.locator('#ms-stt-model').fill('my-transcription-model');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.reload();
  const settings = await (await page.request.get('/api/state')).json();
  expect(settings.settings.text.model).toBe('my-teaching-model');
  expect(settings.settings.tts.model).toBe('my-voice-model');
  expect(settings.settings.stt.model).toBe('my-transcription-model');
  expect(settings.settings.text.apiKey).toBe('');
});

test('editable plain text, rich SVG animation, seek and isolation remain functional', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '课堂脚本', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const source =
    '# 自由图形实验\n任意 SVG，不需要 JSON。\n:::step id="free" title="让圆移动" duration="10"\n这是一段 **自由的讲稿**。\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 450"><style>text{fill:#285b4b}</style><circle data-topic="free-circle" data-label="自由绘制的圆" cx="100" cy="200" r="42" fill="#285b4b"><animate attributeName="cx" from="100" to="700" dur="10s" fill="freeze"/></circle><text x="100" y="80">自由发挥。</text><script>parent.document.body.dataset.compromised="yes"</script><image href="https://example.com/track.png"/><rect onclick="alert(1)"/></svg>\n```\n:::';
  await page.getByRole('dialog').locator('textarea').fill(source);
  await page.getByRole('button', { name: '应用', exact: true }).click();
  await expect(page.getByRole('heading', { name: '自由图形实验', exact: true })).toBeVisible();
  const frame = page.frameLocator('iframe');
  const circle = frame.locator('[data-topic="free-circle"]');
  await expect(circle).toBeVisible();
  const slider = page.getByRole('slider', { name: '课堂播放进度' });
  await slider.focus();
  await page.keyboard.press('Home');
  for (let index = 0; index < 5; index++) await page.keyboard.press('PageUp');
  await expect
    .poll(() => circle.evaluate((node) => (node as SVGCircleElement).cx.animVal.value))
    .toBeCloseTo(400, 0);
  await page.keyboard.press('Home');
  await expect
    .poll(() => circle.evaluate((node) => (node as SVGCircleElement).cx.animVal.value))
    .toBeCloseTo(100, 0);
  await expect(frame.locator('script')).toHaveCount(0);
  await expect(frame.locator('[onclick]')).toHaveCount(0);
  expect(await page.locator('body').getAttribute('data-compromised')).toBeNull();
  expect(await frame.locator('image').getAttribute('href')).toBeNull();
  await circle.click();
  await expect(page.locator('.selected-context')).toContainText('自由绘制的圆');
  await page.reload();
  await expect(page.getByRole('heading', { name: '自由图形实验', exact: true })).toBeVisible();
});

test('desktop layout, course menu and model dialog fit a laptop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.frameLocator('iframe').locator('svg')).toBeVisible();
  await expect(page.getByRole('button', { name: '播放讲解', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  await page.getByRole('button', { name: '切换课程' }).click();
  await page.getByRole('menuitem', { name: /牛顿第二定律/ }).click();
  await expect(page.getByRole('heading', { name: '牛顿第二定律', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '课堂脚本', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /模型与语音/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
});
