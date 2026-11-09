import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  GraduationCap,
  LayoutGrid,
  LoaderCircle,
  Menu,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react';
import { apiJson } from './lib/api';
import type {
  AgentCommand,
  AgentJob,
  BackendStatus,
  Course,
  LearnerProfile,
  PlatformState,
} from './lib/platform';
import { getCourseLessons, findCourseNode, type Subject } from './lib/platform';
import {
  Dashboard,
  CourseOverview,
  LearningRecords,
  SettingsPage,
} from './components/platform/Workspace';
import { Classroom } from './components/platform/Classroom';
import { JobPanel } from './components/platform/JobPanel';
import {
  ClassroomDialog,
  CourseComposerDialog,
  CourseLibraryDialog,
} from './components/platform/ClassroomDialogs';

type Route = {
  page: 'home' | 'courses' | 'records' | 'settings' | 'course' | 'classroom';
  courseId?: string;
  lessonId?: string;
};
function readRoute(): Route {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const page = params.get('page') || 'classroom';
  return {
    page: ['home', 'courses', 'records', 'settings', 'course', 'classroom'].includes(page)
      ? (page as Route['page'])
      : 'classroom',
    courseId: params.get('course') || undefined,
    lessonId: params.get('lesson') || undefined,
  };
}
const navigation = [
  { id: 'home', label: '我的学习', icon: LayoutGrid },
  { id: 'courses', label: '我的课程', icon: BookOpen },
  { id: 'records', label: '学习记录', icon: Activity },
  { id: 'settings', label: '学习设置', icon: Settings2 },
] as const;

