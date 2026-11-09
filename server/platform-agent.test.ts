import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findCourseNode,
  getCourseLessons,
  getCourseNodePath,
  type AgentJob,
  type Course,
  type CourseChapter,
  type CourseLesson,
} from '../src/lib/platform.ts';
import { parseLesson } from '../src/lib/lesson.ts';
import { toSpeechText } from '../src/lib/speech.ts';
import type { AgentExecutionRequest, AgentRuntime } from './agent-runtime.ts';
import { PlatformAgentService } from './platform-agent.ts';
import { PlatformStore } from './platform-store.ts';
import {
  analysisSchema,
  planSchema,
  lessonSchema,
  auditSchema,
  tutorSchema,
  gradeSchema,
  reviewSchema,
  assertSchema,
} from './platform-schemas.ts';

type Data = Record<string, unknown>;
function input(request: AgentExecutionRequest): Data {
  return JSON.parse(request.prompt.split('\n输入数据：')[1].split('\n')[0]) as Data;
}
const analysis = {
  summary: '从等式的含义建立方程概念。',
  prerequisites: ['有理数运算'],
  focus: ['等式性质'],
};
const spec = (title: string) => ({
  title,
  objective: `理解${title}并独立解释。`,
  minutes: 8,
  knowledgePoints: ['等式与数量关系'],
  techniques: ['把未知量代回检验'],
  sources: [
    {
      title: 'OpenStax elementary algebra',
      url: 'https://openstax.org/books/elementary-algebra-2e/pages/2-1-solve-equations-using-the-subtraction-and-addition-properties-of-equality',
    },
  ],
});
const plan = {
  title: '平衡与方程',
  description: '从等式到解方程的章节研究。',
  objectives: ['理解等式', '解方程'],
  prerequisites: ['有理数运算'],
  chapters: [
    { title: '建立概念', objective: '识别等式与未知数。', lessons: [spec('认识等式')] },
    { title: '应用性质', objective: '逐步解决简单方程。', lessons: [spec('解方程')] },
  ],
};
function lectureDraft(title = '理解方程') {
  return {
    source: `# ${title}\n\n通过生活中的数量关系，理解每一步运算的原因。\n\n## 先观察\n\n一支笔和一个两元的本子一共六元，用未知数表示笔价。观察等号，它表示两边数量相同。\n\n## 一起推导\n\n把两个相等的数量分别减去同一个数，它们仍然相等。例如两边同时减去二，天平仍保持平衡。\n\n## 回顾应用\n\n把得到的数代回原来的等式检查。请独立完成课后练习，并说明每一步的理由。`,
    exercises: [
      {
        question: 'x + 3 = 5 的解是什么？',
        options: ['2', '8'],
        answer: '2',
        explanation: '两边同时减三。',
        skill: '等式性质',
      },
      {
        question: '为什么两边要做相同运算？',
        options: [],
        answer: '为了保持相等。',
        explanation: '等式两边同时做相同合法运算，相等关系仍成立。',
        skill: '理解等式',
      },
    ],
  };
}
function standard(request: AgentExecutionRequest): unknown {
  if (request.schema === analysisSchema) return analysis;
  if (request.schema === planSchema) {
    assert.equal(request.allowWebSearch, true);
    return structuredClone(plan);
  }
  if (request.schema === lessonSchema)
    return lectureDraft((input(request).spec as CourseLesson).title);
  if (request.schema === auditSchema)
    return { approved: true, summary: '讲义及练习检查通过。', issues: [] };
  if (request.schema === tutorSchema) return { answer: '先想想两边拿走同样多的东西，天平会怎样？' };
  if (request.schema === reviewSchema)
    return {
      title: '学习复盘',
      summary: '当前练习证据有限，先完成独立练习。',
      strengths: [],
      gaps: [],
      nextSteps: ['完成一次练习', '解释每一步理由'],
    };
  throw new Error('Unexpected offline runtime schema');
}
class FakeRuntime implements AgentRuntime {
  calls: AgentExecutionRequest[] = [];
  handler: (request: AgentExecutionRequest) => unknown | Promise<unknown>;
  constructor(handler: (request: AgentExecutionRequest) => unknown | Promise<unknown> = standard) {
    this.handler = handler;
  }
  async execute(request: AgentExecutionRequest) {
    request.signal?.throwIfAborted();
    this.calls.push(request);
    return this.handler(request);
  }
  async inspect() {
    return [
      { backend: 'codex' as const, label: 'Codex', available: true, message: 'offline fake' },
    ];
  }
}
async function fixture(runtime = new FakeRuntime()) {
  const directory = await mkdtemp(join(tmpdir(), 'teacher-tree-agent-'));
  const store = new PlatformStore(directory);
  const service = new PlatformAgentService(store, runtime);
  await service.state();
  return {
    directory,
    store,
    service,
    runtime,
    cleanup: async () => {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const create = {
  action: 'create_course',
  backend: 'codex',
  learnerId: 'learner-default',
  topic: '一元一次方程',
  subject: '数学',
  lessonCount: 2,
};
async function terminal(service: PlatformAgentService, jobId: string): Promise<AgentJob> {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const job = await service.getJob(jobId);
    if (!['queued', 'running'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Offline job timed out');
}
async function research(f: Awaited<ReturnType<typeof fixture>>) {
  const job = await terminal(f.service, (await f.service.submit(create)).id);
  assert.equal(job.status, 'completed', job.error);
  return f.store.snapshot().courses.find((c) => c.id === job.result?.courseId)!;
}
function generate(course: Course, lessonIds = getCourseLessons(course).map((l) => l.id)) {
  return {
    action: 'generate_lessons',
    backend: 'codex',
    learnerId: 'learner-default',
    courseId: course.id,
    lessonIds,
  };
}
function abortable(request: AgentExecutionRequest): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () =>
      reject(request.signal?.reason ?? new DOMException('cancelled', 'AbortError'));
    if (request.signal?.aborted) abort();
    else request.signal?.addEventListener('abort', abort, { once: true });
  });
}

test('chapter research uses web-enabled agent and publishes cited planned lessons without writing lectures', async () => {
  const f = await fixture();
  try {
    const course = await research(f);
    assert.equal(Object.hasOwn(course, 'lessons'), false);
    assert.equal(course.nodes.length, 2);
    const lessons = getCourseLessons(course);
    assert.equal(lessons.length, 2);
    assert.ok(
      lessons.every(
        (l) =>
          l.status === 'planned' &&
          !l.source &&
          !l.exercises.length &&
          l.sources.length &&
          l.knowledgePoints.length &&
          l.techniques.length,
      ),
    );
    assert.equal(f.runtime.calls.length, 2);
    assert.equal(f.runtime.calls[1].allowWebSearch, true);
    assert.match(f.runtime.calls[1].prompt, /必须先使用联网搜索工具/);
    assert.equal(
      f.runtime.calls.some((c) => c.schema === lessonSchema),
      false,
    );
    assert.deepEqual(new PlatformStore(f.directory).snapshot().courses[0].nodes, course.nodes);
  } finally {
    await f.cleanup();
  }
});

test('only selected leaves generate, get hierarchical context and publish atomically after audit', async () => {
  const f = await fixture();
  try {
    const course = await research(f);
    const leaves = getCourseLessons(course);
    const untouched = structuredClone(leaves[1]);
    f.runtime.calls = [];
    f.runtime.handler = (request) => {
      if (request.schema === lessonSchema) {
        const d = input(request);
        assert.equal((d.spec as CourseLesson).id, leaves[0].id);
        assert.deepEqual(
          (d.path as { title: string }[]).map((n) => n.title),
          ['建立概念', '认识等式'],
        );
      }
      if (request.schema === auditSchema) {
        assert.equal(getCourseLessons(f.store.snapshot().courses[0])[0].status, 'planned');
        assert.ok(Array.isArray(input(request).nodes));
      }
      return standard(request);
    };
    const job = await terminal(
      f.service,
      (await f.service.submit(generate(course, [leaves[0].id]))).id,
    );
    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.result?.nodeId, leaves[0].id);
    const saved = f.store.snapshot().courses.find((c) => c.id === course.id)!;
    const ready = getCourseLessons(saved)[0];
    assert.equal(ready.status, 'ready');
    assert.ok(ready.source);
    assert.equal(f.runtime.calls.filter((c) => c.schema === lessonSchema).length, 1);
    assert.deepEqual(getCourseLessons(saved)[1], untouched);
    assert.equal(
      getCourseLessons((await f.service.state()).courses.find((c) => c.id === course.id)!)[0]
        .exercises[0].answer,
      '',
    );
    assert.equal(f.store.checkpoint(job.id), undefined);
  } finally {
    await f.cleanup();
  }
});

test('lecture audit repairs only selected lessons and keeps private reference details out of public events', async () => {
  const f = await fixture();
  try {
    const course = await research(f);
    let audits = 0;
    f.runtime.handler = (request) => {
      if (request.schema === auditSchema)
        return ++audits === 1
          ? {
              approved: false,
              summary: '修订',
              issues: [{ lessonIndex: 0, problem: '补充检验 PRIVATE_REFERENCE_ANSWER' }],
            }
          : { approved: true, summary: '通过', issues: [] };
      return standard(request);
    };
    const job = await terminal(f.service, (await f.service.submit(generate(course))).id);
    assert.equal(job.status, 'completed', job.error);
    assert.equal(audits, 2);
    assert.equal(f.runtime.calls.filter((c) => c.schema === lessonSchema).length, 3);
    assert.doesNotMatch(JSON.stringify(job.events), /PRIVATE_REFERENCE/);
    assert.ok(getCourseLessons(f.store.snapshot().courses[0]).every((l) => l.status === 'ready'));
  } finally {
    await f.cleanup();
  }
});

test('invalid citations never publish a course and malformed schemas are corrected once', async () => {
  let analyses = 0;
  const runtime = new FakeRuntime((request) => {
    if (request.schema === analysisSchema && ++analyses === 1) return { summary: '缺少字段' };
    if (request.schema === analysisSchema) assert.match(request.prompt, /上一次结果/);
    return standard(request);
  });
  const f = await fixture(runtime);
  try {
    await research(f);
    assert.equal(analyses, 2);
    const count = f.store.snapshot().courses.length;
    runtime.handler = (request) => {
      if (request.schema === planSchema) {
        const invalid = structuredClone(plan);
        invalid.chapters[0].lessons[0].sources[0].url = 'javascript:alert(1)';
        return invalid;
      }
      return standard(request);
    };
    const job = await terminal(f.service, (await f.service.submit(create)).id);
    assert.equal(job.status, 'failed');
    assert.match(job.error!, /HTTPS/);
    assert.equal(f.store.snapshot().courses.length, count);
  } finally {
    await f.cleanup();
  }
});

test('failed selected generation saves private drafts, then retry writes only unfinished selected leaves', async () => {
  const f = await fixture();
  let next: PlatformAgentService | undefined;
  try {
    const course = await research(f);
    f.runtime.handler = (request) => {
      if (request.schema === lessonSchema && input(request).lessonIndex === 1)
        throw new Error('temporary offline');
      return standard(request);
    };
    const old = await terminal(f.service, (await f.service.submit(generate(course))).id);
    assert.equal(old.status, 'failed');
    assert.ok(getCourseLessons(f.store.snapshot().courses[0]).every((l) => l.status === 'planned'));
    const checkpoint = f.store.checkpoint(old.id) as { lessons: CourseLesson[] };
    assert.equal(checkpoint.lessons.length, 1);
    await f.service.close();
    const runtime = new FakeRuntime();
    next = new PlatformAgentService(new PlatformStore(f.directory), runtime);
    const done = await terminal(next, (await next.retry(old.id)).id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(runtime.calls.filter((c) => c.schema === lessonSchema).length, 1);
    assert.equal(input(runtime.calls.find((c) => c.schema === lessonSchema)!).lessonIndex, 1);
    assert.ok(getCourseLessons((await next.state()).courses[0]).every((l) => l.status === 'ready'));
  } finally {
    await next?.close();
    await f.cleanup();
  }
});

test('research extends a nested chapter without changing existing leaves, notes or progress', async () => {
  const f = await fixture();
  try {
    const before = f.store.snapshot().courses.find((c) => c.origin === 'sample')!;
    const parent = before.nodes[0];
    assert.equal(parent.kind, 'chapter');
    const original = getCourseLessons(before);
    await f.service.progress({
      learnerId: 'learner-default',
      courseId: before.id,
      lessonId: original[0].id,
      position: 2,
      completed: true,
    });
    const job = await terminal(
      f.service,
      (
        await f.service.submit({
          action: 'extend_course',
          backend: 'codex',
          learnerId: 'learner-default',
          courseId: before.id,
          parentNodeId: parent.id,
          topic: '等式性质的进一步应用',
          lessonCount: 2,
        })
      ).id,
    );
    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.result?.courseId, before.id);
    const after = f.store.snapshot().courses.find((c) => c.id === before.id)!;
    for (const prior of original) assert.deepEqual(findCourseNode(after, prior.id), prior);
    const branch = findCourseNode(after, job.result!.nodeId!)!;
    assert.equal(branch.kind, 'chapter');
    assert.deepEqual(
      getCourseNodePath(after, branch.id).map((n) => n.id),
      [parent.id, branch.id],
    );
    assert.equal(getCourseLessons(after).length, original.length + 2);
    assert.ok(getCourseLessons({ ...after, nodes: [branch] }).every((l) => l.status === 'planned'));
    assert.equal(f.store.snapshot().progress[0].lessonId, original[0].id);
    const base = {
      action: 'extend_course',
      backend: 'codex',
      learnerId: 'learner-default',
      courseId: before.id,
      topic: '新章节',
      lessonCount: 2,
    };
    await assert.rejects(f.service.submit({ ...base, parentNodeId: original[0].id }), /叶子/);
    await assert.rejects(f.service.submit({ ...base, parentNodeId: 'missing' }), /不存在/);
    await assert.rejects(
      f.service.submit({
        ...base,
        parentNodeId: f.store.snapshot().courses.find((c) => c.id !== before.id)!.nodes[0].id,
      }),
      /不属于/,
    );
    const tooDeep = (branch as CourseChapter).children[0];
    await assert.rejects(f.service.submit({ ...base, parentNodeId: tooDeep.id }), /最多支持 5 层/);
  } finally {
    await f.cleanup();
  }
});

test('replan appends a researched remedial branch to the same course using current-lesson evidence', async () => {
  const f = await fixture();
  try {
    const course = f.store.snapshot().courses.find((c) => c.origin === 'sample')!;
    const lesson = getCourseLessons(course)[0];
    f.runtime.handler = (request) => {
      if (request.schema === analysisSchema) {
        const data = input(request);
        assert.equal((data.currentLesson as CourseLesson).id, lesson.id);
        assert.equal(data.request, '多讲生活例子');
        assert.deepEqual(data.evidence, []);
        assert.match(String(data.instruction), /证据不足/);
      }
      return standard(request);
    };
    const count = f.store.snapshot().courses.length;
    const job = await terminal(
      f.service,
      (
        await f.service.submit({
          action: 'replan',
          backend: 'codex',
          learnerId: 'learner-default',
          courseId: course.id,
          lessonId: lesson.id,
          parentNodeId: course.nodes[0].id,
          question: '多讲生活例子',
        })
      ).id,
    );
    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.result?.courseId, course.id);
    assert.equal(f.store.snapshot().courses.length, count);
    for (const prior of getCourseLessons(course))
      assert.deepEqual(
        findCourseNode(
          f.store.snapshot().courses.find((c) => c.id === course.id)!,
          prior.id,
        ),
        prior,
      );
    assert.equal(f.runtime.calls.filter((c) => c.schema === lessonSchema).length, 0);
  } finally {
    await f.cleanup();
  }
});

