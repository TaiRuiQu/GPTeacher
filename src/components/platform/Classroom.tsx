import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Ellipsis,
  FileText,
  GraduationCap,
  Lightbulb,
  List,
  LoaderCircle,
  Maximize2,
  Minimize2,
  MessageCircle,
  Mic,
  MicOff,
  NotebookPen,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { AgentRunner, PlatformMutator } from '../../App';
import {
  findCourseNode,
  getCourseLessons,
  getCourseNodePath,
  getNodeLessons,
  type Course,
  type CourseNode,
  type LearnerProfile,
  type PlatformState,
  type TeachingInterruption,
} from '../../lib/platform';
import {
  useClassroomVoice,
  type SpeechCursor,
  type VoiceQuestionContext,
} from '../../hooks/useClassroomVoice';
import { toSpeechText } from '../../lib/speech';
import { LearningTree } from './LearningTree';
import { formatTime, locateStep, parseLesson } from '../../lib/lesson';
import { LessonStage } from '../LessonStage';
import { Markdown } from './Markdown';
import { activeJob } from './JobPanel';

type DockTab = 'outline' | 'tutor' | 'practice' | 'notes' | 'transcript';
const dockTabs = [
  { id: 'outline', label: '学习树', accessible: '学习树', icon: List },
  { id: 'tutor', label: '提问', accessible: '提问', icon: MessageCircle },
  { id: 'practice', label: '练习', accessible: '随堂练习', icon: Lightbulb },
  { id: 'notes', label: '笔记', accessible: '学习笔记', icon: NotebookPen },
  { id: 'transcript', label: '讲稿', accessible: '课堂讲解', icon: FileText },
] as const;

interface ClassroomProps {
  course: Course;
  lessonId: string;
  learner: LearnerProfile;
  state: PlatformState;
  pending: boolean;
  onBack: () => void;
  onLesson: (id: string) => void;
  onAgent: AgentRunner;
  onMutate: PlatformMutator;
  onNotice: (message: string) => void;
  onLibrary?: () => void;
  onNewCourse?: () => void;
  onSettings?: () => void;
  onRecords?: () => void;
  onJobs?: () => void;
  activeJobs?: number;
  onExtendCourse?: (parentNodeId?: string) => void;
  suspended?: boolean;
}

