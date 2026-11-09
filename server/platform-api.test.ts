import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createPlatformMiddleware } from './platform-api.ts';
import { PlatformAgentService } from './platform-agent.ts';
import { PlatformStore } from './platform-store.ts';
import type { AgentRuntime } from './agent-runtime.ts';
import { createApiMiddleware } from './api.ts';
import { StateStore } from './storage.ts';
import { getCourseLessons, type Course } from '../src/lib/platform.ts';

test('platform HTTP API persists learner/progress/notes, hides keys, and rejects invalid origins and methods', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teacher-platform-api-'));
  const runtime: AgentRuntime = {
    inspect: async () => [
      { backend: 'codex', label: 'Codex', available: true, message: 'test executable' },
    ],
    execute: async () => {
      throw new Error('offline only');
    },
  };
  const service = new PlatformAgentService(new PlatformStore(directory), runtime);
  const middleware = createPlatformMiddleware({ service });
  const server = createServer((req, res) => {
    if (!middleware(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}/api/platform${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const initial = await (await send('')).json();
    assert.equal(initial.courses.length, 3);
    assert.equal(initial.progress.length, 0);
    assert.ok(
      initial.courses.every((c: Course) =>
        getCourseLessons(c).every((l) => l.exercises.every((e) => !e.answer && !e.explanation)),
      ),
    );
    assert.equal(
      (await send('', 'GET', undefined, { Origin: 'https://evil.example' })).status,
      403,
    );
    assert.equal((await send('/profile', 'GET')).status, 405);
    assert.equal((await send('/nothing')).status, 404);
    assert.equal(
      (
        await send('/profile', 'PUT', {
          learner: { name: '小禾', grade: 13, dailyMinutes: 25, goal: '学习' },
        })
      ).status,
      400,
    );
    let response = await send('/profile', 'PUT', {
      learner: {
        id: initial.activeLearnerId,
        name: '小禾',
        grade: 8,
        dailyMinutes: 30,
        goal: '理解几何与方程',
      },
    });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.learners[0].name, '小禾');
    const course = initial.courses[0];
    const lesson = getCourseLessons(course)[0];
    const context = {
      learnerId: initial.activeLearnerId,
      courseId: course.id,
      lessonId: lesson.id,
    };
    response = await send('/progress', 'PUT', { ...context, position: 2, completed: true });
    assert.equal(response.status, 200);
    response = await send('/notes', 'POST', { ...context, body: '等式两边需要同时变化。' });
    assert.equal(response.status, 201);
    const withNote = await response.json();
    assert.equal(withNote.notes[0].body, '等式两边需要同时变化。');
    assert.equal(
      (await send('/progress', 'PUT', { ...context, position: 999999, completed: true })).status,
      400,
    );
    assert.equal(
      (
        await send('/jobs', 'POST', {
          action: 'grade',
          backend: 'codex',
          learnerId: initial.activeLearnerId,
          courseId: course.id,
          lessonId: lesson.id,
          answers: {},
        })
      ).status,
      400,
    );
    assert.equal((await send('/preferences', 'PUT', { preferredBackend: 'shell' })).status, 400);
    assert.equal(
      (await send('/notes', 'POST', { ...context, body: 'a'.repeat(40000) })).status,
      413,
    );
    assert.equal((await send(`/notes/${withNote.notes[0].id}`, 'DELETE')).status, 200);
    const reloaded = new PlatformStore(directory).snapshot();
    assert.equal(reloaded.learners[0].name, '小禾');
    assert.equal(reloaded.progress[0].completed, true);
    assert.equal(reloaded.attempts.length, 0, 'playback completion is not an assessment');
    assert.equal(reloaded.notes.length, 0);
    assert.notEqual(
      getCourseLessons(reloaded.courses[0])[0].exercises[0].answer,
      '',
      'private grading key survives public serialization',
    );
  } finally {
    await service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('platform middleware shutdown cancels in-flight agents, leaves no writes pending, and rejects new commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teacher-platform-shutdown-'));
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = false;
  const runtime: AgentRuntime = {
    inspect: async () => [],
    execute: async ({ signal }) => {
      started();
      return new Promise((_resolve, reject) => {
        const stop = () => {
          aborted = true;
          reject(signal?.reason);
        };
        if (signal?.aborted) stop();
        else signal?.addEventListener('abort', stop, { once: true });
      });
    },
  };
  const service = new PlatformAgentService(new PlatformStore(directory), runtime);
  const middleware = createPlatformMiddleware({ service });
  const server = createServer((req, res) => {
    if (!middleware(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/api/platform/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'review', backend: 'codex', learnerId: 'learner-default' }),
    });
    const { job } = await response.json();
    assert.equal(response.status, 202);
    await running;
    const closing = middleware.close();
    assert.equal(middleware.close(), closing, 'shutdown is idempotent');
    await closing;
    assert.equal(aborted, true);
    assert.equal(
      new PlatformStore(directory).snapshot().jobs.find((saved) => saved.id === job.id)?.status,
      'interrupted',
    );
    const stopped = await fetch(`${base}/api/platform`);
    assert.equal(stopped.status, 503);
    assert.equal((await stopped.json()).code, 'SERVICE_STOPPING');
  } finally {
    await middleware.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('combined API middleware forwards shutdown without creating an unused platform store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teacher-api-shutdown-'));
  const api = createApiMiddleware({ store: new StateStore(directory) });
  const server = createServer((req, res) => api(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await api.close();
    assert.equal((await fetch(`${base}/api/platform`)).status, 503);
    const files = await import('node:fs/promises').then((fs) => fs.readdir(directory));
    assert.deepEqual(
      files,
      [],
      'shutdown must not construct a platform service or write starter data',
    );
  } finally {
    await api.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
