import { useEffect, useRef } from 'react';
import {
  Activity,
  ArrowRight,
  Check,
  CircleAlert,
  LoaderCircle,
  RotateCcw,
  Square,
  X,
} from 'lucide-react';
import type { AgentJob } from '../../lib/platform';

export const ACTION_LABELS: Record<string, string> = {
  create_course: '检索章节课程',
  extend_course: '拓展课程树',
  generate_lessons: '生成所选讲解',
  tutor: '解答学习问题',
  grade: '批改随堂练习',
  review: '整理学习建议',
  replan: '研究巩固分支',
};
export const STATUS_LABELS: Record<string, string> = {
  queued: '等待执行',
  running: '正在执行',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
  interrupted: '服务重启后中断',
};
export function activeJob(job: AgentJob) {
  return job.status === 'running' || job.status === 'queued';
}
export function JobPanel({
  jobs,
  onClose,
  onAction,
  onOpenCourse,
}: {
  jobs: AgentJob[];
  onClose: () => void;
  onAction: (id: string, action: 'retry' | 'cancel') => Promise<void>;
  onOpenCourse: (id: string) => void;
}) {
  const drawer = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    drawer.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const elements = Array.from(
        drawer.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
        ) || [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = elements[0],
        last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', keyboard);
      previous?.focus();
    };
  }, []);
  return (
    <div className="drawer-layer">
      <button className="drawer-backdrop" aria-label="关闭 Agent 工作台" onClick={onClose} />
      <section
        ref={drawer}
        className="job-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="jobs-title"
      >
        <header>
          <div>
            <span className="eyebrow">教学 Agent</span>
            <h2 id="jobs-title">工作台</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭工作台">
            <X size={21} />
          </button>
        </header>
        <p className="drawer-intro">
          章节检索、课程树研究、讲解和反馈都在这里逐步执行。离开页面后，任务仍会继续。
        </p>
        <div className="job-list">
          {jobs.length === 0 ? (
            <div className="empty-state compact">
              <Activity size={30} />
              <h3>还没有教学任务</h3>
              <p>输入一个主题，让 Agent 为你安排第一门课程。</p>
            </div>
          ) : (
            [...jobs]
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((job) => (
                <article className={`job-card status-${job.status}`} key={job.id}>
                  <div className="job-card-top">
                    <span className="job-icon">
                      {activeJob(job) ? (
                        <LoaderCircle className="spin" size={18} />
                      ) : job.status === 'completed' ? (
                        <Check size={18} />
                      ) : (
                        <CircleAlert size={18} />
                      )}
                    </span>
                    <div>
                      <h3>{ACTION_LABELS[job.command.action] || job.command.action}</h3>
                      <p>
                        {job.command.topic ||
                          (job.command.backend === 'claude' ? 'Claude Code' : 'Codex')}{' '}
                        ·{' '}
                        {new Date(job.createdAt).toLocaleString('zh-CN', {
                          month: 'numeric',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>
                    <span className="status-label">{STATUS_LABELS[job.status]}</span>
                  </div>
                  <div className="job-progress">
                    <div style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} />
                  </div>
                  <p className="job-stage" aria-live="polite">
                    {job.stage || STATUS_LABELS[job.status]}
                    <span>{Math.round(job.progress)}%</span>
                  </p>
                  {job.events.length > 0 && (
                    <ol className="event-list">
                      {job.events.slice(-8).map((event) => (
                        <li key={event.id} className={event.status}>
                          <span className="event-dot" />
                          <div>
                            <p>{event.message}</p>
                            <small>
                              {new Date(event.time).toLocaleTimeString('zh-CN', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </small>
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                  {job.error && (
                    <p className="field-error" role="status">
                      {job.error}
                    </p>
                  )}
                  <div className="job-actions">
                    {activeJob(job) && (
                      <button
                        className="btn p-button secondary small"
                        onClick={() => void onAction(job.id, 'cancel')}
                      >
                        <Square size={13} />
                        取消任务
                      </button>
                    )}
                    {['failed', 'interrupted', 'cancelled'].includes(job.status) && (
                      <button
                        className="btn p-button secondary small"
                        onClick={() => void onAction(job.id, 'retry')}
                      >
                        <RotateCcw size={14} />
                        重新执行
                      </button>
                    )}
                    {job.status === 'completed' && job.result?.courseId && (
                      <button
                        className="btn p-button small"
                        onClick={() => onOpenCourse(job.result!.courseId!)}
                      >
                        打开课程 <ArrowRight size={14} />
                      </button>
                    )}
                    {job.status === 'completed' && !job.result?.courseId && (
                      <p className="job-finished-note">结果已保存到对应课堂或学习记录。</p>
                    )}
                  </div>
                </article>
              ))
          )}
        </div>
      </section>
    </div>
  );
}
