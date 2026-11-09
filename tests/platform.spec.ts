import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  getCourseLessons,
  findCourseNode,
  type AgentCommand,
  type AgentJob,
  type Course,
  type CourseChapter,
  type CourseLesson,
  type PlatformState,
} from '../src/lib/platform';

const mathCourseId = 'sample-equations';
const firstLessonId = 'equations-meaning';

async function readState(request: APIRequestContext): Promise<PlatformState> {
  const response = await request.get('/api/platform');
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<PlatformState>;
}

async function createLearner(request: APIRequestContext, suffix: string) {
  const response = await request.put('/api/platform/profile', {
    data: {
      learner: {
        name: `测试同学-${suffix}`,
        grade: 7,
        dailyMinutes: 25,
        goal: '理解概念，再独立解决问题。',
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<PlatformState>;
}

async function openFirstLesson(page: Page) {
  await page.goto(`/#page=classroom&course=${mathCourseId}&lesson=${firstLessonId}`);
  await expect(page.getByRole('heading', { name: '未知数藏在哪里', exact: true })).toBeVisible();
}

async function installBrowserVoice(page: Page) {
  await page.addInitScript(() => {
    const control = {
      amplitude: 0,
      cancelled: 0,
      spoken: [] as string[],
      utterance: null as null | TestUtterance,
      recognition: null as null | TestRecognition,
    };
    class TestUtterance {
      text: string;
      lang = '';
      rate = 1;
      voice = null;
      onstart: (() => void) | null = null;
      onboundary: ((event: { charIndex: number }) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    class TestRecognition {
      lang = '';
      continuous = false;
      interimResults = false;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        control.recognition = this;
      }
      stop() {
        this.onend?.();
      }
      abort() {}
    }
    Object.defineProperty(window, '__classroomVoiceTest', { value: control });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: TestUtterance,
      configurable: true,
    });
    Object.defineProperty(window, 'SpeechRecognition', {
      value: TestRecognition,
      configurable: true,
    });
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        getVoices: () => [{ lang: 'zh-CN', localService: true }],
        speak(message: TestUtterance) {
          control.utterance = message;
          control.spoken.push(message.text);
          window.setTimeout(() => {
            message.onstart?.();
            message.onboundary?.({ charIndex: 9 });
          }, 0);
        },
        cancel() {
          control.cancelled++;
        },
        pause() {},
        resume() {},
      },
      configurable: true,
    });
    class TestAudioContext {
      async resume() {}
      async close() {}
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return {
          fftSize: 2048,
          getFloatTimeDomainData(samples: Float32Array) {
            samples.fill(control.amplitude);
          },
        };
      }
    }
    Object.defineProperty(window, 'AudioContext', { value: TestAudioContext, configurable: true });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => ({ getTracks: () => [{ stop() {} }] }),
      configurable: true,
    });
  });
}

/** All pedagogical job endpoints are intercepted, including accidental submissions. */
test.beforeEach(async ({ page }) => {
  await installBrowserVoice(page);
  await page.route('**/api/platform/backends', (route) =>
    route.fulfill({
      json: {
        backends: [
          {
            id: 'codex',
            name: 'Codex',
            available: true,
            version: '1.0.0-test',
            message: '测试用 CLI 状态；不调用模型。',
          },
          {
            id: 'claude',
            name: 'Claude Code',
            available: true,
            version: '1.0.0-test',
            message: '测试用 CLI 状态；不调用模型。',
          },
        ],
      },
    }),
  );
  await page.route('**/api/platform/jobs**', (route) =>
    route.fulfill({
      status: 503,
      json: { error: '本测试未启用教学任务模拟器。', code: 'OFFLINE_TEST' },
    }),
  );
});

