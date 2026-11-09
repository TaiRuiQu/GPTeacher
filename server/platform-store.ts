import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Course, CourseNode, PlatformState } from '../src/lib/platform.ts';
import { getCourseLessons } from '../src/lib/platform.ts';
import { sampleCourses } from '../src/content/platform-courses.ts';
import { getDataDirectory } from './storage.ts';

export interface PlatformDisk {
  state: PlatformState;
  checkpoints: Record<string, unknown>;
}

/** Stored courses are trees: there is no parallel flat lesson representation. */
export function assertCourseTree(course: Course): void {
  if (
    !course ||
    typeof course !== 'object' ||
    typeof course.id !== 'string' ||
    !course.id ||
    !Array.isArray(course.nodes) ||
    !course.nodes.length ||
    Object.hasOwn(course, 'lessons')
  )
    throw new Error('课程需要有效的树形节点。');
  const identifiers = new Set<string>([course.id]);
  let total = 0;
  let lessons = 0;
  function inspect(nodes: CourseNode[], depth: number) {
    if (depth > 5 || !nodes.length) throw new Error('课程树深度或章节内容无效。');
    for (const node of nodes) {
      if (
        ++total > 2000 ||
        !node ||
        typeof node !== 'object' ||
        typeof node.id !== 'string' ||
        !node.id ||
        identifiers.has(node.id) ||
        typeof node.title !== 'string' ||
        !node.title.trim() ||
        typeof node.objective !== 'string'
      )
        throw new Error('课程节点标识或内容无效。');
      identifiers.add(node.id);
      if (node.kind === 'chapter') {
        if (!Array.isArray(node.children)) throw new Error('章节需要子节点。');
        inspect(node.children, depth + 1);
      } else if (node.kind === 'lesson') {
        if (
          ++lessons > 300 ||
          typeof node.source !== 'string' ||
          !Number.isInteger(node.minutes) ||
          node.minutes < 1 ||
          !Array.isArray(node.exercises) ||
          !['planned', 'ready'].includes(node.status) ||
          !Array.isArray(node.knowledgePoints) ||
          !Array.isArray(node.techniques) ||
          !Array.isArray(node.sources)
        )
          throw new Error('课时内容无效或超过数量上限。');
        if (node.status === 'ready' && !node.source.trim()) throw new Error('已生成课时需要讲义。');
        if (
          node.status === 'planned' &&
          (node.source !== '' ||
            node.exercises.length !== 0 ||
            !node.sources.length ||
            !node.knowledgePoints.length ||
            !node.techniques.length)
        )
          throw new Error('候选课时需要研究资料，不能提前保存讲义或练习。');
        for (const source of node.sources) {
          if (
            !source ||
            typeof source.title !== 'string' ||
            !source.title.trim() ||
            typeof source.url !== 'string'
          )
            throw new Error('研究来源格式无效。');
          const url = new URL(source.url);
          if (url.protocol !== 'https:' || url.username || url.password)
            throw new Error('研究来源地址无效。');
        }
      } else throw new Error('课程节点类型无效。');
    }
  }
  inspect(course.nodes, 1);
  if (!lessons) throw new Error('课程至少需要一节课。');
}

export function initialPlatformState(): PlatformState {
  return {
    version: 1,
    learners: [
      {
        id: 'learner-default',
        name: '同学',
        grade: 7,
        dailyMinutes: 25,
        goal: '理解知识，学会独立解决问题。',
      },
    ],
    activeLearnerId: 'learner-default',
    courses: structuredClone(sampleCourses),
    progress: [],
    attempts: [],
    messages: [],
    notes: [],
    reviews: [],
    jobs: [],
    preferredBackend: 'claude',
  };
}

/** A trusted, single-server family workspace. Every mutation is serialized and atomically saved. */
export class PlatformStore {
  readonly directory: string;
  private data: PlatformDisk | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(directory = getDataDirectory()) {
    this.directory = resolve(directory);
  }

  private file() {
    if (existsSync(this.directory) && lstatSync(this.directory).isSymbolicLink())
      throw new Error('学习数据目录不能是符号链接。');
    const file = join(this.directory, 'platform.json');
    if (existsSync(file) && lstatSync(file).isSymbolicLink())
      throw new Error('学习数据文件不能是符号链接。');
    return file;
  }

  private load(): PlatformDisk {
    if (this.data) return this.data;
    const file = this.file();
    if (!existsSync(file)) return (this.data = { state: initialPlatformState(), checkpoints: {} });
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as PlatformDisk;
      const state = parsed.state;
      if (
        state?.version !== 1 ||
        !Array.isArray(state.learners) ||
        !state.learners.length ||
        !Array.isArray(state.courses) ||
        !Array.isArray(state.jobs) ||
        !Array.isArray(state.progress) ||
        !Array.isArray(state.attempts) ||
        !Array.isArray(state.notes) ||
        !Array.isArray(state.messages) ||
        !Array.isArray(state.reviews) ||
        !state.learners.some((l) => l.id === state.activeLearnerId) ||
        !parsed.checkpoints ||
        typeof parsed.checkpoints !== 'object'
      )
        throw new Error('Invalid format');
      state.courses.forEach(assertCourseTree);
      return (this.data = parsed);
    } catch {
      throw new Error('学习数据文件无法读取。原文件已保留，请从备份恢复 platform.json 后重启。');
    }
  }

  snapshot(): PlatformState {
    return structuredClone(this.load().state);
  }
  checkpoint(id: string): unknown {
    return structuredClone(this.load().checkpoints[id]);
  }
  async flush() {
    await this.queue;
  }

  async change<T>(update: (disk: PlatformDisk) => T): Promise<T> {
    let result: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.load());
      result = update(next);
      next.state.courses.forEach(assertCourseTree);
      const file = this.file();
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const temp = join(this.directory, `.platform-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temp, file);
        this.data = next;
      } finally {
        await unlink(temp).catch(() => undefined);
      }
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return structuredClone(result!);
  }
}

/** Exercise keys stay on the server until an assessment produces feedback. */
export function publicPlatformState(state: PlatformState): PlatformState {
  const clean = structuredClone(state);
  for (const course of clean.courses)
    for (const lesson of getCourseLessons(course))
      for (const exercise of lesson.exercises) {
        exercise.answer = '';
        exercise.explanation = '';
      }
  return clean;
}
