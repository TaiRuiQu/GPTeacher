import { expect, test, type Page } from './fixtures';

const AUDIO_SOURCE = `# 语音同步测试
:::step id="first" title="第一段" duration="10"
第一段讲解，先认识这个概念。
:::
:::step id="second" title="第二段" duration="10"
第二段讲解，现在检查理解。
:::`;

function wav(seconds = 3) {
  const sampleRate = 8000;
  const length = Math.round(sampleRate * seconds) * 2;
  const data = Buffer.alloc(44 + length);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + length, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(length, 40);
  return data;
}

async function prepare(page: Page, tts: boolean, stt = false) {
  const common = { provider: 'custom', baseUrl: 'http://127.0.0.1:9010/v1' };
  await page.request.put('/api/settings', {
    data: {
      settings: {
        text: { ...common, enabled: true, model: 'teaching-model' },
        tts: { ...common, enabled: tts, model: 'voice-model', voice: 'alloy' },
        stt: { ...common, enabled: stt, model: 'transcription-model', language: 'zh' },
      },
    },
  });
  await page.request.put('/api/workspace', {
    data: {
      workspace: {
        currentId: 'audio-test',
        sources: { 'audio-test': AUDIO_SOURCE },
        notes: [],
      },
    },
  });
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    Object.defineProperty(window, 'Audio', {
      value: function (src?: string) {
        const audio = new NativeAudio(src);
        Object.assign(window, { __teacherAudio: audio });
        return audio;
      },
    });
  });
}

async function fakeMicrophone(page: Page, permission: 'allowed' | 'denied' = 'allowed') {
  await page.addInitScript((permissionMode) => {
    const diagnostics = { stopped: 0, started: 0 };
    Object.assign(window, { __microphone: diagnostics });
    const track = { stop: () => (diagnostics.stopped += 1) };
    const stream = { getTracks: () => [track] };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          if (permissionMode === 'denied')
            throw new DOMException('Permission denied', 'NotAllowedError');
          return stream;
        },
      },
    });
    class FakeRecorder {
      static isTypeSupported() {
        return true;
      }
      state = 'inactive';
      mimeType = 'audio/webm';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start() {
        this.state = 'recording';
        diagnostics.started += 1;
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({
          data: new Blob(['recorded audio'], { type: this.mimeType }),
        } as BlobEvent);
        queueMicrotask(() => this.onstop?.());
      }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeRecorder });
  }, permission);
}

test('real WAV playback drives the timeline, resumes from cache, seeks, changes speed and advances steps', async ({
  page,
}) => {
  await prepare(page, true);
  let speechRequests = 0;
  await page.route('**/api/speech', async (route) => {
    speechRequests += 1;
    expect(route.request().postDataJSON().settings.model).toBe('voice-model');
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav() });
  });
  await page.goto('/');
  const slider = page.getByRole('slider', { name: '课堂播放进度' });
  await expect.poll(() => speechRequests).toBe(2);
  await expect(page.locator('.narration-status')).toContainText('2/2');
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect
    .poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(0.5);
  await page.getByRole('button', { name: '暂停讲解', exact: true }).click();
  const pausedTime = await slider.getAttribute('aria-valuenow');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __teacherAudio: HTMLAudioElement }).__teacherAudio.paused,
      ),
    )
    .toBe(true);
  await expect(slider).toHaveAttribute('aria-valuenow', pausedTime!);
  await slider.focus();
  await page.keyboard.press('Home');
  for (let index = 0; index < 5; index += 1) await page.keyboard.press('PageUp');
  await expect(slider).toHaveAttribute('aria-valuenow', '5');
  await page.getByRole('button', { name: '播放速度', exact: true }).click();
  await page.getByRole('menuitem', { name: '2×', exact: true }).click();
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __teacherAudio: HTMLAudioElement }).__teacherAudio.playbackRate,
      ),
    )
    .toBe(2);
  expect(speechRequests).toBe(2);
  await expect(page.getByRole('heading', { name: '第二段', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新播放', exact: true })).toBeVisible();
  await expect(slider).toHaveAttribute('aria-valuenow', '20');
  expect(speechRequests).toBe(2);
});

test('a 0.1 second timeline seek during playback reaches the audio without feeding back its clock', async ({
  page,
}) => {
  await prepare(page, true);
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!;
    const seeks: Array<{ target: number; previous: number }> = [];
    Object.assign(window, { __teacherAudioSeeks: seeks });
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      ...descriptor,
      set(this: HTMLMediaElement, value: number) {
        if (this === (window as unknown as { __teacherAudio?: HTMLAudioElement }).__teacherAudio)
          seeks.push({ target: value, previous: descriptor.get!.call(this) as number });
        descriptor.set!.call(this, value);
      },
    });
  });
  await page.route('**/api/speech', (route) =>
    route.fulfill({ contentType: 'audio/wav', body: wav(12) }),
  );
  await page.goto('/');
  const slider = page.getByRole('slider', { name: '课堂播放进度' });
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect
    .poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(0.25);
  await slider.focus();
  await page.evaluate(async () => {
    const seeks = (window as unknown as { __teacherAudioSeeks: unknown[] }).__teacherAudioSeeks;
    seeks.length = 0;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    if (seeks.length)
      throw new Error('The audio clock must not seek itself on each rendered frame.');
  });
  await page.keyboard.down('ArrowRight');
  const requestedTime = Number(await slider.getAttribute('aria-valuenow'));
  await page.keyboard.up('ArrowRight');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __teacherAudioSeeks: unknown[] }).__teacherAudioSeeks.length,
      ),
    )
    .toBe(1);
  const target = await page.evaluate(() => {
    const [seek] = (
      window as unknown as { __teacherAudioSeeks: Array<{ target: number; previous: number }> }
    ).__teacherAudioSeeks;
    return seek.target;
  });
  expect(target).toBeCloseTo((requestedTime / 10) * 12, 2);
  await expect(page.getByRole('button', { name: '暂停讲解', exact: true })).toBeVisible();
});

