import { useEffect, useRef, useState } from 'react';
import { AudioLines, BrainCircuit, LoaderCircle, Mic, RotateCcw, Save, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DEFAULT_SETTINGS } from '../lib/settings';
import { clearServerKeys, saveServerSettings } from '../lib/persistence';
import type { ModelProvider, ModelSettingsValue } from '../lib/settings';
import { ApiError, apiJson, type ApiDiagnostics } from '../lib/api';
import { ErrorDetails } from './ErrorDetails';
import '../styles/settings.css';

type Props = {
  open: boolean;
  onClose: () => void;
  settings: ModelSettingsValue;
  onSave: (settings: ModelSettingsValue) => void;
};

type Channel = keyof ModelSettingsValue;
type InvalidField = { channel: Channel; field: string; message: string };
type TestResult = {
  status: 'idle' | 'testing' | 'success' | 'error';
  message: string;
  diagnostics?: ApiDiagnostics;
};

const CHANNELS = [
  { id: 'text' as const, name: '教学模型', icon: BrainCircuit },
  { id: 'tts' as const, name: '文字转语音', icon: AudioLines },
  { id: 'stt' as const, name: '语音转文字', icon: Mic },
];
const INITIAL_TESTS: Record<Channel, TestResult> = {
  text: { status: 'idle', message: '' },
  tts: { status: 'idle', message: '' },
  stt: { status: 'idle', message: '' },
};

function copySettings(settings: ModelSettingsValue): ModelSettingsValue {
  return { text: { ...settings.text }, tts: { ...settings.tts }, stt: { ...settings.stt } };
}

function normalizeSettings(settings: ModelSettingsValue): ModelSettingsValue {
  const normalized = copySettings(settings);
  for (const { id } of CHANNELS) {
    normalized[id].model = normalized[id].model.trim();
    normalized[id].baseUrl = normalized[id].baseUrl.trim().replace(/\/$/, '');
    normalized[id].apiKey = normalized[id].apiKey.trim();
  }
  normalized.tts.voice = normalized.tts.voice.trim();
  normalized.stt.language = normalized.stt.language.trim().toLowerCase();
  return normalized;
}

function validateSettings(
  settings: ModelSettingsValue,
  onlyChannel?: Channel,
): InvalidField | null {
  for (const { id } of CHANNELS) {
    if (onlyChannel ? id !== onlyChannel : !settings[id].enabled) continue;
    if (!settings[id].model) return { channel: id, field: 'model', message: '请输入模型名称。' };
    const { baseUrl, provider } = settings[id];
    if (!baseUrl) {
      if (provider !== 'openai')
        return { channel: id, field: 'baseUrl', message: '请输入该供应商的服务地址。' };
      continue;
    }
    try {
      const url = new URL(baseUrl);
      if (!['http:', 'https:'].includes(url.protocol))
        return { channel: id, field: 'baseUrl', message: '服务地址需要使用 HTTP 或 HTTPS。' };
      if (url.username || url.password || url.search || url.hash)
        return {
          channel: id,
          field: 'baseUrl',
          message: '请仅填写基础地址，不包含凭证、查询参数或锚点。',
        };
      if (provider === 'azure' && !url.pathname.replace(/\/$/, '').endsWith('/openai/v1'))
        return {
          channel: id,
          field: 'baseUrl',
          message: 'Azure 服务地址请以 /openai/v1 结尾。',
        };
    } catch {
      return { channel: id, field: 'baseUrl', message: '请输入完整的服务地址。' };
    }
  }
  if (
    (!onlyChannel ? settings.text.enabled : onlyChannel === 'text') &&
    (!Number.isInteger(settings.text.maxOutputTokens) ||
      settings.text.maxOutputTokens < 512 ||
      settings.text.maxOutputTokens > 65536)
  )
    return {
      channel: 'text',
      field: 'maxOutputTokens',
      message: '最大输出 Token 请输入 512 到 65536 之间的整数。',
    };
  if ((!onlyChannel ? settings.tts.enabled : onlyChannel === 'tts') && !settings.tts.voice)
    return { channel: 'tts', field: 'voice', message: '请输入音色名称。' };
  if (
    (!onlyChannel ? settings.stt.enabled : onlyChannel === 'stt') &&
    !/^(auto|[a-z]{2,3})$/.test(settings.stt.language)
  )
    return { channel: 'stt', field: 'language', message: '请使用语言代码，如 zh、en，或 auto。' };
  return null;
}

