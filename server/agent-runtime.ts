import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export type AgentBackend = 'codex' | 'claude';
export type AgentBackendStatus = {
  backend: AgentBackend;
  label: string;
  available: boolean;
  version?: string;
  message: string;
};
export type AgentExecutionRequest = {
  backend: AgentBackend;
  prompt: string;
  schema: Record<string, unknown>;
  /** A research stage may use hosted search/fetch only; it must produce observed tool evidence. */
  allowWebSearch?: boolean;
  signal?: AbortSignal;
  /** Only fixed lifecycle messages are forwarded; model reasoning and tool output stay private. */
  onEvent?: (message: string) => void;
};
export interface AgentRuntime {
  execute(request: AgentExecutionRequest): Promise<unknown>;
  inspect(): Promise<AgentBackendStatus[]>;
}

export class AgentRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentRuntimeError';
    this.code = code;
  }
}

type SpawnProcess = (
  file: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;
type Options = {
  /** Operator-owned executable paths, never supplied by a learner's request. */
  binaries?: Partial<Record<AgentBackend, string>>;
  models?: Partial<Record<AgentBackend, string>>;
  env?: NodeJS.ProcessEnv;
  loadClaudeUserSettings?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Dependency injection keeps tests offline and makes process lifecycle testable. */
  spawnProcess?: SpawnProcess;
  terminateProcess?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
};
const LABELS: Record<AgentBackend, string> = { codex: 'Codex', claude: 'Claude Code' };
const LOGIN: Record<AgentBackend, string> = { codex: 'codex login', claude: 'claude auth login' };
const CLAUDE_PROVIDER_ENV =
  /^(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_MODEL|ANTHROPIC_DEFAULT_(?:SONNET|OPUS|HAIKU)_MODEL(?:_NAME|_DESCRIPTION)?|CLAUDE_CODE_OAUTH_TOKEN)$/;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonEvents(output: string): Record<string, unknown>[] {
  return output.split('\n').flatMap((line) => {
    try {
      return [object(JSON.parse(line))];
    } catch {
      return [];
    }
  });
}

/** Normalize a source identity, never reducing it to a domain or origin. */
function sourceUrl(value: string): string | undefined {
  let cleaned = value
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/[.,;:!?，。；：！？"'`>]+$/gu, '');
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    while (cleaned.endsWith(close) && cleaned.split(close).length > cleaned.split(open).length)
      cleaned = cleaned.slice(0, -1);
  }
  try {
    const url = new URL(cleaned);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

function observedUrls(value: unknown, urls: Set<string>, search = false) {
  if (!usefulWebResult(value, search)) return;
  if (typeof value === 'string') {
    for (const match of value.matchAll(/https:\/\/[^\s<>"'`\\]+/gi)) {
      const normalized = sourceUrl(match[0]);
      if (normalized) urls.add(normalized);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) observedUrls(item, urls, search);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (!['query', 'queries', 'search_query', 'request', 'input', 'arguments'].includes(key))
        observedUrls(item, urls, search);
    }
  }
}

/** Failed or empty tool responses are not research evidence, even without is_error. */
function usefulWebResult(value: unknown, search = false): boolean {
  if (typeof value === 'string') {
    const content = value.trim();
    if (
      !content ||
      /^(?:error(?:\s*:|\s+(?:fetching|searching|retrieving|loading|reading|accessing))|failed(?:\s+to|\s*:)|unable to|could not|cannot (?:fetch|search|access)|access denied|permission denied|(?:web\s*)?(?:search|fetch|request)\s+(?:is\s+)?(?:failed|blocked|unavailable|timed out)|(?:the\s+)?(?:website|webpage|site|page)\s+(?:could not|cannot|is (?:unavailable|blocked|inaccessible))|(?:HTTP\s*)?(?:401|403|404|429|500|502|503)\b)/i.test(
        content,
      )
    )
      return false;
    if (
      search &&
      /(?:^|\n)\s*(?:no (?:relevant )?(?:search )?(?:results|matches)|0\s+(?:results|urls)|nothing (?:was )?found|未找到|没有找到|无搜索结果)/i.test(
        content,
      )
    )
      return false;
    return true;
  }
  if (Array.isArray(value)) return value.some((item) => usefulWebResult(item, search));
  if (!value || typeof value !== 'object') return false;
  const data = object(value);
  if (
    data.is_error === true ||
    data.error ||
    data.error_code ||
    /(?:^|_)error$/.test(String(data.type)) ||
    ['failed', 'error', 'incomplete'].includes(String(data.status))
  )
    return false;
  if (data.text !== undefined) return usefulWebResult(data.text, search);
  if (data.content !== undefined) return usefulWebResult(data.content, search);
  return Object.entries(data).some(
    ([key, item]) => key !== 'type' && usefulWebResult(item, search),
  );
}

/** Tool traces are evidence; claims or citations in generated prose are not. */
function researchTrace(
  backend: AgentBackend,
  enabled: boolean,
  onEvent?: (message: string) => void,
) {
  const calls = new Map<string, { name: string; url?: string }>();
  const completed = new Set<string>();
  const urls = new Set<string>();
  const denied = () =>
    new AgentRuntimeError(
      'AGENT_TOOL_DENIED',
      'Agent 尝试使用教学任务未授权的工具，执行已停止。请检查服务器 CLI 配置。',
    );
  const inspect = (event: Record<string, unknown>) => {
    if (backend === 'codex') {
      if (event.type === 'thread.started') onEvent?.('Agent 会话已启动。');
      if (event.type === 'turn.started') onEvent?.('Agent 正在分析学习任务。');
      const item = object(event.item);
      if (item.type === 'web_search') {
        if (!enabled) throw denied();
        if (
          event.type === 'item.completed' &&
          item.status !== 'failed' &&
          item.status !== 'incomplete' &&
          !item.error
        ) {
          // Search queries and final assistant prose are never treated as source evidence.
          for (const key of [
            'results',
            'search_results',
            'result',
            'response',
            'content',
            'sources',
            'urls',
          ]) {
            if (usefulWebResult(item[key], true)) observedUrls(item[key], urls, true);
          }
          const action = object(item.action);
          if (
            ['open_page', 'fetch', 'open'].includes(String(action.type)) &&
            typeof action.url === 'string'
          ) {
            const normalized = sourceUrl(action.url);
            if (normalized) urls.add(normalized);
          }
          completed.add(String(item.id || completed.size));
          onEvent?.('Agent 已完成网页资料查询。');
        }
      } else if (
        [
          'command_execution',
          'mcp_tool_call',
          'file_change',
          'image_generation',
          'collab_agent_tool_call',
        ].includes(String(item.type))
      )
        throw denied();
      return;
    }
    const message = object(event.message);
    const content = Array.isArray(message.content) ? message.content : [];
    for (const raw of content) {
      const block = object(raw);
      if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        const name = String(block.name);
        if (name === 'StructuredOutput') continue;
        if (!enabled || !['WebSearch', 'WebFetch'].includes(name)) throw denied();
        if (typeof block.id === 'string') {
          const input = object(block.input);
          calls.set(block.id, {
            name,
            ...(name === 'WebFetch' && typeof input.url === 'string' ? { url: input.url } : {}),
          });
        }
      }
      const callId = String(block.tool_use_id);
      const call = calls.get(callId);
      if (
        !call ||
        !['tool_result', 'web_search_tool_result', 'web_fetch_tool_result'].includes(
          String(block.type),
        ) ||
        block.is_error === true
      )
        continue;
      if (!usefulWebResult(block.content, call.name === 'WebSearch')) continue;
      const resultUrls = new Set<string>();
      observedUrls(block.content, resultUrls, call.name === 'WebSearch');
      if (call.name === 'WebFetch' && call.url) {
        const normalized = sourceUrl(call.url);
        if (normalized) resultUrls.add(normalized);
      }
      // A no-hit search is not a usable research result. A successful fetch may contain plain text.
      if (!resultUrls.size) continue;
      for (const url of resultUrls) urls.add(url);
      completed.add(callId);
      onEvent?.('Agent 已读取网页资料。');
    }
  };
  const assertSources = (result: unknown) => {
    const sources: string[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'sources' && Array.isArray(child)) {
          for (const source of child) {
            const url = object(source).url;
            if (typeof url === 'string') sources.push(url);
          }
        }
        visit(child);
      }
    };
    visit(result);
    for (const source of sources) {
      const normalized = sourceUrl(source);
      if (!normalized || !urls.has(normalized))
        throw new AgentRuntimeError(
          'AGENT_UNGROUNDED_SOURCE',
          '研究结果包含未在实际网页查询或成功读取中出现的来源，未发布候选课时。请重试，让 Agent 查阅对应网页后再引用；不会用编造地址代替资料。',
        );
    }
  };
  return { inspect, performed: () => completed.size > 0, assertSources };
}

/** Restricted Claude skips settings. Reuse only its provider credential envelope. */
async function claudeProviderEnvironment(source: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  // An explicit server credential must never be paired with a settings-file host.
  if (source.ANTHROPIC_API_KEY || source.ANTHROPIC_AUTH_TOKEN || source.CLAUDE_CODE_OAUTH_TOKEN)
    return source;
  const config = join(
    source.CLAUDE_CONFIG_DIR || join(source.USERPROFILE || source.HOME || homedir(), '.claude'),
    'settings.json',
  );
  try {
    if ((await stat(config)).size > 1_000_000) return source;
    const settings = object(JSON.parse(await readFile(config, 'utf8')));
    const saved = object(settings.env);
    // Never load hooks, executable auth helpers, permissions or plugins.
    if (!saved.ANTHROPIC_API_KEY && !saved.ANTHROPIC_AUTH_TOKEN && !saved.CLAUDE_CODE_OAUTH_TOKEN)
      return source;
    if (source.ANTHROPIC_BASE_URL) {
      const savedAddress =
        typeof saved.ANTHROPIC_BASE_URL === 'string'
          ? saved.ANTHROPIC_BASE_URL
          : 'https://api.anthropic.com';
      if (
        new URL(source.ANTHROPIC_BASE_URL).toString().replace(/\/$/, '') !==
        new URL(savedAddress).toString().replace(/\/$/, '')
      )
        return source;
    }
    const provider: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(saved)) {
      if (CLAUDE_PROVIDER_ENV.test(key) && typeof value === 'string' && !/[\r\n\0]/.test(value))
        provider[key] = value;
    }
    return { ...provider, ...source };
  } catch {
    // Missing/invalid configuration is reported as an actionable CLI login failure.
    return source;
  }
}