test('dragging backward across steps pauses the audio clock until release and paused seeks stay paused', async ({
  page,
}) => {
  await prepare(page, true);
  let speechRequests = 0;
  await page.route('**/api/speech', async (route) => {
    speechRequests += 1;
    await route.fulfill({ contentType: 'audio/wav', body: wav(10) });
  });
  await page.goto('/');
  await expect.poll(() => speechRequests).toBe(2);
  await expect(page.locator('.narration-status')).toContainText('2/2');
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await page.getByRole('button', { name: '跳转到第二段', exact: true }).click();
  const slider = page.getByRole('slider', { name: '课堂播放进度' });
  await expect
    .poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(10.1);
  const bounds = await page.locator('.lesson-slider').boundingBox();
  expect(bounds).not.toBeNull();
  const x = (value: number) => bounds!.x + (bounds!.width * value) / 20;
  const y = bounds!.y + bounds!.height / 2;
  await page.mouse.move(x(12), y);
  await page.mouse.down();
  for (const target of [8, 4, 6, 2]) {
    await page.mouse.move(x(target), y, { steps: 5 });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const observed = Number(await slider.getAttribute('aria-valuenow'));
    expect(Math.abs(observed - target)).toBeLessThan(0.5);
  }
  const held = Number(await slider.getAttribute('aria-valuenow'));
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(Number(await slider.getAttribute('aria-valuenow'))).toBeCloseTo(held, 1);
  await page.mouse.up();
  await expect(page.getByRole('heading', { name: '第一段', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '暂停讲解', exact: true })).toBeVisible();
  await expect
    .poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(held + 0.1);
  expect(speechRequests).toBe(2);
  await page.getByRole('button', { name: '暂停讲解', exact: true }).click();
  await page.mouse.move(x(5), y);
  await page.mouse.down();
  await page.mouse.move(x(1), y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '播放讲解', exact: true })).toBeVisible();
  const pausedTime = Number(await slider.getAttribute('aria-valuenow'));
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(Number(await slider.getAttribute('aria-valuenow'))).toBeCloseTo(pausedTime, 1);
  expect(speechRequests).toBe(2);
});

test('a failed TTS request is actionable and can retry successfully', async ({ page }) => {
  await prepare(page, true);
  const attempts = { first: 0, second: 0 };
  let failFirst = () => {};
  const failureGate = new Promise<void>((resolve) => {
    failFirst = resolve;
  });
  await page.route('**/api/speech', async (route) => {
    const isFirst = (route.request().postDataJSON().text as string).includes('第一段');
    const key = isFirst ? 'first' : 'second';
    attempts[key] += 1;
    if (isFirst && attempts.first === 1) {
      await failureGate;
      await route.fulfill({
        status: 503,
        json: { error: '语音服务暂时不可用，请重试。', code: 'unavailable' },
      });
    } else await route.fulfill({ contentType: 'audio/wav', body: wav() });
  });
  await page.goto('/');
  await expect(page.locator('.narration-status')).toContainText('1/2');
  failFirst();
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('语音服务暂时不可用');
  await page.getByRole('button', { name: '重试语音', exact: true }).click();
  await expect
    .poll(async () =>
      Number(
        await page.getByRole('slider', { name: '课堂播放进度' }).getAttribute('aria-valuenow'),
      ),
    )
    .toBeGreaterThan(0.5);
  expect(attempts.first).toBe(2);
  expect(attempts.second).toBe(1);
  await expect(page.getByRole('button', { name: '重试语音', exact: true })).not.toBeVisible();
});

