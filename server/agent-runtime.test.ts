import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CliAgentRuntime, AgentRuntimeError } from './agent-runtime.ts';

type TestChild = ChildProcessWithoutNullStreams & { stdout: PassThrough; stderr: PassThrough };
type Invocation = {
  file: string;
  args: readonly string[];
  options: SpawnOptionsWithoutStdio;
  input: string;
  child: TestChild;
};
function fakeSpawn(action: (invocation: Invocation) => Promise<void> | void) {
  const calls: Invocation[] = [];
  const spawnProcess = (
    file: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => {
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      pid: 12345,
      kill: () => true,
    }) as unknown as TestChild;
    const invocation = { file, args, options, input: '', child };
    calls.push(invocation);
    stdin.setEncoding('utf8');
    stdin.on('data', (value: string) => {
      invocation.input += value;
    });
    stdin.on('finish', () => {
      void Promise.resolve()
        .then(() => action(invocation))
        .catch((error: unknown) => child.emit('error', error));
    });
    return child;
  };
  return { calls, spawnProcess };
}
const schema = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
  additionalProperties: false,
};

test('Codex uses a clean temporary cwd, stdin, disabled host tools and a schema; lifecycle excludes reasoning', async () => {
  const events: string[] = [];
  const fake = fakeSpawn(async ({ child, args, input, options }) => {
    assert.equal(input, '学生主题：分数；$() and `shell` remain plain data');
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.notEqual(options.cwd, process.cwd());
    assert.equal(options.env?.APP_DATABASE_SECRET, undefined);
    assert.equal(options.env?.CLAUDECODE, undefined);
    assert.equal(options.env?.OPENAI_API_KEY, 'server-owned-test-key');
    assert.ok(args.includes('--ignore-user-config'));
    assert.ok(args.includes('--ignore-rules'));
    assert.ok(args.includes('--ephemeral'));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(args.some((value, i) => value === '--disable' && args[i + 1] === 'shell_tool'));
    assert.ok(args.includes('project_doc_max_bytes=0'));
    assert.ok(!args.some((value) => value.includes('学生主题')));
    assert.deepEqual(
      JSON.parse(await readFile(String(args[args.indexOf('--output-schema') + 1]), 'utf8')),
      schema,
    );
    child.stdout.write(
      JSON.stringify({ type: 'thread.started', thread_id: 'private-session-id' }) + '\n',
    );
    child.stdout.write(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'reasoning', text: 'private chain of thought and sk-test-secret' },
      }) + '\n',
    );
    await writeFile(
      String(args[args.indexOf('--output-last-message') + 1]),
      JSON.stringify({ title: '认识分数' }),
    );
    child.emit('close', 0);
  });
  const runtime = new CliAgentRuntime({
    spawnProcess: fake.spawnProcess,
    env: {
      PATH: process.env.PATH,
      APP_DATABASE_SECRET: 'do-not-copy',
      CLAUDECODE: '1',
      OPENAI_API_KEY: 'server-owned-test-key',
    },
  });
  assert.deepEqual(
    await runtime.execute({
      backend: 'codex',
      prompt: '学生主题：分数；$() and `shell` remain plain data',
      schema,
      onEvent: (message) => events.push(message),
    }),
    { title: '认识分数' },
  );
  assert.ok(events.includes('Agent 会话已启动。'));
  assert.doesNotMatch(events.join('\n'), /private|sk-test|thought/);
  await assert.rejects(access(String(fake.calls[0].options.cwd)));
});

test('Codex accepts final agent_message JSONL without exposing other event content', async () => {
  const fake = fakeSpawn(({ child }) => {
    child.stdout.write(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '{"title":"平衡"}' },
      }) + '\n',
    );
    child.emit('close', 0);
  });
  const runtime = new CliAgentRuntime({ spawnProcess: fake.spawnProcess });
  assert.deepEqual(await runtime.execute({ backend: 'codex', prompt: '教学任务', schema }), {
    title: '平衡',
  });
});