/** Keep OS/session auth, proxy and CA settings, but exclude application secrets and agent nesting. */
function runtimeEnvironment(source: NodeJS.ProcessEnv, backend: AgentBackend): NodeJS.ProcessEnv {
  const allowed =
    /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|LANG|LC_ALL|TERM|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|CODEX_HOME|CLAUDE_CONFIG_DIR)$/i;
  const credentials =
    backend === 'codex'
      ? /^(?:OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL)$/
      : CLAUDE_PROVIDER_ENV;
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(([key]) => allowed.test(key) || credentials.test(key)),
    ),
    NO_COLOR: '1',
    ...(backend === 'claude'
      ? { CLAUDE_CODE_SAFE_MODE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
      : {}),
  };
}

/** Kill descendants too: aborting the HTTP request must not leave a billable CLI running. */
async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      const timer = setTimeout(() => {
        killer.kill();
        child.kill();
        resolve();
      }, 3_000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      killer.once('error', () => {
        child.kill();
        done();
      });
      killer.once('close', done);
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* The process group already exited. */
    }
  }
}

function processFailure(backend: AgentBackend, stderr: string, code?: string): AgentRuntimeError {
  const label = LABELS[backend];
  if (code === 'ENOENT')
    return new AgentRuntimeError(
      'AGENT_NOT_INSTALLED',
      `未找到 ${label} CLI。请在服务器安装它，或设置 ${backend === 'codex' ? 'CODEX' : 'CLAUDE'}_CLI_PATH 指向可执行文件。`,
    );
  if (/auth|log.?in|unauthorized|credentials|401|token.*expired/i.test(stderr))
    return new AgentRuntimeError(
      'AGENT_AUTH_REQUIRED',
      `${label} 登录无效或已过期。请在运行服务器的账户下执行 ${LOGIN[backend]}，然后重试。`,
    );
  if (/quota|rate.limit|usage.limit|insufficient|credit|429|billing/i.test(stderr))
    return new AgentRuntimeError(
      'AGENT_QUOTA',
      `${label} 的用量或速率受限。请检查账户额度，稍后重试或切换 agent 后端。`,
    );
  if (/unknown option|unexpected argument|unrecognized|unknown.*flag/i.test(stderr))
    return new AgentRuntimeError(
      'AGENT_VERSION',
      `${label} CLI 版本不支持所需的安全运行参数。请更新 CLI 后重试。`,
    );
  return new AgentRuntimeError(
    'AGENT_FAILED',
    `${label} 任务执行失败。请在服务器检查 CLI 登录、网络及模型权限后重试；不会用示例内容替代生成结果。`,
  );
}