export default function App() {
  const [state, setState] = useState<PlatformState | null>(null);
  const [backends, setBackends] = useState<BackendStatus[]>([]);
  const [route, setRoute] = useState<Route>(readRoute);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [jobsOpen, setJobsOpen] = useState(false);
  const [overlay, setOverlay] = useState<'library' | 'create' | 'settings' | 'records' | null>(
    null,
  );
  const [researchTarget, setResearchTarget] = useState<{
    courseId: string;
    parentNodeId?: string;
  } | null>(null);
  const [researchSubject, setResearchSubject] = useState<Subject>('数学');
  const [followJobId, setFollowJobId] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const requestCount = useRef(0);
  const mutationQueue = useRef<Promise<unknown>>(Promise.resolve());
  const mutationCount = useRef(0);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const serial = ++requestCount.current;
    const next = await apiJson<PlatformState>('/api/platform', undefined, undefined, 'GET');
    if (mounted.current && serial === requestCount.current && !mutationCount.current)
      setState(next);
    return next;
  }, []);
  const refreshBackends = useCallback(async () => {
    const result = await apiJson<{ backends: BackendStatus[] }>(
      '/api/platform/backends',
      undefined,
      undefined,
      'GET',
    );
    if (mounted.current) setBackends(result.backends);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void Promise.all([refresh(), refreshBackends()])
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '暂时无法加载学习空间。'))
      .finally(() => setLoading(false));
    const changed = () => {
      setRoute(readRoute());
      setMobileOpen(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', changed);
    return () => {
      mounted.current = false;
      window.removeEventListener('hashchange', changed);
    };
  }, [refresh, refreshBackends]);
  const hasActive =
    state?.jobs.some((job) => job.status === 'running' || job.status === 'queued') ?? false;
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => {
      void refresh().catch((e: unknown) =>
        setError(e instanceof Error ? e.message : '任务状态读取失败，请重新连接。'),
      );
    }, 1300);
    return () => window.clearInterval(timer);
  }, [hasActive, refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const navigate = (next: Route) => {
    setOverlay(null);
    const params = new URLSearchParams({ page: next.page });
    if (next.courseId) params.set('course', next.courseId);
    if (next.lessonId) params.set('lesson', next.lessonId);
    window.location.hash = params.toString();
    setMobileOpen(false);
  };
  const mutate = async (path: string, body: unknown, method: 'POST' | 'PUT' | 'DELETE' = 'PUT') => {
    mutationCount.current += 1;
    const operation = mutationQueue.current
      .catch(() => undefined)
      .then(async () => {
        setError('');
        ++requestCount.current;
        try {
          const next = await apiJson<PlatformState>(path, body, undefined, method);
          if (mounted.current && mutationCount.current === 1) setState(next);
          return next;
        } catch (e) {
          const message = e instanceof Error ? e.message : '操作未能保存，请重试。';
          setError(message);
          throw new Error(message);
        } finally {
          mutationCount.current -= 1;
        }
      });
    mutationQueue.current = operation;
    return operation;
  };
  const runAgent = async (command: Omit<AgentCommand, 'backend' | 'learnerId'>) => {
    if (!state) return;
    setPending(true);
    setError('');
    try {
      const { job } = await apiJson<{ job: AgentJob }>('/api/platform/jobs', {
        ...command,
        backend: state.preferredBackend,
        learnerId: state.activeLearnerId,
      });
      setState((current) =>
        current
          ? {
              ...current,
              jobs: [job, ...current.jobs.filter((existing) => existing.id !== job.id)],
            }
          : current,
      );
      if (
        ['create_course', 'extend_course', 'replan', 'generate_lessons'].includes(command.action)
      ) {
        setOverlay(null);
        setFollowJobId(job.id);
        if (command.action !== 'generate_lessons') setJobsOpen(true);
      }
      await refresh();
      return job;
    } catch (e) {
      const message = e instanceof Error ? e.message : '智能任务未能启动，请检查学习设置。';
      setError(message);
      throw new Error(message);
    } finally {
      setPending(false);
    }
  };
  const jobAction = async (id: string, action: 'cancel' | 'retry') => {
    setError('');
    try {
      await apiJson(`/api/platform/jobs/${encodeURIComponent(id)}/${action}`, {});
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '任务操作失败，请重试。');
    }
  };
  const learner =
    state?.learners.find((item) => item.id === state.activeLearnerId) || state?.learners[0];
  const recent = state?.progress
    .filter(
      (item) =>
        item.learnerId === learner?.id &&
        state.courses.some(
          (course) =>
            course.id === item.courseId &&
            getCourseLessons(course).some(
              (lesson) => lesson.id === item.lessonId && lesson.status === 'ready',
            ),
        ),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const course =
    state?.courses.find((item) => item.id === route.courseId) ||
    (route.page === 'classroom' && !route.courseId
      ? state?.courses.find((item) => item.id === recent?.courseId) ||
        state?.courses.find((item) => item.origin === 'agent') ||
        state?.courses[0]
      : undefined);
  const classroomLessonId =
    route.lessonId ||
    (recent?.courseId === course?.id ? recent?.lessonId : undefined) ||
    (course
      ? getCourseLessons(course).find((lesson) => lesson.status === 'ready')?.id ||
        course.nodes[0]?.id
      : '') ||
    '';
  const backend = backends.find((item) => item.id === state?.preferredBackend);
  const openCourse = (item: Course) =>
    navigate({ page: 'classroom', courseId: item.id, lessonId: item.nodes[0]?.id });
  const enterLesson = (item: Course, lessonId?: string) => {
    const resumed = state?.progress
      .filter((p) => p.learnerId === learner?.id && p.courseId === item.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const selected =
      lessonId ||
      resumed?.lessonId ||
      getCourseLessons(item).find((lesson) => lesson.status === 'ready')?.id ||
      item.nodes[0]?.id;
    navigate({ page: 'classroom', courseId: item.id, lessonId: selected });
  };

  useEffect(() => {
    if (!state || !followJobId) return;
    const job = state.jobs.find((item) => item.id === followJobId);
    if (!job || !['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return;
    setFollowJobId(null);
    if (job.status !== 'completed' || !job.result?.courseId) return;
    const resultCourse = state.courses.find((item) => item.id === job.result?.courseId);
    if (!resultCourse) return;
    const target =
      job.result.nodeId && findCourseNode(resultCourse, job.result.nodeId)
        ? job.result.nodeId
        : resultCourse.nodes[0]?.id;
    setJobsOpen(false);
    setOverlay(null);
    navigate({ page: 'classroom', courseId: resultCourse.id, lessonId: target });
  }, [state, followJobId]);

  if (loading && !state)
    return (
      <div className="boot-screen">
        <span className="brand-symbol">
          <GraduationCap size={27} />
        </span>
        <h1>GPT Teacher</h1>
        <p>
          <LoaderCircle className="spin" size={16} /> 正在打开学习空间
        </p>
      </div>
    );
  if (!state || !learner)
    return (
      <div className="boot-screen">
        <BookOpen size={36} />
        <h1>学习空间暂时无法打开</h1>
        <p role="alert">{error || '没有找到学习档案。'}</p>
        <button className="btn p-button" onClick={() => window.location.reload()}>
          重新连接 <ArrowRight size={16} />
        </button>
      </div>
    );
  const activeJobs = state.jobs.filter((job) => ['running', 'queued'].includes(job.status)).length;
  const isClassroom = route.page === 'classroom' && !!course;
  return (
    <div className={`platform-shell ${isClassroom ? 'whiteboard-app' : ''}`}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById('main-content');
          main?.focus();
          main?.scrollIntoView();
        }}
      >
        跳到学习内容
      </a>
      {!isClassroom && mobileOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭导航"
          onClick={() => setMobileOpen(false)}
        />
      )}
      {!isClassroom && (
        <aside className={`platform-sidebar ${mobileOpen ? 'is-open' : ''}`}>
          <button
            className="brand-lockup"
            onClick={() => navigate({ page: 'home' })}
            aria-label="GPT Teacher 学习首页"
          >
            <span className="brand-symbol">
              <GraduationCap size={25} />
            </span>
            <span className="brand-words">
              GPT Teacher<small>每个问题，都值得学懂</small>
            </span>
          </button>
          <div className="workspace-label">
            学习空间 <span>K12</span>
          </div>
          <nav aria-label="主导航">
            {navigation.map((item) => (
              <button
                key={item.id}
                title={item.label}
                className={`nav-item ${route.page === item.id || (item.id === 'courses' && ['course', 'classroom'].includes(route.page)) ? 'active' : ''}`}
                aria-current={route.page === item.id ? 'page' : undefined}
                onClick={() => navigate({ page: item.id })}
              >
                <item.icon size={19} />
                <span>{item.label}</span>
                {item.id === 'courses' && <small>{state.courses.length}</small>}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="agent-mini">
              <span className={`status-dot ${backend?.available ? 'online' : ''}`} />
              <span>
                <strong>
                  {backend?.name || (state.preferredBackend === 'claude' ? 'Claude Code' : 'Codex')}
                </strong>
                <small>{backend?.available ? '已检测到本机程序' : '前往设置检查连接'}</small>
              </span>
            </div>
            <button className="learner-switch" onClick={() => navigate({ page: 'settings' })}>
              <span className="avatar">{learner.name.slice(0, 1)}</span>
              <span>
                <strong>{learner.name}</strong>
                <small>
                  {learner.grade} 年级 · 每天 {learner.dailyMinutes} 分钟
                </small>
              </span>
              <ChevronDown size={15} />
            </button>
          </div>
        </aside>
      )}
      <div className="platform-body">
        {!isClassroom && (
          <header className="workspace-header">
            <div className="header-breadcrumb">
              <button
                className="icon-button mobile-menu"
                aria-label="打开导航"
                aria-expanded={mobileOpen}
                onClick={() => setMobileOpen(!mobileOpen)}
              >
                <Menu size={21} />
              </button>
              <span>我的学习空间</span>
              <span className="breadcrumb-slash">/</span>
              <strong>
                {isClassroom
                  ? course.title
                  : route.page === 'course'
                    ? '课程计划'
                    : navigation.find((item) => item.id === route.page)?.label || '我的学习'}
              </strong>
            </div>
            <button
              className={`agent-activity ${activeJobs ? 'working' : ''}`}
              onClick={() => setJobsOpen(true)}
            >
              <Sparkles size={16} />
              <span>{activeJobs ? `${activeJobs} 个任务进行中` : 'Agent 工作台'}</span>
              {activeJobs > 0 && <span className="job-count">{activeJobs}</span>}
            </button>
          </header>
        )}
        {error && (
          <div className="global-error" role="alert">
            <span>{error}</span>
            <button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        <main
          id="main-content"
          tabIndex={-1}
          className={isClassroom ? 'whiteboard-main' : 'workspace-main'}
        >
          {(route.page === 'home' || route.page === 'courses') && (
            <Dashboard
              state={state}
              learner={learner}
              backends={backends}
              libraryOnly={route.page === 'courses'}
              pending={pending}
              onOpen={openCourse}
              onEnter={enterLesson}
              onAgent={runAgent}
              onSettings={() => navigate({ page: 'settings' })}
            />
          )}
          {route.page === 'course' && course && (
            <CourseOverview
              course={course}
              state={state}
              learner={learner}
              pending={pending}
              onBack={() => navigate({ page: 'courses' })}
              onEnter={(id) => enterLesson(course, id)}
              onAgent={runAgent}
            />
          )}
          {isClassroom && (
            <Classroom
              key={`${course.id}:${learner.id}`}
              course={course}
              lessonId={classroomLessonId}
              learner={learner}
              state={state}
              pending={pending}
              onBack={() => setOverlay('library')}
              onLibrary={() => setOverlay('library')}
              onNewCourse={() => {
                setResearchTarget(null);
                setResearchSubject(course.subject);
                setOverlay('create');
              }}
              onExtendCourse={(parentNodeId) => {
                setResearchTarget({ courseId: course.id, parentNodeId });
                setResearchSubject(course.subject);
                setOverlay('create');
              }}
              onSettings={() => setOverlay('settings')}
              onRecords={() => setOverlay('records')}
              onJobs={() => {
                setOverlay(null);
                setJobsOpen(true);
              }}
              activeJobs={activeJobs}
              suspended={!!overlay || jobsOpen}
              onLesson={(id) => enterLesson(course, id)}
              onAgent={runAgent}
              onMutate={mutate}
              onNotice={setNotice}
            />
          )}
          {route.page === 'records' && (
            <LearningRecords
              state={state}
              learner={learner}
              pending={pending}
              onOpen={openCourse}
              onAgent={runAgent}
              onMutate={mutate}
            />
          )}
          {route.page === 'settings' && (
            <SettingsPage
              key={learner.id}
              state={state}
              learner={learner}
              backends={backends}
              onRefreshBackends={refreshBackends}
              onMutate={mutate}
              onSaved={() => setNotice('学习设置已保存')}
            />
          )}
          {['course', 'classroom'].includes(route.page) && !course && (
            <div className="empty-state">
              <BookOpen size={32} />
              <h1>这门课程暂时不存在</h1>
              <p>回到课程列表，选择一门课程继续学习。</p>
              <button className="btn p-button" onClick={() => navigate({ page: 'courses' })}>
                查看我的课程 <ArrowRight size={16} />
              </button>
            </div>
          )}
        </main>
        {!isClassroom && (
          <footer className="workspace-footer">
            <span>GPT Teacher · 面向 1–12 年级的 AI 学习平台</span>
            <span>知识需要练习，也值得核对。</span>
          </footer>
        )}
      </div>
      {overlay === 'library' && course && (
        <CourseLibraryDialog
          state={state}
          learner={learner}
          currentCourseId={course.id}
          currentNodeId={classroomLessonId}
          onEnter={(item, nodeId) => {
            setOverlay(null);
            enterLesson(item, nodeId);
          }}
          onCreate={(subject) => {
            setResearchTarget(null);
            setResearchSubject(subject || course.subject);
            setOverlay('create');
          }}
          onExtend={(item, parentNodeId) => {
            setResearchTarget({ courseId: item.id, parentNodeId });
            setResearchSubject(item.subject);
            setOverlay('create');
          }}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === 'create' && (
        <CourseComposerDialog
          learner={learner}
          targetCourse={
            researchTarget
              ? state.courses.find((item) => item.id === researchTarget.courseId)
              : undefined
          }
          parentNodeId={researchTarget?.parentNodeId}
          initialSubject={researchSubject}
          pending={pending}
          onAgent={runAgent}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === 'settings' && (
        <ClassroomDialog title="学习设置" wide onClose={() => setOverlay(null)}>
          <SettingsPage
            key={learner.id}
            state={state}
            learner={learner}
            backends={backends}
            onRefreshBackends={refreshBackends}
            onMutate={mutate}
            onSaved={() => setNotice('学习设置已保存')}
          />
        </ClassroomDialog>
      )}
      {overlay === 'records' && (
        <ClassroomDialog title="学习记录" wide onClose={() => setOverlay(null)}>
          <LearningRecords
            state={state}
            learner={learner}
            pending={pending}
            onOpen={(item) => {
              setOverlay(null);
              enterLesson(item);
            }}
            onAgent={runAgent}
            onMutate={mutate}
          />
        </ClassroomDialog>
      )}
      {jobsOpen && (
        <JobPanel
          jobs={state.jobs.filter((job) => job.command.learnerId === learner.id)}
          onClose={() => setJobsOpen(false)}
          onAction={jobAction}
          onOpenCourse={(id) => {
            setJobsOpen(false);
            const resultCourse = state.courses.find((item) => item.id === id);
            const selected = state.jobs.find(
              (job) => job.result?.courseId === id && job.status === 'completed',
            )?.result?.nodeId;
            if (resultCourse) enterLesson(resultCourse, selected);
            else navigate({ page: 'classroom', courseId: id });
          }}
        />
      )}
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
    </div>
  );
}

export type AgentRunner = (
  command: Omit<AgentCommand, 'backend' | 'learnerId'>,
) => Promise<AgentJob | undefined>;
export type PlatformMutator = (
  path: string,
  body: unknown,
  method?: 'POST' | 'PUT' | 'DELETE',
) => Promise<PlatformState>;
export type Profile = LearnerProfile;