test('cancelling research or selected-lecture audit never publishes a partial branch or lecture', async () => {
  const f = await fixture();
  try {
    const course = await research(f);
    let announce!: () => void;
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    f.runtime.handler = (request) => {
      if (request.schema === auditSchema) {
        announce();
        return abortable(request);
      }
      return standard(request);
    };
    const job = await f.service.submit(generate(course));
    await started;
    await f.service.cancel(job.id);
    assert.equal((await terminal(f.service, job.id)).status, 'cancelled');
    assert.ok(getCourseLessons(f.store.snapshot().courses[0]).every((l) => l.status === 'planned'));
    assert.equal((f.store.checkpoint(job.id) as { lessons: CourseLesson[] }).lessons.length, 2);
    let researchStart!: () => void;
    const researchStarted = new Promise<void>((resolve) => {
      researchStart = resolve;
    });
    f.runtime.handler = (request) => {
      if (request.schema === planSchema) {
        researchStart();
        return abortable(request);
      }
      return standard(request);
    };
    const before = f.store.snapshot().courses[0].nodes;
    const extension = await f.service.submit({
      action: 'extend_course',
      backend: 'codex',
      learnerId: 'learner-default',
      courseId: course.id,
      topic: '扩展应用',
      lessonCount: 2,
    });
    await researchStarted;
    await f.service.cancel(extension.id);
    assert.equal((await terminal(f.service, extension.id)).status, 'cancelled');
    assert.deepEqual(f.store.snapshot().courses[0].nodes, before);
  } finally {
    await f.cleanup();
  }
});