export function Classroom({
  course,
  lessonId,
  learner,
  state,
  pending,
  onBack,
  onLesson,
  onAgent,
  onMutate,
  onNotice,
  onLibrary,
  onNewCourse,
  onSettings,
  onRecords,
  onJobs,
  activeJobs = 0,
  onExtendCourse,
  suspended = false,
}: ClassroomProps) {
  const selectedNode = findCourseNode(course, lessonId) || course.nodes[0];
  const lesson = selectedNode?.kind === 'lesson' ? selectedNode : null;
  const title = selectedNode?.title || course.title;
  const lessons = getCourseLessons(course);
  const lessonIndex = lesson ? lessons.findIndex((item) => item.id === lesson.id) : -1;
  const path = selectedNode ? getCourseNodePath(course, selectedNode.id) : [];
  const parentChapter = path
    .slice(0, -1)
    .filter((node) => node.kind === 'chapter')
    .at(-1);
  const ready = !!lesson && lesson.status === 'ready' && !!lesson.source.trim();
  const parsed = useMemo(() => {
    if (!ready || !lesson) return { lesson: null, error: '' };
    try {
      return { lesson: parseLesson(lesson.source), error: '' };
    } catch (e) {
      return { lesson: null, error: e instanceof Error ? e.message : '课程内容无法读取。' };
    }
  }, [ready, lesson?.source]);
  const saved = lesson
    ? state.progress.find(
        (p) => p.learnerId === learner.id && p.courseId === course.id && p.lessonId === lesson.id,
      )
    : undefined;
  const playbackId = ready ? lesson!.id : '';
  const [clock, setClock] = useState({
    lessonId: playbackId,
    elapsed: saved?.position || 0,
    playing: false,
  });
  const records = useRef(
    new Map<string, { position: number; lastSaved: number; completed: boolean; saving: boolean }>(),
  );
  if (playbackId && !records.current.has(playbackId))
    records.current.set(playbackId, {
      position: saved?.position || 0,
      lastSaved: saved?.position || 0,
      completed: saved?.completed || false,
      saving: false,
    });
  const elapsed =
    clock.lessonId === playbackId
      ? Math.min(clock.elapsed, parsed.lesson?.duration || 0)
      : Math.min(
          records.current.get(playbackId)?.position || saved?.position || 0,
          parsed.lesson?.duration || 0,
        );
  const playing = !!playbackId && clock.lessonId === playbackId && clock.playing;
  const [speed, setSpeed] = useState(1);
  const [tab, setTab] = useState<DockTab>('outline');
  const [dockOpen, setDockOpen] = useState(true);
  const [selectedLessonIds, setSelectedLessonIds] = useState<string[]>([]);
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [remedialRequest, setRemedialRequest] = useState('');
  const [error, setError] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [selected, setSelected] = useState<{ id: string; label: string } | null>(null);
  const tutorInput = useRef<HTMLTextAreaElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const mutateRef = useRef(onMutate);
  mutateRef.current = onMutate;
  const parsedLesson = parsed.lesson;
  const located = parsedLesson ? locateStep(parsedLesson, elapsed) : null;
  const tutorJob = state.jobs.find(
    (j) =>
      j.command.learnerId === learner.id &&
      j.command.courseId === course.id &&
      j.command.lessonId === lesson?.id &&
      j.command.action === 'tutor' &&
      activeJob(j),
  );
  const gradeJob = state.jobs.find(
    (j) =>
      j.command.learnerId === learner.id &&
      j.command.courseId === course.id &&
      j.command.lessonId === lesson?.id &&
      j.command.action === 'grade' &&
      activeJob(j),
  );
  const generationJob = state.jobs.find(
    (j) =>
      j.command.courseId === course.id &&
      j.command.action === 'generate_lessons' &&
      j.command.lessonIds?.includes(lesson?.id || '') &&
      activeJob(j),
  );
  const generatingCourse = state.jobs.some(
    (j) =>
      j.command.courseId === course.id && j.command.action === 'generate_lessons' && activeJob(j),
  );
  const plannedSelection = lessons.filter(
    (item) => item.status === 'planned' && selectedLessonIds.includes(item.id),
  );
  const messages = state.messages
    .filter(
      (m) => m.learnerId === learner.id && m.courseId === course.id && m.lessonId === lesson?.id,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const notes = state.notes
    .filter(
      (n) => n.learnerId === learner.id && n.courseId === course.id && n.lessonId === lesson?.id,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latestAttempt = state.attempts
    .filter(
      (a) => a.learnerId === learner.id && a.courseId === course.id && a.lessonId === lesson?.id,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const progressCompleted = saved?.completed || false;
  const activeTab = dockTabs.find((item) => item.id === tab)!;
  const resumeCursors = useRef(new Map<string, Pick<SpeechCursor, 'offset' | 'boundary'>>());
  const seenMessages = useRef(new Set(state.messages.map((message) => message.id)));
  const [answerToRead, setAnswerToRead] = useState<{ id: string; text: string } | null>(null);
  const [speechRevision, setSpeechRevision] = useState(0);
  const stepSpeechText = useMemo(
    () => toSpeechText(located?.step.narration || ''),
    [located?.step.narration],
  );
  const voice = useClassroomVoice({
    capture: (cursor) => classroomSnapshot(cursor),
    onInterrupt: (context) => {
      pauseLecture(context);
      setAnswerToRead(null);
      if (context?.lessonId === lesson?.id) openTab('tutor');
    },
    onQuestion: async (text, context) => {
      setQuestion(text);
      if (!context) {
        setError('先打开一节已生成的讲解，再开启语音对话。');
        return;
      }
      setError('');
      try {
        await onAgent({
          action: 'tutor',
          courseId: context.courseId,
          lessonId: context.lessonId,
          question: text,
          interruption: context.interruption,
        });
        setQuestion('');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '语音问题提交失败，识别文字已保留。');
        throw cause;
      }
    },
    onError: (message) => {
      setClock((current) => ({ ...current, playing: false }));
      setError(message);
    },
  });
  const voiceStatusLabel =
    voice.teacherSpeaking && voice.enabled
      ? '正在讲解，可随时插话'
      : {
          off: '开启后可直接说出问题',
          starting: '正在开启麦克风',
          listening: '正在聆听，说完后自动提问',
          speaking: '检测到你在说话',
          recognizing: '正在识别你的问题',
          submitting: '正在提交问题',
          error: '语音连接已停止',
        }[voice.status];

  function classroomSnapshot(cursor: SpeechCursor | null): VoiceQuestionContext | null {
    if (!ready || !lesson || !parsedLesson || !located) return null;
    const spokenStep =
      cursor?.mode === 'lesson'
        ? parsedLesson.steps.find((step) => step.id === cursor.key)
        : undefined;
    const currentPosition = Math.min(
      parsedLesson.duration,
      records.current.get(lesson.id)?.position ?? elapsed,
    );
    const step = spokenStep || locateStep(parsedLesson, currentPosition).step;
    const text = toSpeechText(step.narration);
    const remembered = resumeCursors.current.get(`${lesson.id}:${step.id}`);
    const boundary = spokenStep
      ? cursor!.boundary
      : voice.ttsEnabled
        ? remembered?.boundary || 'section'
        : 'section';
    const offset = Math.floor(
      Math.max(0, Math.min(text.length, spokenStep ? cursor!.offset : remembered?.offset || 0)),
    );
    const position = spokenStep
      ? step.start +
        Math.min(
          Math.max(0, step.duration - 0.001),
          (offset / Math.max(1, text.length)) * step.duration,
        )
      : currentPosition;
    return {
      courseId: course.id,
      lessonId: lesson.id,
      interruption: {
        position,
        stepId: step.id,
        ...(boundary !== 'section' ? { narrationOffset: offset } : {}),
        boundary,
        channel: 'voice',
        interrupted: true,
        ...(cursor?.mode === 'answer'
          ? { answerMessageId: cursor.key, answerOffset: Math.floor(cursor.offset) }
          : {}),
        ...(selected ? { selectedObject: { ...selected } } : {}),
      },
    };
  }

  function pauseLecture(context?: VoiceQuestionContext | null) {
    const snapshot = context || classroomSnapshot(voice.getCursor());
    if (snapshot?.courseId === course.id) {
      const record = records.current.get(snapshot.lessonId);
      if (record) record.position = snapshot.interruption.position;
      if (snapshot.interruption.narrationOffset !== undefined)
        resumeCursors.current.set(`${snapshot.lessonId}:${snapshot.interruption.stepId}`, {
          offset: snapshot.interruption.narrationOffset,
          boundary: snapshot.interruption.boundary,
        });
      setClock({
        lessonId: snapshot.lessonId,
        elapsed: snapshot.interruption.position,
        playing: false,
      });
    } else setClock((current) => ({ ...current, playing: false }));
    voice.stopSpeaking();
  }

  useEffect(() => {
    voice.stopSpeaking();
    voice.stopListening();
    setAnswerToRead(null);
    state.messages.forEach((message) => seenMessages.current.add(message.id));
    setQuestion('');
    setAnswers({});
    setNote('');
    setSelected(null);
    setError('');
    setRemedialRequest('');
  }, [selectedNode?.id]);
  useEffect(() => {
    if (!suspended) return;
    pauseLecture();
    voice.stopListening();
    setAnswerToRead(null);
  }, [suspended]);
  useEffect(() => {
    const planned = new Set(
      lessons.filter((item) => item.status === 'planned').map((item) => item.id),
    );
    setSelectedLessonIds((current) =>
      current.every((id) => planned.has(id)) ? current : current.filter((id) => planned.has(id)),
    );
  }, [course]);
  useEffect(() => {
    if (!playing || !parsedLesson || (voice.ttsEnabled && stepSpeechText)) return;
    const timer = window.setInterval(
      () =>
        setClock((current) => {
          if (current.lessonId !== playbackId) return current;
          const next = Math.min(parsedLesson.duration, current.elapsed + 0.25 * speed);
          const record = records.current.get(playbackId);
          if (record) record.position = next;
          return { ...current, elapsed: next, playing: next < parsedLesson.duration };
        }),
      250,
    );
    return () => window.clearInterval(timer);
  }, [playing, parsedLesson, playbackId, speed, voice.ttsEnabled, stepSpeechText]);
  useEffect(() => {
    if (!playing || !voice.ttsEnabled || !located || !parsedLesson || !playbackId || suspended)
      return;
    const step = located.step;
    const text = toSpeechText(step.narration);
    if (!text) return;
    const key = `${playbackId}:${step.id}`;
    const prior = resumeCursors.current.get(key);
    const position = records.current.get(playbackId)?.position || step.start;
    const estimatedOffset = Math.floor(
      (Math.max(0, position - step.start) / step.duration) * text.length,
    );
    const offset = Math.min(text.length, Math.max(0, prior?.offset ?? estimatedOffset));
    voice.speak(text, {
      key: step.id,
      mode: 'lesson',
      offset,
      rate: speed,
      onBoundary: (cursor) => {
        resumeCursors.current.set(key, { offset: cursor.offset, boundary: cursor.boundary });
        const position =
          step.start +
          Math.min(
            Math.max(0, step.duration - 0.001),
            (cursor.offset / Math.max(1, text.length)) * step.duration,
          );
        const record = records.current.get(playbackId);
        if (record) record.position = position;
        setClock((current) =>
          current.lessonId === playbackId ? { ...current, elapsed: position } : current,
        );
      },
      onEnd: () => {
        resumeCursors.current.delete(key);
        const next = parsedLesson.steps[located.index + 1];
        if (next) resumeCursors.current.delete(`${playbackId}:${next.id}`);
        const position = next?.start ?? parsedLesson.duration;
        const record = records.current.get(playbackId);
        if (record) record.position = position;
        setClock((current) =>
          current.lessonId === playbackId
            ? { ...current, elapsed: position, playing: !!next }
            : current,
        );
      },
    });
    return () => {
      const cursor = voice.getCursor();
      if (cursor?.mode === 'lesson' && cursor.key === step.id)
        resumeCursors.current.set(key, { offset: cursor.offset, boundary: cursor.boundary });
      voice.stopSpeaking();
    };
  }, [playing, playbackId, located?.step.id, voice.ttsEnabled, speed, speechRevision, suspended]);
  useEffect(() => {
    const fresh = messages.filter(
      (message) => message.role === 'assistant' && !seenMessages.current.has(message.id),
    );
    messages.forEach((message) => seenMessages.current.add(message.id));
    const newest = fresh.at(-1);
    if (!newest || !ready || !voice.ttsEnabled || suspended) return;
    pauseLecture();
    openTab('tutor');
    setAnswerToRead({ id: newest.id, text: toSpeechText(newest.content) });
  }, [messages, voice.ttsEnabled, ready, suspended]);
  useEffect(() => {
    if (!answerToRead || playing || !voice.ttsEnabled || suspended) return;
    voice.speak(answerToRead.text, {
      key: answerToRead.id,
      mode: 'answer',
      rate: speed,
      onEnd: () => setAnswerToRead(null),
    });
    return () => voice.stopSpeaking();
  }, [answerToRead?.id, playing, voice.ttsEnabled, suspended]);
  useEffect(() => {
    if (playbackId && saved?.completed) {
      const record = records.current.get(playbackId);
      if (record) record.completed = true;
    }
  }, [playbackId, saved?.completed]);
  useEffect(() => {
    if (!playbackId) return;
    const persist = () => {
      const record = records.current.get(playbackId);
      if (!record || record.saving || Math.abs(record.position - record.lastSaved) < 0.5) return;
      record.saving = true;
      record.lastSaved = record.position;
      void mutateRef
        .current('/api/platform/progress', {
          learnerId: learner.id,
          courseId: course.id,
          lessonId: playbackId,
          position: record.position,
          completed: record.completed,
        })
        .catch(() => {
          record.lastSaved = -1;
        })
        .finally(() => {
          record.saving = false;
        });
    };
    const timer = window.setInterval(persist, 8000);
    return () => {
      window.clearInterval(timer);
      persist();
    };
  }, [playbackId, learner.id, course.id]);
  useEffect(() => {
    if (!playbackId || playing) return;
    const timer = window.setTimeout(() => {
      const record = records.current.get(playbackId);
      if (!record || record.saving || Math.abs(record.position - record.lastSaved) < 0.5) return;
      record.saving = true;
      record.lastSaved = record.position;
      void mutateRef
        .current('/api/platform/progress', {
          learnerId: learner.id,
          courseId: course.id,
          lessonId: playbackId,
          position: record.position,
          completed: record.completed,
        })
        .catch(() => {
          record.lastSaved = -1;
        })
        .finally(() => {
          record.saving = false;
        });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [playbackId, playing, elapsed, learner.id, course.id]);
  useEffect(() => {
    if (tab === 'tutor' && dockOpen) chatEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length, tab, dockOpen]);
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  const setPlaying = (value: boolean) => {
    if (!playbackId) return;
    if (!value) {
      pauseLecture();
      setAnswerToRead(null);
      return;
    }
    voice.stopSpeaking();
    setAnswerToRead(null);
    setClock((current) => ({
      lessonId: playbackId,
      elapsed:
        current.lessonId === playbackId
          ? current.elapsed
          : records.current.get(playbackId)?.position || 0,
      playing: value,
    }));
  };
  const openTab = (next: DockTab) => {
    setTab(next);
    setDockOpen(true);
  };
  const seek = (position: number) => {
    if (!playbackId) return;
    voice.stopSpeaking();
    setAnswerToRead(null);
    const next = Math.max(0, Math.min(parsedLesson?.duration || 0, position));
    if (parsedLesson) {
      const target = locateStep(parsedLesson, next);
      const text = toSpeechText(target.step.narration);
      resumeCursors.current.set(`${playbackId}:${target.step.id}`, {
        offset: Math.floor((target.localTime / target.step.duration) * text.length),
        boundary: 'estimated',
      });
    }
    const record = records.current.get(playbackId);
    if (record) record.position = next;
    setClock((current) => ({
      lessonId: playbackId,
      elapsed: next,
      playing: current.lessonId === playbackId && current.playing,
    }));
    setSpeechRevision((current) => current + 1);
    setSelected(null);
  };
  const changeSpeed = () => {
    if (playing) {
      const snapshot = classroomSnapshot(voice.getCursor());
      if (snapshot) {
        const record = records.current.get(snapshot.lessonId);
        if (record) record.position = snapshot.interruption.position;
        if (snapshot.interruption.narrationOffset !== undefined)
          resumeCursors.current.set(`${snapshot.lessonId}:${snapshot.interruption.stepId}`, {
            offset: snapshot.interruption.narrationOffset,
            boundary: snapshot.interruption.boundary,
          });
        setClock((current) => ({ ...current, elapsed: snapshot.interruption.position }));
      }
      voice.stopSpeaking();
    }
    setSpeed(speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1);
  };
  const toggleNarration = () => {
    if (voice.ttsEnabled) {
      const snapshot = classroomSnapshot(voice.getCursor());
      if (snapshot) {
        const record = records.current.get(snapshot.lessonId);
        if (record) record.position = snapshot.interruption.position;
        setClock((current) => ({ ...current, elapsed: snapshot.interruption.position }));
      }
      setAnswerToRead(null);
    } else if (located) {
      resumeCursors.current.set(`${playbackId}:${located.step.id}`, {
        offset: Math.floor((located.localTime / located.step.duration) * stepSpeechText.length),
        boundary: 'estimated',
      });
    }
    voice.setTtsEnabled(!voice.ttsEnabled);
  };
  const generate = async (ids: string[]) => {
    const wanted = ids.filter((id) =>
      lessons.some((item) => item.id === id && item.status === 'planned'),
    );
    if (!wanted.length || pending || generatingCourse) return;
    setError('');
    try {
      await onAgent({ action: 'generate_lessons', courseId: course.id, lessonIds: wanted });
    } catch (e) {
      setError(e instanceof Error ? e.message : '讲解任务未能启动。');
    }
  };
  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || !lesson || !located || !question.trim() || tutorJob || pending) return;
    const snapshot = classroomSnapshot(voice.getCursor());
    const interruption: TeachingInterruption = {
      position: snapshot?.interruption.position ?? elapsed,
      stepId: snapshot?.interruption.stepId || located!.step.id,
      boundary: 'section',
      channel: 'text',
      interrupted: false,
      ...(selected ? { selectedObject: { ...selected } } : {}),
    };
    pauseLecture(snapshot);
    setAnswerToRead(null);
    setError('');
    try {
      await onAgent({
        action: 'tutor',
        courseId: course.id,
        lessonId: lesson.id,
        question: question.trim(),
        interruption,
      });
      setQuestion('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '提问失败，请重试。');
    }
  };
  const complete = async () => {
    if (!playbackId) return;
    setPlaying(false);
    setError('');
    const record = records.current.get(playbackId)!;
    const previous = { completed: record.completed, lastSaved: record.lastSaved };
    record.completed = true;
    record.lastSaved = elapsed;
    try {
      await onMutate('/api/platform/progress', {
        learnerId: learner.id,
        courseId: course.id,
        lessonId: playbackId,
        position: elapsed,
        completed: true,
      });
      onNotice('本节已标记学完，试试随堂练习检验理解');
      openTab('practice');
    } catch (e) {
      record.completed = previous.completed;
      record.lastSaved = previous.lastSaved;
      setError(e instanceof Error ? e.message : '学习进度保存失败。');
    }
  };
  const saveNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || !lesson || !note.trim()) return;
    setNoteSaving(true);
    setError('');
    try {
      await onMutate(
        '/api/platform/notes',
        { learnerId: learner.id, courseId: course.id, lessonId: lesson.id, body: note.trim() },
        'POST',
      );
      setNote('');
      onNotice('学习笔记已保存');
    } catch (e) {
      setError(e instanceof Error ? e.message : '笔记未能保存。');
    } finally {
      setNoteSaving(false);
    }
  };
  const exportLesson = () => {
    if (!ready || !lesson) return;
    const url = URL.createObjectURL(
      new Blob([lesson.source], { type: 'text/markdown;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `${lesson.title}.md`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await shell.current?.requestFullscreen();
    } catch {
      onNotice('浏览器未能进入全屏，可以收起辅助面板扩大白板。');
    }
  };

  return (
    <div ref={shell} className={`classroom-shell ${dockOpen ? 'dock-is-open' : 'dock-is-closed'}`}>
      <header className="cr-topbar">
        <button
          className="cr-brand"
          aria-label="打开课程列表"
          title="打开课程列表"
          onClick={onLibrary || onBack}
        >
          <GraduationCap size={23} />
          <span>GPT Teacher</span>
        </button>
        <span className="cr-topbar-divider" />
        <button className="cr-course-switch" onClick={onLibrary || onBack} title="切换课程">
          <span>{course.title}</span>
          <ChevronDown size={15} />
        </button>
        <div className="lesson-title cr-lesson-title">
          <span className="cr-title-divider">/</span>
          <h1>{title}</h1>
          {progressCompleted && (
            <span className="cr-completed">
              <CircleCheck size={14} />
              <span>已学完</span>
            </span>
          )}
        </div>
        <div className="cr-header-actions">
          {onJobs && (
            <button
              className="cr-icon cr-desktop-action"
              title="Agent 工作台"
              aria-label="Agent 工作台"
              onClick={onJobs}
            >
              <Sparkles size={18} />
              {activeJobs > 0 && <span className="cr-job-badge">{activeJobs}</span>}
            </button>
          )}
          {onRecords && (
            <button
              className="cr-icon cr-desktop-action"
              title="学习记录"
              aria-label="学习记录"
              onClick={onRecords}
            >
              <NotebookPen size={18} />
            </button>
          )}
          {onSettings && (
            <button
              className="cr-icon cr-desktop-action"
              title="学习设置"
              aria-label="学习设置"
              onClick={onSettings}
            >
              <Settings2 size={18} />
            </button>
          )}
          {onNewCourse && (
            <button className="cr-button cr-primary cr-new-course" onClick={onNewCourse}>
              <Plus size={16} />
              <span>研究章节</span>
            </button>
          )}
          <details className="cr-more-menu">
            <summary aria-label="更多课堂操作" title="更多课堂操作">
              <Ellipsis size={20} />
            </summary>
            <div>
              <button disabled={!ready} onClick={exportLesson}>
                <ArrowDownToLine size={16} />
                导出本节课 Markdown
              </button>
              {onJobs && (
                <button className="cr-mobile-action" onClick={onJobs}>
                  <Sparkles size={16} />
                  Agent 工作台
                </button>
              )}
              {onRecords && (
                <button className="cr-mobile-action" onClick={onRecords}>
                  <NotebookPen size={16} />
                  学习记录
                </button>
              )}
              {onSettings && (
                <button className="cr-mobile-action" onClick={onSettings}>
                  <Settings2 size={16} />
                  学习设置
                </button>
              )}
              <button onClick={onBack}>
                <BookOpen size={16} />
                查看课程计划
              </button>
            </div>
          </details>
        </div>
      </header>
      <div className="cr-workspace">
        <section className="cr-board-area" aria-label="课堂白板区域">
          <div className="cr-board" data-testid="classroom-board">
            <div className="cr-board-header">
              <span>课堂白板</span>
              <div>
                {voice.enabled && (
                  <button className="cr-voice-indicator" onClick={() => openTab('tutor')}>
                    <Mic size={13} />
                    <span>{voiceStatusLabel}</span>
                  </button>
                )}
                <span className="cr-step-label">
                  {located ? `${located.index + 1} / ${parsedLesson!.steps.length}` : ''}
                </span>
                <button
                  className="cr-icon"
                  aria-label={fullscreen ? '退出全屏白板' : '全屏白板'}
                  title={fullscreen ? '退出全屏白板' : '全屏白板'}
                  onClick={() => void toggleFullscreen()}
                >
                  {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                </button>
              </div>
            </div>
            {located ? (
              <div className="cr-board-stage">
                {located.step.svg ? (
                  <LessonStage
                    step={located.step}
                    time={located.localTime}
                    selectedId={selected?.id}
                    onSelect={(selection) => {
                      setSelected(selection);
                      setPlaying(false);
                      setQuestion(`请帮我解释一下「${selection.label}」。`);
                      openTab('tutor');
                      window.setTimeout(() => tutorInput.current?.focus(), 0);
                    }}
                  />
                ) : (
                  <div className="prose-board cr-prose-board">
                    <span className="cr-prose-number">
                      {String(located.index + 1).padStart(2, '0')}
                    </span>
                    <h2>{located.step.title}</h2>
                    <Markdown source={located.step.narration} />
                  </div>
                )}
              </div>
            ) : (
              <NodePreview
                node={selectedNode}
                course={course}
                path={path}
                state={state}
                learner={learner}
                pending={pending || generatingCourse}
                generationMessage={generationJob?.stage}
                onSelect={onLesson}
                onExtend={onExtendCourse}
                onGenerate={generate}
                onSelectLessons={(ids) => {
                  setSelectedLessonIds((current) => [...new Set([...current, ...ids])]);
                  openTab('outline');
                }}
                error={parsed.error}
              />
            )}
            {located && (
              <div className="cr-board-caption">
                <span>{located.step.title}</span>
                <button onClick={() => openTab('transcript')}>
                  查看讲稿 <ChevronRight size={14} />
                </button>
              </div>
            )}
          </div>
          {ready ? (
            <div className="cr-playback">
              <div className="cr-playback-main">
                <div className="cr-play-buttons">
                  <button
                    className="cr-icon"
                    aria-label="上一讲解片段"
                    title="上一讲解片段"
                    disabled={!located || located.index === 0}
                    onClick={() =>
                      parsedLesson &&
                      located &&
                      seek(parsedLesson.steps[Math.max(0, located.index - 1)].start)
                    }
                  >
                    <ChevronLeft size={22} />
                  </button>
                  <button
                    className="cr-play"
                    aria-label={playing ? '暂停讲解' : '播放讲解'}
                    disabled={!parsedLesson}
                    onClick={() => {
                      if (parsedLesson && elapsed >= parsedLesson.duration) seek(0);
                      setPlaying(!playing);
                    }}
                  >
                    {playing ? <Pause size={18} /> : <Play size={18} />}
                    <span>{playing ? '暂停' : '播放讲解'}</span>
                  </button>
                  <button
                    className="cr-icon"
                    aria-label="下一讲解片段"
                    title="下一讲解片段"
                    disabled={!located || located.index === (parsedLesson?.steps.length || 0) - 1}
                    onClick={() =>
                      parsedLesson &&
                      located &&
                      seek(
                        parsedLesson.steps[
                          Math.min(parsedLesson.steps.length - 1, located.index + 1)
                        ].start,
                      )
                    }
                  >
                    <ChevronRight size={22} />
                  </button>
                </div>
                <div className="cr-timeline">
                  <label className="sr-only" htmlFor="lesson-timeline">
                    课程播放位置
                  </label>
                  <input
                    id="lesson-timeline"
                    type="range"
                    min={0}
                    max={parsedLesson?.duration || 1}
                    step={0.1}
                    value={elapsed}
                    disabled={!parsedLesson}
                    onChange={(e) => {
                      setPlaying(false);
                      seek(Number(e.target.value));
                    }}
                  />
                  <span>
                    {formatTime(elapsed)}
                    <span> / {formatTime(parsedLesson?.duration || 0)}</span>
                  </span>
                </div>
                <button
                  className="cr-speed"
                  aria-label="切换播放速度"
                  title="切换播放速度"
                  onClick={changeSpeed}
                >
                  {speed}×
                </button>
                <button
                  className={`cr-icon cr-narration-toggle ${voice.ttsEnabled ? 'is-enabled' : ''}`}
                  aria-label={voice.ttsEnabled ? '关闭语音朗读' : '开启语音朗读'}
                  title={voice.ttsEnabled ? '关闭语音朗读' : '开启语音朗读'}
                  disabled={!('speechSynthesis' in window)}
                  onClick={toggleNarration}
                >
                  {voice.ttsEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
                </button>
                <button
                  className={`cr-bar-mic ${voice.enabled ? 'is-active' : ''}`}
                  aria-label={voice.enabled ? '停止随时插话' : '开启随时插话'}
                  title="开启麦克风后可以直接插话提问"
                  disabled={!voice.supported || voice.status === 'starting' || suspended}
                  onClick={() => {
                    openTab('tutor');
                    void voice.toggleListening();
                  }}
                >
                  <Mic size={16} />
                  <span>{voice.enabled ? '正在聆听' : '随时插话'}</span>
                </button>
                <button className="cr-complete-button" onClick={() => void complete()}>
                  <Check size={16} />
                  <span>{progressCompleted ? '前往随堂练习' : '标记学完，做练习'}</span>
                </button>
              </div>
              <div className="cr-lesson-navigation">
                <button
                  disabled={lessonIndex === 0}
                  onClick={() => onLesson(lessons[Math.max(0, lessonIndex - 1)].id)}
                >
                  <ArrowLeft size={14} />
                  上一节课
                </button>
                <span>
                  第 {lessonIndex + 1} / {lessons.length} 节 · {course.subject}
                </span>
                <button
                  disabled={lessonIndex >= lessons.length - 1}
                  onClick={() =>
                    onLesson(lessons[Math.min(lessons.length - 1, lessonIndex + 1)].id)
                  }
                >
                  下一节课
                  <ArrowRight size={14} />
                </button>
              </div>
            </div>
          ) : (
            <div className="cr-planning-bar">
              <span>
                {selectedNode?.kind === 'chapter'
                  ? '展开学习树，勾选需要学习的课时，再生成讲解。'
                  : '先核对本课的知识点与解题技巧，再生成讲解。'}
              </span>
              <button className="cr-button" onClick={() => openTab('outline')}>
                <List size={15} />
                打开学习树
              </button>
            </div>
          )}
          {error && (
            <div className="cr-error" role="alert">
              <span>{error}</span>
              <button className="cr-icon" aria-label="关闭课堂错误" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
        </section>
        {dockOpen && (
          <aside
            id={`cr-panel-${tab}`}
            className={`cr-dock cr-dock-${tab}`}
            data-testid="classroom-dock"
            role="tabpanel"
            aria-labelledby={`cr-tab-${tab}`}
          >
            <div className="cr-dock-header">
              <div>
                <activeTab.icon size={17} />
                <h2>{activeTab.accessible}</h2>
              </div>
              <button
                className="cr-icon"
                aria-label="关闭辅助面板"
                title="收起辅助面板"
                aria-expanded="true"
                onClick={() => setDockOpen(false)}
              >
                <PanelRightClose size={18} />
              </button>
            </div>
            {tab === 'outline' && (
              <>
                <div className="cr-dock-scroll cr-outline">
                  <LearningTree
                    course={course}
                    state={state}
                    learner={learner}
                    selectedNodeId={selectedNode?.id}
                    onSelect={onLesson}
                    onExtend={onExtendCourse}
                    selectedLessonIds={selectedLessonIds}
                    onSelectionChange={setSelectedLessonIds}
                  />
                  {ready && parsedLesson && (
                    <div className="cr-section-list">
                      <h3>本讲片段</h3>
                      {parsedLesson.steps.map((step, i) => (
                        <button
                          className={i === located?.index ? 'selected' : ''}
                          key={step.id}
                          onClick={() => {
                            seek(step.start);
                            setPlaying(false);
                          }}
                        >
                          <span>{String(i + 1).padStart(2, '0')}</span>
                          {step.title}
                          <small>{formatTime(step.start)}</small>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="cr-tree-actions">
                  <p>
                    {plannedSelection.length
                      ? `已选择 ${plannedSelection.length} 讲`
                      : '勾选待生成课时，按需准备讲解。'}
                  </p>
                  <button
                    className="cr-button cr-primary cr-wide"
                    disabled={!plannedSelection.length || pending || generatingCourse}
                    onClick={() => void generate(plannedSelection.map((item) => item.id))}
                  >
                    {generatingCourse ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Play size={16} />
                    )}
                    <span>
                      {generatingCourse
                        ? '正在生成讲解'
                        : `生成所选讲解${plannedSelection.length ? `（${plannedSelection.length}）` : ''}`}
                    </span>
                  </button>
                  {onExtendCourse && (
                    <button
                      className="cr-tree-extend"
                      onClick={() =>
                        onExtendCourse(
                          selectedNode?.kind === 'chapter' ? selectedNode.id : parentChapter?.id,
                        )
                      }
                    >
                      <Plus size={14} />
                      补充章节
                    </button>
                  )}
                </div>
              </>
            )}
            {tab === 'tutor' && ready && lesson && (
              <>
                <div
                  className={`cr-voice-control ${voice.enabled ? 'is-listening' : ''}`}
                  data-testid="classroom-voice"
                >
                  <button
                    className="cr-voice-toggle"
                    aria-label={voice.enabled ? '关闭语音对话' : '开启语音对话'}
                    disabled={!voice.supported || voice.status === 'starting' || suspended}
                    onClick={() => void voice.toggleListening()}
                  >
                    <span>
                      {voice.status === 'starting' ? (
                        <LoaderCircle className="spin" size={20} />
                      ) : voice.enabled ? (
                        <MicOff size={20} />
                      ) : (
                        <Mic size={20} />
                      )}
                    </span>
                    <strong>{voice.enabled ? '关闭语音对话' : '开启语音对话'}</strong>
                    {voice.enabled && <span className="cr-voice-live-dot" />}
                  </button>
                  <div className="cr-voice-state">
                    <span data-testid="voice-status">
                      {voice.supported
                        ? voiceStatusLabel
                        : '当前浏览器不支持语音识别，请使用文字提问。'}
                    </span>
                    {voice.enabled && (
                      <div
                        className="cr-voice-level"
                        data-testid="voice-level"
                        data-level={voice.level.toFixed(3)}
                      >
                        <span
                          style={{ transform: `scaleX(${Math.max(0, Math.min(1, voice.level))})` }}
                        />
                      </div>
                    )}
                  </div>
                  {voice.enabled && (
                    <p className="cr-voice-transcript" data-testid="voice-transcript">
                      {voice.transcript}
                    </p>
                  )}
                </div>
                <div className="tutor-messages cr-tutor-messages cr-dock-scroll">
                  {messages.length === 0 && (
                    <div className="cr-tutor-welcome">
                      <MessageCircle size={26} />
                      <h3>哪里还没听懂？</h3>
                      <p>可以问概念，也可以说说你的思路。</p>
                      <div className="cr-question-suggestions">
                        {['请用生活中的例子解释', '能换一种方式讲吗？'].map((text) => (
                          <button
                            key={text}
                            onClick={() => {
                              setQuestion(text);
                              tutorInput.current?.focus();
                            }}
                          >
                            {text}
                            <ArrowRight size={14} />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {messages.map((message) => (
                    <article key={message.id} className={`cr-chat-message ${message.role}`}>
                      <span>{message.role === 'user' ? '我' : '教学 Agent'}</span>
                      <Markdown source={message.content} />
                    </article>
                  ))}
                  {tutorJob && (
                    <div className="cr-thinking" role="status">
                      <LoaderCircle className="spin" size={15} />
                      {tutorJob.stage || 'Agent 正在分析你的问题'}
                    </div>
                  )}
                  <div ref={chatEnd} />
                </div>
                <form className="cr-tutor-composer" onSubmit={(e) => void ask(e)}>
                  {selected && <div className="cr-selected-context">板书：{selected.label}</div>}
                  <label htmlFor="tutor-question">向教学 Agent 提问</label>
                  <textarea
                    ref={tutorInput}
                    id="tutor-question"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    rows={3}
                    maxLength={1600}
                    placeholder="写下你的问题……"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        if (question.trim() && !tutorJob) void ask(e as unknown as React.FormEvent);
                      }
                    }}
                  />
                  <div>
                    <span>已关联当前讲解</span>
                    <button
                      className="cr-send"
                      aria-label="发送学习问题"
                      disabled={pending || !!tutorJob || !question.trim()}
                    >
                      {pending || tutorJob ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Send size={16} />
                      )}
                    </button>
                  </div>
                </form>
              </>
            )}
            {tab === 'practice' && ready && lesson && (
              <section className="cr-dock-scroll cr-practice">
                <div className="cr-pane-intro">
                  <h3>自己试一试</h3>
                  <p>先独立思考，再让 Agent 给你反馈。</p>
                </div>
                {lesson.exercises.length ? (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setError('');
                      try {
                        await onAgent({
                          action: 'grade',
                          courseId: course.id,
                          lessonId: lesson.id,
                          answers,
                        });
                      } catch (e) {
                        setError(e instanceof Error ? e.message : '练习提交失败。');
                      }
                    }}
                  >
                    {lesson.exercises.map((exercise, index) => (
                      <fieldset className="exercise-card cr-exercise" key={exercise.id}>
                        <legend>
                          <span>{String(index + 1).padStart(2, '0')}</span>
                          <small>{exercise.skill}</small>
                        </legend>
                        <Markdown source={exercise.question} />
                        {exercise.options.length ? (
                          <div className="cr-exercise-options">
                            {exercise.options.map((option, i) => (
                              <label
                                className={answers[exercise.id] === option ? 'selected' : ''}
                                key={i}
                              >
                                <input
                                  type="radio"
                                  name={exercise.id}
                                  value={option}
                                  checked={answers[exercise.id] === option}
                                  onChange={() =>
                                    setAnswers((current) => ({ ...current, [exercise.id]: option }))
                                  }
                                  required
                                />
                                <span className="cr-option-letter">
                                  {String.fromCharCode(65 + i)}
                                </span>
                                <span>{option}</span>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <label className="cr-form-field">
                            <span>你的解答</span>
                            <textarea
                              rows={3}
                              maxLength={2000}
                              value={answers[exercise.id] || ''}
                              onChange={(e) =>
                                setAnswers((current) => ({
                                  ...current,
                                  [exercise.id]: e.target.value,
                                }))
                              }
                              required
                              placeholder="写下答案和思路。"
                            />
                          </label>
                        )}
                      </fieldset>
                    ))}
                    <button
                      className="cr-button cr-primary cr-wide"
                      disabled={
                        pending ||
                        !!gradeJob ||
                        lesson.exercises.some((e) => !answers[e.id]?.trim())
                      }
                    >
                      {gradeJob ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Sparkles size={16} />
                      )}
                      <span>{gradeJob ? 'Agent 正在批改' : '提交给 Agent 批改'}</span>
                    </button>
                    <p className="cr-subtle-note">
                      播放记录不作为掌握程度，反馈根据你的实际作答生成。
                    </p>
                  </form>
                ) : (
                  <p className="cr-dock-description">本节没有独立练习，可以向 Agent 提问。</p>
                )}
                {latestAttempt && (
                  <article className="practice-feedback cr-feedback">
                    <div className="cr-feedback-heading">
                      <strong>
                        {latestAttempt.score}
                        <small>/100</small>
                      </strong>
                      <h3>最近一次练习反馈</h3>
                    </div>
                    <Markdown source={latestAttempt.feedback} />
                    {latestAttempt.items.map((item) => (
                      <div className="cr-feedback-item" key={item.exerciseId}>
                        <span>{item.correct ? '已理解' : '再想一想'}</span>
                        <Markdown source={item.feedback} />
                      </div>
                    ))}
                    {latestAttempt.nextSteps.length > 0 && (
                      <div className="cr-next-steps">
                        <h3>下一步</h3>
                        <ul>
                          {latestAttempt.nextSteps.map((step, i) => (
                            <li key={i}>{step}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </article>
                )}
                <details className="cr-remedial">
                  <summary>
                    设计巩固分支 <Plus size={14} />
                  </summary>
                  <p>告诉 Agent 还想练习什么，新的学习分支会保留在当前课程中。</p>
                  <textarea
                    value={remedialRequest}
                    onChange={(event) => setRemedialRequest(event.target.value)}
                    maxLength={1200}
                    rows={3}
                    placeholder="比如：多练习含括号的方程，并说明每一步的理由。"
                  />
                  <button
                    className="cr-button cr-wide"
                    disabled={!remedialRequest.trim() || pending}
                    onClick={async () => {
                      try {
                        await onAgent({
                          action: 'replan',
                          courseId: course.id,
                          lessonId: lesson.id,
                          parentNodeId: parentChapter?.id,
                          question: remedialRequest.trim(),
                        });
                        setRemedialRequest('');
                      } catch (e) {
                        setError(e instanceof Error ? e.message : '巩固分支设计失败。');
                      }
                    }}
                  >
                    设计巩固分支
                  </button>
                </details>
              </section>
            )}
            {tab === 'notes' && ready && lesson && (
              <section className="cr-dock-scroll cr-notes">
                <div className="cr-pane-intro">
                  <h3>写下自己的理解</h3>
                  <p>记下一个发现，或还没想明白的问题。</p>
                </div>
                <form onSubmit={(e) => void saveNote(e)}>
                  <label className="cr-form-field" htmlFor="classroom-note">
                    <span>课堂笔记</span>
                    <textarea
                      id="classroom-note"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={5}
                      maxLength={4000}
                      placeholder="今天我理解了……"
                      required
                    />
                  </label>
                  <button
                    className="cr-button cr-primary cr-wide"
                    disabled={!note.trim() || noteSaving}
                  >
                    {noteSaving ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                    保存学习笔记
                  </button>
                </form>
                <div className="classroom-note-list cr-note-list">
                  {notes.map((item) => (
                    <article key={item.id}>
                      <div>
                        <time>{new Date(item.createdAt).toLocaleString('zh-CN')}</time>
                        <button
                          className="cr-icon"
                          aria-label="删除这条笔记"
                          onClick={async () => {
                            try {
                              await onMutate(
                                `/api/platform/notes/${encodeURIComponent(item.id)}`,
                                {},
                                'DELETE',
                              );
                            } catch {
                              /* Parent displays error. */
                            }
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                      <p>{item.body}</p>
                    </article>
                  ))}
                </div>
              </section>
            )}
            {tab === 'transcript' && ready && lesson && (
              <section className="cr-dock-scroll cr-transcript">
                {lesson.sources.length > 0 && (
                  <div className="cr-lesson-sources">
                    <h3>参考资料</h3>
                    {lesson.sources.map((source, index) => (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        key={`${source.url}:${index}`}
                      >
                        {source.title}
                        <ChevronRight size={13} />
                      </a>
                    ))}
                  </div>
                )}
                <div className="cr-pane-intro">
                  <h3>{located?.step.title || lesson.title}</h3>
                  <p>{lesson.objective}</p>
                </div>
                <Markdown source={located?.step.narration || ''} />
                <button className="cr-button cr-export" onClick={exportLesson}>
                  <ArrowDownToLine size={15} />
                  导出本节课 Markdown
                </button>
              </section>
            )}
            {tab !== 'outline' && !ready && (
              <div className="cr-dock-scroll cr-unprepared">
                <BookOpen size={28} />
                <h3>{lesson ? '本课还没有生成讲解' : '先选择一节课'}</h3>
                <p>
                  {lesson
                    ? '先在学习树中选择课时，生成讲解后即可提问、练习和记笔记。'
                    : '章节页展示学习目标和课时结构，具体讲解在各个课时中。'}
                </p>
                <button className="cr-button" onClick={() => openTab('outline')}>
                  打开学习树
                </button>
              </div>
            )}
          </aside>
        )}
        <nav className="cr-dock-rail" aria-label="课堂辅助工具">
          <button
            className="cr-icon cr-dock-toggle"
            aria-label={dockOpen ? '收起辅助面板' : '展开辅助面板'}
            title={dockOpen ? '收起辅助面板' : '展开辅助面板'}
            aria-expanded={dockOpen}
            onClick={() => setDockOpen(!dockOpen)}
          >
            {dockOpen ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}
          </button>
          <div role="tablist" aria-label="课堂辅助内容">
            {dockTabs.map((item) => (
              <button
                key={item.id}
                id={`cr-tab-${item.id}`}
                role="tab"
                aria-label={item.accessible}
                aria-selected={dockOpen && tab === item.id}
                aria-controls={dockOpen && tab === item.id ? `cr-panel-${item.id}` : undefined}
                tabIndex={tab === item.id ? 0 : -1}
                title={item.accessible}
                className={dockOpen && tab === item.id ? 'selected' : ''}
                onClick={() => openTab(item.id)}
                onKeyDown={(event) => {
                  const index = dockTabs.findIndex((entry) => entry.id === item.id);
                  const next =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? dockTabs.length - 1
                        : ['ArrowRight', 'ArrowDown'].includes(event.key)
                          ? (index + 1) % dockTabs.length
                          : ['ArrowLeft', 'ArrowUp'].includes(event.key)
                            ? (index - 1 + dockTabs.length) % dockTabs.length
                            : -1;
                  if (next < 0) return;
                  event.preventDefault();
                  openTab(dockTabs[next].id);
                  document.getElementById(`cr-tab-${dockTabs[next].id}`)?.focus();
                }}
              >
                <item.icon size={19} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
          <span className="cr-learner-initial" title={`${learner.name} · ${learner.grade} 年级`}>
            {learner.name.slice(0, 1)}
          </span>
        </nav>
      </div>
    </div>
  );
}

interface NodePreviewProps {
  node?: CourseNode;
  course: Course;
  path: CourseNode[];
  state: PlatformState;
  learner: LearnerProfile;
  pending: boolean;
  generationMessage?: string;
  error?: string;
  onSelect: (nodeId: string) => void;
  onExtend?: (parentNodeId?: string) => void;
  onGenerate: (lessonIds: string[]) => Promise<void>;
  onSelectLessons: (lessonIds: string[]) => void;
}
function NodePreview({
  node,
  course,
  path,
  state,
  learner,
  pending,
  generationMessage,
  error,
  onSelect,
  onExtend,
  onGenerate,
  onSelectLessons,
}: NodePreviewProps) {
  if (error)
    return (
      <div className="cr-board-empty">
        <BookOpen size={30} />
        <p>{error}</p>
      </div>
    );
  if (!node)
    return (
      <div className="cr-board-empty">
        <BookOpen size={30} />
        <h2>从一个章节开始</h2>
        <p>输入章节名称，让 Agent 研究知识点，再选择需要学习的课时。</p>
        {onExtend && (
          <button className="cr-button cr-primary" onClick={() => onExtend()}>
            研究并设计章节
          </button>
        )}
      </div>
    );
  const lessons = getNodeLessons(node);
  const planned = lessons.filter((item) => item.status === 'planned');
  const ready = lessons.filter((item) => item.status === 'ready');
  const done = lessons.filter((item) =>
    state.progress.some(
      (progress) =>
        progress.learnerId === learner.id &&
        progress.courseId === course.id &&
        progress.lessonId === item.id &&
        progress.completed,
    ),
  ).length;
  return (
    <div
      className={`cr-plan-board ${node.kind === 'chapter' ? 'is-chapter-preview' : 'is-lesson-preview'}`}
      data-testid={node.kind === 'chapter' ? 'chapter-preview' : 'lesson-preview'}
    >
      <div className="cr-plan-path">
        <span>{course.subject}</span>
        {path.slice(0, -1).map((item) => (
          <span key={item.id}>
            <ChevronRight size={12} />
            {item.title}
          </span>
        ))}
      </div>
      <div className="cr-plan-heading">
        <span className="cr-plan-kind">{node.kind === 'chapter' ? '章节总览' : '课时设计'}</span>
        <h2>{node.title}</h2>
        <p>{node.objective}</p>
      </div>
      {node.kind === 'chapter' ? (
        <>
          <div className="cr-chapter-facts">
            <span>
              <strong>{lessons.length}</strong> 讲学习内容
            </span>
            <span>
              <strong>{ready.length}</strong> 讲已生成
            </span>
            <span>
              <strong>{done}</strong> 讲已学完
            </span>
          </div>
          <div className="cr-chapter-preview-actions">
            {planned.length > 0 && (
              <button
                className="cr-button cr-primary"
                onClick={() => onSelectLessons(planned.map((item) => item.id))}
              >
                <Check size={16} />
                选择本章待生成课时（{planned.length}）
              </button>
            )}
            {onExtend && (
              <button className="cr-button" onClick={() => onExtend(node.id)}>
                <Plus size={16} />
                补充子章节
              </button>
            )}
          </div>
          <div className="cr-chapter-children">
            {node.children.map((child, index) => {
              const descendants = getNodeLessons(child);
              return (
                <button key={child.id} onClick={() => onSelect(child.id)}>
                  <span className="cr-child-order">{String(index + 1).padStart(2, '0')}</span>
                  <span>
                    <strong>{child.title}</strong>
                    <small>{child.objective}</small>
                  </span>
                  <span className="cr-child-status">
                    {child.kind === 'chapter'
                      ? `${descendants.length} 讲`
                      : child.status === 'ready'
                        ? '可上课'
                        : '待生成'}
                  </span>
                  <ChevronRight size={17} />
                </button>
              );
            })}
          </div>
          {!node.children.length && (
            <p className="cr-plan-empty">这个章节还没有子节点，可以补充研究新的章节内容。</p>
          )}
        </>
      ) : (
        <>
          <div className="cr-lesson-plan-status">
            <span>待生成讲解</span>
            <span>约 {node.minutes} 分钟</span>
          </div>
          <div className="cr-lesson-plan-sections">
            <section>
              <h3>知识点</h3>
              {node.knowledgePoints.length ? (
                <ul>
                  {node.knowledgePoints.map((point, index) => (
                    <li key={index}>{point}</li>
                  ))}
                </ul>
              ) : (
                <p>尚未整理知识点。</p>
              )}
            </section>
            <section>
              <h3>解题技巧与学习方法</h3>
              {node.techniques.length ? (
                <ul>
                  {node.techniques.map((point, index) => (
                    <li key={index}>{point}</li>
                  ))}
                </ul>
              ) : (
                <p>本课以理解概念与实际应用为主。</p>
              )}
            </section>
          </div>
          <section className="cr-plan-sources">
            <h3>研究参考</h3>
            {node.sources.length ? (
              <ol>
                {node.sources.map((source, index) =>
                  /^https?:\/\//i.test(source.url) ? (
                    <li key={index}>
                      <a href={source.url} target="_blank" rel="noreferrer">
                        {source.title}
                        <ArrowRight size={13} />
                      </a>
                      <span>{source.url}</span>
                    </li>
                  ) : null,
                )}
              </ol>
            ) : (
              <p>本课暂无已核实的参考来源。</p>
            )}
          </section>
          <div className="cr-generate-lesson">
            <button
              className="cr-button cr-primary"
              disabled={pending}
              onClick={() => void onGenerate([node.id])}
            >
              {pending ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}
              <span>{generationMessage ? '正在生成讲解' : '生成本课讲解'}</span>
            </button>
            <p>{generationMessage || '确认内容后生成本课讲解和练习。'}</p>
          </div>
        </>
      )}
    </div>
  );
}
