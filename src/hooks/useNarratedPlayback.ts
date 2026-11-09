import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiAudio, isAbortError, type ApiDiagnostics } from '../lib/api';
import { locateStep, type Lesson } from '../lib/lesson';
import type { ModelSettingsValue } from '../lib/settings';
import { NarrationCache } from '../lib/narration-cache';

type Status = 'idle' | 'loading' | 'playing' | 'paused' | 'error';
type Options = {
  lesson: Lesson;
  time: number;
  playing: boolean;
  speed: number;
  settings: ModelSettingsValue['tts'];
  onTime: (time: number) => void;
  onPlaying: (playing: boolean) => void;
  onError: (message: string, diagnostics?: ApiDiagnostics) => void;
};
type ActiveAudio = {
  audio: HTMLAudioElement;
  start: number;
  duration: number;
  ready: boolean;
};

function narrationForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*`_~]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\${1,2}/g, '')
    .trim();
}

/** Audio is the clock; authored step times provide the seekable visual coordinates. */
export function useNarratedPlayback(options: Options) {
  const { lesson, time, playing, speed, settings } = options;
  const [status, setStatus] = useState<Status>('idle');
  const [revision, setRevision] = useState(0);
  const latest = useRef(options);
  latest.current = options;
  const active = useRef<ActiveAudio | null>(null);
  const cache = useRef<NarrationCache>(new NarrationCache());
  const emittedTimes = useRef<number[]>([]);
  const failed = useRef(false);
  const preparationFailed = useRef(false);
  const settingsIdentity = JSON.stringify(settings);
  const identity = useMemo(
    () => JSON.stringify([lesson.id, lesson.source, settingsIdentity]),
    [lesson.id, lesson.source, settingsIdentity],
  );
  const items = useMemo(
    () =>
      lesson.steps.map((item) => {
        const text = narrationForSpeech(item.narration);
        return { key: `${settingsIdentity}\u0000${text}`, text };
      }),
    [lesson.steps, settingsIdentity],
  );
  const [preparation, setPreparation] = useState({
    identity: '',
    revision: -1,
    completed: 0,
    ready: false,
    preparing: false,
  });
  const { step, index: stepIndex } = locateStep(lesson, time);
  const currentPreparation = preparation.identity === identity && preparation.revision === revision;
  const preparedCount = currentPreparation ? preparation.completed : 0;
  const ready = settings.enabled && currentPreparation && preparation.ready;
  const preparing = settings.enabled && (!currentPreparation || preparation.preparing);
  const currentReady = settings.enabled && cache.current.has(items[stepIndex].key);

  useEffect(() => {
    failed.current = false;
    preparationFailed.current = false;
    emittedTimes.current = [];
    return () => cache.current.clear();
  }, [settingsIdentity]);

  useEffect(() => {
    let disposed = false;
    failed.current = false;
    preparationFailed.current = false;
    emittedTimes.current = [];
    if (!settings.enabled) {
      setPreparation({ identity, revision, completed: 0, ready: false, preparing: false });
      return;
    }
    const update = (completed: number, complete = false) => {
      if (!disposed)
        setPreparation({ identity, revision, completed, ready: complete, preparing: !complete });
    };
    update(cache.current.count(items));
    // StrictMode cleans up the first mount before its microtask can issue a paid request.
    queueMicrotask(() => {
      if (disposed) return;
      void cache.current
        .prepare(
          items,
          (text, signal) => {
            if (!text)
              return Promise.reject(new Error('有片段没有可朗读的讲解文字，请在课堂脚本中补充。'));
            return apiAudio('/api/speech', { settings, text }, signal);
          },
          (completed) => update(completed),
          (item) => {
            const current = locateStep(latest.current.lesson, latest.current.time).index;
            const index = items.findIndex((entry) => entry.key === item.key);
            return (index - current + items.length) % items.length;
          },
        )
        .then(
          () => update(items.length, true),
          (error: unknown) => {
            if (disposed || isAbortError(error)) return;
            failed.current = true;
            preparationFailed.current = true;
            setPreparation({
              identity,
              revision,
              completed: cache.current.count(items),
              ready: false,
              preparing: false,
            });
            setStatus('error');
            const current = locateStep(latest.current.lesson, latest.current.time).index;
            if (!cache.current.has(items[current]?.key ?? '')) latest.current.onPlaying(false);
            latest.current.onError(
              error instanceof Error ? error.message : '课程语音准备失败，请检查配置后重试。',
              error instanceof ApiError ? error.diagnostics : undefined,
            );
          },
        );
    });
    return () => {
      disposed = true;
      cache.current.cancel();
    };
  }, [identity, items, revision, settings.enabled]);

  useEffect(() => {
    if (!settings.enabled) {
      setStatus('idle');
      return;
    }
    if (!currentReady) {
      const cannotPrepare = failed.current || preparationFailed.current;
      setStatus(cannotPrepare ? 'error' : 'loading');
      if (cannotPrepare && playing) latest.current.onPlaying(false);
      return;
    }
    if (!playing) {
      setStatus(failed.current ? 'error' : 'paused');
      return;
    }
    let disposed = false;
    let frame = 0;
    let metadataTimeout: ReturnType<typeof setTimeout> | undefined;
    let audio: HTMLAudioElement | null = null;
    let finished = false;
    const requestKey = items[stepIndex].key;
    failed.current = false;
    setStatus('loading');

    const stillCurrent = () =>
      latest.current.lesson.id === lesson.id &&
      latest.current.lesson.source === lesson.source &&
      locateStep(latest.current.lesson, latest.current.time).step.id === step.id;

    const emitTime = (value: number) => {
      if (value === latest.current.time) return;
      // React can batch frames. Retain pending values until their render acknowledges them.
      emittedTimes.current.push(value);
      if (emittedTimes.current.length > 120) emittedTimes.current.shift();
      latest.current.onTime(value);
    };

    const fail = (message: string, diagnostics?: ApiDiagnostics) => {
      if (disposed || finished || !stillCurrent()) return;
      finished = true;
      failed.current = true;
      cancelAnimationFrame(frame);
      audio?.pause();
      setStatus('error');
      latest.current.onPlaying(false);
      latest.current.onError(message, diagnostics);
    };
    const tick = () => {
      if (disposed || finished || !audio || !active.current?.ready) return;
      if (!latest.current.playing || !stillCurrent()) return;
      if (!audio.paused && Number.isFinite(audio.duration) && audio.duration > 0) {
        const fraction = Math.max(0, Math.min(1, audio.currentTime / audio.duration));
        // The ended event commits the exact boundary, so the last syllable is not cut off.
        emitTime(step.start + Math.min(step.duration - 0.001, fraction * step.duration));
      }
      frame = requestAnimationFrame(tick);
    };
    const load = async () => {
      try {
        const entry = cache.current.get(requestKey);
        if (!entry) throw new Error('这一段语音尚未准备好，请重试语音准备。');
        if (disposed) return;
        audio = new Audio();
        audio.preload = 'auto';
        active.current = { audio, start: step.start, duration: step.duration, ready: false };
        metadataTimeout = setTimeout(() => fail('音频载入超时，请检查语音格式后重试。'), 20_000);
        audio.onloadedmetadata = () => {
          if (disposed || !audio || !stillCurrent()) return;
          clearTimeout(metadataTimeout);
          if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
            fail('无法读取语音时长，请检查 TTS 返回的音频格式。');
            return;
          }
          if (active.current) active.current.ready = true;
          audio.playbackRate = Math.max(0.25, Math.min(4, latest.current.speed));
          const fraction = Math.max(
            0,
            Math.min(1, (latest.current.time - step.start) / step.duration),
          );
          audio.currentTime = Math.min(audio.duration, fraction * audio.duration);
          if (!latest.current.playing) return;
          void audio.play().then(
            () => {
              if (disposed || finished || !latest.current.playing || !stillCurrent()) return;
              setStatus('playing');
              frame = requestAnimationFrame(tick);
            },
            () => fail('浏览器未能播放语音，请再次点击播放，或检查音频格式。'),
          );
        };
        audio.onwaiting = () => {
          if (!disposed && !finished) setStatus('loading');
        };
        audio.onplaying = () => {
          if (!disposed && !finished) setStatus('playing');
        };
        audio.onerror = () => {
          cache.current.remove(requestKey);
          fail('这段语音无法解码，请检查 TTS 模型及返回的音频格式。');
        };
        audio.onended = () => {
          if (disposed || finished || !latest.current.playing || !stillCurrent()) return;
          finished = true;
          cancelAnimationFrame(frame);
          emitTime(Math.min(lesson.duration, step.start + step.duration));
          if (step.start + step.duration >= lesson.duration) {
            setStatus('paused');
            latest.current.onPlaying(false);
          } else setStatus('loading');
        };
        audio.src = entry.url;
        audio.load();
      } catch (error) {
        if (!disposed && !isAbortError(error))
          fail(
            error instanceof Error ? error.message : '语音生成失败，请检查配置后重试。',
            error instanceof ApiError ? error.diagnostics : undefined,
          );
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(metadataTimeout);
      cancelAnimationFrame(frame);
      if (audio) {
        audio.onloadedmetadata = null;
        audio.onwaiting = null;
        audio.onplaying = null;
        audio.onerror = null;
        audio.onended = null;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      active.current = null;
    };
  }, [
    settings.enabled,
    settingsIdentity,
    lesson.id,
    lesson.source,
    lesson.duration,
    step.id,
    step.narration,
    step.start,
    step.duration,
    playing,
    currentReady,
    items,
    stepIndex,
  ]);

  useEffect(() => {
    const echoedIndex = emittedTimes.current.indexOf(time);
    if (echoedIndex !== -1) {
      emittedTimes.current.splice(0, echoedIndex + 1);
      return;
    }
    emittedTimes.current = [];
    const item = active.current;
    if (!item?.ready || !Number.isFinite(item.audio.duration)) return;
    const target =
      Math.max(0, Math.min(1, (time - item.start) / item.duration)) * item.audio.duration;
    item.audio.currentTime = target;
  }, [time]);

  useEffect(() => {
    if (active.current) active.current.audio.playbackRate = Math.max(0.25, Math.min(4, speed));
  }, [speed]);

  const retry = useCallback(() => {
    failed.current = false;
    setRevision((value) => value + 1);
    latest.current.onPlaying(true);
  }, []);

  return {
    status,
    retry,
    preparedCount,
    totalCount: lesson.steps.length,
    preparing,
    ready,
    currentReady,
  };
}