test('Claude Code retains operator authentication with customizations, MCP and tools disabled', async () => {
  const fake = fakeSpawn(({ child, args, options, input }) => {
    assert.equal(input, '设计课程');
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(args.includes('--safe-mode'));
    assert.ok(args.includes('--restricted'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('--no-session-persistence'));
    assert.ok(args.includes('mcp__*'));
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.equal(options.env?.CLAUDE_CODE_SAFE_MODE, '1');
    assert.equal(options.env?.ANTHROPIC_API_KEY, 'test-claude-key');
    assert.equal(options.env?.OPENAI_API_KEY, undefined);
    child.stdout.write(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        structured_output: { title: '光的折射' },
        result: 'not-the-structured-result',
      }),
    );
    child.emit('close', 0);
  });
  const runtime = new CliAgentRuntime({
    spawnProcess: fake.spawnProcess,
    env: { ANTHROPIC_API_KEY: 'test-claude-key', OPENAI_API_KEY: 'do-not-copy' },
  });
  assert.deepEqual(await runtime.execute({ backend: 'claude', prompt: '设计课程', schema }), {
    title: '光的折射',
  });
});

test('CLI failures report actionable auth guidance without forwarding stderr or secrets', async () => {
  const fake = fakeSpawn(({ child }) => {
    child.stderr.write(
      '401 Authentication failed for sk-live-private-secret https://private.example',
    );
    child.emit('close', 1);
  });
  const runtime = new CliAgentRuntime({ spawnProcess: fake.spawnProcess });
  await assert.rejects(
    runtime.execute({ backend: 'codex', prompt: '课程', schema }),
    (error: unknown) => {
      assert.ok(error instanceof AgentRuntimeError);
      assert.equal(error.code, 'AGENT_AUTH_REQUIRED');
      assert.match(error.message, /codex login/);
      assert.doesNotMatch(error.message, /private|sk-live/);
      return true;
    },
  );
});

test('inspection executes only version commands and does not claim authenticated access', async () => {
  const fake = fakeSpawn(({ file, child, args }) => {
    assert.deepEqual(args, ['--version']);
    child.stdout.write(file.startsWith('codex') ? 'codex-cli 0.167.0' : '2.1.316 (Claude Code)');
    child.emit('close', 0);
  });
  const statuses = await new CliAgentRuntime({ spawnProcess: fake.spawnProcess }).inspect();
  assert.deepEqual(
    statuses.map(({ backend, available, version }) => ({ backend, available, version })),
    [
      { backend: 'codex', available: true, version: '0.167.0' },
      { backend: 'claude', available: true, version: '2.1.316' },
    ],
  );
  assert.ok(statuses.every((status) => /首次任务/.test(status.message)));
});

test('missing CLI reports installation guidance from inspect and execute', async () => {
  const fake = fakeSpawn(({ child }) => {
    child.emit('error', Object.assign(new Error('private OS path'), { code: 'ENOENT' }));
  });
  const runtime = new CliAgentRuntime({ spawnProcess: fake.spawnProcess });
  const statuses = await runtime.inspect();
  assert.ok(statuses.every(({ available }) => !available));
  await assert.rejects(runtime.execute({ backend: 'claude', prompt: '课程', schema }), {
    code: 'AGENT_NOT_INSTALLED',
  });
});

