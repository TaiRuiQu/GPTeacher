import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Mic, MicOff, LoaderCircle, Plus, Search, X } from 'lucide-react';
import type { AgentRunner } from '../../App';
import type { Course, LearnerProfile, PlatformState, Subject } from '../../lib/platform';
import { getCourseLessons, findCourseNode } from '../../lib/platform';
import { LearningTree } from './LearningTree';
import { useClassroomVoice } from '../../hooks/useClassroomVoice';

/** Supporting tasks are transient overlays; the classroom remains the application underneath. */
export function ClassroomDialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key !== 'Tab') return;
      const elements = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
        ) || [],
      ).filter((el) => el.getClientRects().length > 0);
      const first = elements[0];
      const last = elements.at(-1);
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog.current)
      ) {
        event.preventDefault();
        last?.focus();
      }
      if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === dialog.current)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('keydown', keyboard);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="class-dialog-layer">
      <button
        className="class-dialog-backdrop"
        tabIndex={-1}
        aria-label={`关闭${title}`}
        onClick={onClose}
      />
      <section
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`class-dialog ${wide ? 'wide' : ''}`}
      >
        <header className="class-dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" aria-label={`关闭${title}窗口`} onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="class-dialog-body">{children}</div>
      </section>
    </div>
  );
}

