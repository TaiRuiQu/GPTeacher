import { expect, test, type Page } from './fixtures';
import { mkdir } from 'node:fs/promises';

const CREDENTIALS_KEY = 'gpt-teacher:api-keys:v1';

async function openSettings(page: Page) {
  await page.getByRole('button', { name: /模型与语音/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function saveSettings(page: Page) {
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
}

test('settings and credentials survive refresh on the server without returning plaintext keys to the webpage', async ({
  page,
}) => {
  let sentSettings: { apiKey?: string; model?: string; maxOutputTokens?: number } | undefined;
  await page.route('**/api/answer', async (route) => {
    sentSettings = route.request().postDataJSON().settings;
    await route.fulfill({ json: { answer: '这是使用当前教学配置生成的回答。' } });
  });
  await page.goto('/');
  await openSettings(page);
  await page.locator('#ms-text-model').fill('test-teaching-model');
  await page.locator('#ms-text-maxOutputTokens').fill('511');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('512 到 65536 之间的整数');
  await page.locator('#ms-text-maxOutputTokens').fill('32768');
  await page.locator('#ms-text-apiKey').fill('server-owned-test-key');
  await expect(page.getByRole('checkbox', { name: '在本机记住 API Key' })).toHaveCount(0);
  await saveSettings(page);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(storage).not.toContain('server-owned-test-key');
  expect(await page.evaluate((key) => localStorage.getItem(key), CREDENTIALS_KEY)).toBeNull();
  const state = await (await page.request.get('/api/state')).json();
  expect(state.settings.text.hasApiKey).toBe(true);
  expect(state.settings.text.apiKey).toBe('');
  expect(JSON.stringify(state)).not.toContain('server-owned-test-key');

  await openSettings(page);
  await expect(page.locator('#ms-text-apiKey')).toHaveValue('');
  await expect(page.locator('#ms-text-apiKey')).toHaveAttribute('placeholder', /服务器已保存密钥/);
  await saveSettings(page);
  expect((await (await page.request.get('/api/state')).json()).settings.text.hasApiKey).toBe(true);
  await page.getByRole('textbox', { name: '向老师提问' }).fill('为什么要两边一起计算？');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(page.locator('.teacher-reply').last()).toContainText('使用当前教学配置');
  expect(sentSettings?.apiKey).toBe('');
  expect(sentSettings?.model).toBe('test-teaching-model');
  expect(sentSettings?.maxOutputTokens).toBe(32768);

  await page.reload();
  await openSettings(page);
  await expect(page.locator('#ms-text-apiKey')).toHaveValue('');
  await expect(page.locator('#ms-text-apiKey')).toHaveAttribute('placeholder', /服务器已保存密钥/);
  await expect(page.locator('#ms-text-model')).toHaveValue('test-teaching-model');
  await expect(page.locator('#ms-text-maxOutputTokens')).toHaveValue('32768');
});

test('clearing server credentials removes saved-key flags without exposing the previous values', async ({
  page,
}) => {
  await page.goto('/');
  await openSettings(page);
  await page.locator('#ms-text-apiKey').fill('remembered-test-key');
  await saveSettings(page);
  expect((await (await page.request.get('/api/state')).json()).settings.text.hasApiKey).toBe(true);

  await page.reload();
  await openSettings(page);
  await expect(page.locator('#ms-text-apiKey')).toHaveValue('');
  await expect(page.locator('#ms-text-apiKey')).toHaveAttribute('placeholder', /服务器已保存密钥/);
  await page.getByRole('button', { name: '清除服务器密钥' }).click();
  await expect(page.locator('#ms-text-apiKey')).toHaveValue('');
  await expect(page.locator('#ms-text-apiKey')).toHaveAttribute(
    'placeholder',
    /留空使用服务器环境/,
  );
  expect((await (await page.request.get('/api/state')).json()).settings.text.hasApiKey).toBe(false);
  expect(await page.evaluate((key) => localStorage.getItem(key), CREDENTIALS_KEY)).toBeNull();
  await page.keyboard.press('Escape');
  await openSettings(page);
  await expect(page.locator('#ms-text-apiKey')).toHaveValue('');
  await expect(page.locator('#ms-text-apiKey')).toHaveAttribute(
    'placeholder',
    /留空使用服务器环境/,
  );
});

test('a failed server save retains the editable draft and can be retried', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/settings', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ status: 503, json: { error: '课堂服务器暂时无法保存配置，请重试。' } });
    } else await route.continue();
  });
  await page.goto('/');
  await openSettings(page);
  await page.locator('#ms-text-model').fill('retry-this-model');
  await page.locator('#ms-text-apiKey').fill('retry-this-test-key');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('暂时无法保存配置');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#ms-text-model')).toHaveValue('retry-this-model');
  await expect(page.locator('#ms-text-apiKey')).toHaveValue('retry-this-test-key');
  await saveSettings(page);
  expect(attempts).toBe(2);
  const state = await (await page.request.get('/api/state')).json();
  expect(state.settings.text.model).toBe('retry-this-model');
  expect(state.settings.text.hasApiKey).toBe(true);
  expect(JSON.stringify(state)).not.toContain('retry-this-test-key');
});

