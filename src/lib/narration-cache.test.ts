import assert from 'node:assert/strict';
import test from 'node:test';
import { NarrationCache } from './narration-cache.ts';

function fixture(maxBytes = 1000) {
  let next = 0;
  const revoked: string[] = [];
  const cache = new NarrationCache({
    maxBytes,
    createUrl: () => `blob:test-${++next}`,
    revokeUrl: (url) => revoked.push(url),
  });
  return { cache, revoked };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('preparation generates the whole lesson with at most two concurrent calls and deduplicates narration', async () => {
  const { cache } = fixture();
  const items = ['one', 'two', 'three', 'one'].map((text) => ({ key: text, text }));
  const pending = new Map<string, ReturnType<typeof deferred<Blob>>>();
  let active = 0;
  let peak = 0;
  const progress: number[] = [];
  const promise = cache.prepare(
    items,
    async (text) => {
      active += 1;
      peak = Math.max(active, peak);
      const task = deferred<Blob>();
      pending.set(text, task);
      try {
        return await task.promise;
      } finally {
        active -= 1;
      }
    },
    (value) => progress.push(value),
  );
  assert.deepEqual([...pending.keys()], ['one', 'two']);
  pending.get('one')!.resolve(new Blob(['one']));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual([...pending.keys()], ['one', 'two', 'three']);
  pending.get('two')!.resolve(new Blob(['two']));
  pending.get('three')!.resolve(new Blob(['three']));
  await promise;
  assert.equal(peak, 2);
  assert.equal(cache.count(items), 4);
  assert.equal(progress.at(-1), 4);
  assert.equal(cache.get('one')?.url, 'blob:test-1');
  await cache.prepare(
    items,
    () => {
      throw new Error('Cached audio must not be requested again');
    },
    () => {},
  );
});

test('failed preparation stops further work and retry preserves completed segments', async () => {
  const { cache } = fixture();
  const items = ['one', 'two', 'three'].map((text) => ({ key: text, text }));
  const first = deferred<Blob>();
  const second = deferred<Blob>();
  const calls: string[] = [];
  const request = cache.prepare(
    items,
    (text, signal) => {
      calls.push(text);
      if (text === 'one') return first.promise;
      if (text === 'two') return second.promise;
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError'))),
      );
    },
    () => {},
  );
  first.resolve(new Blob(['ready']));
  await new Promise((resolve) => setTimeout(resolve, 0));
  second.reject(new Error('Provider rejected the second segment'));
  await assert.rejects(request, /Provider rejected/);
  assert.equal(cache.count(items), 1);
  const retried: string[] = [];
  await cache.prepare(
    items,
    async (text) => {
      retried.push(text);
      return new Blob([text]);
    },
    () => {},
  );
  assert.deepEqual(retried, ['two', 'three']);
  assert.equal(cache.count(items), 3);
});

test('changing the preparation cancels pending work and ignores responses that arrive after cancellation', async () => {
  const { cache, revoked } = fixture();
  const stale = deferred<Blob>();
  let aborted = false;
  const previous = cache.prepare(
    [{ key: 'old', text: 'old' }],
    (_text, signal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return stale.promise;
    },
    () => {},
  );
  await cache.prepare(
    [{ key: 'new', text: 'new' }],
    async () => new Blob(['new']),
    () => {},
  );
  assert.equal(aborted, true);
  stale.resolve(new Blob(['old']));
  await assert.rejects(
    previous,
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
  assert.equal(cache.get('old'), undefined);
  assert.ok(cache.get('new'));
  cache.clear();
  assert.deepEqual(revoked, ['blob:test-1']);
});

test('memory pressure evicts other lessons but never silently discards the current lesson', async () => {
  const { cache, revoked } = fixture(8);
  await cache.prepare(
    [{ key: 'old', text: 'old' }],
    async () => new Blob(['123456']),
    () => {},
  );
  await cache.prepare(
    [{ key: 'new', text: 'new' }],
    async () => new Blob(['123456']),
    () => {},
  );
  assert.equal(cache.get('old'), undefined);
  assert.equal(revoked.length, 1);
  await assert.rejects(
    cache.prepare(
      [
        { key: 'new', text: 'new' },
        { key: 'large', text: 'large' },
      ],
      async () => new Blob(['1234']),
      () => {},
    ),
    /缓存上限/,
  );
  assert.ok(cache.get('new'));
  assert.equal(cache.get('large'), undefined);
});

test('newly available workers prioritize the current seek target without cancelling existing requests', async () => {
  const { cache } = fixture();
  const items = ['first', 'second', 'third', 'fourth', 'fifth'].map((text) => ({
    key: text,
    text,
  }));
  const pending = new Map<string, ReturnType<typeof deferred<Blob>>>();
  const calls: string[] = [];
  let current = 0;
  const promise = cache.prepare(
    items,
    (text) => {
      calls.push(text);
      const task = deferred<Blob>();
      pending.set(text, task);
      return task.promise;
    },
    () => {},
    (item) => (items.indexOf(item) - current + items.length) % items.length,
  );
  assert.deepEqual(calls, ['first', 'second']);
  current = 4;
  pending.get('first')!.resolve(new Blob(['first']));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['first', 'second', 'fifth']);
  pending.get('second')!.resolve(new Blob(['second']));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['first', 'second', 'fifth', 'third']);
  pending.get('fifth')!.resolve(new Blob(['fifth']));
  await new Promise((resolve) => setTimeout(resolve, 0));
  pending.get('third')!.resolve(new Blob(['third']));
  pending.get('fourth')!.resolve(new Blob(['fourth']));
  await promise;
  assert.equal(cache.count(items), 5);
});