export function CourseLibraryDialog({
  state,
  learner,
  currentCourseId,
  currentNodeId,
  onEnter,
  onCreate,
  onExtend,
  onClose,
}: {
  state: PlatformState;
  learner: LearnerProfile;
  currentCourseId: string;
  currentNodeId?: string;
  onEnter: (course: Course, nodeId?: string) => void;
  onCreate: (subject?: Subject) => void;
  onExtend?: (course: Course, parentNodeId?: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const courses = state.courses.filter((course) =>
    `${course.title} ${course.subject} ${course.topic} ${getCourseLessons(course)
      .map((lesson) => lesson.title)
      .join(' ')}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const subjects = Array.from(new Set(courses.map((course) => course.subject)));
  return (
    <ClassroomDialog title="学习树" onClose={onClose}>
      <div className="class-library-toolbar">
        <label className="class-library-search">
          <Search size={17} />
          <span className="sr-only">搜索章节与课时</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索学科、章节或课时"
          />
        </label>
        <button className="class-primary" onClick={() => onCreate()}>
          <Plus size={16} />
          研究新章节
        </button>
      </div>
      <p className="class-form-help class-tree-guide">
        从学科进入章节，选择课时查看内容；待生成的课时可在课堂学习树中勾选。
      </p>
      <div className="class-global-tree">
        {subjects.map((subject) => (
          <details key={subject} className="class-subject-branch" open>
            <summary>
              <BookOpen size={16} />
              <strong>{subject}</strong>
              <button
                title={`在${subject}下研究新章节`}
                onClick={(event) => {
                  event.preventDefault();
                  onCreate(subject);
                }}
              >
                <Plus size={15} />
              </button>
            </summary>
            <div>
              {courses
                .filter((course) => course.subject === subject)
                .map((course) => (
                  <details
                    key={course.id}
                    className="class-course-branch"
                    open={course.id === currentCourseId || !!search}
                  >
                    <summary>
                      <span>{course.title}</span>
                      <small>
                        {getCourseLessons(course).length} 讲
                        {course.origin === 'sample' ? ' · 示例' : ''}
                      </small>
                    </summary>
                    <LearningTree
                      course={course}
                      learner={learner}
                      state={state}
                      selectedNodeId={course.id === currentCourseId ? currentNodeId : undefined}
                      onSelect={(nodeId) => onEnter(course, nodeId)}
                      onExtend={
                        onExtend ? (parentNodeId) => onExtend(course, parentNodeId) : undefined
                      }
                    />
                  </details>
                ))}
            </div>
          </details>
        ))}
        {courses.length === 0 && (
          <div className="class-library-empty">
            <BookOpen size={24} />
            <p>没有找到相关章节。</p>
            <button className="class-text-button" onClick={() => onCreate()}>
              研究这个章节 <ArrowRight size={15} />
            </button>
          </div>
        )}
      </div>
    </ClassroomDialog>
  );
}

const subjects: Subject[] = [
  '数学',
  '语文',
  '英语',
  '物理',
  '化学',
  '生物',
  '历史',
  '地理',
  '综合',
];
export function CourseComposerDialog({
  learner,
  pending,
  targetCourse,
  parentNodeId,
  initialSubject = '数学',
  onAgent,
  onClose,
}: {
  learner: LearnerProfile;
  pending: boolean;
  targetCourse?: Course;
  parentNodeId?: string;
  initialSubject?: Subject;
  onAgent: AgentRunner;
  onClose: () => void;
}) {
  const [topic, setTopic] = useState('');
  const [subject, setSubject] = useState<Subject>(targetCourse?.subject || initialSubject);
  const [count, setCount] = useState(4);
  const [error, setError] = useState('');
  const voice = useClassroomVoice({
    capture: () => null,
    onInterrupt: () => undefined,
    onQuestion: (text) => {
      setTopic(text);
      voice.stopListening();
    },
    onError: setError,
  });
  const parent = targetCourse && parentNodeId ? findCourseNode(targetCourse, parentNodeId) : null;
  return (
    <ClassroomDialog title={targetCourse ? '扩展章节' : '研究章节'} onClose={onClose}>
      <form
        className="class-course-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!topic.trim()) {
            setError('请输入要研究的章节名称。');
            return;
          }
          setError('');
          voice.stopListening();
          try {
            await onAgent({
              action: targetCourse ? 'extend_course' : 'create_course',
              ...(targetCourse ? { courseId: targetCourse.id, parentNodeId } : {}),
              topic: topic.trim(),
              subject,
              lessonCount: count,
            });
          } catch (error) {
            setError(error instanceof Error ? error.message : '研究任务未能启动，请重试。');
          }
        }}
      >
        <p className="class-composer-intro">
          {targetCourse
            ? `添加到：${targetCourse.title}${parent ? ` / ${parent.title}` : ''}`
            : `面向 ${learner.grade} 年级，输入章节名称或直接说出来。`}
        </p>
        <label className="class-form-field">
          <span className="class-voice-label">
            章节名称
            <button
              type="button"
              className={`class-voice-input ${voice.enabled ? 'active' : ''}`}
              onClick={() => void voice.toggleListening()}
            >
              {voice.enabled ? <MicOff size={15} /> : <Mic size={15} />}{' '}
              {voice.enabled ? '结束语音输入' : '语音输入章节'}
            </button>
          </span>
          <textarea
            maxLength={500}
            rows={3}
            value={voice.transcript || topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="例如：人教版七年级上册 · 一元一次方程"
            required
          />
        </label>
        {voice.enabled && (
          <p className="class-voice-live">
            {voice.status === 'speaking'
              ? '正在识别章节名称，停顿后自动填入…'
              : '正在听，说出你要研究的章节…'}
          </p>
        )}
        <div className="class-form-row">
          <label className="class-form-field">
            课程学科
            <select
              disabled={!!targetCourse}
              value={subject}
              onChange={(event) => setSubject(event.target.value as Subject)}
            >
              {subjects.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label className="class-form-field">
            候选课时数
            <select value={count} onChange={(event) => setCount(Number(event.target.value))}>
              {[2, 3, 4, 5, 6, 7, 8].map((number) => (
                <option key={number} value={number}>
                  {number} 个候选课时
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="class-research-steps">
          <span>
            <b>1</b>联网查找知识点与解题技巧
          </span>
          <span>
            <b>2</b>整理带来源的课程树
          </span>
          <span>
            <b>3</b>勾选课时后再生成讲解
          </span>
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <footer className="class-form-footer">
          <button type="button" className="class-secondary" onClick={onClose}>
            取消
          </button>
          <button className="class-primary" disabled={pending || !topic.trim()}>
            {pending && <LoaderCircle className="spin" size={16} />}联网研究章节
            <ArrowRight size={16} />
          </button>
        </footer>
      </form>
    </ClassroomDialog>
  );
}
