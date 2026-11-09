import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlatformStore, publicPlatformState } from './platform-store.ts';
import { getCourseLessons } from '../src/lib/platform.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'teacher-platform-store-test-'));
  return {
    directory,
    store: new PlatformStore(directory),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('platform state is persisted and reloaded with private answer keys but public responses omit keys', async () => {
  const f = await fixture();
  try {
    const initial = f.store.snapshot();
    assert.ok(initial.courses.length > 0);
    assert.ok(getCourseLessons(initial.courses[0])[0].exercises[0].answer);
    await f.store.change((disk) => {
      disk.state.learners[0].name = '小林';
      disk.checkpoints.example = { partial: ['已保存的课时'] };
    });
    const reload = new PlatformStore(f.directory);
    assert.equal(reload.snapshot().learners[0].name, '小林');
    assert.deepEqual(reload.checkpoint('example'), { partial: ['已保存的课时'] });
    const publicState = publicPlatformState(reload.snapshot());
    for (const course of publicState.courses)
      for (const lesson of getCourseLessons(course))
        for (const exercise of lesson.exercises) {
          assert.equal(exercise.answer, '');
          assert.equal(exercise.explanation, '');
          assert.ok(exercise.question);
        }
    assert.ok(getCourseLessons(reload.snapshot().courses[0])[0].exercises[0].answer);
    publicState.learners[0].name = '客户端修改';
    assert.equal(reload.snapshot().learners[0].name, '小林');
    assert.deepEqual(
      (await readdir(f.directory)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    await f.cleanup();
  }
});

test('concurrent platform writes serialize, snapshots and returned objects cannot mutate stored data', async () => {
  const f = await fixture();
  try {
    const writes = Array.from({ length: 20 }, (_, index) =>
      f.store.change((disk) => {
        const value = { index };
        disk.checkpoints[`checkpoint-${index}`] = value;
        disk.state.learners[0].dailyMinutes += 1;
        return value;
      }),
    );
    const results = await Promise.all(writes);
    await f.store.flush();
    results[0].index = 999;
    assert.deepEqual(f.store.checkpoint('checkpoint-0'), { index: 0 });
    const snapshot = f.store.snapshot();
    snapshot.learners[0].dailyMinutes = 120;
    assert.equal(f.store.snapshot().learners[0].dailyMinutes, 45);
    const reload = new PlatformStore(f.directory);
    assert.equal(reload.snapshot().learners[0].dailyMinutes, 45);
    assert.deepEqual(reload.checkpoint('checkpoint-19'), { index: 19 });
  } finally {
    await f.cleanup();
  }
});

test('failed mutations roll back and do not poison subsequent serialized writes', async () => {
  const f = await fixture();
  try {
    await f.store.change((disk) => {
      disk.state.learners[0].name = '原记录';
    });
    await assert.rejects(
      f.store.change((disk) => {
        disk.state.learners[0].name = '不应保存';
        throw new Error('validation failed');
      }),
      /validation failed/,
    );
    assert.equal(f.store.snapshot().learners[0].name, '原记录');
    assert.equal(new PlatformStore(f.directory).snapshot().learners[0].name, '原记录');
    await f.store.change((disk) => {
      disk.state.learners[0].name = '后续修改';
    });
    assert.equal(new PlatformStore(f.directory).snapshot().learners[0].name, '后续修改');
  } finally {
    await f.cleanup();
  }
});

test('malformed platform data fails closed and preserves the file for recovery', async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, 'platform.json');
    const original = '{invalid interrupted bytes';
    await writeFile(path, original);
    const reload = new PlatformStore(f.directory);
    assert.throws(() => reload.snapshot(), /原文件已保留/);
    await assert.rejects(
      reload.change(() => undefined),
      /原文件已保留/,
    );
    assert.equal(await readFile(path, 'utf8'), original);
  } finally {
    await f.cleanup();
  }
});

test('symbolic data directories are rejected before reading or replacing data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teacher-platform-link-test-'));
  try {
    const target = join(root, 'target');
    const store = new PlatformStore(target);
    await store.change(() => undefined);
    const alias = join(root, 'alias');
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => new PlatformStore(alias).snapshot(), /符号链接/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tree validation rejects duplicate nodes, excessive depth and invalid planned content without a flat fallback', async () => {
  const f = await fixture();
  try {
    const initial = f.store.snapshot().courses[0];
    const leaf = getCourseLessons(initial)[0];
    for (const update of [
      (course: typeof initial) => {
        course.nodes = [structuredClone(leaf), structuredClone(leaf)];
      },
      (course: typeof initial) => {
        let node: (typeof initial.nodes)[number] = structuredClone(leaf);
        for (let i = 0; i < 5; i++)
          node = {
            kind: 'chapter',
            id: `depth-${i}`,
            title: '深层章节',
            objective: '测试层级',
            children: [node],
          };
        course.nodes = [node];
      },
      (course: typeof initial) => {
        course.nodes = [
          {
            ...structuredClone(leaf),
            status: 'planned',
            sources: [{ title: '参考资料', url: 'https://example.com/algebra' }],
          },
        ];
      },
      (course: typeof initial) => {
        course.nodes = [
          {
            ...structuredClone(leaf),
            sources: [{ title: '无效来源', url: 'javascript:alert(1)' }],
          },
        ];
      },
    ])
      await assert.rejects(f.store.change(({ state }) => update(state.courses[0])));
    await assert.rejects(
      f.store.change(({ state }) => {
        Object.assign(state.courses[0], { lessons: [] });
      }),
    );
    assert.deepEqual(f.store.snapshot().courses[0], initial);
    await f.store.change(() => undefined);
    assert.deepEqual(new PlatformStore(f.directory).snapshot().courses[0], initial);
  } finally {
    await f.cleanup();
  }
});