test('switching channels cancels a pending test and does not overwrite a later test result', async ({
  page,
}) => {
  let count = 0;
  let releaseOldResponse!: () => void;
  let finishOldResponse!: () => void;
  const oldResponseGate = new Promise<void>((resolve) => (releaseOldResponse = resolve));
  const oldResponseFinished = new Promise<void>((resolve) => (finishOldResponse = resolve));
  await page.route('**/api/test', async (route) => {
    count += 1;
    if (count === 1) {
      await oldResponseGate;
      try {
        await route.fulfill({ json: { ok: true, message: '过期的连接结果' } });
      } catch {
        // The browser can discard an explicitly cancelled request before fulfillment.
      } finally {
        finishOldResponse();
      }
    } else {
      await route.fulfill({ json: { ok: true, message: '新的教学连接测试通过。' } });
    }
  });
  await page.goto('/');
  await openSettings(page);
  await page.getByRole('button', { name: '测试当前通道' }).click();
  await expect.poll(() => count).toBe(1);
  await expect(page.getByRole('button', { name: '取消测试' })).toBeVisible();
  await page.getByRole('tab', { name: /文字转语音/ }).click();
  await page.getByRole('tab', { name: '教学模型', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('测试已取消。');
  await page.getByRole('button', { name: '测试当前通道' }).click();
  await expect(page.getByRole('status')).toContainText('新的教学连接测试通过。');
  releaseOldResponse();
  await oldResponseFinished;
  await expect(page.getByRole('status')).toContainText('新的教学连接测试通过。');
  await expect(page.getByRole('dialog')).not.toContainText('过期的连接结果');
});

test('restoring defaults clears server keys only when the defaults are saved', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);
  await page.locator('#ms-text-model').fill('my-custom-model');
  await page.locator('#ms-text-apiKey').fill('reset-this-test-key');
  await saveSettings(page);
  await openSettings(page);
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(page.locator('#ms-text-apiKey')).toHaveValue('');
  await expect(page.locator('#ms-text-model')).toHaveValue('gpt-6.1-sol');
  expect((await (await page.request.get('/api/state')).json()).settings.text.hasApiKey).toBe(true);
  await saveSettings(page);
  expect(await page.evaluate((key) => localStorage.getItem(key), CREDENTIALS_KEY)).toBeNull();
  expect((await (await page.request.get('/api/state')).json()).settings.text.hasApiKey).toBe(false);
  await page.reload();
  await openSettings(page);
  await expect(page.locator('#ms-text-apiKey')).toHaveValue('');
  await expect(page.locator('#ms-text-apiKey')).toHaveAttribute(
    'placeholder',
    /留空使用服务器环境/,
  );
});

test('connection errors stay within the tested channel and hide its API key', async ({ page }) => {
  await page.route('**/api/test', async (route) => {
    await route.fulfill({
      status: 401,
      json: { error: '认证失败 never-show-test-key，请检查密钥。', code: 'AUTHENTICATION_ERROR' },
    });
  });
  await page.goto('/');
  await openSettings(page);
  await page.locator('#ms-text-apiKey').fill('never-show-test-key');
  await page.getByRole('button', { name: '测试当前通道' }).click();
  await expect(page.getByRole('alert')).toContainText('认证失败 [已隐藏]');
  await expect(page.getByRole('alert')).not.toContainText('never-show-test-key');
  await page.getByRole('tab', { name: /文字转语音/ }).click();
  await expect(page.getByRole('dialog')).not.toContainText('认证失败');
  await expect(page.getByRole('button', { name: '测试当前通道' })).toBeDisabled();

  await mkdir('.taste-skill/shots', { recursive: true });
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    const dialog = page.getByRole('dialog');
    const panels = page.locator('.ms-panels');
    await expect(dialog).toHaveCSS('height', `${Math.min(820, viewport.height - 96)}px`);
    await dialog.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished.catch(() => {})),
      );
    });
    await panels.evaluate((element) => (element.scrollTop = 0));
    await expect(dialog).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await expect(page.getByRole('button', { name: '关闭窗口', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await expect(page.locator('.ms-storage-notice')).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.ms-storage .ms-hint')).toBeInViewport({ ratio: 1 });
    expect(await panels.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    const footerBeforeScroll = await page.locator('.ms-footer').boundingBox();
    await page.screenshot({
      path: `.taste-skill/shots/settings-${viewport.width}-top.png`,
      animations: 'disabled',
    });
    await panels.evaluate((element) => (element.scrollTop = element.scrollHeight));
    await expect(page.getByText('测试会实际调用当前通道，可能产生服务商费用。')).toBeInViewport({
      ratio: 1,
    });
    await expect(page.getByRole('button', { name: '测试当前通道' })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await expect(page.getByRole('button', { name: '关闭窗口', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await expect(page.locator('.ms-storage-notice')).toBeInViewport({ ratio: 1 });
    expect(await page.locator('.ms-footer').boundingBox()).toEqual(footerBeforeScroll);
    expect(await dialog.evaluate((element) => element.scrollTop)).toBe(0);
    await page.screenshot({
      path: `.taste-skill/shots/settings-${viewport.width}.png`,
      animations: 'disabled',
    });
  }
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: '输入主题，生成课程', exact: true }).click();
    await page.getByRole('dialog').evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished.catch(() => {})),
      );
    });
    await expect(page.getByRole('dialog')).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('textbox', { name: '想学习什么？' })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: '生成课程', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await expect(page.getByRole('button', { name: '关闭窗口', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await page.screenshot({
      path: `.taste-skill/shots/newcourse-${viewport.width}.png`,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  }
});