function safeTestMessage(value: unknown, settings: ModelSettingsValue): string {
  let message = typeof value === 'string' ? value : '连接测试失败，请检查服务地址、模型和密钥。';
  for (const { id } of CHANNELS) {
    const key = settings[id].apiKey.trim();
    if (key) message = message.split(key).join('[密钥已隐藏]');
  }
  return message.slice(0, 500);
}

export function ModelSettings({ open, onClose, settings, onSave }: Props) {
  const [channel, setChannel] = useState<Channel>('text');
  const [draft, setDraft] = useState(() => copySettings(settings));
  const [resetKeys, setResetKeys] = useState(false);
  const [saving, setSaving] = useState<'save' | 'clear' | null>(null);
  const savingRef = useRef(false);
  const [invalidField, setInvalidField] = useState<InvalidField | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [tests, setTests] = useState(INITIAL_TESTS);
  const testControllerRef = useRef<{ controller: AbortController; channel: Channel } | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(copySettings(settings));
    setResetKeys(false);
    setInvalidField(null);
    setStorageError(null);
    setTests(INITIAL_TESTS);
    return () => {
      testControllerRef.current?.controller.abort();
      testControllerRef.current = null;
    };
  }, [open, settings]);

  function clearErrors() {
    setInvalidField(null);
    setStorageError(null);
  }

  function cancelTest() {
    const current = testControllerRef.current;
    if (!current) return;
    current.controller.abort();
    testControllerRef.current = null;
    setTests((previous) => ({
      ...previous,
      [current.channel]: { status: 'idle', message: '测试已取消。' },
    }));
  }

  function invalidateTest(id: Channel) {
    if (testControllerRef.current?.channel === id) {
      testControllerRef.current.controller.abort();
      testControllerRef.current = null;
    }
    setTests((previous) => ({ ...previous, [id]: { status: 'idle', message: '' } }));
  }

  function updateField(id: Channel, field: 'model' | 'baseUrl' | 'apiKey', value: string) {
    setDraft((previous) => ({
      ...previous,
      [id]: {
        ...previous[id],
        [field]: value,
        ...(field === 'baseUrl' ? { hasApiKey: false } : {}),
      },
    }));
    invalidateTest(id);
    clearErrors();
  }

  function updateProvider(id: Channel, provider: ModelProvider) {
    setDraft((previous) => ({
      ...previous,
      [id]: {
        ...previous[id],
        provider,
        apiKey: '',
        hasApiKey: false,
        baseUrl: provider === 'openai' ? 'https://api.openai.com/v1' : '',
      },
    }));
    invalidateTest(id);
    clearErrors();
  }

  function useOpenRouterTts() {
    const baseUrl = 'https://openrouter.ai/api/v1';
    setDraft((previous) => ({
      ...previous,
      tts: {
        ...previous.tts,
        enabled: true,
        provider: 'custom',
        model: 'google/gemini-3.8-flash-lite-tts',
        baseUrl,
        voice: 'Kore',
        apiKey:
          previous.tts.baseUrl.trim().replace(/\/$/, '') === baseUrl ? previous.tts.apiKey : '',
        hasApiKey:
          previous.tts.baseUrl.trim().replace(/\/$/, '') === baseUrl &&
          previous.tts.provider === 'custom' &&
          previous.tts.hasApiKey === true,
      },
    }));
    invalidateTest('tts');
    clearErrors();
  }

  function showValidation(invalid: InvalidField) {
    setInvalidField(invalid);
    setChannel(invalid.channel);
    requestAnimationFrame(() =>
      document.getElementById(`ms-${invalid.channel}-${invalid.field}`)?.focus(),
    );
  }

  async function handleSave() {
    if (savingRef.current) return;
    const normalized = normalizeSettings(draft);
    const invalid = validateSettings(normalized);
    if (invalid) {
      showValidation(invalid);
      return;
    }
    savingRef.current = true;
    setSaving('save');
    cancelTest();
    try {
      const saved = await saveServerSettings(normalized, resetKeys);
      onSave(saved);
      onClose();
    } catch (reason) {
      setStorageError(
        safeTestMessage(
          reason instanceof Error ? reason.message : '无法保存配置，请检查课堂服务器后重试。',
          normalized,
        ),
      );
    } finally {
      savingRef.current = false;
      setSaving(null);
    }
  }

  async function testConnection() {
    const normalized = normalizeSettings(draft);
    const invalid = validateSettings(normalized, channel);
    if (invalid) {
      showValidation(invalid);
      return;
    }
    const testedChannel = channel;
    cancelTest();
    const controller = new AbortController();
    testControllerRef.current = { controller, channel: testedChannel };
    setTests((previous) => ({
      ...previous,
      [testedChannel]: { status: 'testing', message: '正在检查当前通道…' },
    }));
    try {
      const payload = await apiJson<Record<string, unknown>>(
        '/api/test',
        { channel: testedChannel, settings: normalized[testedChannel] },
        controller.signal,
      );
      if (testControllerRef.current?.controller !== controller) return;
      const data =
        typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
      if (data.ok !== true) {
        setTests((previous) => ({
          ...previous,
          [testedChannel]: { status: 'error', message: safeTestMessage(data.error, normalized) },
        }));
        return;
      }
      const name = CHANNELS.find(({ id }) => id === testedChannel)!.name;
      setTests((previous) => ({
        ...previous,
        [testedChannel]: {
          status: 'success',
          message: safeTestMessage(data.message ?? `${name}连接测试通过。`, normalized),
        },
      }));
    } catch (reason) {
      if (testControllerRef.current?.controller !== controller) return;
      setTests((previous) => ({
        ...previous,
        [testedChannel]: {
          status: controller.signal.aborted ? 'idle' : 'error',
          message: controller.signal.aborted
            ? '测试已取消。'
            : safeTestMessage(reason instanceof Error ? reason.message : undefined, normalized),
          diagnostics: reason instanceof ApiError ? reason.diagnostics : undefined,
        },
      }));
    } finally {
      if (testControllerRef.current?.controller === controller) testControllerRef.current = null;
    }
  }

  async function clearKeys() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving('clear');
    cancelTest();
    try {
      const cleared = await clearServerKeys();
      setDraft(copySettings(cleared));
      setResetKeys(false);
      setTests(INITIAL_TESTS);
      onSave(cleared);
      clearErrors();
    } catch (reason) {
      setStorageError(
        safeTestMessage(
          reason instanceof Error ? reason.message : '无法清除服务器密钥，请重试。',
          draft,
        ),
      );
    } finally {
      savingRef.current = false;
      setSaving(null);
    }
  }

  function errorProps(id: Channel, field: string) {
    const isInvalid = invalidField?.channel === id && invalidField.field === field;
    return {
      'aria-invalid': isInvalid,
      'aria-describedby': isInvalid ? `ms-${id}-${field}-error` : undefined,
    };
  }

  function fieldError(id: Channel, field: string) {
    return invalidField?.channel === id && invalidField.field === field ? (
      <p id={`ms-${id}-${field}-error`} className="ms-error" role="alert">
        {invalidField.message}
      </p>
    ) : null;
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings) || resetKeys;
  const testing = tests[channel].status === 'testing';

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && !saving && onClose()}>
      <DialogContent
        className="ms-dialog"
        aria-describedby={undefined}
        aria-busy={saving !== null}
        showCloseButton={!saving}
        onOpenAutoFocus={() => {
          returnFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
        }}
      >
        <DialogHeader className="ms-header">
          <DialogTitle className="ms-title">模型设置</DialogTitle>
          <Badge variant="outline" className="ms-status">
            {saving ? '正在保存' : dirty ? '未保存' : '已保存'}
          </Badge>
        </DialogHeader>

        <Tabs
          value={channel}
          onValueChange={(value) => {
            if (saving) return;
            cancelTest();
            setChannel(value as Channel);
            clearErrors();
          }}
          orientation="vertical"
          className="ms-layout"
        >
          <TabsList className="ms-tabs" aria-label="模型通道">
            {CHANNELS.map(({ id, name, icon: Icon }) => (
              <TabsTrigger key={id} value={id} className="ms-tab">
                <Icon size={20} strokeWidth={1.8} />
                <span>{name}</span>
                {!draft[id].enabled && <span className="ms-tab-state">关</span>}
              </TabsTrigger>
            ))}
          </TabsList>

          <fieldset className="ms-panels" disabled={saving !== null}>
            {CHANNELS.map(({ id, name }) => (
              <TabsContent key={id} value={id} className="ms-panel">
                <div className="ms-enable-row">
                  <Label htmlFor={`ms-${id}-enabled`}>启用{name}</Label>
                  <button
                    id={`ms-${id}-enabled`}
                    type="button"
                    role="switch"
                    aria-checked={draft[id].enabled}
                    className="ms-switch"
                    onClick={() => {
                      setDraft((previous) => ({
                        ...previous,
                        [id]: { ...previous[id], enabled: !previous[id].enabled },
                      }));
                      invalidateTest(id);
                      clearErrors();
                    }}
                  >
                    <span />
                  </button>
                </div>
                {id === 'tts' && (
                  <Button type="button" variant="outline" onClick={useOpenRouterTts}>
                    使用 OpenRouter Gemini TTS 配置
                  </Button>
                )}
                <div className="ms-field">
                  <Label htmlFor={`ms-${id}-provider`}>供应商</Label>
                  <Select
                    value={draft[id].provider}
                    onValueChange={(provider) => updateProvider(id, provider as ModelProvider)}
                  >
                    <SelectTrigger id={`ms-${id}-provider`} className="ms-control">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai">OpenAI</SelectItem>
                      <SelectItem value="azure">Azure OpenAI</SelectItem>
                      <SelectItem value="custom">自定义兼容接口</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="ms-field">
                  <Label htmlFor={`ms-${id}-model`}>
                    {draft[id].provider === 'azure' ? '模型部署名称' : '模型名称'}
                  </Label>
                  <Input
                    id={`ms-${id}-model`}
                    className="ms-control"
                    value={draft[id].model}
                    onChange={(event) => updateField(id, 'model', event.target.value)}
                    placeholder={draft[id].provider === 'azure' ? 'Azure 部署名称' : '模型 ID'}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={160}
                    {...errorProps(id, 'model')}
                  />
                  {id === 'tts' && <p className="ms-hint">请选择支持语音合成的模型。</p>}
                  {id === 'stt' && <p className="ms-hint">请选择支持音频转写的模型。</p>}
                  {fieldError(id, 'model')}
                </div>
                {id === 'text' && (
                  <div className="ms-field">
                    <Label htmlFor="ms-text-maxOutputTokens">最大输出 Token</Label>
                    <Input
                      id="ms-text-maxOutputTokens"
                      className="ms-control"
                      type="number"
                      min={512}
                      max={65536}
                      step={512}
                      value={draft.text.maxOutputTokens}
                      onChange={(event) => {
                        setDraft((previous) => ({
                          ...previous,
                          text: { ...previous.text, maxOutputTokens: Number(event.target.value) },
                        }));
                        invalidateTest('text');
                        clearErrors();
                      }}
                      {...errorProps('text', 'maxOutputTokens')}
                    />
                    <p className="ms-hint">课程含板书，输出过短可能被截断；以服务商上限为准。</p>
                    {fieldError('text', 'maxOutputTokens')}
                  </div>
                )}
                <div className="ms-field">
                  <Label htmlFor={`ms-${id}-baseUrl`}>服务地址</Label>
                  <Input
                    id={`ms-${id}-baseUrl`}
                    className="ms-control"
                    type="url"
                    value={draft[id].baseUrl}
                    onChange={(event) => updateField(id, 'baseUrl', event.target.value)}
                    placeholder={
                      draft[id].provider === 'azure'
                        ? 'https://your-resource.openai.azure.com/openai/v1'
                        : draft[id].provider === 'custom'
                          ? 'https://your-provider.example/v1'
                          : 'https://api.openai.com/v1'
                    }
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={400}
                    {...errorProps(id, 'baseUrl')}
                  />
                  {draft[id].provider === 'azure' && (
                    <p className="ms-hint">使用 Azure v1 地址，并在上方填写部署名称。</p>
                  )}
                  {fieldError(id, 'baseUrl')}
                </div>
                <div className="ms-field">
                  <Label htmlFor={`ms-${id}-apiKey`}>API Key</Label>
                  <Input
                    id={`ms-${id}-apiKey`}
                    className="ms-control"
                    type="password"
                    value={draft[id].apiKey}
                    onChange={(event) => updateField(id, 'apiKey', event.target.value)}
                    placeholder={
                      draft[id].hasApiKey
                        ? '服务器已保存密钥，留空保留'
                        : '留空使用服务器环境配置的密钥'
                    }
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={4096}
                  />
                  <p className="ms-hint">
                    {draft[id].hasApiKey
                      ? '服务器已保存此通道密钥；输入新值将替换，网页不会读取原值。'
                      : '填写后随配置保存在服务器，只用于当前通道的服务地址。'}
                  </p>
                </div>
                {id === 'tts' && (
                  <div className="ms-field">
                    <Label htmlFor="ms-tts-voice">音色</Label>
                    <Input
                      id="ms-tts-voice"
                      className="ms-control"
                      value={draft.tts.voice}
                      list="ms-voice-options"
                      onChange={(event) => {
                        setDraft((previous) => ({
                          ...previous,
                          tts: { ...previous.tts, voice: event.target.value },
                        }));
                        invalidateTest('tts');
                        clearErrors();
                      }}
                      maxLength={80}
                      {...errorProps('tts', 'voice')}
                    />
                    <datalist id="ms-voice-options">
                      <option value="marin" />
                      <option value="cedar" />
                      <option value="alloy" />
                      <option value="coral" />
                      <option value="Kore" />
                      <option value="Zephyr" />
                      <option value="Puck" />
                      <option value="Aoede" />
                    </datalist>
                    {/^https:\/\/openrouter\.ai(?:\/|$)/i.test(draft.tts.baseUrl.trim()) &&
                      /^google\/.*tts/i.test(draft.tts.model) && (
                        <p className="ms-hint">
                          Gemini TTS 需要 Google 音色，如 Kore；请勿沿用 marin、alloy 等 OpenAI
                          音色。
                        </p>
                      )}
                    {fieldError('tts', 'voice')}
                  </div>
                )}
                {id === 'stt' && (
                  <div className="ms-field">
                    <Label htmlFor="ms-stt-language">识别语言</Label>
                    <Input
                      id="ms-stt-language"
                      className="ms-control"
                      value={draft.stt.language}
                      list="ms-language-options"
                      onChange={(event) => {
                        setDraft((previous) => ({
                          ...previous,
                          stt: { ...previous.stt, language: event.target.value },
                        }));
                        invalidateTest('stt');
                        clearErrors();
                      }}
                      maxLength={40}
                      {...errorProps('stt', 'language')}
                    />
                    <datalist id="ms-language-options">
                      <option value="zh" />
                      <option value="en" />
                      <option value="auto" />
                    </datalist>
                    <p className="ms-hint">zh 为中文，en 为英文，auto 为自动识别。</p>
                    {fieldError('stt', 'language')}
                  </div>
                )}
                <div className="ms-test">
                  <p className="ms-hint">测试会实际调用当前通道，可能产生服务商费用。</p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!draft[id].enabled}
                    onClick={() => (testing ? cancelTest() : void testConnection())}
                  >
                    {testing && <LoaderCircle className="ms-spinner" size={16} />}
                    {testing ? '取消测试' : '测试当前通道'}
                  </Button>
                  {tests[id].status === 'error' ? (
                    <ErrorDetails message={tests[id].message} diagnostics={tests[id].diagnostics} />
                  ) : (
                    <p className="ms-test-message" role="status" aria-live="polite">
                      {tests[id].message || (!draft[id].enabled ? '启用此通道后可测试连接。' : '')}
                    </p>
                  )}
                </div>
              </TabsContent>
            ))}
          </fieldset>
        </Tabs>

        <footer className="ms-footer">
          <div className="ms-storage">
            <p className="ms-hint ms-storage-notice">
              配置与密钥保存在服务器，网页不会读取已保存的密钥。
            </p>
            <Button
              type="button"
              variant="ghost"
              className="ms-clear"
              onClick={() => void clearKeys()}
              disabled={saving !== null}
            >
              <Trash2 size={14} />
              {saving === 'clear' ? '正在清除密钥…' : '清除服务器密钥'}
            </Button>
            {storageError && (
              <p className="ms-error" role="alert">
                {storageError}
              </p>
            )}
          </div>
          <div className="ms-actions">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="恢复默认"
                  disabled={saving !== null}
                  onClick={() => {
                    testControllerRef.current?.controller.abort();
                    testControllerRef.current = null;
                    setDraft(copySettings(DEFAULT_SETTINGS));
                    setResetKeys(true);
                    setTests(INITIAL_TESTS);
                    clearErrors();
                  }}
                >
                  <RotateCcw size={20} />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="ms-tooltip">恢复默认</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  aria-label="保存配置"
                  onClick={() => void handleSave()}
                  disabled={saving !== null}
                >
                  {saving === 'save' ? (
                    <LoaderCircle className="ms-spinner" size={20} />
                  ) : (
                    <Save size={20} />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="ms-tooltip">保存配置</TooltipContent>
            </Tooltip>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
