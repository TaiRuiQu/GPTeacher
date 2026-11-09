import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiJson, isAbortError, type ApiDiagnostics } from '../lib/api';
import type { ModelSettingsValue } from '../lib/settings';

type Status = 'idle' | 'requesting' | 'recording' | 'transcribing';
type Options = {
  settings: ModelSettingsValue['stt'];
  onTranscript: (text: string) => void;
  onError: (message: string, diagnostics?: ApiDiagnostics) => void;
  onRecordingStart?: () => void;
};
const MAX_RECORDING_MS = 90_000;
const MAX_RECORDING_BYTES = 20 * 1024 * 1024;

function microphoneMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError')
      return '无法使用麦克风。请在浏览器中允许麦克风权限后重试。';
    if (error.name === 'NotFoundError') return '没有找到麦克风，请连接设备后重试。';
    if (error.name === 'NotReadableError') return '麦克风正被其他程序占用，请释放设备后重试。';
    if (error.name === 'SecurityError')
      return '当前页面无法录音，请使用 HTTPS 或本机地址打开课堂。';
  }
  return '无法启动录音，请检查麦克风权限和设备。';
}

export function useVoiceQuestion(options: Options) {
  const [status, setStatus] = useState<Status>('idle');
  const statusRef = useRef<Status>('idle');
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(true);
  const generation = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settingsIdentity = JSON.stringify(options.settings);

  const updateStatus = useCallback((value: Status) => {
    statusRef.current = value;
    if (mounted.current) setStatus(value);
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    generation.current += 1;
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
    requestRef.current?.abort();
    requestRef.current = null;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        // Some engines finish recording as the device is disconnected.
      }
    }
    releaseStream();
    updateStatus('idle');
  }, [releaseStream, updateStatus]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, [cancel]);

  useEffect(() => {
    cancel();
  }, [settingsIdentity, cancel]);

  const start = useCallback(async () => {
    if (!latest.current.settings.enabled) {
      latest.current.onError('请先在“模型与语音”中启用语音识别并填写配置。');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      latest.current.onError(
        '当前浏览器无法录音，请使用新版 Chrome、Edge 或 Safari，并通过 HTTPS 或本机地址打开。',
      );
      return;
    }
    const id = ++generation.current;
    updateStatus('requesting');
    latest.current.onRecordingStart?.();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (!mounted.current || id !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      const chunks: Blob[] = [];
      let bytes = 0;
      const fail = (message: string) => {
        if (id !== generation.current || !mounted.current) return;
        cancel();
        latest.current.onError(message);
      };
      recorder.ondataavailable = (event: BlobEvent) => {
        if (id !== generation.current || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > MAX_RECORDING_BYTES) {
          fail('录音超过 20 MB，请缩短问题后重新录制。');
          return;
        }
        chunks.push(event.data);
      };
      recorder.onerror = () => fail('录音中断，请检查麦克风后重新录制。');
      recorder.onstop = () => {
        if (id !== generation.current || !mounted.current) return;
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
        releaseStream();
        recorderRef.current = null;
        if (!bytes) {
          fail('没有录到声音，请重新录制。');
          return;
        }
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const data = new FormData();
        data.append('settings', JSON.stringify(latest.current.settings));
        data.append('file', new Blob(chunks, { type }), `question.${extension}`);
        const controller = new AbortController();
        requestRef.current = controller;
        updateStatus('transcribing');
        void apiJson<{ text: string }>('/api/transcribe', data, controller.signal).then(
          (result) => {
            if (id !== generation.current || !mounted.current) return;
            requestRef.current = null;
            updateStatus('idle');
            const text = typeof result.text === 'string' ? result.text.trim() : '';
            if (!text) {
              latest.current.onError('没有识别到语音内容，请靠近麦克风后重试。');
              return;
            }
            latest.current.onTranscript(text);
          },
          (error: unknown) => {
            if (id !== generation.current || !mounted.current) return;
            requestRef.current = null;
            updateStatus('idle');
            if (!isAbortError(error))
              latest.current.onError(
                error instanceof Error ? error.message : '语音识别失败，请重试。',
                error instanceof ApiError ? error.diagnostics : undefined,
              );
          },
        );
      };
      recorder.start(500);
      updateStatus('recording');
      timerRef.current = setTimeout(() => {
        if (id === generation.current && recorder.state === 'recording') {
          updateStatus('transcribing');
          recorder.stop();
        }
      }, MAX_RECORDING_MS);
    } catch (error) {
      if (id !== generation.current || !mounted.current) return;
      cancel();
      latest.current.onError(microphoneMessage(error));
    }
  }, [cancel, releaseStream, updateStatus]);

  const toggle = useCallback(() => {
    if (statusRef.current === 'recording') {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
      updateStatus('transcribing');
      recorderRef.current?.stop();
    } else if (statusRef.current === 'requesting' || statusRef.current === 'transcribing') {
      cancel();
    } else void start();
  }, [cancel, start, updateStatus]);

  return { status, toggle, cancel };
}