test('entry opens the classroom, keeps a dominant whiteboard and resumes the learner’s last lesson', async ({
  page,
  request,
}) => {
  const initial = await readState(request);
  const course = initial.courses.find((item) => item.id === mathCourseId)!;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('classroom-board')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: getCourseLessons(course)[0].title, exact: true }),
  ).toBeVisible();
  await expect(page.locator('.platform-sidebar')).toHaveCount(0);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(async () => {
        const box = await page.getByTestId('classroom-board').boundingBox();
        return box ? box.width / viewport.width : 0;
      })
      .toBeGreaterThan(0.65);
    const board = await page.getByTestId('classroom-board').boundingBox();
    expect(board!.height / viewport.height).toBeGreaterThan(0.6);
    expect(board!.y + board!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1),
    ).toBe(true);
  }
  const expanded = await page.getByTestId('classroom-board').boundingBox();
  await page.locator('.cr-dock-toggle').click();
  await expect(page.getByTestId('classroom-dock')).toBeHidden();
  await expect
    .poll(async () => (await page.getByTestId('classroom-board').boundingBox())!.width)
    .toBeGreaterThan(expanded!.width + 200);
  await page.getByRole('button', { name: '展开辅助面板', exact: true }).click();
  await expect(page.getByTestId('classroom-dock')).toBeVisible();
  await page.getByRole('tab', { name: '随堂练习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '自己试一试', exact: true })).toBeVisible();
  await expect(page.getByTestId('classroom-board')).toBeVisible();
  await page.getByRole('tab', { name: '学习笔记', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '课堂笔记', exact: true })).toBeVisible();
  await expect(page.getByTestId('classroom-board')).toBeVisible();
  const resumed = getCourseLessons(course)[1];
  const saved = await request.put('/api/platform/progress', {
    data: {
      learnerId: initial.activeLearnerId,
      courseId: course.id,
      lessonId: resumed.id,
      position: 3,
      completed: false,
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: resumed.title, exact: true })).toBeVisible();
  await expect(page.getByTestId('classroom-board')).toBeVisible();
  await expect(page.getByRole('slider', { name: '课程播放位置' })).toHaveValue('3');
});

test('a slow completion save cannot be undone by a paused playback autosave', async ({
  page,
  request,
}) => {
  const initial = await createLearner(request, '完成记录');
  const learnerId = initial.activeLearnerId;
  await page.route('**/api/platform/progress', async (route) => {
    const progress = route.request().postDataJSON() as { completed: boolean };
    if (progress.completed) await new Promise((resolve) => setTimeout(resolve, 1800));
    await route.continue();
  });
  await openFirstLesson(page);
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect
    .poll(async () => Number(await page.getByRole('slider', { name: '课程播放位置' }).inputValue()))
    .toBeGreaterThan(1);
  await page.getByRole('button', { name: '标记学完，做练习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '自己试一试', exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const state = await readState(request);
      return state.progress.find((p) => p.learnerId === learnerId && p.lessonId === firstLessonId)
        ?.completed;
    })
    .toBe(true);
  // A queued autosave after the slow response would appear in the server snapshot and reload.
  await page.reload();
  await expect(page.locator('.lesson-title').getByText('已学完', { exact: true })).toBeVisible();
  const saved = await readState(request);
  expect(
    saved.progress.find((p) => p.learnerId === learnerId && p.lessonId === firstLessonId)
      ?.completed,
  ).toBe(true);
  expect(saved.attempts.filter((a) => a.learnerId === learnerId)).toHaveLength(0);
});

