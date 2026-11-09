import { useCallback, useEffect, useRef, useState } from 'react';
import type { TeachingInterruption } from '../lib/platform';
import { EnergyVad } from '../lib/vad';
import { looksLikePlaybackEcho } from '../lib/speech';

export interface SpeechCursor {
  key: string;
  mode: 'lesson' | 'answer';
  text: string;
  offset: number;
  boundary: 'word' | 'estimated' | 'section';
}
export interface VoiceQuestionContext {
  courseId: string;
  lessonId: string;
  interruption: TeachingInterruption;
}
type RecognitionResult = {
  isFinal: boolean;
  length: number;
  [index: number]: { transcript: string; confidence: number };
};
type RecognitionEvent = {
  resultIndex: number;
  results: { length: number; [index: number]: RecognitionResult };
};
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => Recognition;
type Options = {
  /** Called at speech onset, before TTS is stopped or the playback clock changes. */
  capture: (cursor: SpeechCursor | null) => VoiceQuestionContext | null;
  onInterrupt: (context: VoiceQuestionContext | null) => void;
  onQuestion: (text: string, context: VoiceQuestionContext | null) => Promise<unknown> | void;
  onError: (message: string) => void;
};
type SpeakOptions = {
  key: string;
  mode: 'lesson' | 'answer';
  rate?: number;
  offset?: number;
  onBoundary?: (cursor: SpeechCursor) => void;
  onEnd?: () => void;
};
function recognitionConstructor(): RecognitionConstructor | undefined {
  const browser = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return browser.SpeechRecognition || browser.webkitSpeechRecognition;
}

