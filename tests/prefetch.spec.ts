import { expect, test, type Page } from './fixtures';

function source(count: number) {
  return `# 提前准备语音\n${Array.from({ length: count }, (_, index) => `:::step id="step-${index + 1}" title="讲解${index + 1}" duration="3"\n第${index + 1}段独立讲解。\n:::`).join('\n')}`;
}

function wav(seconds = 0.65) {
  const rate = 8000;
  const bytes = Math.round(rate * seconds) * 2;
  const result = Buffer.alloc(44 + bytes);
  result.write('RIFF', 0);
  result.writeUInt32LE(36 + bytes, 4);
  result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(rate, 24);
  result.writeUInt32LE(rate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write('data', 36);
  result.writeUInt32LE(bytes, 40);
  return result;
}

async function prepare(page: Page, count: number) {
  const common = { enabled: true, provider: 'custom', baseUrl: 'http://127.0.0.1:9010/v1' };
  await page.request.put('/api/settings', {
    data: {
      settings: {
        text: { ...common, model: 'teaching-model' },
        tts: { ...common, model: 'voice-model', voice: 'alloy' },
        stt: { ...common, model: 'asr-model', enabled: false, language: 'zh' },
      },
    },
  });
  await page.request.put('/api/workspace', {
    data: {
      workspace: {
        currentId: 'prefetch',
        sources: { prefetch: source(count) },
        notes: [],
      },
    },
  });
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    const played: Array<{ startedAt: number; source: string }> = [];
    Object.assign(window, { __prefetchPlayed: played });
    Object.defineProperty(window, 'Audio', {
      value: function (src?: string) {
        const audio = new NativeAudio(src);
        const play = audio.play.bind(audio);
        audio.play = () => {
          played.push({ startedAt: performance.now(), source: audio.src });
          return play();
        };
        return audio;
      },
    });
  });
}

test('the prepared first segment plays while remaining audio is generated with at most two concurrent requests', async ({
  page,
}) => {
  await prepare(page, 6);
  let requests = 0;
  let inFlight = 0;
  let peak = 0;
  let completed = 0;
  const releases = new Map<number, () => void>();
  await page.route('**/api/speech', async (route) => {
    requests += 1;
    const segment = Number((route.request().postDataJSON().text as string).match(/第(\d+)段/)![1]);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) => releases.set(segment, resolve));
    await route.fulfill({ contentType: 'audio/wav', body: wav(segment === 1 ? 3 : 0.65) });
    inFlight -= 1;
    completed += 1;
  });
  await page.goto('/');
  const slider = page.getByRole('slider', { name: '课堂播放进度' });
  await expect.poll(() => requests).toBe(2);
  expect(
    await page.evaluate(
      () => (window as unknown as { __prefetchPlayed: unknown[] }).__prefetchPlayed.length,
    ),
  ).toBe(0);
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  expect(
    await page.evaluate(
      () => (window as unknown as { __prefetchPlayed: unknown[] }).__prefetchPlayed.length,
    ),
  ).toBe(0);
  releases.get(1)!();
  releases.delete(1);
  await expect.poll(() => completed).toBe(1);
  await expect.poll(() => requests).toBe(3);
  await expect(page.locator('.narration-status')).toContainText('1/6');
  await expect
    .poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(0.1);
  expect(
    await page.evaluate(
      () => (window as unknown as { __prefetchPlayed: unknown[] }).__prefetchPlayed.length,
    ),
  ).toBe(1);
  for (const [requested, done] of [
    [3, 3],
    [5, 5],
    [6, 6],
  ]) {
    await expect.poll(() => requests).toBe(requested);
    for (const [segment, release] of releases) {
      release();
      releases.delete(segment);
    }
    await expect.poll(() => completed).toBe(done);
  }
  expect(peak).toBe(2);
  await expect(page.locator('.narration-status')).toContainText('6/6');
  await expect(page.getByRole('button', { name: '重新播放', exact: true })).toBeVisible({
    timeout: 10_000,
  });
  expect(requests).toBe(6);
  expect(
    await page.evaluate(
      () => (window as unknown as { __prefetchPlayed: unknown[] }).__prefetchPlayed.length,
    ),
  ).toBe(6);
  await expect(slider).toHaveAttribute('aria-valuenow', '18');
});

test('changing voice cancels obsolete preparation and cannot install its late results', async ({
  page,
}) => {
  await prepare(page, 3);
  let oldRequests = 0;
  let newRequests = 0;
  const releaseOld: Array<() => void> = [];
  await page.route('**/api/speech', async (route) => {
    const voice = route.request().postDataJSON().settings.voice as string;
    if (voice === 'alloy') {
      oldRequests += 1;
      await new Promise<void>((resolve) => releaseOld.push(resolve));
      await route.fulfill({ contentType: 'audio/wav', body: wav() }).catch(() => {});
    } else {
      expect(voice).toBe('Kore');
      newRequests += 1;
      await route.fulfill({ contentType: 'audio/wav', body: wav() });
    }
  });
  await page.goto('/');
  await expect.poll(() => oldRequests).toBe(2);
  const aborted = [
    page.waitForEvent('requestfailed', {
      predicate: (request) =>
        request.url().endsWith('/api/speech') && request.postDataJSON().settings.voice === 'alloy',
    }),
  ];
  await page.getByRole('button', { name: '模型与语音', exact: true }).click();
  await page.getByRole('tab', { name: /文字转语音/ }).click();
  await page.locator('#ms-tts-voice').fill('Kore');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await Promise.all(aborted);
  await expect.poll(() => newRequests).toBe(3);
  await expect(page.locator('.narration-status')).toContainText('3/3');
  releaseOld.splice(0).forEach((release) => release());
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新播放', exact: true })).toBeVisible();
  expect(newRequests).toBe(3);
  expect(oldRequests).toBe(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('jumping to an unprepared segment prioritizes its audio without waiting for earlier pending segments', async ({
  page,
}) => {
  await prepare(page, 6);
  const requested: number[] = [];
  const releases = new Map<number, () => void>();
  let releaseAll = false;
  await page.route('**/api/speech', async (route) => {
    const segment = Number((route.request().postDataJSON().text as string).match(/第(\d+)段/)![1]);
    requested.push(segment);
    if (!releaseAll) await new Promise<void>((resolve) => releases.set(segment, resolve));
    await route.fulfill({ contentType: 'audio/wav', body: wav(2) }).catch(() => {});
  });
  await page.goto('/');
  await expect.poll(() => requested.length).toBe(2);
  expect(requested).toEqual([1, 2]);
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await page.getByRole('button', { name: '跳转到讲解6', exact: true }).click();
  releases.get(2)!();
  releases.delete(2);
  await expect.poll(() => requested.length).toBe(3);
  expect(requested[2]).toBe(6);
  releases.get(6)!();
  releases.delete(6);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __prefetchPlayed: unknown[] }).__prefetchPlayed.length,
      ),
    )
    .toBe(1);
  const slider = page.getByRole('slider', { name: '课堂播放进度' });
  await expect
    .poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(15);
  expect(releases.has(1)).toBe(true);
  releaseAll = true;
  releases.forEach((release) => release());
  releases.clear();
  await expect(page.locator('.narration-status')).toContainText('6/6');
});