test('TTS failure can fall back to captions and the visual clock', async ({ page }) => {
  await prepare(page, true);
  let attempts = 0;
  await page.route('**/api/speech', async (route) => {
    attempts += 1;
    await route.fulfill({ status: 401, json: { error: '请检查语音配置。', code: 'unauthorized' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('请检查语音配置');
  await page.getByRole('button', { name: '仅看字幕', exact: true }).click();
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect
    .poll(async () =>
      Number(
        await page.getByRole('slider', { name: '课堂播放进度' }).getAttribute('aria-valuenow'),
      ),
    )
    .toBeGreaterThan(0.2);
  expect(attempts).toBeGreaterThan(0);
  expect(attempts).toBeLessThanOrEqual(2);
  await expect(page.locator('.caption-area')).toContainText('第一段讲解');
});

test('recording transcribes multipart audio into the question without sending it to the teacher', async ({
  page,
}) => {
  await prepare(page, false, true);
  await fakeMicrophone(page);
  let answers = 0;
  let transcriptions = 0;
  await page.route('**/api/answer', async (route) => {
    answers += 1;
    await route.fulfill({ json: { answer: '不应自动调用' } });
  });
  await page.route('**/api/transcribe', async (route) => {
    transcriptions += 1;
    expect(route.request().headers()['content-type']).toContain('multipart/form-data');
    const payload = route.request().postDataBuffer()!.toString();
    expect(payload).toContain('name="settings"');
    expect(payload).toContain('transcription-model');
    expect(payload).toContain('filename="question.webm"');
    await route.fulfill({ json: { text: '为什么这个概念成立？' } });
  });
  await page.goto('/');
  const question = page.getByRole('textbox', { name: '向老师提问' });
  await question.fill('我想知道，');
  await page.getByRole('button', { name: '语音提问', exact: true }).click();
  await expect(page.getByRole('button', { name: '完成录音并识别', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '完成录音并识别', exact: true }).click();
  await expect(question).toHaveValue('我想知道， 为什么这个概念成立？');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __microphone: { stopped: number } }).__microphone.stopped,
      ),
    )
    .toBe(1);
  expect(transcriptions).toBe(1);
  expect(answers).toBe(0);
});

test('microphone permission failure is explicit and allows retrying', async ({ page }) => {
  await prepare(page, false, true);
  await fakeMicrophone(page, 'denied');
  await page.goto('/');
  await page.getByRole('button', { name: '语音提问', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('允许麦克风权限');
  await expect(page.getByRole('button', { name: '语音提问', exact: true })).toBeEnabled();
});

test('cancelled recording and transcription release the microphone and never fill stale text', async ({
  page,
}) => {
  await prepare(page, false, true);
  await fakeMicrophone(page);
  let transcriptions = 0;
  let releaseReply = () => {};
  await page.route('**/api/transcribe', async (route) => {
    transcriptions += 1;
    await new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    await route.fulfill({ json: { text: '已取消的录音不得回填' } }).catch(() => {});
  });
  await page.goto('/');
  await page.getByRole('button', { name: '语音提问', exact: true }).click();
  await expect(page.getByRole('button', { name: '完成录音并识别', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消录音', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __microphone: { stopped: number } }).__microphone.stopped,
      ),
    )
    .toBe(1);
  expect(transcriptions).toBe(0);
  await page.getByRole('button', { name: '语音提问', exact: true }).click();
  await page.getByRole('button', { name: '完成录音并识别', exact: true }).click();
  await expect(page.getByRole('button', { name: '正在识别语音', exact: true })).toBeVisible();
  await expect.poll(() => transcriptions).toBe(1);
  const aborted = page.waitForEvent('requestfailed', {
    predicate: (request) => request.url().endsWith('/api/transcribe'),
  });
  await page.getByRole('button', { name: '取消录音', exact: true }).click();
  await aborted;
  releaseReply();
  await expect(page.getByRole('textbox', { name: '向老师提问' })).toHaveValue('');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __microphone: { stopped: number } }).__microphone.stopped,
      ),
    )
    .toBe(2);
  await expect(page.getByRole('button', { name: '语音提问', exact: true })).toBeEnabled();
});

test('opening notes cancels both recording and pending transcription without filling stale questions', async ({
  page,
}) => {
  await prepare(page, false, true);
  await fakeMicrophone(page);
  let requests = 0;
  let releaseReply = () => {};
  await page.route('**/api/transcribe', async (route) => {
    requests += 1;
    await new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    await route.fulfill({ json: { text: '笔记页返回后不应出现这句转写' } }).catch(() => {});
  });
  await page.goto('/');
  await page.getByRole('button', { name: '语音提问', exact: true }).click();
  await expect(page.getByRole('button', { name: '完成录音并识别', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '课堂笔记', exact: true }).click();
  await expect(page.getByRole('heading', { name: '课堂笔记', exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __microphone: { stopped: number } }).__microphone.stopped,
      ),
    )
    .toBe(1);
  expect(requests).toBe(0);
  await page.getByRole('button', { name: '我的课堂', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '向老师提问' })).toHaveValue('');
  await page.getByRole('button', { name: '语音提问', exact: true }).click();
  await page.getByRole('button', { name: '完成录音并识别', exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  const aborted = page.waitForEvent('requestfailed', {
    predicate: (request) => request.url().endsWith('/api/transcribe'),
  });
  await page.getByRole('button', { name: '课堂笔记', exact: true }).click();
  await aborted;
  releaseReply();
  await expect(page.getByRole('heading', { name: '课堂笔记', exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __microphone: { stopped: number } }).__microphone.stopped,
      ),
    )
    .toBe(2);
  await page.getByRole('button', { name: '我的课堂', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '向老师提问' })).toHaveValue('');
  await expect(page.getByRole('button', { name: '语音提问', exact: true })).toBeEnabled();
});
