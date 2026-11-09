import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEFAULT_SETTINGS, type ModelSettingsValue } from '../src/lib/settings.ts';
import { lessonSources } from '../src/content/lessons.ts';
import { parseLesson } from '../src/lib/lesson.ts';
import { ApiError } from './errors.ts';

type Channel = keyof ModelSettingsValue;
const CHANNELS: Channel[] = ['text', 'tts', 'stt'];
export const STATE_BODY_LIMIT = 10 * 1024 * 1024;

export type StoredNote = {
  id: string;
  lessonId: string;
  lessonTitle: string;
  stepTitle: string;
  time: number;
  body: string;
  createdAt: string;
};
export type Workspace = { currentId: string; sources: Record<string, string>; notes: StoredNote[] };
export type PublicSettings = ModelSettingsValue & {
  [C in Channel]: ModelSettingsValue[C] & { hasApiKey: boolean };
};
type Envelope = { iv: string; tag: string; data: string };
type DiskState = {
  version: 1;
  workspace: Workspace | null;
  settings: ModelSettingsValue | null;
  credentials?: Envelope;
};
type RuntimeState = { workspace: Workspace | null; settings: ModelSettingsValue | null };
export type PublicState = {
  workspace: Workspace | null;
  settings: PublicSettings;
  hasWorkspace: boolean;
  hasSettings: boolean;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'INVALID_STATE', '保存内容需要是对象。');
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number, optional = false): string {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max)
    throw new ApiError(400, 'INVALID_STATE', `${name}为空、格式无效或超过长度限制。`);
  return value;
}

function identifier(value: unknown, name: string): string {
  const result = text(value, name, 160);
  if (
    !/^[\p{L}\p{N}_.:-]+$/u.test(result) ||
    ['__proto__', 'constructor', 'prototype'].includes(result)
  )
    throw new ApiError(400, 'INVALID_STATE', `${name}格式无效。`);
  return result;
}

function bounded(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > STATE_BODY_LIMIT)
    throw new ApiError(413, 'STATE_TOO_LARGE', '课堂与笔记超过 10 MB，请导出并整理后重试。');
}

export function validateWorkspace(raw: unknown): Workspace {
  const value = object(raw);
  bounded(value);
  const entries = Object.entries(object(value.sources));
  if (entries.length > 300)
    throw new ApiError(400, 'TOO_MANY_COURSES', '最多可保存 300 节课程，请先导出并整理。');
  const sources = Object.fromEntries(
    entries.map(([id, source]) => {
      const safeId = identifier(id, '课程标识');
      const safeSource = text(source, '课堂脚本', 2_000_000);
      try {
        parseLesson(safeSource);
      } catch {
        throw new ApiError(400, 'INVALID_LESSON', `课程「${safeId}」的脚本无法读取。`);
      }
      return [safeId, safeSource];
    }),
  );
  const currentId = identifier(value.currentId, '当前课程标识');
  if (!Object.hasOwn(sources, currentId) && !lessonSources.some((item) => item.id === currentId))
    throw new ApiError(400, 'INVALID_CURRENT_COURSE', '当前课程不存在，请重新选择课程。');
  if (!Array.isArray(value.notes) || value.notes.length > 2000)
    throw new ApiError(400, 'INVALID_NOTES', '课堂笔记格式无效或超过 2000 条。');
  const notes: StoredNote[] = value.notes.map((rawNote) => {
    const note = object(rawNote);
    if (typeof note.time !== 'number' || !Number.isFinite(note.time) || note.time < 0)
      throw new ApiError(400, 'INVALID_NOTES', '笔记播放位置无效。');
    return {
      id: identifier(note.id, '笔记标识'),
      lessonId: identifier(note.lessonId, '笔记课程标识'),
      lessonTitle: text(note.lessonTitle, '课程标题', 500),
      stepTitle: text(note.stepTitle, '片段标题', 500),
      time: note.time,
      body: text(note.body, '笔记内容', 100_000, true),
      createdAt: text(note.createdAt, '笔记创建时间', 100),
    };
  });
  return { currentId, sources, notes };
}

function normalizedAddress(value: string): string {
  return value ? new URL(value).toString().replace(/\/$/, '') : '';
}