test('cancellation terminates the process and cleans up its isolated work directory', async () => {
  const controller = new AbortController();
  const fake = fakeSpawn(() => {
    controller.abort();
  });
  let terminated = 0;
  const runtime = new CliAgentRuntime({
    spawnProcess: fake.spawnProcess,
    terminateProcess: async (child) => {
      terminated++;
      child.emit('close', 1);
    },
  });
  await assert.rejects(
    runtime.execute({ backend: 'codex', prompt: '课程', schema, signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(terminated, 1);
  await assert.rejects(access(String(fake.calls[0].options.cwd)));
});

test('already cancelled requests never spawn a process', async () => {
  const fake = fakeSpawn(() => {});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new CliAgentRuntime({ spawnProcess: fake.spawnProcess }).execute({
      backend: 'codex',
      prompt: '课程',
      schema,
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal(fake.calls.length, 0);
});

test('output limits and timeout terminate the process rather than leave a job running', async () => {
  let terminated = 0;
  const terminateProcess = async (child: ChildProcessWithoutNullStreams) => {
    terminated++;
    child.emit('close', 1);
  };
  const fake = fakeSpawn(({ child }) => {
    child.stdout.write('x'.repeat(200));
  });
  await assert.rejects(
    new CliAgentRuntime({
      spawnProcess: fake.spawnProcess,
      maxOutputBytes: 100,
      terminateProcess,
    }).execute({ backend: 'codex', prompt: '课程', schema }),
    { code: 'AGENT_OUTPUT_LIMIT' },
  );
  const silent = fakeSpawn(() => {});
  // Fake streams have no native process handle; keep the event loop alive for the deadline.
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(
      new CliAgentRuntime({
        spawnProcess: silent.spawnProcess,
        timeoutMs: 10,
        terminateProcess,
      }).execute({ backend: 'claude', prompt: '课程', schema }),
      { code: 'AGENT_TIMEOUT' },
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(terminated, 2);
});

test('unexpected host tool events stop Codex and invalid final JSON is rejected', async () => {
  const fake = fakeSpawn(({ child }) => {
    child.stdout.write(
      JSON.stringify({
        type: 'item.started',
        item: { type: 'command_execution', command: 'private-command' },
      }) + '\n',
    );
  });
  let terminated = false;
  const runtime = new CliAgentRuntime({
    spawnProcess: fake.spawnProcess,
    terminateProcess: async () => {
      terminated = true;
    },
  });
  await assert.rejects(runtime.execute({ backend: 'codex', prompt: '课程', schema }), {
    code: 'AGENT_TOOL_DENIED',
  });
  assert.equal(terminated, true);
  const invalid = fakeSpawn(({ child }) => {
    child.stdout.write('{"result":"unfinished');
    child.emit('close', 0);
  });
  await assert.rejects(
    new CliAgentRuntime({ spawnProcess: invalid.spawnProcess }).execute({
      backend: 'claude',
      prompt: '课程',
      schema,
    }),
    { code: 'AGENT_INVALID_OUTPUT' },
  );
});

test('restricted Claude can reuse only the provider envelope from operator CLI settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teacher-cli-settings-test-'));
  try {
    await writeFile(
      join(directory, 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'saved-test-credential',
          ANTHROPIC_BASE_URL: 'https://saved-provider.example',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'provider-sonnet',
          WEB_SEARCH_API_KEY: 'unrelated-search-key',
          CLAUDE_CODE_AUTO_MODE_SERVER: 'unrelated-customization',
        },
        hooks: { unsafe: 'never run this' },
        apiKeyHelper: 'never execute this',
        permissions: { defaultMode: 'bypassPermissions' },
      }),
    );
    const fake = fakeSpawn(({ args, child, options }) => {
      assert.equal(options.env?.ANTHROPIC_AUTH_TOKEN, 'saved-test-credential');
      assert.equal(options.env?.ANTHROPIC_BASE_URL, 'https://saved-provider.example');
      assert.equal(options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL, 'provider-sonnet');
      assert.equal(options.env?.WEB_SEARCH_API_KEY, undefined);
      assert.equal(options.env?.CLAUDE_CODE_AUTO_MODE_SERVER, undefined);
      assert.ok(args.includes('--safe-mode'));
      assert.ok(args.includes('--restricted'));
      assert.doesNotMatch(args.join(' '), /saved-test-credential|never execute|never run/);
      child.stdout.write('{"structured_output":{"title":"configured"}}');
      child.emit('close', 0);
    });
    const runtime = new CliAgentRuntime({
      spawnProcess: fake.spawnProcess,
      env: { CLAUDE_CONFIG_DIR: directory },
      loadClaudeUserSettings: true,
    });
    assert.deepEqual(await runtime.execute({ backend: 'claude', prompt: '课程', schema }), {
      title: 'configured',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicit server credentials or a different provider URL never borrow settings-file credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teacher-cli-settings-isolation-test-'));
  try {
    await writeFile(
      join(directory, 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'saved-test-key',
          ANTHROPIC_BASE_URL: 'https://saved-provider.example',
        },
      }),
    );
    const fake = fakeSpawn(({ child, options }) => {
      assert.equal(options.env?.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.notEqual(options.env?.ANTHROPIC_BASE_URL, 'https://saved-provider.example');
      child.stdout.write('{"structured_output":{"title":"isolated"}}');
      child.emit('close', 0);
    });
    for (const settings of [
      { ANTHROPIC_API_KEY: 'explicit-server-key' },
      { ANTHROPIC_BASE_URL: 'https://other-provider.example' },
    ]) {
      const runtime = new CliAgentRuntime({
        spawnProcess: fake.spawnProcess,
        env: { CLAUDE_CONFIG_DIR: directory, ...settings },
        loadClaudeUserSettings: true,
      });
      assert.deepEqual(await runtime.execute({ backend: 'claude', prompt: '课程', schema }), {
        title: 'isolated',
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex research enables live search only and requires a completed search trace', async () => {
  const messages: string[] = [];
  const fake = fakeSpawn(async ({ child, args }) => {
    assert.ok(args.includes('web_search="live"'));
    assert.ok(args.some((arg, i) => arg === '--disable' && args[i + 1] === 'shell_tool'));
    child.stdout.write(
      JSON.stringify({
        type: 'item.started',
        item: { id: 'search-1', type: 'web_search', query: 'private query' },
      }) + '\n',
    );
    child.stdout.write(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'search-1',
          type: 'web_search',
          action: { type: 'search', query: 'private query' },
        },
      }) + '\n',
    );
    await writeFile(
      String(args[args.indexOf('--output-last-message') + 1]),
      '{"title":"查询后的课程"}',
    );
    child.emit('close', 0);
  });
  assert.deepEqual(
    await new CliAgentRuntime({ spawnProcess: fake.spawnProcess }).execute({
      backend: 'codex',
      prompt: '先检索课程资料',
      schema,
      allowWebSearch: true,
      onEvent: (event) => messages.push(event),
    }),
    { title: '查询后的课程' },
  );
  assert.ok(messages.includes('Agent 已完成网页资料查询。'));
  assert.doesNotMatch(messages.join('\n'), /private query/);
});

test('research rejects prose claims, failed searches and invocations without observed results', async () => {
  for (const backend of ['codex', 'claude'] as const) {
    for (const toolAttempt of [false, true]) {
      const fake = fakeSpawn(async ({ child, args }) => {
        if (backend === 'codex') {
          if (toolAttempt)
            child.stdout.write(
              JSON.stringify({
                type: 'item.completed',
                item: { type: 'web_search', status: 'failed' },
              }) + '\n',
            );
          await writeFile(
            String(args[args.indexOf('--output-last-message') + 1]),
            '{"title":"I searched and cited sources"}',
          );
        } else {
          if (toolAttempt) {
            child.stdout.write(
              JSON.stringify({
                type: 'assistant',
                message: {
                  content: [
                    { type: 'tool_use', id: 'lookup', name: 'WebSearch', input: { query: '课程' } },
                  ],
                },
              }) + '\n',
            );
            child.stdout.write(
              JSON.stringify({
                type: 'user',
                message: {
                  content: [
                    {
                      type: 'tool_result',
                      tool_use_id: 'lookup',
                      is_error: true,
                      content: 'Search is blocked',
                    },
                  ],
                },
              }) + '\n',
            );
          }
          child.stdout.write(
            JSON.stringify({
              type: 'result',
              subtype: 'success',
              structured_output: { title: 'I searched and cited sources' },
            }),
          );
        }
        child.emit('close', 0);
      });
      await assert.rejects(
        new CliAgentRuntime({ spawnProcess: fake.spawnProcess }).execute({
          backend,
          prompt: '搜索资料',
          schema,
          allowWebSearch: true,
        }),
        { code: 'RESEARCH_NOT_PERFORMED' },
      );
    }
  }
});

test('Claude research streams successful WebSearch/WebFetch evidence and preserves structured output', async () => {
  const lifecycle: string[] = [];
  const fake = fakeSpawn(({ child, args, options }) => {
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(args[args.indexOf('--tools') + 1], 'WebSearch,WebFetch');
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
    assert.ok(args.includes('--verbose'));
    assert.ok(args.includes('--restricted'));
    assert.ok(args.includes('--safe-mode'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(options.shell, false);
    const events = [
      { type: 'system', subtype: 'init', tools: ['WebSearch', 'WebFetch'] },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'search',
              name: 'WebSearch',
              input: { query: 'a private query' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'search',
              content: 'A real search result with a webpage URL',
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'fetch',
              name: 'WebFetch',
              input: { url: 'https://example.com' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'fetch',
              content: [{ type: 'text', text: 'Fetched page content' }],
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'structured',
              name: 'StructuredOutput',
              input: { title: '学习资料' },
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', structured_output: { title: '学习资料' } },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
    child.stdout.write(events.slice(0, 25));
    child.stdout.write(events.slice(25));
    child.emit('close', 0);
  });
  assert.deepEqual(
    await new CliAgentRuntime({ spawnProcess: fake.spawnProcess }).execute({
      backend: 'claude',
      prompt: '检索后设计课程',
      schema,
      allowWebSearch: true,
      onEvent: (event) => lifecycle.push(event),
    }),
    { title: '学习资料' },
  );
  assert.ok(lifecycle.includes('Agent 已读取网页资料。'));
  assert.doesNotMatch(lifecycle.join('\n'), /private query|Fetched page content/);
});

test('research still terminates unauthorized host tools and teaching never permits search', async () => {
  for (const backend of ['codex', 'claude'] as const) {
    for (const research of [false, true]) {
      let killed = false;
      const fake = fakeSpawn(({ child }) => {
        const tool = research ? 'Bash' : 'WebSearch';
        child.stdout.write(
          JSON.stringify(
            backend === 'codex'
              ? {
                  type: 'item.started',
                  item: { type: research ? 'command_execution' : 'web_search' },
                }
              : {
                  type: 'assistant',
                  message: {
                    content: [{ type: 'tool_use', id: 'forbidden', name: tool, input: {} }],
                  },
                },
          ) + '\n',
        );
      });
      const runtime = new CliAgentRuntime({
        spawnProcess: fake.spawnProcess,
        terminateProcess: async (child) => {
          killed = true;
          child.emit('close', 1);
        },
      });
      await assert.rejects(
        runtime.execute({ backend, prompt: '学习任务', schema, allowWebSearch: research }),
        { code: 'AGENT_TOOL_DENIED' },
      );
      assert.equal(killed, true);
    }
  }
});

function researchResult(url: string) {
  return {
    title: '调研章节',
    chapters: [{ lessons: [{ sources: [{ title: '课程资料', url }] }] }],
  };
}
function claudeEvents(child: TestChild, events: unknown[]) {
  child.stdout.write(events.map((event) => JSON.stringify(event)).join('\n'));
  child.emit('close', 0);
}
function toolUse(id: string, name: 'WebSearch' | 'WebFetch', input: Record<string, unknown>) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } };
}
function toolResult(id: string, content: unknown, is_error = false) {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] },
  };
}

test('research sources are grounded in successful fetch inputs with exact normalized URL identity', async () => {
  const fake = fakeSpawn(({ child }) =>
    claudeEvents(child, [
      toolUse('fetch', 'WebFetch', { url: 'https://example.com/algebra#intro' }),
      toolResult('fetch', [{ type: 'text', text: 'A fetched algebra chapter with examples.' }]),
      {
        type: 'result',
        subtype: 'success',
        structured_output: researchResult('https://example.com/algebra#equations'),
      },
    ]),
  );
  const result = await new CliAgentRuntime({ spawnProcess: fake.spawnProcess }).execute({
    backend: 'claude',
    prompt: '调研章节资料',
    schema,
    allowWebSearch: true,
  });
  assert.deepEqual(result, researchResult('https://example.com/algebra#equations'));
});

test('search-result citations normalize hashes and trailing punctuation but never accept another path on the same host', async () => {
  for (const [source, accepted] of [
    ['https://example.com/algebra#lesson', true],
    ['https://example.com/not-in-results', false],
  ] as const) {
    const fake = fakeSpawn(({ child }) =>
      claudeEvents(child, [
        toolUse('search', 'WebSearch', { query: 'algebra' }),
        toolResult(
          'search',
          'Found [Algebra](https://example.com/algebra#intro).\nAnother resource: https://example.org/math.',
        ),
        // Assistant-generated prose must not create source evidence.
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'I also visited https://example.com/not-in-results' }],
          },
        },
        { type: 'result', subtype: 'success', structured_output: researchResult(source) },
      ]),
    );
    const promise = new CliAgentRuntime({ spawnProcess: fake.spawnProcess }).execute({
      backend: 'claude',
      prompt: '研究',
      schema,
      allowWebSearch: true,
    });
    if (accepted) assert.deepEqual(await promise, researchResult(source));
    else await assert.rejects(promise, { code: 'AGENT_UNGROUNDED_SOURCE' });
  }
});