test('sample curriculum, playback, notes and completion use real persistent platform state', async ({
  page,
  request,
}) => {
  const initial = await createLearner(request, '课堂');
  const learnerId = initial.activeLearnerId;
  const exercises = initial.courses.flatMap((course) =>
    getCourseLessons(course).flatMap((lesson) => lesson.exercises),
  );
  expect(exercises.length).toBeGreaterThan(0);
  expect(exercises.every((exercise) => exercise.answer === '' && exercise.explanation === '')).toBe(
    true,
  );
  await openFirstLesson(page);
  await page.getByRole('tab', { name: '学习树', exact: true }).click();
  await expect(page.getByTestId('learning-tree')).toBeVisible();
  await expect(page.locator('[data-node-id="equations-meaning"]')).toContainText('未知数藏在哪里');
  await page.getByRole('tab', { name: '提问', exact: true }).click();
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停讲解', exact: true })).toBeVisible();
  await expect
    .poll(async () => Number(await page.getByRole('slider', { name: '课程播放位置' }).inputValue()))
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: '暂停讲解', exact: true }).click();
  await page.getByRole('button', { name: '下一讲解片段' }).click();
  await expect(
    page.locator('.prose-board').getByRole('heading', { name: '什么样的等式叫方程' }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await readState(request)).progress.find(
          (item) => item.learnerId === learnerId && item.lessonId === firstLessonId,
        )?.position ?? 0,
    )
    .toBeGreaterThan(1);
  await page.getByRole('tab', { name: '学习笔记' }).click();
  await expect(page.getByTestId('classroom-board')).toBeVisible();
  const note = '等式两边做同样的运算，才能保持相等。';
  await page.getByRole('textbox', { name: '课堂笔记' }).fill(note);
  await page.getByRole('button', { name: '保存学习笔记' }).click();
  await expect(page.locator('.classroom-note-list')).toContainText(note);
  await page.reload();
  await page.getByRole('tab', { name: '学习笔记' }).click();
  await expect(page.locator('.classroom-note-list')).toContainText(note);
  await page.getByRole('tab', { name: '课堂讲解' }).click();
  await page.getByRole('button', { name: '标记学完，做练习' }).click();
  await expect(page.getByTestId('classroom-board')).toBeVisible();
  await expect(page.getByRole('tab', { name: /随堂练习/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect
    .poll(
      async () =>
        (await readState(request)).progress.find(
          (item) => item.learnerId === learnerId && item.lessonId === firstLessonId,
        )?.completed,
    )
    .toBe(true);
  await page.reload();
  await expect(page.locator('.lesson-title')).toContainText('已学完');
});

test('learning profiles save through settings and isolate each learner’s records', async ({
  page,
  request,
}) => {
  const original = await createLearner(request, '档案原始');
  const originalId = original.activeLearnerId;
  const noteResponse = await request.post('/api/platform/notes', {
    data: {
      learnerId: originalId,
      courseId: mathCourseId,
      lessonId: firstLessonId,
      body: '这条笔记属于原学习档案。',
    },
  });
  expect(noteResponse.ok(), await noteResponse.text()).toBe(true);
  await openFirstLesson(page);
  await page.getByRole('button', { name: '学习设置', exact: true }).click();
  await page.getByRole('button', { name: '新增档案' }).click();
  await page.getByRole('textbox', { name: '新学习者的称呼' }).fill('新档案小林');
  await page.getByRole('textbox', { name: '学习目标' }).fill('用生活例子学习数学。');
  await page.getByRole('button', { name: '保存学习档案' }).click();
  await expect(page.getByRole('textbox', { name: '你的称呼' })).toHaveValue('新档案小林');
  const created = await readState(request);
  expect(created.activeLearnerId).not.toBe(originalId);
  await page.getByRole('button', { name: '关闭学习设置窗口', exact: true }).click();
  await page.getByRole('button', { name: '学习记录', exact: true }).click();
  await page
    .getByRole('dialog', { name: '学习记录', exact: true })
    .getByRole('tab', { name: /学习笔记/ })
    .click();
  await expect(page.getByRole('heading', { name: '给理解留个记号' })).toBeVisible();
  await expect(page.getByText('这条笔记属于原学习档案。', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭学习记录窗口', exact: true }).click();
  await page.getByRole('button', { name: '学习设置', exact: true }).click();
  await page.getByRole('combobox', { name: '切换学习档案' }).selectOption(originalId);
  await expect(page.getByRole('textbox', { name: '你的称呼' })).toHaveValue('测试同学-档案原始');
  await page.getByRole('button', { name: '关闭学习设置窗口', exact: true }).click();
  await page.getByRole('button', { name: '学习记录', exact: true }).click();
  await page
    .getByRole('dialog', { name: '学习记录', exact: true })
    .getByRole('tab', { name: /学习笔记/ })
    .click();
  await expect(page.getByText('这条笔记属于原学习档案。', { exact: true })).toBeVisible();
});

type MockController = {
  state: PlatformState;
  submitted: AgentCommand[];
  complete: () => void;
  fail: (message: string) => void;
};

async function mockTeaching(page: Page, initial: PlatformState): Promise<MockController> {
  const state = structuredClone(initial);
  state.jobs = [];
  state.attempts = [];
  state.messages = [];
  state.reviews = [];
  let sequence = 0;
  const submitted: AgentCommand[] = [];
  const makeJob = (command: AgentCommand, retryOf?: string): AgentJob => ({
    id: `mock-job-${++sequence}`,
    command,
    status: 'running',
    stage: '编排课程路径',
    progress: 35,
    events: [
      {
        id: `event-${sequence}`,
        time: new Date().toISOString(),
        stage: '编排课程路径',
        message: '已经保存任务，正在分阶段执行。',
        status: 'running',
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(retryOf ? { retryOf } : {}),
  });
  await page.route(/\/api\/platform$/, (route) => route.fulfill({ json: state }));
  await page.route('**/api/platform/jobs**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/platform/jobs' && route.request().method() === 'POST') {
      const command = route.request().postDataJSON() as AgentCommand;
      submitted.push(command);
      const job = makeJob(command);
      state.jobs.unshift(job);
      if (command.action === 'tutor')
        state.messages.push({
          id: `mock-user-${sequence}`,
          learnerId: command.learnerId,
          courseId: command.courseId!,
          lessonId: command.lessonId!,
          role: 'user',
          content: command.question!,
          createdAt: new Date().toISOString(),
        });
      await route.fulfill({ status: 202, json: { job } });
      return;
    }
    const match = path.match(/\/jobs\/([^/]+)(?:\/(cancel|retry))?$/);
    const job = state.jobs.find((item) => item.id === match?.[1]);
    if (!job) {
      await route.fulfill({ status: 404, json: { error: '测试任务不存在。' } });
      return;
    }
    if (match?.[2] === 'cancel') {
      job.status = 'cancelled';
      job.stage = '已取消';
      job.events.push({
        id: `cancel-${job.id}`,
        time: new Date().toISOString(),
        stage: '已取消',
        message: '任务已取消，检查点已保留。',
        status: 'done',
      });
      await route.fulfill({ json: { job } });
      return;
    }
    if (match?.[2] === 'retry') {
      const next = makeJob(job.command, job.id);
      state.jobs.unshift(next);
      await route.fulfill({ status: 202, json: { job: next } });
      return;
    }
    await route.fulfill({ json: { job } });
  });
  return {
    state,
    submitted,
    fail(message) {
      const job = state.jobs[0];
      job.status = 'failed';
      job.error = message;
      job.stage = '检查教学内容';
      job.events[0].status = 'error';
    },
    complete() {
      const job = state.jobs[0];
      const command = job.command;
      const time = new Date().toISOString();
      job.status = 'completed';
      job.stage = '已完成';
      job.progress = 100;
      job.updatedAt = time;
      job.events[0].status = 'done';
      job.events.push({
        id: `done-${job.id}`,
        time,
        stage: '已完成',
        message: '教学结果已检查并保存。',
        status: 'done',
      });
      if (command.action === 'create_course') {
        const base = state.courses.find((course) => course.id === mathCourseId)!;
        const leaf = (id: string, title: string): CourseLesson => ({
          kind: 'lesson',
          status: 'planned',
          id,
          title,
          objective: '理解分数的单位与比较方法。',
          minutes: 10,
          source: '',
          exercises: [],
          knowledgePoints: ['分数单位', '同分母比较'],
          techniques: ['把整体平均分成同样多份，再比较份数。'],
          sources: [
            {
              title: '模拟检索：分数的意义',
              url: 'https://www.khanacademy.org/math/arithmetic/fraction-arithmetic',
            },
          ],
        });
        const course: Course = {
          ...structuredClone(base),
          id: `mock-course-${sequence}`,
          title: '分数的意义与比较',
          topic: command.topic || base.topic,
          origin: 'agent',
          createdAt: time,
          nodes: [
            {
              kind: 'chapter',
              id: 'fractions-root',
              title: '分数入门',
              objective: '从整体与部分开始理解分数。',
              children: [
                leaf('fractions-meaning', '分数表示什么'),
                {
                  kind: 'chapter',
                  id: 'fractions-comparison',
                  title: '分数比较',
                  objective: '用分数单位解释大小关系。',
                  children: [leaf('fractions-compare', '同分母分数比较')],
                },
              ],
            },
          ],
        };
        state.courses.unshift(course);
        job.result = { courseId: course.id, nodeId: course.nodes[0].id };
      } else if (command.action === 'extend_course' || command.action === 'replan') {
        const course = state.courses.find((item) => item.id === command.courseId)!;
        const leaf: CourseLesson = {
          kind: 'lesson',
          status: 'planned',
          id: `remedial-lesson-${sequence}`,
          title: '移项之前的等式性质',
          objective: '用相同运算维持相等关系。',
          minutes: 10,
          source: '',
          exercises: [],
          knowledgePoints: ['等式性质'],
          techniques: ['先画天平，再写两边同时变化。'],
          sources: [
            { title: '模拟检索：方程基础', url: 'https://www.khanacademy.org/math/algebra' },
          ],
        };
        const branch: CourseChapter = {
          kind: 'chapter',
          id: `remedial-branch-${sequence}`,
          title: '根据练习研究的巩固分支',
          objective: '巩固当前课程中的薄弱点。',
          children: [leaf],
        };
        const parent = command.parentNodeId
          ? findCourseNode(course, command.parentNodeId)
          : undefined;
        if (parent?.kind === 'chapter') parent.children.push(branch);
        else course.nodes.push(branch);
        job.result = { courseId: course.id, nodeId: branch.id };
      } else if (command.action === 'generate_lessons') {
        const course = state.courses.find((item) => item.id === command.courseId)!;
        const reference = getCourseLessons(
          state.courses.find((item) => item.id === mathCourseId)!,
        )[0];
        for (const lessonId of command.lessonIds || []) {
          const lesson = findCourseNode(course, lessonId);
          if (!lesson || lesson.kind !== 'lesson') continue;
          lesson.status = 'ready';
          lesson.source = reference.source.replace(/^# .+/, `# ${lesson.title}`);
          lesson.exercises = structuredClone(reference.exercises).map((exercise, index) => ({
            ...exercise,
            id: `${lessonId}-q${index + 1}`,
          }));
        }
        job.result = { courseId: course.id, nodeId: command.lessonIds?.[0] };
      } else if (command.action === 'tutor') {
        const answer = '先把等号想成平衡的天平。两边同时减去同一个数，为什么还能保持平衡？';
        state.messages.push({
          id: `mock-answer-${sequence}`,
          learnerId: command.learnerId,
          courseId: command.courseId!,
          lessonId: command.lessonId!,
          role: 'assistant',
          content: answer,
          createdAt: time,
        });
        job.result = { message: answer };
      } else if (command.action === 'grade') {
        const selectedCourse = state.courses.find((course) => course.id === command.courseId)!;
        const lesson = getCourseLessons(selectedCourse).find(
          (item) => item.id === command.lessonId,
        )!;
        const attempt = {
          id: `mock-attempt-${sequence}`,
          learnerId: command.learnerId,
          courseId: command.courseId!,
          lessonId: command.lessonId!,
          answers: command.answers!,
          score: 100,
          feedback: '你能识别方程，也能通过代入检验结果。',
          items: lesson.exercises.map((exercise) => ({
            exerciseId: exercise.id,
            correct: true,
            feedback: '答案和解释完整，继续保持代入检验的习惯。',
          })),
          nextSteps: ['再试一题包含括号的方程。'],
          createdAt: time,
        };
        state.attempts.push(attempt);
        job.result = { attemptId: attempt.id, message: attempt.feedback };
      } else {
        const review = {
          id: `mock-review-${sequence}`,
          learnerId: command.learnerId,
          title: '从检验开始的学习建议',
          summary: '根据这次练习，你已经能用代入检查方程的解。',
          strengths: ['能识别一元一次方程。'],
          gaps: ['尚无去括号练习的证据。'],
          nextSteps: ['学习下一课。', '完成一道去括号练习。'],
          createdAt: time,
        };
        state.reviews.unshift(review);
        job.result = { reviewId: review.id, message: review.summary };
      }
    },
  };
}

test('course generation submits a real command shape and survives page reload until completion', async ({
  page,
  request,
}) => {
  const initial = await createLearner(request, '生成');
  const mock = await mockTeaching(page, initial);
  await page.goto('/');
  await expect(page.getByTestId('classroom-board')).toBeVisible();
  await page.locator('.cr-new-course').click();
  await expect(page.getByRole('dialog', { name: '研究章节', exact: true })).toBeVisible();
  await page.locator('.class-course-form textarea').fill('分数的意义与比较');
  await page.getByRole('combobox', { name: '候选课时数' }).selectOption('2');
  await page.getByRole('button', { name: '联网研究章节' }).click();
  await expect(page.getByRole('dialog')).toContainText('编排课程路径');
  expect(mock.submitted[0]).toMatchObject({
    action: 'create_course',
    backend: initial.preferredBackend,
    learnerId: initial.activeLearnerId,
    topic: '分数的意义与比较',
    subject: '数学',
    lessonCount: 2,
  });
  await page.reload();
  await expect(page.getByTestId('classroom-board')).toBeVisible();
  await page.getByRole('button', { name: 'Agent 工作台', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('已经保存任务，正在分阶段执行。');
  mock.complete();
  await expect(page.getByRole('dialog')).toContainText('已完成');
  await page.getByRole('button', { name: '打开课程', exact: true }).click();
  await expect(page.getByTestId('classroom-board')).toBeVisible();
  await expect(page.getByTestId('chapter-preview')).toContainText('分数入门');
  const researched = mock.state.courses.find((course) => course.id === 'mock-course-1')!;
  expect(
    getCourseLessons(researched).every(
      (lesson) => lesson.status === 'planned' && !lesson.source && lesson.exercises.length === 0,
    ),
  ).toBe(true);
  await page.getByRole('tab', { name: '学习树', exact: true }).click();
  const tree = page.getByTestId('learning-tree');
  await tree.locator('[data-node-id="fractions-comparison"] .learning-tree-disclosure').click();
  await tree.locator('[data-node-id="fractions-compare"] .learning-tree-select').click();
  const preview = page.getByTestId('lesson-preview');
  await expect(preview).toContainText('分数单位');
  await expect(preview).toContainText('把整体平均分成同样多份');
  await expect(preview.getByRole('link', { name: '模拟检索：分数的意义' })).toHaveAttribute(
    'href',
    'https://www.khanacademy.org/math/arithmetic/fraction-arithmetic',
  );
  await tree.getByRole('checkbox', { name: '选择分数比较', exact: true }).check();
  await page.getByRole('button', { name: /生成所选讲解（1）/ }).click();
  await expect.poll(() => mock.submitted.length).toBe(2);
  expect(mock.submitted[1]).toMatchObject({
    action: 'generate_lessons',
    courseId: 'mock-course-1',
    lessonIds: ['fractions-compare'],
  });
  await expect(page.getByTestId('classroom-board')).toBeVisible();
  mock.complete();
  await expect(page.getByRole('button', { name: '播放讲解', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '同分母分数比较', exact: true })).toBeVisible();
  expect(findCourseNode(researched, 'fractions-compare')).toMatchObject({ status: 'ready' });
  expect(findCourseNode(researched, 'fractions-meaning')).toMatchObject({
    status: 'planned',
    source: '',
  });
  await page.reload();
  await expect(page.getByRole('button', { name: '播放讲解', exact: true })).toBeVisible();
  await page.locator('.cr-course-switch').click();
  const library = page.getByRole('dialog', { name: '学习树', exact: true });
  await expect(library).toContainText('分数的意义与比较');
  await library.locator('[data-node-id="fractions-meaning"] .learning-tree-select').click();
  await expect(page.getByTestId('classroom-board')).toBeVisible();
});

test('failed jobs show useful errors and can be retried then cancelled', async ({
  page,
  request,
}) => {
  const mock = await mockTeaching(page, await createLearner(request, '恢复'));
  await page.goto('/');
  await page.locator('.cr-new-course').click();
  await page.locator('.class-course-form textarea').fill('光的反射');
  await page.getByRole('button', { name: '联网研究章节' }).click();
  await expect(page.getByRole('dialog')).toContainText('编排课程路径');
  mock.fail('测试后端登录已过期，请重新登录后重试。');
  await expect(page.getByRole('dialog')).toContainText('测试后端登录已过期，请重新登录后重试。');
  await page.getByRole('button', { name: '重新执行', exact: true }).click();
  await expect(page.locator('.job-card.status-running')).toHaveCount(1);
  expect(mock.state.jobs[0].retryOf).toBe('mock-job-1');
  await page.getByRole('button', { name: '取消任务', exact: true }).click();
  await expect(page.locator('.job-card.status-cancelled')).toContainText('检查点已保留');
});

test('speaker echo does not freeze an earlier cursor for a later student question', async ({
  page,
  request,
}) => {
  const mock = await mockTeaching(page, await createLearner(request, '回声'));
  await openFirstLesson(page);
  await page.getByRole('tab', { name: '提问', exact: true }).click();
  await page.getByRole('button', { name: '开启语音对话', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!(
            window as unknown as {
              __classroomVoiceTest: { recognition: unknown };
            }
          ).__classroomVoiceTest.recognition,
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __classroomVoiceTest: { spoken: string[] };
            }
          ).__classroomVoiceTest.spoken.length,
      ),
    )
    .toBeGreaterThan(0);
  const cancelledBeforeEcho = await page.evaluate(
    () =>
      (
        window as unknown as {
          __classroomVoiceTest: { cancelled: number };
        }
      ).__classroomVoiceTest.cancelled,
  );
  await page.evaluate(() => {
    (
      window as unknown as { __classroomVoiceTest: { amplitude: number } }
    ).__classroomVoiceTest.amplitude = 0.08;
  });
  // The VAD first captures the word-nine position while the teacher is still speaking.
  await page.waitForTimeout(180);
  const provisionalPosition = Number(
    await page.getByRole('slider', { name: '课程播放位置' }).inputValue(),
  );
  await page.evaluate(() => {
    const control = (
      window as unknown as {
        __classroomVoiceTest: {
          utterance: { text: string };
          recognition: { onresult: (event: unknown) => void };
        };
      }
    ).__classroomVoiceTest;
    control.recognition.onresult({
      resultIndex: 0,
      results: {
        length: 1,
        0: {
          length: 1,
          isFinal: true,
          0: { transcript: control.utterance.text.slice(0, 8), confidence: 1 },
        },
      },
    });
  });
  // An echo must not enqueue a delayed final-result submission or cancel the teacher.
  await page.waitForTimeout(1250);
  expect(mock.submitted).toHaveLength(0);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __classroomVoiceTest: { cancelled: number };
          }
        ).__classroomVoiceTest.cancelled,
    ),
  ).toBe(cancelledBeforeEcho);
  await expect(page.getByRole('button', { name: '暂停讲解', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const control = (
      window as unknown as {
        __classroomVoiceTest: {
          amplitude: number;
          utterance: { onboundary: (event: { charIndex: number }) => void };
          recognition: { onresult: (event: unknown) => void };
        };
      }
    ).__classroomVoiceTest;
    control.utterance.onboundary({ charIndex: 15 });
    control.recognition.onresult({
      resultIndex: 0,
      results: {
        length: 1,
        0: {
          length: 1,
          isFinal: true,
          0: { transcript: '我不明白，为什么这里要用未知数？', confidence: 1 },
        },
      },
    });
    control.amplitude = 0;
  });
  await expect.poll(() => mock.submitted.length).toBe(1);
  expect(mock.submitted[0]).toMatchObject({
    action: 'tutor',
    courseId: mathCourseId,
    lessonId: firstLessonId,
    interruption: { channel: 'voice', interrupted: true, boundary: 'word', narrationOffset: 15 },
  });
  expect(mock.submitted[0].interruption!.position).toBeGreaterThan(provisionalPosition);
  expect(mock.submitted[0].question).toBe('我不明白，为什么这里要用未知数？');
  await expect(page.getByRole('button', { name: '播放讲解', exact: true })).toBeVisible();
  await expect(page.getByTestId('classroom-board')).toBeVisible();
});

test('voice turns freeze lecture and answer context, then resume the interrupted lecture', async ({
  page,
  request,
}) => {
  const mock = await mockTeaching(page, await createLearner(request, '语音'));
  await openFirstLesson(page);
  await page.getByRole('tab', { name: '提问', exact: true }).click();
  await page.getByRole('button', { name: '开启语音对话', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!(
            window as unknown as {
              __classroomVoiceTest: { recognition: unknown };
            }
          ).__classroomVoiceTest.recognition,
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __classroomVoiceTest: { spoken: string[] };
            }
          ).__classroomVoiceTest.spoken.length,
      ),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    const control = (window as unknown as { __classroomVoiceTest: { amplitude: number } })
      .__classroomVoiceTest;
    control.amplitude = 0.08;
  });
  // Attack hysteresis needs a real interval before ASR confirms a novel utterance.
  await page.waitForTimeout(180);
  const onset = Number(await page.getByRole('slider', { name: '课程播放位置' }).inputValue());
  await page.evaluate(() => {
    const control = (
      window as unknown as {
        __classroomVoiceTest: {
          amplitude: number;
          recognition: { onresult: (event: unknown) => void };
        };
      }
    ).__classroomVoiceTest;
    control.recognition.onresult({
      resultIndex: 0,
      results: {
        length: 1,
        0: {
          length: 1,
          isFinal: true,
          0: { transcript: '为什么这里的未知数可以表示价格？', confidence: 1 },
        },
      },
    });
    control.amplitude = 0;
  });
  await expect.poll(() => mock.submitted.length).toBe(1);
  const turn = mock.submitted[0];
  expect(turn).toMatchObject({
    action: 'tutor',
    courseId: mathCourseId,
    lessonId: firstLessonId,
    interruption: { interrupted: true, channel: 'voice', boundary: 'word', narrationOffset: 9 },
  });
  expect(turn.question).toContain('为什么这里的未知数可以表示价格');
  expect(Math.abs(turn.interruption!.position - onset)).toBeLessThan(0.5);
  await expect(page.getByRole('button', { name: '播放讲解', exact: true })).toBeVisible();
  await expect(page.getByTestId('classroom-board')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  mock.complete();
  await expect(page.locator('.tutor-messages')).toContainText('先把等号想成平衡的天平');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __classroomVoiceTest: { spoken: string[] };
          }
        ).__classroomVoiceTest.spoken.some((text) => text.includes('先把等号想成平衡的天平')),
      ),
    )
    .toBe(true);
  const spokenBeforeFollowup = await page.evaluate(
    () =>
      (window as unknown as { __classroomVoiceTest: { spoken: string[] } }).__classroomVoiceTest
        .spoken.length,
  );
  const cancelledBeforeFollowup = await page.evaluate(
    () =>
      (window as unknown as { __classroomVoiceTest: { cancelled: number } }).__classroomVoiceTest
        .cancelled,
  );
  await page.evaluate(() => {
    (
      window as unknown as { __classroomVoiceTest: { amplitude: number } }
    ).__classroomVoiceTest.amplitude = 0.08;
  });
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    const control = (
      window as unknown as {
        __classroomVoiceTest: {
          amplitude: number;
          recognition: { onresult: (event: unknown) => void };
        };
      }
    ).__classroomVoiceTest;
    control.recognition.onresult({
      resultIndex: 0,
      results: {
        length: 1,
        0: {
          length: 1,
          isFinal: true,
          0: { transcript: '你刚才回答中的平衡具体是什么意思？', confidence: 1 },
        },
      },
    });
    control.amplitude = 0;
  });
  await expect.poll(() => mock.submitted.length).toBe(2);
  expect(mock.submitted[1]).toMatchObject({
    action: 'tutor',
    courseId: mathCourseId,
    lessonId: firstLessonId,
    interruption: {
      channel: 'voice',
      interrupted: true,
      answerMessageId: 'mock-answer-1',
      answerOffset: 9,
    },
  });
  expect(
    Math.abs(mock.submitted[1].interruption!.position - turn.interruption!.position),
  ).toBeLessThan(0.1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __classroomVoiceTest: { cancelled: number } })
            .__classroomVoiceTest.cancelled,
      ),
    )
    .toBeGreaterThan(cancelledBeforeFollowup);
  mock.complete();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __classroomVoiceTest: { spoken: string[] } }).__classroomVoiceTest
            .spoken.length,
      ),
    )
    .toBeGreaterThan(spokenBeforeFollowup);
  await page.getByRole('button', { name: '播放讲解', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __classroomVoiceTest: { spoken: string[] };
            }
          ).__classroomVoiceTest.spoken.at(-1) || '',
      ),
    )
    .toMatch(/练习本|价格|字母|笔价/);
  expect(mock.submitted).toHaveLength(2);
});