/** Browser TTS + real microphone VAD + ASR, with one frozen classroom snapshot per voice turn. */
export function useClassroomVoice(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<
    'off' | 'starting' | 'listening' | 'speaking' | 'recognizing' | 'submitting' | 'error'
  >('off');
  const [transcript, setTranscript] = useState('');
  const [level, setLevel] = useState(0);
  const [teacherSpeaking, setTeacherSpeaking] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(() => 'speechSynthesis' in window);
  const active = useRef(false),
    mounted = useRef(true),
    serial = useRef(0);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const frame = useRef(0);
  const recognition = useRef<Recognition | null>(null);
  const recognitionRunning = useRef(false);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const endTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const speechSerial = useRef(0);
  const cursor = useRef<SpeechCursor | null>(null);
  const startSpeechAt = useRef(0);
  const speechOriginOffset = useRef(0);
  const speechRate = useRef(1);
  const snapshot = useRef<VoiceQuestionContext | null>(null);
  const snapshotTaken = useRef(false);
  const interrupted = useRef(false);
  const words = useRef('');
  const finalizing = useRef(false);
  const voiceDetected = useRef(false);
  const vad = useRef(new EnergyVad());
  const supported = !!recognitionConstructor() && !!navigator.mediaDevices?.getUserMedia;

  const getCursor = useCallback((): SpeechCursor | null => {
    if (!cursor.current) return null;
    const result = { ...cursor.current };
    if (result.boundary !== 'word') {
      const estimated =
        speechOriginOffset.current +
        Math.floor(((performance.now() - startSpeechAt.current) / 1000) * 4.2 * speechRate.current);
      result.offset = Math.min(result.text.length, Math.max(result.offset, estimated));
      result.boundary = 'estimated';
    }
    return result;
  }, []);

  const stopSpeaking = useCallback(() => {
    speechSerial.current += 1;
    utterance.current = null;
    cursor.current = null;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (mounted.current) setTeacherSpeaking(false);
  }, []);

  const speak = useCallback(
    (text: string, settings: SpeakOptions) => {
      stopSpeaking();
      if (!text.trim() || !('speechSynthesis' in window)) return;
      const token = ++speechSerial.current;
      const offset = Math.max(0, Math.min(text.length, settings.offset ?? 0));
      const message = new SpeechSynthesisUtterance(text.slice(offset));
      message.lang = 'zh-CN';
      message.rate = Math.min(2, Math.max(0.6, settings.rate || 1));
      speechRate.current = message.rate;
      const voices = window.speechSynthesis.getVoices();
      const voice =
        voices.find((v) => /zh[-_]CN/i.test(v.lang) && v.localService) ||
        voices.find((v) => /^zh/i.test(v.lang));
      if (voice) message.voice = voice;
      utterance.current = message;
      cursor.current = {
        key: settings.key,
        mode: settings.mode,
        text,
        offset,
        boundary: 'estimated',
      };
      speechOriginOffset.current = offset;
      startSpeechAt.current = performance.now();
      message.onstart = () => {
        if (token === speechSerial.current && mounted.current) setTeacherSpeaking(true);
      };
      message.onboundary = (event) => {
        if (token !== speechSerial.current || !cursor.current) return;
        cursor.current = {
          ...cursor.current,
          offset: Math.min(text.length, offset + event.charIndex),
          boundary: 'word',
        };
        settings.onBoundary?.({ ...cursor.current });
      };
      message.onend = () => {
        if (token !== speechSerial.current) return;
        cursor.current = null;
        utterance.current = null;
        if (mounted.current) setTeacherSpeaking(false);
        settings.onEnd?.();
      };
      message.onerror = (event) => {
        if (token !== speechSerial.current || ['canceled', 'interrupted'].includes(event.error))
          return;
        cursor.current = null;
        if (mounted.current) {
          setTeacherSpeaking(false);
          latest.current.onError('语音朗读失败，可以关闭朗读后继续查看白板。');
        }
      };
      window.speechSynthesis.speak(message);
    },
    [stopSpeaking],
  );

  const resetTurn = useCallback(() => {
    snapshot.current = null;
    snapshotTaken.current = false;
    interrupted.current = false;
    words.current = '';
    voiceDetected.current = false;
    clearTimeout(finishTimer.current);
    clearTimeout(endTimer.current);
    if (mounted.current) setTranscript('');
  }, []);

  const stopListening = useCallback(() => {
    active.current = false;
    serial.current += 1;
    clearTimeout(restartTimer.current);
    clearTimeout(finishTimer.current);
    clearTimeout(endTimer.current);
    cancelAnimationFrame(frame.current);
    if (recognition.current) {
      recognition.current.onend = null;
      recognition.current.onresult = null;
      recognition.current.onerror = null;
      recognition.current.abort();
    }
    recognition.current = null;
    recognitionRunning.current = false;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    void audio.current?.close().catch(() => undefined);
    audio.current = null;
    resetTurn();
    if (mounted.current) {
      setEnabled(false);
      setStatus('off');
      setLevel(0);
    }
  }, [resetTurn]);

  const beginTurn = useCallback(() => {
    if (!snapshotTaken.current) {
      const captured = latest.current.capture(getCursor());
      snapshot.current = captured ? structuredClone(captured) : null;
      snapshotTaken.current = true;
    }
  }, [getCursor]);

  const confirmInterruption = useCallback(() => {
    beginTurn();
    if (interrupted.current) return;
    interrupted.current = true;
    latest.current.onInterrupt(snapshot.current);
    stopSpeaking();
  }, [beginTurn, stopSpeaking]);

  const startListening = useCallback(async () => {
    if (active.current) {
      stopListening();
      return;
    }
    const Constructor = recognitionConstructor();
    if (!Constructor || !navigator.mediaDevices?.getUserMedia) {
      latest.current.onError('当前浏览器没有可用的语音识别，请使用桌面 Chrome 并允许麦克风。');
      return;
    }
    const token = ++serial.current;
    setStatus('starting');
    try {
      const input = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (!mounted.current || token !== serial.current) {
        input.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = input;
      const context = new AudioContext();
      audio.current = context;
      await context.resume();
      if (!mounted.current || token !== serial.current) {
        input.getTracks().forEach((track) => track.stop());
        await context.close().catch(() => undefined);
        return;
      }
      const source = context.createMediaStreamSource(input),
        analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const recognizer = new Constructor();
      recognition.current = recognizer;
      recognizer.lang = 'zh-CN';
      recognizer.continuous = true;
      recognizer.interimResults = true;
      active.current = true;
      finalizing.current = false;
      vad.current.reset();
      resetTurn();
      setEnabled(true);
      setStatus('listening');

      const restart = () => {
        if (!active.current || token !== serial.current || recognitionRunning.current) return;
        try {
          recognizer.start();
          recognitionRunning.current = true;
        } catch {
          clearTimeout(restartTimer.current);
          restartTimer.current = setTimeout(restart, 300);
        }
      };
      const finish = async () => {
        if (!active.current || finalizing.current) return;
        clearTimeout(finishTimer.current);
        clearTimeout(endTimer.current);
        const question = words.current.trim();
        if (!question) {
          resetTurn();
          setStatus('listening');
          return;
        }
        confirmInterruption();
        const frozen = snapshot.current ? structuredClone(snapshot.current) : null;
        finalizing.current = true;
        setStatus('submitting');
        if (recognitionRunning.current) {
          recognizer.stop();
          recognitionRunning.current = false;
        }
        try {
          await latest.current.onQuestion(question, frozen);
        } catch (error) {
          latest.current.onError(
            error instanceof Error ? error.message : '语音问题提交失败，识别文字已保留。',
          );
        } finally {
          finalizing.current = false;
          if (active.current && token === serial.current) {
            resetTurn();
            setStatus('listening');
            clearTimeout(restartTimer.current);
            restartTimer.current = setTimeout(restart, 250);
          }
        }
      };

      recognizer.onresult = (event) => {
        if (!active.current || finalizing.current || token !== serial.current) return;
        let text = '';
        let final = false;
        for (let index = 0; index < event.results.length; index++) {
          text += event.results[index][0]?.transcript || '';
          final = final || event.results[index].isFinal;
        }
        text = text.trim();
        const audible = getCursor();
        if (!text) return;
        if (audible && looksLikePlaybackEcho(text, audible.text, audible.offset)) {
          // A speaker echo must not freeze a stale lesson position for a later real question.
          if (!interrupted.current) {
            snapshot.current = null;
            snapshotTaken.current = false;
          }
          return;
        }
        beginTurn();
        confirmInterruption();
        words.current = text;
        setTranscript(text);
        setStatus('speaking');
        clearTimeout(finishTimer.current);
        // ASR final results also close a turn if a device does not expose clean silence to VAD.
        finishTimer.current = setTimeout(
          () => {
            void finish();
          },
          final ? 1100 : 1700,
        );
      };
      recognizer.onerror = (event) => {
        recognitionRunning.current = false;
        if (!active.current || event.error === 'aborted') return;
        if (event.error === 'no-speech') return;
        const message =
          event.error === 'not-allowed' || event.error === 'service-not-allowed'
            ? '麦克风或语音识别权限被拒绝，请在浏览器中允许后重新开启语音对话。'
            : event.error === 'network'
              ? '浏览器语音识别服务连接失败，请检查网络后重新开启语音对话。'
              : '语音识别暂时不可用，请重新开启语音对话或使用文字提问。';
        stopListening();
        setStatus('error');
        latest.current.onError(message);
      };
      recognizer.onend = () => {
        recognitionRunning.current = false;
        if (!active.current || token !== serial.current || finalizing.current) return;
        if (words.current.trim()) {
          void finish();
          return;
        }
        clearTimeout(restartTimer.current);
        restartTimer.current = setTimeout(restart, 200);
      };

      let lastMeterUpdate = 0;
      const inspect = () => {
        if (!active.current || token !== serial.current) return;
        analyser.getFloatTimeDomainData(samples);
        const signal = vad.current.process(samples, performance.now());
        const stamp = performance.now();
        if (stamp - lastMeterUpdate >= 90) {
          setLevel(Math.min(1, signal.rms * 12));
          lastMeterUpdate = stamp;
        }
        if (signal.started && !finalizing.current) {
          voiceDetected.current = true;
          beginTurn();
          setStatus('speaking');
          // During playback ASR confirms novelty before stopping sound, suppressing speaker echo.
          if (!cursor.current) confirmInterruption();
        }
        if (signal.ended && !finalizing.current) {
          voiceDetected.current = false;
          if (words.current.trim()) {
            setStatus('recognizing');
            clearTimeout(finishTimer.current);
            finishTimer.current = setTimeout(() => {
              void finish();
            }, 350);
          } else {
            clearTimeout(endTimer.current);
            endTimer.current = setTimeout(() => {
              if (!words.current.trim()) {
                resetTurn();
                setStatus('listening');
              }
            }, 2500);
          }
        }
        frame.current = requestAnimationFrame(inspect);
      };
      restart();
      frame.current = requestAnimationFrame(inspect);
    } catch (error) {
      stopListening();
      if (mounted.current) setStatus('error');
      latest.current.onError(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? '请允许麦克风权限后开启语音对话。'
          : '无法打开麦克风，请检查设备是否可用。',
      );
    }
  }, [beginTurn, confirmInterruption, resetTurn, stopListening]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopListening();
      stopSpeaking();
    };
  }, [stopListening, stopSpeaking]);

  return {
    supported,
    enabled,
    status,
    transcript,
    level,
    teacherSpeaking,
    ttsEnabled,
    setTtsEnabled: (value: boolean) => {
      setTtsEnabled(value);
      if (!value) stopSpeaking();
    },
    speak,
    stopSpeaking,
    getCursor,
    toggleListening: startListening,
    stopListening,
    resetTurn,
  };
}