export function normalizeStoredSettings(raw: unknown): ModelSettingsValue {
  const value = object(raw);
  const result = structuredClone(DEFAULT_SETTINGS);
  for (const channel of CHANNELS) {
    const input = object(value[channel]);
    const fallback = DEFAULT_SETTINGS[channel];
    if (input.provider !== 'openai' && input.provider !== 'azure' && input.provider !== 'custom')
      throw new ApiError(400, 'INVALID_SETTINGS', '请选择有效的服务供应商。');
    if (typeof input.enabled !== 'boolean')
      throw new ApiError(400, 'INVALID_SETTINGS', '通道开关格式无效。');
    const baseUrl = text(input.baseUrl ?? fallback.baseUrl, '服务地址', 2000, true).trim();
    if (baseUrl) {
      let url: URL;
      try {
        url = new URL(baseUrl);
      } catch {
        throw new ApiError(400, 'INVALID_URL', '服务地址需要是完整的 HTTP(S) 地址。');
      }
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol === 'http:' && !loopback)
      )
        throw new ApiError(400, 'INVALID_URL', '远程服务需要 HTTPS，地址不能包含凭证或查询参数。');
    }
    const apiKey = text(input.apiKey ?? '', 'API Key', 4096, true).trim();
    if (/[\r\n]/.test(apiKey)) throw new ApiError(400, 'INVALID_KEY', 'API Key 不能包含换行。');
    Object.assign(result[channel], {
      enabled: input.enabled,
      provider: input.provider,
      model: text(input.model ?? fallback.model, '模型名称', 160, !input.enabled).trim(),
      baseUrl: normalizedAddress(baseUrl),
      apiKey,
    });
  }
  const textSettings = object(value.text);
  const budget = textSettings.maxOutputTokens ?? DEFAULT_SETTINGS.text.maxOutputTokens;
  if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 512 || budget > 65536)
    throw new ApiError(
      400,
      'INVALID_TOKEN_BUDGET',
      '最大输出 Token 需要是 512 到 65536 之间的整数。',
    );
  result.text.maxOutputTokens = budget;
  result.tts.voice = text(
    object(value.tts).voice ?? DEFAULT_SETTINGS.tts.voice,
    '音色',
    80,
    !result.tts.enabled,
  ).trim();
  result.stt.language = text(
    object(value.stt).language ?? DEFAULT_SETTINGS.stt.language,
    '识别语言',
    40,
    !result.stt.enabled,
  )
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  if (result.stt.enabled && !/^(auto|[a-z]{2,3})$/.test(result.stt.language))
    throw new ApiError(400, 'INVALID_LANGUAGE', '识别语言请使用 zh、en 或 auto 等语言代码。');
  return result;
}

export function getDataDirectory() {
  return resolve(process.env.GPT_TEACHER_DATA_DIR || join(process.cwd(), '.data'));
}

/** A single local application state, serialized writes, atomic replace, and encrypted credentials. */
export class StateStore {
  readonly directory: string;
  private state: RuntimeState | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(directory = getDataDirectory()) {
    this.directory = resolve(directory);
  }

