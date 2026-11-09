/** Shared contracts for the learner workspace and durable teaching-agent jobs. */
export type AgentBackend = 'codex' | 'claude';
export type Subject =
  '数学' | '语文' | '英语' | '物理' | '化学' | '生物' | '历史' | '地理' | '综合';
export interface LearnerProfile {
  id: string;
  name: string;
  grade: number;
  dailyMinutes: number;
  goal: string;
}
export interface Exercise {
  id: string;
  question: string;
  options: string[];
  answer: string;
  explanation: string;
  skill: string;
}
export interface CourseLesson {
  kind: 'lesson';
  status: 'planned' | 'ready';
  id: string;
  title: string;
  objective: string;
  minutes: number;
  source: string;
  exercises: Exercise[];
  knowledgePoints: string[];
  techniques: string[];
  sources: LearningSource[];
}
export interface LearningSource {
  title: string;
  url: string;
}
export interface TeachingInterruption {
  position: number;
  stepId: string;
  narrationOffset?: number;
  boundary: 'word' | 'estimated' | 'section';
  channel: 'voice' | 'text';
  interrupted: boolean;
  answerMessageId?: string;
  answerOffset?: number;
  selectedObject?: { id: string; label: string };
}
export interface CourseChapter {
  kind: 'chapter';
  id: string;
  title: string;
  objective: string;
  children: CourseNode[];
}
export type CourseNode = CourseChapter | CourseLesson;
export interface Course {
  id: string;
  title: string;
  topic: string;
  subject: Subject;
  grade: number;
  description: string;
  objectives: string[];
  prerequisites: string[];
  nodes: CourseNode[];
  origin: 'sample' | 'agent';
  createdAt: string;
}
export interface LessonProgress {
  lessonId: string;
  courseId: string;
  learnerId: string;
  position: number;
  completed: boolean;
  updatedAt: string;
}
export interface Attempt {
  id: string;
  learnerId: string;
  courseId: string;
  lessonId: string;
  answers: Record<string, string>;
  score: number;
  feedback: string;
  items: { exerciseId: string; correct: boolean; feedback: string }[];
  nextSteps: string[];
  createdAt: string;
}
export interface ChatMessage {
  id: string;
  learnerId: string;
  courseId: string;
  lessonId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}
export interface LearningNote {
  id: string;
  learnerId: string;
  courseId: string;
  lessonId: string;
  body: string;
  createdAt: string;
}
export type AgentAction =
  'create_course' | 'extend_course' | 'generate_lessons' | 'tutor' | 'grade' | 'review' | 'replan';
export interface AgentCommand {
  action: AgentAction;
  backend: AgentBackend;
  learnerId: string;
  courseId?: string;
  /** A chapter receiving a new branch. Omit to attach directly to the course root. */
  parentNodeId?: string;
  lessonId?: string;
  lessonIds?: string[];
  topic?: string;
  subject?: Subject;
  lessonCount?: number;
  question?: string;
  answers?: Record<string, string>;
  interruption?: TeachingInterruption;
}
export interface AgentEvent {
  id: string;
  time: string;
  stage: string;
  message: string;
  status: 'running' | 'done' | 'error';
}
export interface AgentJob {
  id: string;
  command: AgentCommand;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  stage: string;
  progress: number;
  events: AgentEvent[];
  result?: {
    courseId?: string;
    nodeId?: string;
    message?: string;
    attemptId?: string;
    reviewId?: string;
  };
  error?: string;
  createdAt: string;
  updatedAt: string;
  retryOf?: string;
}
export interface LearningReview {
  id: string;
  learnerId: string;
  title: string;
  summary: string;
  strengths: string[];
  gaps: string[];
  nextSteps: string[];
  createdAt: string;
}
export interface PlatformState {
  version: 1;
  learners: LearnerProfile[];
  activeLearnerId: string;
  courses: Course[];
  progress: LessonProgress[];
  attempts: Attempt[];
  messages: ChatMessage[];
  notes: LearningNote[];
  reviews: LearningReview[];
  jobs: AgentJob[];
  preferredBackend: AgentBackend;
}
export interface BackendStatus {
  id: AgentBackend;
  name: string;
  available: boolean;
  version?: string;
  message: string;
}

/** Playback order is derived from the tree; lessons are stored only at their own nodes. */
export function getCourseLessons(course: Course): CourseLesson[] {
  return course.nodes.flatMap(getNodeLessons);
}
export function getNodeLessons(node: CourseNode): CourseLesson[] {
  return node.kind === 'lesson' ? [node] : node.children.flatMap(getNodeLessons);
}
export function findCourseNode(course: Course, nodeId: string): CourseNode | undefined {
  for (const node of course.nodes) {
    if (node.id === nodeId) return node;
    if (node.kind === 'chapter') {
      const found = findCourseNode({ ...course, nodes: node.children }, nodeId);
      if (found) return found;
    }
  }
  return undefined;
}
/** Ancestors first, ending in the selected node; an unknown node has an empty path. */
export function getCourseNodePath(course: Course, nodeId: string): CourseNode[] {
  for (const node of course.nodes) {
    if (node.id === nodeId) return [node];
    if (node.kind === 'chapter') {
      const path = getCourseNodePath({ ...course, nodes: node.children }, nodeId);
      if (path.length) return [node, ...path];
    }
  }
  return [];
}
export function courseNodeCompletion(
  course: Course,
  learnerId: string,
  progress: LessonProgress[],
  node?: CourseNode,
) {
  const lessons = node ? getNodeLessons(node) : getCourseLessons(course);
  const completed = lessons.filter((lesson) =>
    progress.some(
      (item) =>
        item.learnerId === learnerId &&
        item.courseId === course.id &&
        item.lessonId === lesson.id &&
        item.completed,
    ),
  ).length;
  return { completed, total: lessons.length };
}
