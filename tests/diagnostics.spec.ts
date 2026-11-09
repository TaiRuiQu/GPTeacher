import { expect, test } from './fixtures';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

const SECRET = 'diagnostic-test-credential';
const MODEL = 'google/gemini-3.8-flash-lite-tts';

test.describe('provider diagnostics through the real backend', () => {
  let provider: Server;
  let baseUrl: string;

  test.beforeAll(async () => {
    provider = createServer((req, res) => {
      req.resume();
      res.writeHead(403, {
        'Content-Type': 'application/json',
        'X-Request-Id': 'req-openrouter-fixture',
      });
      res.end(
        JSON.stringify({
          error: {
            code: 403,
            message: 'Provider returned error',
            metadata: {
              provider_name: 'Google fixture',
              raw: JSON.stringify({
                error: {
                  status: 'PERMISSION_DENIED',
                  message:
                    'TTS is unavailable for this project. Contact the provider with this reason.',
                },
              }),
              authorization: `Bearer ${SECRET}`,
            },
          },
        }),
      );
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('Mock provider failed to listen.');
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => {
      provider.close(() => resolve());
      provider.closeAllConnections();
    });
  });

  test('TTS playback and connection tests expose provider body and request ID while redacting credentials', async ({
    page,
  }) => {
    const common = { enabled: true, provider: 'custom', model: MODEL, baseUrl };
    await page.request.put('/api/settings', {
      data: {
        settings: {
          text: common,
          tts: { ...common, voice: 'Kore', apiKey: SECRET },
          stt: { ...common, enabled: false, language: 'zh' },
        },
      },
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => Object.assign(window, { __copiedDiagnostics: text }),
        },
      });
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page.getByRole('button', { name: '播放讲解', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('HTTP 403');
    await expect(page.getByRole('alert')).toContainText('Provider returned error');
    await page.getByText('查看服务商错误详情', { exact: true }).click();
    const details = page.locator('.error-details-disclosure pre');
    await expect(details).toContainText(`${baseUrl}/audio/speech`);
    await expect(details).toContainText(MODEL);
    await expect(details).toContainText('req-openrouter-fixture');
    await expect(details).toContainText('PERMISSION_DENIED');
    await expect(details).toContainText('TTS is unavailable for this project');
    await expect(details).toContainText('Google fixture');
    await expect(details).not.toContainText(SECRET);
    await page.getByRole('button', { name: '复制诊断信息' }).click();
    await expect(page.getByRole('button', { name: '已复制诊断' })).toBeVisible();
    const copied = await page.evaluate(
      () => (window as unknown as { __copiedDiagnostics: string }).__copiedDiagnostics,
    );
    expect(copied).toContain('PERMISSION_DENIED');
    expect(copied).not.toContain(SECRET);
    await page.getByRole('button', { name: '模型与语音', exact: true }).click();
    await page.getByRole('tab', { name: /文字转语音/ }).click();
    await page.getByRole('button', { name: '测试当前通道' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toContainText('HTTP 403');
    await dialog.getByText('查看服务商错误详情', { exact: true }).click();
    const testDetails = dialog.locator('.error-details-disclosure pre');
    await expect(testDetails).toContainText('TTS is unavailable for this project');
    await expect(testDetails).toContainText('req-openrouter-fixture');
    await expect(testDetails).not.toContainText(SECRET);
    expect(errors).toEqual([]);
  });
});

test('OpenRouter Gemini TTS preset uses Kore and keeps credentials only for the same address', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '模型与语音', exact: true }).click();
  await page.getByRole('tab', { name: /文字转语音/ }).click();
  await page.locator('#ms-tts-apiKey').fill('other-provider-test-key');
  await page.getByRole('button', { name: '使用 OpenRouter Gemini TTS 配置', exact: true }).click();
  await expect(page.locator('#ms-tts-model')).toHaveValue(MODEL);
  await expect(page.locator('#ms-tts-baseUrl')).toHaveValue('https://openrouter.ai/api/v1');
  await expect(page.locator('#ms-tts-voice')).toHaveValue('Kore');
  await expect(page.locator('#ms-tts-apiKey')).toHaveValue('');
  await expect(page.getByRole('switch', { name: '启用文字转语音' })).toBeChecked();
  await page.locator('#ms-tts-apiKey').fill('same-provider-test-key');
  await page.getByRole('button', { name: '使用 OpenRouter Gemini TTS 配置', exact: true }).click();
  await expect(page.locator('#ms-tts-apiKey')).toHaveValue('same-provider-test-key');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '模型与语音', exact: true }).click();
  await page.getByRole('tab', { name: /文字转语音/ }).click();
  await expect(page.locator('#ms-tts-voice')).toHaveValue('Kore');
  await expect(page.locator('#ms-tts-apiKey')).toHaveValue('');
});