  private ensureDirectory() {
    if (existsSync(this.directory) && lstatSync(this.directory).isSymbolicLink())
      throw new ApiError(500, 'STORAGE_UNSAFE', '服务器数据目录不能是符号链接。');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  private safeFile(name: string) {
    const path = join(this.directory, name);
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new ApiError(500, 'STORAGE_UNSAFE', '服务器数据文件不能是符号链接。');
    return path;
  }

  private masterKey(create = false): Buffer {
    const file = this.safeFile('master.key');
    if (!existsSync(file)) {
      if (!create)
        throw new ApiError(
          500,
          'STORAGE_KEY_MISSING',
          '服务器密钥文件缺失，无法读取已保存的模型凭据。',
        );
      this.ensureDirectory();
      try {
        writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const key = readFileSync(file);
    if (key.length !== 32)
      throw new ApiError(500, 'STORAGE_KEY_INVALID', '服务器密钥文件格式无效。');
    return key;
  }

  private current(): RuntimeState {
    if (this.state) return this.state;
    const path = this.safeFile('state.json');
    if (!existsSync(path)) return (this.state = { workspace: null, settings: null });
    try {
      const bytes = readFileSync(path);
      if (bytes.length > STATE_BODY_LIMIT + 100_000) throw new Error('Too large');
      const disk = object(JSON.parse(bytes.toString('utf8')));
      if (disk.version !== 1) throw new Error('Unknown version');
      const workspace = disk.workspace === null ? null : validateWorkspace(disk.workspace);
      const settings = disk.settings === null ? null : normalizeStoredSettings(disk.settings);
      if (disk.credentials) {
        if (!settings) throw new Error('Missing settings');
        const envelope = object(disk.credentials);
        const decipher = createDecipheriv(
          'aes-256-gcm',
          this.masterKey(),
          Buffer.from(String(envelope.iv), 'base64'),
        );
        decipher.setAuthTag(Buffer.from(String(envelope.tag), 'base64'));
        const raw = Buffer.concat([
          decipher.update(Buffer.from(String(envelope.data), 'base64')),
          decipher.final(),
        ]);
        const keys = object(JSON.parse(raw.toString('utf8')));
        for (const channel of CHANNELS)
          settings[channel].apiKey = text(keys[channel] ?? '', 'API Key', 4096, true);
      }
      return (this.state = { workspace, settings });
    } catch (error) {
      if (error instanceof ApiError && error.status === 500) throw error;
      throw new ApiError(
        500,
        'STORAGE_READ_ERROR',
        '服务器数据无法读取。请保留数据目录并检查文件，避免覆盖已有课堂。',
      );
    }
  }

  getState(): PublicState {
    const state = this.current();
    const settings = structuredClone(state.settings ?? DEFAULT_SETTINGS) as PublicSettings;
    for (const channel of CHANNELS) {
      settings[channel].hasApiKey = Boolean(settings[channel].apiKey);
      settings[channel].apiKey = '';
    }
    return {
      workspace: structuredClone(state.workspace),
      settings,
      hasWorkspace: state.workspace !== null,
      hasSettings: state.settings !== null,
    };
  }

  /** Reads after navigation must observe writes already accepted by this process. */
  async flush(): Promise<void> {
    await this.queue;
  }

  resolveChannel(raw: unknown, channel: Channel): Record<string, unknown> {
    const saved = this.current().settings?.[channel];
    const input =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    if (!saved) return { ...input };
    const result = { ...saved, ...input };
    const provider = result.provider;
    const base = typeof result.baseUrl === 'string' ? result.baseUrl.trim() : '';
    let sameAddress = false;
    try {
      sameAddress = normalizedAddress(base) === normalizedAddress(saved.baseUrl);
    } catch {
      /* The provider validator reports malformed addresses. */
    }
    const explicit = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    result.apiKey = explicit || (provider === saved.provider && sameAddress ? saved.apiKey : '');
    return result;
  }

  private async persist(next: RuntimeState) {
    this.ensureDirectory();
    const settings = next.settings ? structuredClone(next.settings) : null;
    const disk: DiskState = { version: 1, workspace: next.workspace, settings };
    if (settings) {
      const keys = Object.fromEntries(
        CHANNELS.map((channel) => [channel, settings[channel].apiKey]),
      );
      for (const channel of CHANNELS) settings[channel].apiKey = '';
      if (Object.values(keys).some(Boolean)) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.masterKey(true), iv);
        const encrypted = Buffer.concat([
          cipher.update(JSON.stringify(keys), 'utf8'),
          cipher.final(),
        ]);
        disk.credentials = {
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          data: encrypted.toString('base64'),
        };
      }
    }
    const temp = join(this.directory, `state-${randomUUID()}.tmp`);
    try {
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(disk));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, this.safeFile('state.json'));
    } catch {
      throw new ApiError(
        500,
        'STORAGE_WRITE_ERROR',
        '无法保存服务器数据，请检查数据目录的空间和写入权限。',
      );
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  private mutate(operation: (state: RuntimeState) => RuntimeState | null): Promise<boolean> {
    const run = this.queue.then(async () => {
      const next = operation(structuredClone(this.current()));
      if (!next) return false;
      await this.persist(next);
      this.state = next;
      return true;
    });
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async saveWorkspace(raw: unknown) {
    const workspace = validateWorkspace(raw);
    await this.mutate((state) => ({ ...state, workspace }));
  }

  private mergeSavedKeys(
    next: ModelSettingsValue,
    previous: ModelSettingsValue | null,
    clearKeys: boolean,
  ) {
    for (const channel of CHANNELS) {
      if (clearKeys) next[channel].apiKey = '';
      else if (
        !next[channel].apiKey &&
        previous &&
        next[channel].provider === previous[channel].provider &&
        normalizedAddress(next[channel].baseUrl) === normalizedAddress(previous[channel].baseUrl)
      )
        next[channel].apiKey = previous[channel].apiKey;
    }
    return next;
  }

  async saveSettings(raw: unknown, clearKeys = false): Promise<PublicSettings> {
    const normalized = normalizeStoredSettings(raw);
    await this.mutate((state) => ({
      ...state,
      settings: this.mergeSavedKeys(structuredClone(normalized), state.settings, clearKeys),
    }));
    return this.getState().settings;
  }

  async clearKeys(): Promise<PublicSettings> {
    await this.mutate((state) => {
      const settings = structuredClone(state.settings ?? DEFAULT_SETTINGS);
      for (const channel of CHANNELS) settings[channel].apiKey = '';
      return { ...state, settings };
    });
    return this.getState().settings;
  }

  async importOnce(raw: unknown) {
    const body = object(raw);
    const workspace = body.workspace === undefined ? null : validateWorkspace(body.workspace);
    const settings = body.settings === undefined ? null : normalizeStoredSettings(body.settings);
    const imported = await this.mutate((state) => {
      if (state.workspace || state.settings || (!workspace && !settings)) return null;
      return { workspace, settings };
    });
    return { ...this.getState(), imported };
  }
}

const stores = new Map<string, StateStore>();
export function getStateStore(): StateStore {
  const directory = getDataDirectory();
  let store = stores.get(directory);
  if (!store) {
    store = new StateStore(directory);
    stores.set(directory, store);
  }
  return store;
}
