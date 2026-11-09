import { useState } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Atom,
  BookMarked,
  BookOpen,
  Check,
  CircleCheck,
  Clock3,
  FileText,
  GraduationCap,
  Languages,
  LoaderCircle,
  NotebookPen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Target,
  Trash2,
} from 'lucide-react';
import type { AgentRunner, PlatformMutator } from '../../App';
import type {
  BackendStatus,
  Course,
  LearnerProfile,
  PlatformState,
  Subject,
} from '../../lib/platform';
import {
  findCourseNode,
  getCourseLessons,
  getCourseNodePath,
  type CourseNode,
} from '../../lib/platform';
import { LearningTree } from './LearningTree';
import { Markdown } from './Markdown';
import { activeJob } from './JobPanel';

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
const gradeName = (grade: number) =>
  grade <= 6
    ? `小学 ${grade} 年级`
    : grade <= 9
      ? `初中 ${grade - 6} 年级`
      : `高中 ${grade - 9} 年级`;
export function courseCompletion(course: Course, state: PlatformState, learnerId: string) {
  return getCourseLessons(course).filter((l) =>
    state.progress.some(
      (p) =>
        p.learnerId === learnerId && p.courseId === course.id && p.lessonId === l.id && p.completed,
    ),
  ).length;
}
function SubjectIcon({ subject, size = 22 }: { subject: string; size?: number }) {
  if (subject === '英语') return <Languages size={size} />;
  if (['物理', '化学', '生物'].includes(subject)) return <Atom size={size} />;
  if (['语文', '历史', '地理'].includes(subject)) return <BookMarked size={size} />;
  return <BookOpen size={size} />;
}
function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function courseMarkdown(course: Course) {
  const serialize = (node: CourseNode, depth: number): string => {
    const heading = '#'.repeat(Math.min(6, depth + 2));
    if (node.kind === 'chapter')
      return `${heading} ${node.title}\n\n${node.objective}\n\n${node.children.map((child) => serialize(child, depth + 1)).join('\n\n')}`;
    const content =
      node.status === 'ready' ? node.source.replace(/^#\s+.+\n?/, '').trim() : '讲解尚未生成。';
    return `${heading} ${node.title}\n\n${content}`;
  };
  return `# ${course.title}\n\n${course.description}\n\n${course.nodes.map((node) => serialize(node, 0)).join('\n\n')}`;
}

interface DashboardProps {
  state: PlatformState;
  learner: LearnerProfile;
  backends: BackendStatus[];
  libraryOnly: boolean;
  pending: boolean;
  onOpen: (course: Course) => void;
  onEnter: (course: Course) => void;
  onAgent: AgentRunner;
  onSettings: () => void;
}
export function Dashboard({
  state,
  learner,
  backends,
  libraryOnly,
  pending,
  onOpen,
  onEnter,
  onAgent,
  onSettings,
}: DashboardProps) {
  const [topic, setTopic] = useState('');
  const [subject, setSubject] = useState<Subject>('数学');
  const [count, setCount] = useState(4);
  const [filter, setFilter] = useState('全部');
  const [query, setQuery] = useState('');
  const [localError, setLocalError] = useState('');
  const progress = state.progress.filter((p) => p.learnerId === learner.id);
  const attempts = state.attempts.filter((a) => a.learnerId === learner.id);
  const completed = progress.filter((p) => p.completed).length;
  const latest = [...progress].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const continued = state.courses.find((c) => c.id === latest?.courseId);
  const backend = backends.find((b) => b.id === state.preferredBackend);
  const creating = state.jobs.find(
    (j) =>
      j.command.learnerId === learner.id && j.command.action === 'create_course' && activeJob(j),
  );
  const courses = [...state.courses]
    .sort((a, b) =>
      a.origin !== b.origin
        ? a.origin === 'agent'
          ? -1
          : 1
        : b.createdAt.localeCompare(a.createdAt),
    )
    .filter(
      (c) =>
        (filter === '全部' || c.subject === filter) &&
        `${c.title} ${c.description} ${c.topic}`.toLowerCase().includes(query.toLowerCase()),
    );
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim()) {
      setLocalError('先写下一个想学习的主题。');
      return;
    }
    setLocalError('');
    try {
      await onAgent({ action: 'create_course', topic: topic.trim(), subject, lessonCount: count });
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : '课程任务启动失败。');
    }
  };
  return (
    <div className="dashboard-page">
      <div className="page-heading" data-enter>
        <div>
          <span className="eyebrow">{libraryOnly ? '课程书架' : `${learner.name}的学习空间`}</span>
          <h1>{libraryOnly ? '我的课程' : '每一次好奇，都有一堂课。'}</h1>
          <p>
            {libraryOnly
              ? '把一个个主题学完整，按自己的节奏继续。'
              : '选一个想学的主题，让教学 Agent 陪你一步步学懂。'}
          </p>
        </div>
        <span className="grade-badge">
          <GraduationCap size={16} />
          {gradeName(learner.grade)}
        </span>
      </div>
      {!libraryOnly && (
        <>
          <div className="dashboard-top">
            <section className="topic-composer" aria-labelledby="topic-title">
              <div className="composer-heading">
                <span className="composer-symbol">
                  <Sparkles size={20} />
                </span>
                <span>研究一个新章节</span>
                <small>为 {learner.grade} 年级设计</small>
              </div>
              <h2 id="topic-title">从你想学的主题开始</h2>
              <form onSubmit={(e) => void submit(e)}>
                <label className="field-caption" htmlFor="learning-topic">
                  学习主题
                </label>
                <textarea
                  id="learning-topic"
                  maxLength={500}
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="比如：从生活中的天平，理解一元一次方程"
                  rows={2}
                />
                <div className="composer-controls">
                  <div className="composer-selects">
                    <label>
                      <span>学科</span>
                      <select
                        aria-label="课程学科"
                        value={subject}
                        onChange={(e) => setSubject(e.target.value as Subject)}
                      >
                        {subjects.map((item) => (
                          <option key={item}>{item}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>课程安排</span>
                      <select
                        aria-label="课程节数"
                        value={count}
                        onChange={(e) => setCount(Number(e.target.value))}
                      >
                        {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                          <option key={n} value={n}>
                            {n} 节课
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <button className="btn p-button" type="submit" disabled={pending || !!creating}>
                    {pending ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
                    研究章节课程
                    <ArrowRight size={16} />
                  </button>
                </div>
                {localError && (
                  <p className="field-error" role="alert">
                    {localError}
                  </p>
                )}
              </form>
              <div className="composer-footer">
                <span className={`status-dot ${backend?.available ? 'online' : ''}`} />
                <span>
                  {backend?.name || (state.preferredBackend === 'claude' ? 'Claude Code' : 'Codex')}{' '}
                  教学 Agent
                </span>
                <span className="dot-separator">·</span>
                <span>检索资料 → 研究知识点 → 建立课程树</span>
              </div>
              {creating && (
                <div className="inline-progress" role="status">
                  <LoaderCircle className="spin" size={14} />
                  {creating.stage || '正在设计课程'}
                  <span>{Math.round(creating.progress)}%</span>
                </div>
              )}
              {backend && !backend.available && (
                <div className="setup-hint">
                  教学 Agent 需要先完成配置。
                  <button onClick={onSettings}>
                    打开学习设置 <ArrowRight size={13} />
                  </button>
                </div>
              )}
            </section>
            <aside className="daily-card">
              <span className="eyebrow">按自己的节奏</span>
              <div className="daily-target">
                <span>{learner.dailyMinutes}</span>
                <small>分钟 / 天</small>
                <span className="target-icon">
                  <Target size={27} />
                </span>
              </div>
              <h3>每天留一点时间给好奇心</h3>
              <p>{learner.goal || '先学一点，再用练习看看自己理解了多少。'}</p>
              <div className="daily-card-bottom">
                <span>
                  <span className="status-dot online" />
                  学过的内容会为你保存
                </span>
                <button className="icon-button" aria-label="调整每日学习计划" onClick={onSettings}>
                  <Settings2 size={16} />
                </button>
              </div>
            </aside>
          </div>
          <div className="learning-stats">
            <div>
              <span className="stat-icon sage">
                <BookOpen size={19} />
              </span>
              <strong>{state.courses.length}</strong>
              <span>门学习课程</span>
            </div>
            <div>
              <span className="stat-icon peach">
                <CircleCheck size={19} />
              </span>
              <strong>{completed}</strong>
              <span>节已学课程</span>
            </div>
            <div>
              <span className="stat-icon sand">
                <NotebookPen size={19} />
              </span>
              <strong>{attempts.length}</strong>
              <span>次练习提交</span>
            </div>
            <div>
              <span className="stat-icon blue">
                <BookMarked size={19} />
              </span>
              <strong>{state.notes.filter((n) => n.learnerId === learner.id).length}</strong>
              <span>条学习笔记</span>
            </div>
          </div>
          {continued && (
            <section className="continue-banner">
              <span className={`subject-chip tone-${subjects.indexOf(continued.subject) % 4}`}>
                <SubjectIcon subject={continued.subject} />
              </span>
              <div>
                <span className="eyebrow">接着上次的进度</span>
                <h2>{continued.title}</h2>
                <p>
                  {getCourseLessons(continued).find((l) => l.id === latest.lessonId)?.title ||
                    '继续当前课程'}
                </p>
              </div>
              <button className="btn p-button secondary" onClick={() => onEnter(continued)}>
                继续学习 <ArrowRight size={16} />
              </button>
            </section>
          )}
        </>
      )}
      <section className="course-library" aria-labelledby="library-title">
        <div className="section-heading">
          <div>
            <div className="library-title-group">
              <h2 id="library-title">{libraryOnly ? '全部课程' : '我的课程'}</h2>
              <span className="heading-count" aria-label={`${state.courses.length} 门课程`}>
                {state.courses.length}
              </span>
            </div>
            <p>
              {state.courses.some((c) => c.origin === 'agent')
                ? '为你设计的课程和可直接体验的示例课，都在这里。'
                : '先体验一门示例课，也可以从上方创建自己的主题课程。'}
            </p>
          </div>
          <label className="search-field">
            <Search size={16} />
            <span>搜索</span>
            <input
              aria-label="搜索课程"
              placeholder="搜索课程"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        <div className="subject-filters" aria-label="按学科筛选">
          {['全部', ...Array.from(new Set(state.courses.map((c) => c.subject)))].map((item) => (
            <button
              key={item}
              className={filter === item ? 'selected' : ''}
              aria-pressed={filter === item}
              onClick={() => setFilter(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="course-grid">
          {courses.map((course) => {
            const done = courseCompletion(course, state, learner.id);
            return (
              <button
                key={course.id}
                className={`course-card tone-${subjects.indexOf(course.subject) % 4}`}
                onClick={() => onOpen(course)}
              >
                <div className="course-card-content">
                  <div className="course-meta">
                    <span>{course.subject}</span>
                    <span>{gradeName(course.grade)}</span>
                    <span>{course.origin === 'sample' ? '示例课程' : 'Agent 设计'}</span>
                    <span>
                      {getCourseLessons(course).length} 节课 ·{' '}
                      {getCourseLessons(course).reduce((s, l) => s + l.minutes, 0)} 分钟
                    </span>
                  </div>
                  <h3>{course.title}</h3>
                  <p>{course.description}</p>
                  <div className="course-bottom">
                    <span>
                      {done
                        ? `已学 ${done} / ${getCourseLessons(course).length} 节`
                        : '开始你的第一课'}
                    </span>
                    <ArrowRight size={17} />
                  </div>
                  <div className="course-meter">
                    <span
                      style={{
                        width: `${getCourseLessons(course).length ? (done / getCourseLessons(course).length) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        {courses.length === 0 && (
          <div className="empty-state compact">
            <Search size={27} />
            <h3>没有找到匹配的课程</h3>
            <p>试试其他关键词，或者创建一门新的主题课程。</p>
            <button
              className="btn p-button secondary"
              onClick={() => {
                setQuery('');
                setFilter('全部');
              }}
            >
              查看全部课程
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export function CourseOverview({
  course,
  state,
  learner,
  pending,
  onBack,
  onEnter,
  onAgent,
}: {
  course: Course;
  state: PlatformState;
  learner: LearnerProfile;
  pending: boolean;
  onBack: () => void;
  onEnter: (id?: string) => void;
  onAgent: AgentRunner;
}) {
  const [request, setRequest] = useState('');
  const [selectedLessonIds, setSelectedLessonIds] = useState<string[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [extendParentId, setExtendParentId] = useState<string>();
  const generating = state.jobs.some(
    (job) =>
      job.command.courseId === course.id &&
      job.command.action === 'generate_lessons' &&
      activeJob(job),
  );
  const [localError, setLocalError] = useState('');
  const done = courseCompletion(course, state, learner.id);
  const latest = state.progress
    .filter((p) => p.learnerId === learner.id && p.courseId === course.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const replanning = state.jobs.some(
    (j) =>
      j.command.courseId === course.id &&
      ['replan', 'extend_course'].includes(j.command.action) &&
      activeJob(j),
  );
  return (
    <div className="course-page">
      <button className="back-button" onClick={onBack}>
        <ArrowLeft size={16} />
        我的课程
      </button>
      <section className="course-hero">
        <div>
          <div className="course-title-meta">
            <span className="tag sage">{course.subject}</span>
            <span>{gradeName(course.grade)}</span>
            <span>{course.origin === 'sample' ? '可离线体验的示例课程' : '由教学 Agent 设计'}</span>
          </div>
          <h1>{course.title}</h1>
          <p>{course.description}</p>
          <div className="course-facts">
            <span>
              <BookOpen size={16} />
              {getCourseLessons(course).length} 节课程
            </span>
            <span>
              <Clock3 size={16} />约 {getCourseLessons(course).reduce((s, l) => s + l.minutes, 0)}{' '}
              分钟
            </span>
            <span>
              <CircleCheck size={16} />
              已学 {done} 节
            </span>
          </div>
          <button className="btn p-button" onClick={() => onEnter(latest?.lessonId)}>
            {latest ? '继续学习' : '开始第一课'}
            <ArrowRight size={17} />
          </button>
        </div>
        <div className="course-overview-art" aria-hidden="true">
          <SubjectIcon subject={course.subject} size={92} />
          <span>{course.subject}</span>
        </div>
      </section>
      <div className="overview-grid">
        <section className="syllabus panel">
          <div className="section-heading">
            <h2>课程目录</h2>
            <span className="muted">循序渐进，学会一个主题</span>
          </div>
          <LearningTree
            course={course}
            state={state}
            learner={learner}
            selectedNodeId={selectedNodeId}
            onSelect={(nodeId) => {
              setSelectedNodeId(nodeId);
              const node = findCourseNode(course, nodeId);
              if (node?.kind === 'lesson') onEnter(node.id);
            }}
            onExtend={(parentId) => {
              setExtendParentId(parentId);
              setSelectedNodeId(parentId);
            }}
            selectedLessonIds={selectedLessonIds}
            onSelectionChange={setSelectedLessonIds}
          />
          <button
            className="btn p-button"
            disabled={pending || selectedLessonIds.length === 0 || generating}
            onClick={async () => {
              try {
                setLocalError('');
                await onAgent({
                  action: 'generate_lessons',
                  courseId: course.id,
                  lessonIds: selectedLessonIds,
                });
                setSelectedLessonIds([]);
              } catch (error) {
                setLocalError(error instanceof Error ? error.message : '讲解生成失败');
              }
            }}
          >
            <Sparkles size={16} />
            {generating
              ? '正在生成讲解'
              : `生成所选讲解${selectedLessonIds.length ? `（${selectedLessonIds.length} 讲）` : ''}`}
          </button>
          <p className="form-help">
            先研究章节结构，再勾选需要学习的小节生成讲解。已生成的小节可直接上课。
          </p>
        </section>
        <aside className="overview-aside">
          <section className="panel learning-goals">
            <span className="section-symbol">
              <Target size={20} />
            </span>
            <h2>这门课会学到</h2>
            <ul>
              {course.objectives.map((goal, i) => (
                <li key={i}>
                  <Check size={15} />
                  {goal}
                </li>
              ))}
            </ul>
            {course.prerequisites.length > 0 && (
              <>
                <h3>开始前的小准备</h3>
                <p>{course.prerequisites.join('；')}</p>
              </>
            )}
          </section>
          <section className="panel replan-card">
            <Sparkles size={21} />
            <h2>拓展学习分支</h2>
            <p>输入新知识点或薄弱环节，Agent 检索研究后将新章节接到当前课程树中。</p>
            <p className="form-help">
              接到：
              {extendParentId
                ? getCourseNodePath(course, extendParentId)
                    .map((node) => node.title)
                    .join(' / ')
                : course.title}
            </p>
            <label className="sr-only" htmlFor="replan-request">
              补充章节的主题
            </label>
            <textarea
              id="replan-request"
              rows={3}
              maxLength={1000}
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              placeholder="比如：我还不理解移项，希望多讲两道例题"
            />
            <button
              className="btn p-button secondary"
              disabled={!request.trim() || pending || replanning}
              onClick={async () => {
                try {
                  setLocalError('');
                  await onAgent({
                    action: 'extend_course',
                    courseId: course.id,
                    topic: request.trim(),
                    parentNodeId: extendParentId,
                  });
                  setRequest('');
                } catch (e) {
                  setLocalError(e instanceof Error ? e.message : '调整失败');
                }
              }}
            >
              <RefreshCw size={15} />
              {replanning ? '正在研究分支' : '研究并添加分支'}
            </button>
            {localError && <p className="field-error">{localError}</p>}
          </section>
          <button
            className="text-button export-course"
            onClick={() => downloadText(`${course.title}.md`, courseMarkdown(course))}
          >
            <ArrowDownToLine size={15} />
            导出课程 Markdown
          </button>
        </aside>
      </div>
    </div>
  );
}

export function LearningRecords({
  state,
  learner,
  pending,
  onOpen,
  onAgent,
  onMutate,
}: {
  state: PlatformState;
  learner: LearnerProfile;
  pending: boolean;
  onOpen: (course: Course) => void;
  onAgent: AgentRunner;
  onMutate: PlatformMutator;
}) {
  const [tab, setTab] = useState<'attempts' | 'notes' | 'reviews'>('attempts');
  const [localError, setLocalError] = useState('');
  const attempts = state.attempts
    .filter((a) => a.learnerId === learner.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const notes = state.notes
    .filter((n) => n.learnerId === learner.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const reviews = state.reviews
    .filter((r) => r.learnerId === learner.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const reviewing = state.jobs.some(
    (j) => j.command.learnerId === learner.id && j.command.action === 'review' && activeJob(j),
  );
  return (
    <div>
      <div className="page-heading">
        <div>
          <span className="eyebrow">回看每一步</span>
          <h1>学习记录</h1>
          <p>练习告诉你哪里理解了，哪里值得再想一想。</p>
        </div>
        <button
          className="btn p-button"
          disabled={pending || reviewing || attempts.length === 0}
          onClick={async () => {
            try {
              setLocalError('');
              await onAgent({ action: 'review' });
              setTab('reviews');
            } catch (e) {
              setLocalError(e instanceof Error ? e.message : '学习建议生成失败');
            }
          }}
        >
          <Sparkles size={16} />
          {reviewing ? '正在整理学习建议' : '生成学习建议'}
        </button>
      </div>
      {attempts.length === 0 && (
        <p className="gentle-note">
          <BookOpen size={16} />
          完成一次随堂练习后，Agent 会根据真实作答给出学习建议。
        </p>
      )}
      {localError && (
        <p className="field-error" role="alert">
          {localError}
        </p>
      )}
      <div className="page-tabs" role="tablist" aria-label="学习记录类型">
        {(
          [
            { id: 'attempts', label: '练习记录', count: attempts.length },
            { id: 'notes', label: '学习笔记', count: notes.length },
            { id: 'reviews', label: '学习建议', count: reviews.length },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            <span>{item.count}</span>
          </button>
        ))}
      </div>
      <div className="records-list">
        {tab === 'attempts' &&
          (attempts.length ? (
            attempts.map((attempt) => {
              const course = state.courses.find((c) => c.id === attempt.courseId);
              const lesson = (course ? getCourseLessons(course) : []).find(
                (l) => l.id === attempt.lessonId,
              );
              return (
                <article className="panel attempt-record" key={attempt.id}>
                  <div className="record-heading">
                    <span className="record-score">
                      {attempt.score}
                      <small>/100</small>
                    </span>
                    <div>
                      <h2>{lesson?.title || '课堂练习'}</h2>
                      <p>
                        {course?.title} · {new Date(attempt.createdAt).toLocaleString('zh-CN')}
                      </p>
                    </div>
                    {course && (
                      <button className="text-button" onClick={() => onOpen(course)}>
                        回到课程
                        <ArrowRight size={15} />
                      </button>
                    )}
                  </div>
                  <Markdown source={attempt.feedback} />
                  <div className="attempt-items">
                    {attempt.items.map((item) => (
                      <div key={item.exerciseId}>
                        <span className={`tag ${item.correct ? 'sage' : 'peach'}`}>
                          {item.correct ? '已理解' : '再想一想'}
                        </span>
                        <Markdown source={item.feedback} />
                      </div>
                    ))}
                  </div>
                  {attempt.nextSteps.length > 0 && (
                    <div className="next-steps">
                      <strong>接下来可以这样学</strong>
                      <ul>
                        {attempt.nextSteps.map((step, i) => (
                          <li key={i}>{step}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </article>
              );
            })
          ) : (
            <RecordEmpty
              icon="practice"
              title="还没有练习记录"
              text="打开一门课程，完成随堂练习，就能看到 Agent 的具体反馈。"
            />
          ))}
        {tab === 'notes' &&
          (notes.length ? (
            notes.map((note) => {
              const course = state.courses.find((c) => c.id === note.courseId);
              return (
                <article className="panel note-record" key={note.id}>
                  <div className="record-heading">
                    <span className="section-symbol">
                      <NotebookPen size={20} />
                    </span>
                    <div>
                      <h2>
                        {(course ? getCourseLessons(course) : []).find(
                          (l) => l.id === note.lessonId,
                        )?.title || '课堂笔记'}
                      </h2>
                      <p>
                        {course?.title} · {new Date(note.createdAt).toLocaleString('zh-CN')}
                      </p>
                    </div>
                    <button
                      className="icon-button"
                      aria-label="删除笔记"
                      onClick={async () => {
                        try {
                          await onMutate(
                            `/api/platform/notes/${encodeURIComponent(note.id)}`,
                            {},
                            'DELETE',
                          );
                        } catch {
                          /* Parent displays error. */
                        }
                      }}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                  <p className="note-body">{note.body}</p>
                </article>
              );
            })
          ) : (
            <RecordEmpty
              icon="notes"
              title="给理解留个记号"
              text="课堂中记下自己的想法，之后随时回来看看。"
            />
          ))}
        {tab === 'reviews' &&
          (reviews.length ? (
            reviews.map((review) => (
              <article className="panel review-record" key={review.id}>
                <div className="record-heading">
                  <span className="section-symbol">
                    <Sparkles size={20} />
                  </span>
                  <div>
                    <h2>{review.title}</h2>
                    <p>
                      {new Date(review.createdAt).toLocaleString('zh-CN')} · 根据真实学习记录整理
                    </p>
                  </div>
                </div>
                <Markdown source={review.summary} />
                <div className="review-columns">
                  <div>
                    <h3>已经理解的内容</h3>
                    <ul>
                      {review.strengths.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3>值得再练一练</h3>
                    <ul>
                      {review.gaps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                <div className="next-steps">
                  <h3>下一步的学习安排</h3>
                  <ol>
                    {review.nextSteps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                </div>
              </article>
            ))
          ) : (
            <RecordEmpty
              icon="review"
              title={reviewing ? 'Agent 正在整理学习建议' : '让练习带来下一步'}
              text={
                reviewing
                  ? '可以在 Agent 工作台查看进度，整理完成后会出现在这里。'
                  : '提交练习后，生成一份针对当前学习情况的建议。'
              }
            />
          ))}
      </div>
    </div>
  );
}
function RecordEmpty({ icon, title, text }: { icon: string; title: string; text: string }) {
  return (
    <div className="empty-state records-empty">
      {icon === 'notes' ? (
        <NotebookPen size={34} />
      ) : icon === 'review' ? (
        <Sparkles size={34} />
      ) : (
        <FileText size={34} />
      )}
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

export function SettingsPage({
  state,
  learner,
  backends,
  onRefreshBackends,
  onMutate,
  onSaved,
}: {
  state: PlatformState;
  learner: LearnerProfile;
  backends: BackendStatus[];
  onRefreshBackends: () => Promise<void>;
  onMutate: PlatformMutator;
  onSaved: () => void;
}) {
  const [name, setName] = useState(learner.name);
  const [grade, setGrade] = useState(learner.grade);
  const [minutes, setMinutes] = useState(learner.dailyMinutes);
  const [goal, setGoal] = useState(learner.goal);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await onMutate('/api/platform/profile', {
        learner: {
          ...(isNew ? {} : { id: learner.id }),
          name: name.trim(),
          grade,
          dailyMinutes: minutes,
          goal: goal.trim(),
        },
      });
      setIsNew(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : '档案未能保存。');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="settings-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">适合自己的学习方式</span>
          <h1>学习设置</h1>
          <p>年级和学习目标，会帮助教学 Agent 安排合适的课程。</p>
        </div>
      </div>
      <div className="settings-grid">
        <section className="panel profile-settings">
          <div className="section-heading">
            <h2>学习档案</h2>
            <button
              className="text-button"
              onClick={() => {
                setIsNew(!isNew);
                setName(isNew ? learner.name : '');
                setGrade(learner.grade);
                setMinutes(learner.dailyMinutes);
                setGoal(isNew ? learner.goal : '');
              }}
            >
              {isNew ? (
                <>
                  <ArrowLeft size={15} />
                  返回当前档案
                </>
              ) : (
                <>
                  <Plus size={15} />
                  新增档案
                </>
              )}
            </button>
          </div>
          {!isNew && state.learners.length > 1 && (
            <label className="form-field">
              切换学习档案
              <select
                aria-label="切换学习档案"
                value={learner.id}
                onChange={async (e) => {
                  try {
                    await onMutate('/api/platform/preferences', {
                      activeLearnerId: e.target.value,
                    });
                  } catch {
                    /* Parent displays error. */
                  }
                }}
              >
                {state.learners.map((l) => (
                  <option value={l.id} key={l.id}>
                    {l.name} · {l.grade} 年级
                  </option>
                ))}
              </select>
            </label>
          )}
          <form onSubmit={(e) => void save(e)}>
            <label className="form-field">
              {isNew ? '新学习者的称呼' : '你的称呼'}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={30}
                required
                placeholder="例如：小同学"
                autoComplete="off"
              />
            </label>
            <div className="field-row">
              <label className="form-field">
                当前年级
                <select value={grade} onChange={(e) => setGrade(Number(e.target.value))}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {gradeName(n)}（{n} 年级）
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                每天的学习时间
                <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                  {Array.from(new Set([10, 15, 20, 25, 30, 45, 60, 90, 120, minutes]))
                    .sort((a, b) => a - b)
                    .map((n) => (
                      <option value={n} key={n}>
                        {n} 分钟
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <label className="form-field">
              学习目标
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={4}
                maxLength={500}
                placeholder="比如：先理解数学概念，再学会自己解决问题"
              />
            </label>
            <p className="form-help">使用称呼即可。请不要填写姓名、学校、联系方式等个人信息。</p>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <button className="btn p-button" disabled={saving}>
              {saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
              保存学习档案
            </button>
          </form>
        </section>
        <div className="settings-side">
          <section className="panel backend-settings">
            <div className="section-heading">
              <h2>教学 Agent</h2>
              <button
                className="icon-button"
                aria-label="重新检测 Agent 后端"
                disabled={checking}
                onClick={async () => {
                  setChecking(true);
                  try {
                    await onRefreshBackends();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : '检测失败');
                  } finally {
                    setChecking(false);
                  }
                }}
              >
                <RefreshCw size={17} className={checking ? 'spin' : ''} />
              </button>
            </div>
            <p>选择负责设计课程、讲解和反馈的 Agent。使用服务器上已经登录的账号。</p>
            <div className="backend-options">
              {(['codex', 'claude'] as const).map((id) => {
                const info = backends.find((b) => b.id === id);
                return (
                  <button
                    key={id}
                    className={`backend-option ${state.preferredBackend === id ? 'selected' : ''}`}
                    aria-pressed={state.preferredBackend === id}
                    onClick={async () => {
                      try {
                        await onMutate('/api/platform/preferences', { preferredBackend: id });
                        onSaved();
                      } catch {
                        /* Parent displays error. */
                      }
                    }}
                  >
                    <span className={`backend-monogram ${id}`}>
                      {id === 'codex' ? (
                        <span aria-hidden="true">&gt;_</span>
                      ) : (
                        <span aria-hidden="true">✳</span>
                      )}
                    </span>
                    <span>
                      <strong>{id === 'codex' ? 'Codex' : 'Claude Code'}</strong>
                      <small>{info?.available ? '已检测到本机 Agent' : '尚未检测到'}</small>
                    </span>
                    <span className="radio-mark">{state.preferredBackend === id && <span />}</span>
                  </button>
                );
              })}
            </div>
            {backends.map(
              (info) =>
                state.preferredBackend === info.id && (
                  <div className="backend-detail" key={info.id}>
                    <span className={`status-dot ${info.available ? 'online' : ''}`} />
                    <div>
                      <p>{info.message}</p>
                      {info.version && <code>{info.version}</code>}
                    </div>
                  </div>
                ),
            )}
            <p className="form-help">
              检测只确认程序可运行；首次教学任务还需要有效登录和可用额度。
            </p>
          </section>
          <section className="panel settings-info">
            <span className="section-symbol">
              <GraduationCap size={21} />
            </span>
            <h2>面向青少年的学习空间</h2>
            <p>
              课程、练习、提问和笔记按学习档案分别记录。学习内容由 AI
              生成，遇到疑问时可以请老师或家长一起核对。
            </p>
            <p>当前工作区保存在这台服务器上。不同档案用于区分学习记录。</p>
          </section>
        </div>
      </div>
    </div>
  );
}
