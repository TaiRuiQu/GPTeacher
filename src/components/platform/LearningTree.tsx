import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, FileText, Folder, Plus } from 'lucide-react';
import {
  getCourseLessons,
  getCourseNodePath,
  getNodeLessons,
  type Course,
  type CourseNode,
  type LearnerProfile,
  type PlatformState,
} from '../../lib/platform';

interface LearningTreeProps {
  course: Course;
  state: PlatformState;
  learner: LearnerProfile;
  selectedNodeId?: string;
  onSelect: (nodeId: string) => void;
  onExtend?: (parentNodeId?: string) => void;
  selectedLessonIds?: string[];
  onSelectionChange?: (lessonIds: string[]) => void;
}

export function LearningTree({
  course,
  state,
  learner,
  selectedNodeId,
  onSelect,
  onExtend,
  selectedLessonIds = [],
  onSelectionChange,
}: LearningTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () =>
      new Set([
        ...course.nodes.filter((node) => node.kind === 'chapter').map((node) => node.id),
        ...getCourseNodePath(course, selectedNodeId || '')
          .filter((node) => node.kind === 'chapter')
          .map((node) => node.id),
      ]),
  );
  useEffect(() => {
    const ancestors = getCourseNodePath(course, selectedNodeId || '')
      .filter((node) => node.kind === 'chapter')
      .map((node) => node.id);
    setExpanded((current) =>
      ancestors.every((id) => current.has(id)) ? current : new Set([...current, ...ancestors]),
    );
  }, [course, selectedNodeId]);
  const selected = new Set(selectedLessonIds);
  const isCompleted = (id: string) =>
    state.progress.some(
      (progress) =>
        progress.learnerId === learner.id &&
        progress.courseId === course.id &&
        progress.lessonId === id &&
        progress.completed,
    );
  const chooseLessons = (ids: string[]) => {
    const all = ids.every((id) => selected.has(id));
    const next = new Set(selected);
    for (const id of ids) {
      if (all) next.delete(id);
      else next.add(id);
    }
    onSelectionChange?.([...next]);
  };
  const renderNode = (node: CourseNode, depth: number): React.ReactNode => {
    const lessons = getNodeLessons(node);
    const planned = lessons
      .filter((lesson) => lesson.status === 'planned')
      .map((lesson) => lesson.id);
    const ready = lessons.filter((lesson) => lesson.status === 'ready').length;
    const done = lessons.filter((lesson) => isCompleted(lesson.id)).length;
    const checked = planned.length > 0 && planned.every((id) => selected.has(id));
    const partial = !checked && planned.some((id) => selected.has(id));
    const chapter = node.kind === 'chapter';
    const open = expanded.has(node.id);
    return (
      <div className={`learning-tree-node ${chapter ? 'is-chapter' : 'is-lesson'}`} key={node.id}>
        <div
          className={`learning-tree-row ${selectedNodeId === node.id ? 'selected' : ''}`}
          style={{ paddingLeft: 12 + depth * 16 }}
          data-node-id={node.id}
        >
          {chapter ? (
            <button
              className="learning-tree-disclosure"
              title={open ? '收起章节' : '展开章节'}
              onClick={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(node.id)) next.delete(node.id);
                  else next.add(node.id);
                  return next;
                })
              }
            >
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          ) : (
            <span className="learning-tree-disclosure-placeholder" />
          )}
          {onSelectionChange && planned.length > 0 ? (
            <input
              type="checkbox"
              className="learning-tree-checkbox"
              title={`选择${node.title}`}
              aria-label={`选择${node.title}`}
              checked={checked}
              ref={(element) => {
                if (element) element.indeterminate = partial;
              }}
              onChange={() => chooseLessons(planned)}
            />
          ) : (
            <span
              className={`learning-tree-symbol ${done === lessons.length && done > 0 ? 'complete' : ''}`}
            >
              {done === lessons.length && done > 0 ? (
                <Check size={13} />
              ) : chapter ? (
                <Folder size={14} />
              ) : (
                <FileText size={14} />
              )}
            </span>
          )}
          <button
            className="learning-tree-select"
            onClick={() => onSelect(node.id)}
            title={node.objective}
          >
            <span>{node.title}</span>
            <small>
              {chapter
                ? `${lessons.length} 讲 · ${ready} 已生成${done ? ` · ${done} 已学完` : ''}`
                : node.status === 'planned'
                  ? '待生成讲解'
                  : `${node.minutes} 分钟${done ? ' · 已学完' : ' · 可上课'}`}
            </small>
          </button>
          {chapter && onExtend && (
            <button
              className="learning-tree-add"
              title={`向${node.title}补充章节`}
              onClick={() => onExtend(node.id)}
            >
              <Plus size={14} />
            </button>
          )}
        </div>
        {chapter && open && (
          <div className="learning-tree-children">
            {node.children.length ? (
              node.children.map((child) => renderNode(child, depth + 1))
            ) : (
              <p className="learning-tree-empty" style={{ paddingLeft: 40 + depth * 16 }}>
                还没有子章节
              </p>
            )}
          </div>
        )}
      </div>
    );
  };
  const all = getCourseLessons(course);
  return (
    <div className="learning-tree" data-testid="learning-tree">
      <div className="learning-tree-root">
        <button onClick={() => course.nodes[0] && onSelect(course.nodes[0].id)}>
          <BookTreeMark />
          <span>
            {course.title}
            <small>
              {all.length} 讲 · {all.filter((lesson) => lesson.status === 'ready').length} 讲已生成
            </small>
          </span>
        </button>
        {onExtend && (
          <button className="learning-tree-add" title="补充章节" onClick={() => onExtend()}>
            <Plus size={16} />
          </button>
        )}
      </div>
      <div className="learning-tree-branches">
        {course.nodes.map((node) => renderNode(node, 0))}
      </div>
      {!course.nodes.length && (
        <p className="learning-tree-empty">输入章节名称，让 Agent 研究并设计学习树。</p>
      )}
    </div>
  );
}
function BookTreeMark() {
  return <Folder size={17} />;
}