test('tutor, assessment, review and course adaptation use agent jobs and render results', async ({
  page,
  request,
}) => {
  const initial = await createLearner(request, '反馈');
  const mock = await mockTeaching(page, initial);
  await openFirstLesson(page);
  await page.getByRole('tab', { name: '提问', exact: true }).click();
  await page
    .getByRole('textbox', { name: '向教学 Agent 提问' })
    .fill('为什么等号两边要减去相同的数？');
  await page.getByRole('button', { name: '发送学习问题' }).click();
  await expect(page.getByTestId('classroom-board')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => mock.submitted.length).toBe(1);
  expect(mock.submitted[0]).toMatchObject({
    action: 'tutor',
    courseId: mathCourseId,
    lessonId: firstLessonId,
  });
  expect(mock.submitted[0]).toMatchObject({
    question: '为什么等号两边要减去相同的数？',
    interruption: { channel: 'text', stepId: '从文具店的问题开始', position: 0 },
  });
  mock.complete();
  await expect(page.locator('.tutor-messages')).toContainText('先把等号想成平衡的天平');
  await page.getByRole('tab', { name: /随堂练习/ }).click();
  await page.getByRole('radio', { name: /3x \+ 2 = 11/ }).check();
  await page.getByRole('textbox', { name: '你的解答' }).fill('x = 7，代入后 7 + 5 = 12。');
  await page.getByRole('button', { name: '提交给 Agent 批改' }).click();
  await expect(page.getByTestId('classroom-board')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => mock.submitted.length).toBe(2);
  expect(mock.submitted[1]).toMatchObject({
    action: 'grade',
    answers: { 'meaning-1': '3x + 2 = 11', 'meaning-2': 'x = 7，代入后 7 + 5 = 12。' },
  });
  mock.complete();
  await expect(page.locator('.practice-feedback')).toContainText(
    '你能识别方程，也能通过代入检验结果。',
  );
  await expect(page.locator('.cr-feedback-heading strong')).toContainText('100');
  await page.getByRole('button', { name: '学习记录', exact: true }).click();
  await page.getByRole('button', { name: '生成学习建议' }).click();
  await expect.poll(() => mock.submitted.length).toBe(3);
  expect(mock.submitted[2].action).toBe('review');
  mock.complete();
  await expect(page.getByRole('heading', { name: '从检验开始的学习建议' })).toBeVisible();
  await expect(page.getByText('尚无去括号练习的证据。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭学习记录窗口', exact: true }).click();
  await page.getByRole('tab', { name: '随堂练习', exact: true }).click();
  await page.locator('.cr-remedial summary').click();
  await page.locator('.cr-remedial textarea').fill('希望多讲几个移项的生活例子。');
  const originalCount = mock.state.courses.length;
  await page.getByRole('button', { name: '设计巩固分支', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('研究巩固分支');
  expect(mock.submitted[3]).toMatchObject({
    action: 'replan',
    courseId: mathCourseId,
    question: '希望多讲几个移项的生活例子。',
  });
  const parentId = mock.submitted[3].parentNodeId;
  expect(parentId).toBeTruthy();
  mock.complete();
  await expect(page).toHaveURL(/lesson=remedial-branch-4/);
  await expect(page.getByTestId('chapter-preview')).toContainText('根据练习研究的巩固分支');
  expect(mock.state.courses.length).toBe(originalCount);
  const original = mock.state.courses.find((course) => course.id === mathCourseId)!;
  const parent = findCourseNode(original, parentId!);
  expect(parent?.kind).toBe('chapter');
  expect(
    parent?.kind === 'chapter' && parent.children.some((node) => node.id === 'remedial-branch-4'),
  ).toBe(true);
  expect(getCourseLessons(original).find((lesson) => lesson.id === firstLessonId)?.status).toBe(
    'ready',
  );
});