/**
 * CLI harness adapters. Each bounded agent step receives only the context explicitly supplied
 * by the orchestrator. No repository cwd, local skills, MCP servers or host execution tools.
 * CLI authentication is owned by the server operator; no keys are sent to the browser.
 * Flag references: developers.openai.com/codex/cli/reference and code.claude.com/docs/en/cli-reference.
 */
export class CliAgentRuntime implements AgentRuntime {
  private readonly options: Options;
  private readonly spawnProcess: SpawnProcess;
  constructor(options: Options = {}) {
    this.options = options;
    this.spawnProcess =
      options.spawnProcess ??
      ((file, args, settings) => spawn(file, [...args], { ...settings, stdio: 'pipe' }));
  }

  private binary(backend: AgentBackend): string {
    return (
      this.options.binaries?.[backend] ||
      this.options.env?.[`${backend.toUpperCase()}_CLI_PATH`] ||
      process.env[`${backend.toUpperCase()}_CLI_PATH`] ||
      `${backend}${process.platform === 'win32' ? '.exe' : ''}`
    );
  }

  private async run(
    backend: AgentBackend,
    args: string[],
    directory: string,
    input: string,
    signal?: AbortSignal,
    timeoutMs = this.options.timeoutMs ?? 180_000,
    onProtocolEvent?: (event: Record<string, unknown>) => void,
  ): Promise<string> {
    signal?.throwIfAborted();
    const baseEnvironment = this.options.env ?? process.env;
    const environment =
      backend === 'claude' &&
      (this.options.loadClaudeUserSettings ?? !this.options.env) &&
      !args.includes('--version')
        ? await claudeProviderEnvironment(baseEnvironment)
        : baseEnvironment;
    signal?.throwIfAborted();
    return new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let pendingLine = '';
      let bytes = 0;
      let settled = false;
      let stopping = false;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(this.binary(backend), args, {
          cwd: directory,
          env: runtimeEnvironment(environment, backend),
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
        });
      } catch (error) {
        reject(processFailure(backend, '', object(error).code as string | undefined));
        return;
      }
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(stdout);
      };
      const stop = (error: unknown) => {
        if (stopping || settled) return;
        stopping = true;
        void (this.options.terminateProcess ?? terminateProcessTree)(child)
          .catch(() => {
            child.kill();
          })
          .finally(() => finish(error));
      };
      const abort = () => stop(signal?.reason ?? new DOMException('Agent 已取消。', 'AbortError'));
      const timer = setTimeout(
        () =>
          stop(
            new AgentRuntimeError(
              'AGENT_TIMEOUT',
              `${LABELS[backend]} 本次执行超时，进程已停止。可以重试或减少课程数量。`,
            ),
          ),
        timeoutMs,
      );
      timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdin.on('error', () => {
        /* The close/error handler reports the actual CLI failure. */
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (settled || stopping) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > (this.options.maxOutputBytes ?? 2_000_000)) {
          stop(
            new AgentRuntimeError(
              'AGENT_OUTPUT_LIMIT',
              'Agent 输出超过上限，已停止执行。请拆分学习主题后重试。',
            ),
          );
          return;
        }
        stdout += chunk;
        if (args.includes('--version') || !onProtocolEvent) return;
        pendingLine += chunk;
        const lines = pendingLine.split('\n');
        pendingLine = lines.pop() ?? '';
        for (const line of lines) {
          let event: Record<string, unknown>;
          try {
            event = object(JSON.parse(line));
          } catch {
            continue;
          }
          try {
            onProtocolEvent(event);
          } catch (error) {
            stop(error);
            return;
          }
        }
      });
      child.stderr.on('data', (chunk: string) => {
        if (settled || stopping) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > (this.options.maxOutputBytes ?? 2_000_000)) {
          stop(
            new AgentRuntimeError(
              'AGENT_OUTPUT_LIMIT',
              'Agent 输出超过上限，已停止执行。请拆分学习主题后重试。',
            ),
          );
        } else stderr += chunk;
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (!stopping) finish(processFailure(backend, stderr, error.code));
      });
      child.once('close', (code) => {
        if (stopping) return;
        if (onProtocolEvent && pendingLine.trim()) {
          try {
            const event = JSON.parse(pendingLine);
            onProtocolEvent(object(event));
          } catch (error) {
            if (error instanceof AgentRuntimeError) {
              finish(error);
              return;
            }
          }
        }
        finish(code === 0 ? undefined : processFailure(backend, stderr || stdout));
      });
      child.stdin.end(input);
    });
  }

  async inspect(): Promise<AgentBackendStatus[]> {
    const directory = await mkdtemp(join(tmpdir(), 'gpt-teacher-inspect-'));
    try {
      return await Promise.all(
        (['codex', 'claude'] as const).map(async (backend) => {
          const base = { backend, label: LABELS[backend] };
          try {
            const output = await this.run(backend, ['--version'], directory, '', undefined, 5_000);
            const version = output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
            return {
              ...base,
              available: true,
              ...(version ? { version } : {}),
              message: 'CLI 已安装；登录状态与模型权限将在首次任务时验证。',
            };
          } catch (error) {
            return {
              ...base,
              available: false,
              message: error instanceof Error ? error.message : '无法启动 CLI。',
            };
          }
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async execute(request: AgentExecutionRequest): Promise<unknown> {
    if (request.backend !== 'codex' && request.backend !== 'claude')
      throw new AgentRuntimeError('INVALID_AGENT', '请选择 Codex 或 Claude Code 作为 agent 后端。');
    if (!request.prompt.trim() || request.prompt.length > 500_000)
      throw new AgentRuntimeError('INVALID_AGENT_INPUT', 'Agent 任务为空或过长，请缩短学习内容。');
    const schema = JSON.stringify(request.schema);
    if (!schema || schema.length > 200_000)
      throw new AgentRuntimeError('INVALID_AGENT_SCHEMA', 'Agent 输出结构无效或过长。');
    request.signal?.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), 'gpt-teacher-agent-'));
    try {
      const schemaPath = join(directory, 'schema.json');
      const outputPath = join(directory, 'result.json');
      await writeFile(schemaPath, schema, { mode: 0o600 });
      const backend = request.backend;
      const research = request.allowWebSearch === true;
      const trace = researchTrace(backend, research, request.onEvent);
      const model = this.options.models?.[backend];
      let args: string[];
      if (backend === 'codex') {
        args = [
          'exec',
          '--ignore-user-config',
          '--ignore-rules',
          '--ephemeral',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '--json',
          '--color',
          'never',
          '--output-schema',
          schemaPath,
          '--output-last-message',
          outputPath,
        ];
        for (const feature of [
          'shell_tool',
          'unified_exec',
          'shell_snapshot',
          'apps',
          'hooks',
          'plugins',
          'remote_plugin',
          'skill_search',
          'skill_mcp_dependency_install',
          'multi_agent',
          'memories',
          'browser_use',
          'computer_use',
          'view_image',
          'image_generation',
          'code_mode_host',
          'goals',
        ])
          args.push('--disable', feature);
        args.push('--enable', 'skip_host_skill_discovery');
        args.push(
          '-c',
          'approval_policy="never"',
          '-c',
          `web_search="${research ? 'live' : 'disabled'}"`,
          '-c',
          'project_doc_max_bytes=0',
          '-c',
          'agents.enabled=false',
          '-c',
          'check_for_update_on_startup=false',
        );
        if (model) args.push('--model', model);
        args.push('-');
      } else {
        args = [
          '--print',
          '--output-format',
          research ? 'stream-json' : 'json',
          '--input-format',
          'text',
          '--json-schema',
          schema,
          '--safe-mode',
          '--restricted',
          '--tools',
          research ? 'WebSearch,WebFetch' : '',
          '--disallowedTools',
          'mcp__*',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--no-session-persistence',
          '--disable-slash-commands',
          '--permission-mode',
          'dontAsk',
          '--no-chrome',
          '--effort',
          'medium',
        ];
        if (research) args.push('--verbose', '--allowedTools', 'WebSearch,WebFetch');
        if (model) args.push('--model', model);
      }
      request.onEvent?.(`正在启动 ${LABELS[backend]} 教学 agent。`);
      const stdout = await this.run(
        backend,
        args,
        directory,
        request.prompt,
        request.signal,
        this.options.timeoutMs ?? 300_000,
        trace.inspect,
      );
      let result: unknown;
      if (backend === 'codex') {
        let text: string;
        try {
          const info = await stat(outputPath);
          if (info.size > (this.options.maxOutputBytes ?? 2_000_000))
            throw new AgentRuntimeError(
              'AGENT_OUTPUT_LIMIT',
              'Agent 结果超过大小上限，请拆分学习主题。',
            );
          text = await readFile(outputPath, 'utf8');
        } catch (error) {
          if (error instanceof AgentRuntimeError) throw error;
          // Some wrappers return only the documented JSONL agent_message event.
          const messages = stdout.split('\n').flatMap((line) => {
            try {
              const item = object(object(JSON.parse(line)).item);
              return item.type === 'agent_message' && typeof item.text === 'string'
                ? [item.text]
                : [];
            } catch {
              return [];
            }
          });
          text = messages.at(-1) ?? '';
        }
        try {
          result = JSON.parse(text);
        } catch {
          throw new AgentRuntimeError(
            'AGENT_INVALID_OUTPUT',
            'Codex 未返回完整的结构化教学结果，请重试。',
          );
        }
      } else {
        let envelope: Record<string, unknown>;
        try {
          envelope = research
            ? jsonEvents(stdout)
                .filter((event) => event.type === 'result')
                .at(-1) || {}
            : object(JSON.parse(stdout));
        } catch {
          throw new AgentRuntimeError(
            'AGENT_INVALID_OUTPUT',
            'Claude Code 未返回完整的结构化教学结果，请重试。',
          );
        }
        if (
          envelope.is_error === true ||
          (typeof envelope.subtype === 'string' && envelope.subtype.startsWith('error'))
        )
          throw processFailure(
            backend,
            typeof envelope.result === 'string' ? envelope.result : String(envelope.subtype),
          );
        if (envelope.structured_output !== undefined) result = envelope.structured_output;
        else {
          try {
            result = JSON.parse(String(envelope.result ?? ''));
          } catch {
            throw new AgentRuntimeError(
              'AGENT_INVALID_OUTPUT',
              'Claude Code 未返回约定的教学数据，请重试。',
            );
          }
        }
      }
      if (research && !trace.performed())
        throw new AgentRuntimeError(
          'RESEARCH_NOT_PERFORMED',
          `${LABELS[backend]} 未完成可验证的网页查询或读取。请检查后端是否支持 WebSearch/WebFetch、网络及账户权限后重试；本次不会用模型记忆或编造引用替代调研。`,
        );
      if (research) trace.assertSources(result);
      request.onEvent?.('Agent 已提交结果，正在进行平台校验。');
      return result;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