test('no-hit searches and textual fetch failures do not count as research or validate their requested URLs', async () => {
  for (const [name, content] of [
    ['WebSearch', 'No results found.'],
    ['WebFetch', 'Error: Failed to fetch https://example.com/algebra'],
  ] as const) {
    const fake = fakeSpawn(({ child }) =>
      claudeEvents(child, [
        toolUse(
          'lookup',
          name,
          name === 'WebFetch'
            ? { url: 'https://example.com/algebra' }
            : { query: 'site:https://example.com/algebra' },
        ),
        toolResult('lookup', content),
        {
          type: 'result',
          subtype: 'success',
          structured_output: researchResult('https://example.com/algebra'),
        },
      ]),
    );
    await assert.rejects(
      new CliAgentRuntime({ spawnProcess: fake.spawnProcess }).execute({
        backend: 'claude',
        prompt: '调研',
        schema,
        allowWebSearch: true,
      }),
      { code: 'RESEARCH_NOT_PERFORMED' },
    );
  }
});

test('a failed fetch cannot ground a citation even when a different successful search proves research occurred', async () => {
  const fake = fakeSpawn(({ child }) =>
    claudeEvents(child, [
      toolUse('search', 'WebSearch', { query: 'algebra' }),
      toolResult('search', [{ type: 'text', text: 'Result https://example.org/math' }]),
      toolUse('fetch', 'WebFetch', { url: 'https://example.com/invented' }),
      toolResult('fetch', [{ type: 'text', text: 'Error: Access denied.' }]),
      {
        type: 'result',
        subtype: 'success',
        structured_output: researchResult('https://example.com/invented'),
      },
    ]),
  );
  await assert.rejects(
    new CliAgentRuntime({ spawnProcess: fake.spawnProcess }).execute({
      backend: 'claude',
      prompt: '调研',
      schema,
      allowWebSearch: true,
    }),
    { code: 'AGENT_UNGROUNDED_SOURCE' },
  );
});