test('invalid selected-node sets and not-yet-generated tutoring are rejected without an agent call', async () => {
  const f = await fixture();
  try {
    const course = await research(f);
    const lesson = getCourseLessons(course)[0];
    const before = f.runtime.calls.length;
    const base = generate(course);
    for (const ids of [
      [],
      [lesson.id, lesson.id],
      [course.nodes[0].id],
      ['missing'],
      [getCourseLessons(f.store.snapshot().courses.find((c) => c.id !== course.id)!)[0].id],
    ])
      await assert.rejects(f.service.submit({ ...base, lessonIds: ids }));
    await assert.rejects(
      f.service.submit({
        action: 'tutor',
        backend: 'codex',
        learnerId: 'learner-default',
        courseId: course.id,
        lessonId: lesson.id,
        question: '为什么',
      }),
      /先选择/,
    );
    assert.equal(f.runtime.calls.length, before);
    const done = await terminal(
      f.service,
      (await f.service.submit(generate(course, [lesson.id]))).id,
    );
    assert.equal(done.status, 'completed');
    await assert.rejects(f.service.submit(generate(course, [lesson.id])), /尚未生成/);
  } finally {
    await f.cleanup();
  }
});

test('tutor receives the frozen interruption, canonical section, spoken prefix and course path', async () => {
  const f = await fixture();
  try {
    const course = f.store.snapshot().courses.find((c) => c.origin === 'sample')!;
    const lesson = getCourseLessons(course)[0];
    const parsed = parseLesson(lesson.source);
    const step = parsed.steps[0];
    const plain = toSpeechText(step.narration);
    const interruption = {
      position: Math.min(2, step.duration - 0.1),
      stepId: step.id,
      narrationOffset: Math.min(8, plain.length),
      boundary: 'estimated',
      channel: 'voice',
      interrupted: true,
      selectedObject: { id: 'equation', label: '等式' },
    };
    f.runtime.handler = (request) => {
      assert.equal(request.schema, tutorSchema);
      const d = input(request);
      const captured = d.interruption as Record<string, unknown>;
      assert.equal(captured.time, interruption.position);
      assert.equal(captured.stepId, step.id);
      assert.equal(captured.currentNarration, step.narration);
      assert.equal(captured.spokenPrefix, plain.slice(0, interruption.narrationOffset));
      assert.equal(captured.remainingText, plain.slice(interruption.narrationOffset));
      assert.match(String(captured.reliability), /估计位置/);
      assert.deepEqual(
        (d.path as { title: string }[]).map((n) => n.title),
        getCourseNodePath(course, lesson.id).map((n) => n.title),
      );
      assert.equal((d.lesson as Record<string, unknown>).exercises, undefined);
      return standard(request);
    };
    const base = {
      action: 'tutor',
      backend: 'claude',
      learnerId: 'learner-default',
      courseId: course.id,
      lessonId: lesson.id,
      question: '刚才这里为什么要减三？',
    };
    const job = await terminal(f.service, (await f.service.submit({ ...base, interruption })).id);
    assert.equal(job.status, 'completed', job.error);
    assert.deepEqual(job.command.interruption, interruption);
    const count = f.runtime.calls.length;
    for (const bad of [
      { ...interruption, position: parsed.duration + 1 },
      { ...interruption, stepId: parsed.steps[1].id },
      { ...interruption, narrationOffset: plain.length + 1 },
      { ...interruption, boundary: 'exact' },
    ])
      await assert.rejects(f.service.submit({ ...base, interruption: bad }));
    assert.equal(f.runtime.calls.length, count);
    assert.equal(f.store.snapshot().messages.filter((m) => m.role === 'assistant').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('grading finds tree leaves, computes score and rejects feedback contradicting a choice key', async () => {
  const f = await fixture();
  try {
    const course = f.store.snapshot().courses.find((c) => c.origin === 'sample')!;
    const lesson = getCourseLessons(course)[0];
    const answers = Object.fromEntries(lesson.exercises.map((e) => [e.id, e.answer]));
    const command = {
      action: 'grade',
      backend: 'codex',
      learnerId: 'learner-default',
      courseId: course.id,
      lessonId: lesson.id,
      answers,
    };
    let correct = true;
    f.runtime.handler = (request) => {
      assert.equal(request.schema, gradeSchema);
      assert.deepEqual(input(request).answers, answers);
      return {
        feedback: '逐题反馈。',
        items: lesson.exercises.map((e) => ({ exerciseId: e.id, correct, feedback: '解题说明。' })),
        nextSteps: ['再解释一次思路'],
      };
    };
    const job = await terminal(f.service, (await f.service.submit(command)).id);
    assert.equal(job.status, 'completed', job.error);
    assert.equal(f.store.snapshot().attempts[0].score, 100);
    correct = false;
    const bad = await terminal(f.service, (await f.service.submit(command)).id);
    assert.equal(bad.status, 'failed');
    assert.match(bad.error!, /参考答案不一致/);
    assert.equal(f.store.snapshot().attempts.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('review sees submitted exercise evidence separately from completion records', async () => {
  const f = await fixture();
  try {
    const course = f.store.snapshot().courses.find((c) => c.origin === 'sample')!;
    await f.service.progress({
      learnerId: 'learner-default',
      courseId: course.id,
      lessonId: getCourseLessons(course)[0].id,
      position: 0,
      completed: true,
    });
    f.runtime.handler = (request) => {
      assert.equal(request.schema, reviewSchema);
      const d = input(request);
      assert.deepEqual(d.attempts, []);
      assert.equal((d.progress as unknown[]).length, 1);
      assert.ok((d.courses as { nodes: unknown[] }[]).every((c) => c.nodes));
      assert.match(request.prompt, /没有练习时说明证据不足/);
      return standard(request);
    };
    const job = await terminal(
      f.service,
      (await f.service.submit({ action: 'review', backend: 'codex', learnerId: 'learner-default' }))
        .id,
    );
    assert.equal(job.status, 'completed', job.error);
    assert.match(f.store.snapshot().reviews[0].summary, /证据有限/);
  } finally {
    await f.cleanup();
  }
});

test('shutdown interrupts active work, keeps FIFO queued work and restart resumes safely', async () => {
  let announce!: () => void;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const runtime = new FakeRuntime((request) => {
    announce();
    return abortable(request);
  });
  const f = await fixture(runtime);
  let next: PlatformAgentService | undefined;
  try {
    const running = await f.service.submit(create);
    await started;
    const queued = await f.service.submit({ ...create, topic: '第二个章节' });
    await f.service.close();
    assert.equal(runtime.calls.length, 1);
    assert.equal(f.store.snapshot().jobs.find((j) => j.id === running.id)?.status, 'interrupted');
    assert.equal(f.store.snapshot().jobs.find((j) => j.id === queued.id)?.status, 'queued');
    next = new PlatformAgentService(new PlatformStore(f.directory), new FakeRuntime());
    assert.equal((await terminal(next, queued.id)).status, 'completed');
    assert.equal((await terminal(next, (await next.retry(running.id)).id)).status, 'completed');
  } finally {
    await next?.close();
    await f.cleanup();
  }
});

test('lecture format problems are repaired automatically only for the selected node', async () => {
  const f = await fixture();
  try {
    const course = await research(f);
    let writes = 0;
    let corrected = false;
    f.runtime.handler = (request) => {
      if (request.schema === lessonSchema) {
        writes++;
        const d = input(request);
        if (d.correction) corrected = true;
        const content = lectureDraft((d.spec as CourseLesson).title);
        return writes === 1
          ? { ...content, source: content.source + '\n<div>复杂标签</div>' }
          : content;
      }
      return standard(request);
    };
    const job = await terminal(
      f.service,
      (await f.service.submit(generate(course, [getCourseLessons(course)[0].id]))).id,
    );
    assert.equal(job.status, 'completed', job.error);
    assert.equal(writes, 2);
    assert.equal(corrected, true);
    assert.equal(getCourseLessons(f.store.snapshot().courses[0])[1].status, 'planned');
  } finally {
    await f.cleanup();
  }
});

test('schema validates hierarchical research properties and rejects missing citations or unknown fields', () => {
  for (const invalid of [
    { ...plan, lessons: [] },
    { ...plan, chapters: [{ ...plan.chapters[0], lessons: [{ ...spec('课时'), sources: [] }] }] },
    { ...analysis, extra: true },
    { summary: ' ', prerequisites: [], focus: [] },
  ])
    assert.throws(() =>
      assertSchema(invalid, Object.hasOwn(invalid, 'chapters') ? planSchema : analysisSchema),
    );
});

test('interrupting an answer grounds offsets in the saved assistant message and rejects foreign classroom messages', async () => {
  const f = await fixture();
  try {
    const state = f.store.snapshot();
    const course = state.courses.find((item) => item.origin === 'sample')!;
    const lesson = getCourseLessons(course)[0];
    const parsed = parseLesson(lesson.source);
    const content = '**等式两边减去相同的数，仍然相等。**\n\n想象天平两边各拿走三块积木。';
    const answerText = toSpeechText(content);
    const interruption = {
      position: 2,
      stepId: parsed.steps[0].id,
      narrationOffset: 3,
      boundary: 'word',
      channel: 'voice',
      interrupted: true,
      answerMessageId: 'saved-answer',
      answerOffset: 9,
    };
    await f.store.change(({ state: saved }) => {
      const base = {
        learnerId: 'learner-default',
        courseId: course.id,
        lessonId: lesson.id,
        content,
        createdAt: new Date().toISOString(),
      };
      saved.messages.push(
        { ...base, id: 'saved-answer', role: 'assistant' },
        { ...base, id: 'foreign-answer', role: 'assistant', learnerId: 'another-learner' },
        {
          ...base,
          id: 'other-course-answer',
          role: 'assistant',
          courseId: state.courses.find((item) => item.id !== course.id)!.id,
        },
        {
          ...base,
          id: 'other-lesson-answer',
          role: 'assistant',
          lessonId: getCourseLessons(course)[1].id,
        },
        { ...base, id: 'user-message', role: 'user' },
      );
    });
    f.runtime.handler = (request) => {
      assert.equal(request.schema, tutorSchema);
      const captured = input(request).interruption as Record<string, unknown>;
      const answer = captured.interruptedAnswer as Record<string, unknown>;
      assert.equal(captured.position, 2);
      assert.equal(captured.stepId, parsed.steps[0].id);
      assert.equal(answer.messageId, 'saved-answer');
      assert.equal(answer.content, content);
      assert.equal(answer.spokenPrefix, answerText.slice(0, 9));
      assert.equal(answer.remainingText, answerText.slice(9));
      assert.equal(answer.boundary, 'word');
      assert.match(request.prompt, /学生打断的是上一条回答的语音/);
      return standard(request);
    };
    const base = {
      action: 'tutor',
      backend: 'claude',
      learnerId: 'learner-default',
      courseId: course.id,
      lessonId: lesson.id,
      question: '你刚刚说的“仍然相等”是什么意思？',
    };
    const done = await terminal(f.service, (await f.service.submit({ ...base, interruption })).id);
    assert.equal(done.status, 'completed', done.error);
    assert.deepEqual(done.command.interruption, interruption);
    for (const bad of [
      { ...interruption, answerMessageId: 'foreign-answer' },
      { ...interruption, answerMessageId: 'other-course-answer' },
      { ...interruption, answerMessageId: 'other-lesson-answer' },
      { ...interruption, answerMessageId: 'user-message' },
      { ...interruption, answerMessageId: 'missing' },
      { ...interruption, answerOffset: answerText.length + 1 },
      { ...interruption, answerOffset: -1 },
      { ...interruption, answerMessageId: undefined },
    ])
      await assert.rejects(f.service.submit({ ...base, interruption: bad }));
    assert.equal(f.runtime.calls.length, 1);
    assert.equal(f.store.snapshot().jobs.length, 1);
  } finally {
    await f.cleanup();
  }
});