test('Codex research citations must appear in successful search-result URLs rather than queries', async () => {
  for (const [url, accepted] of [
    ['https://example.edu/algebra', true],
    ['https://example.edu/imaginary', false],
  ] as const) {
    const fake = fakeSpawn(async ({ child, args }) => {
      child.stdout.write(
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'research',
            type: 'web_search',
            status: 'completed',
            action: { type: 'search', query: 'https://example.edu/imaginary' },
            results: [{ title: 'Algebra', url: 'https://example.edu/algebra#section' }],
          },
        }) + '\n',
      );
      await writeFile(
        String(args[args.indexOf('--output-last-message') + 1]),
        JSON.stringify(researchResult(url)),
      );
      child.emit('close', 0);
    });
    const promise = new CliAgentRuntime({ spawnProcess: fake.spawnProcess }).execute({
      backend: 'codex',
      prompt: '调研',
      schema,
      allowWebSearch: true,
    });
    if (accepted) assert.deepEqual(await promise, researchResult(url));
    else await assert.rejects(promise, { code: 'AGENT_UNGROUNDED_SOURCE' });
  }
});

test('query echoes in no-result content and failed result entries cannot supply citation evidence', async () => {
  const noHits = fakeSpawn(({ child }) =>
    claudeEvents(child, [
      toolUse('search', 'WebSearch', { query: 'https://example.edu/algebra' }),
      toolResult(
        'search',
        'Search results for query: https://example.edu/algebra\nNo results found.',
      ),
      {
        type: 'result',
        subtype: 'success',
        structured_output: researchResult('https://example.edu/algebra'),
      },
    ]),
  );
  await assert.rejects(
    new CliAgentRuntime({ spawnProcess: noHits.spawnProcess }).execute({
      backend: 'claude',
      prompt: '调研',
      schema,
      allowWebSearch: true,
    }),
    { code: 'RESEARCH_NOT_PERFORMED' },
  );
  const mixed = fakeSpawn(async ({ child, args }) => {
    child.stdout.write(
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'web_search',
          status: 'completed',
          results: [
            { title: 'Valid', url: 'https://example.edu/valid' },
            { title: 'Failed', url: 'https://example.edu/blocked', error: '403 forbidden' },
          ],
        },
      }) + '\n',
    );
    await writeFile(
      String(args[args.indexOf('--output-last-message') + 1]),
      JSON.stringify(researchResult('https://example.edu/blocked')),
    );
    child.emit('close', 0);
  });
  await assert.rejects(
    new CliAgentRuntime({ spawnProcess: mixed.spawnProcess }).execute({
      backend: 'codex',
      prompt: '调研',
      schema,
      allowWebSearch: true,
    }),
    { code: 'AGENT_UNGROUNDED_SOURCE' },
  );
});
