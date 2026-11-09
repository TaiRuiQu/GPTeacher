/**
 * A lesson is ordinary Markdown: # title, introduction, then ## sections.
 * Each section becomes a playable step; SVG is optional. Older :::step
 * directives remain readable so existing lessons do not need migration.
 */
export interface LessonStep {
  id: string;
  title: string;
  narration: string;
  svg: string;
  css: string;
  duration: number;
  start: number;
}

export interface Lesson {
  id: string;
  title: string;
  description: string;
  steps: LessonStep[];
  duration: number;
  source: string;
  warnings: string[];
}

export interface SceneSelection {
  id: string;
  label: string;
}

export interface PauseContext {
  lessonId: string;
  lessonTitle: string;
  stepId: string;
  stepTitle: string;
  stepIndex: number;
  time: number;
  localTime: number;
  currentNarration: string;
  priorTimelineSteps: Array<Pick<LessonStep, 'id' | 'title' | 'narration'>>;
  futureStepIds: string[];
  selection: SceneSelection | null;
  presentationBoundary: string;
}

interface RawStep {
  attributes: Record<string, string>;
  lines: string[];
}

function hasStepDirectives(lines: string[]): boolean {
  let fence: { marker: string; length: number } | null = null;
  for (const line of lines) {
    const marks = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (!fence && /^\s*:::step\b/.test(line)) return true;
    if (marks) {
      if (!fence) fence = { marker: marks[0], length: marks.length };
      else if (
        marks[0] === fence.marker &&
        marks.length >= fence.length &&
        /^\s*[`~]+\s*$/.test(line)
      )
        fence = null;
    }
  }
  return false;
}

function attributesOf(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  for (const match of input.matchAll(pattern)) {
    result[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return result;
}

function identifier(value: string, fallback: string): string {
  return (
    value
      .trim()
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/^-+|-+$/g, '') || fallback
  );
}

function unpackBody(body: string, warnings: string[], title: string) {
  const svgBlocks: string[] = [];
  const cssBlocks: string[] = [];
  // A line scanner allows SVG itself to contain backticks without ending a fence.
  const lines = body.split('\n');
  const prose: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const fence = lines[index].match(/^\s*(`{3,}|~{3,})\s*(svg|css)\b[^\n]*$/i);
    if (!fence) {
      prose.push(lines[index]);
      continue;
    }
    const captured: string[] = [];
    const closer = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
    let closed = false;
    while (++index < lines.length) {
      if (closer.test(lines[index])) {
        closed = true;
        break;
      }
      captured.push(lines[index]);
    }
    if (!closed)
      warnings.push(
        `“${title}”的 ${fence[2].toUpperCase()} 代码块没有结束标记，已读取到片段末尾。`,
      );
    if (fence[2].toLowerCase() === 'svg') svgBlocks.push(captured.join('\n').trim());
    else cssBlocks.push(captured.join('\n').trim());
  }
  let narration = prose.join('\n').trim();
  // Also accept a raw SVG: pasted model output need not have perfect fences.
  narration = narration
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, (svg) => {
      svgBlocks.push(svg);
      return '';
    })
    .trim();
  if (svgBlocks.length > 1)
    warnings.push(`“${title}”含多个 SVG 场景，当前显示最后一个；可拆成多个 :::step 逐段播放。`);
  return { narration, svg: svgBlocks.at(-1) || '', css: cssBlocks.join('\n') };
}

export function parseLesson(source: string): Lesson {
  if (!source.trim())
    throw new Error('讲稿还是空的。写一段文字，或粘贴带 SVG 的 Teacher Markdown。');
  if (source.length > 2_000_000) throw new Error('这份讲稿超过 2 MB，请先按章节拆开。');
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const usesDirectives = hasStepDirectives(lines);
  const warnings: string[] = [];
  const rawSteps: RawStep[] = [];
  const preamble: string[] = [];
  let current: RawStep | null = null;
  let fence: { marker: string; length: number } | null = null;
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (!fence) {
      // Only level-two headings split a simple lesson. Headings in code examples
      // and level-three subheadings are part of the current explanation.
      const heading = !usesDirectives && line.match(/^ {0,3}##[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/);
      if (heading) {
        if (current) rawSteps.push(current);
        current = { attributes: { title: heading[1].trim() }, lines: [] };
        continue;
      }
      const opening = line.match(/^\s*:::step\b(.*)$/);
      if (opening) {
        if (current) {
          rawSteps.push(current);
          warnings.push('一个片段缺少 ::: 结束标记，已在下个片段开始处自动结束。');
        }
        current = { attributes: attributesOf(opening[1]), lines: [] };
        continue;
      }
      if (/^\s*:::\s*$/.test(line) && current) {
        rawSteps.push(current);
        current = null;
        continue;
      }
    }
    if (fenceMatch) {
      const marks = fenceMatch[1];
      if (!fence) fence = { marker: marks[0], length: marks.length };
      else if (
        marks[0] === fence.marker &&
        marks.length >= fence.length &&
        /^\s*[`~]+\s*$/.test(line)
      )
        fence = null;
    }
    if (current) current.lines.push(line);
    else if (!rawSteps.length) preamble.push(line);
  }
  if (current) {
    rawSteps.push(current);
    if (usesDirectives) warnings.push('最后一个片段缺少 ::: 结束标记，已自动补齐。');
  }

  const preambleText = preamble.join('\n');
  const title = preambleText.match(/^#\s+(.+)\s*$/m)?.[1]?.trim() || '一堂新的课';
  const explicitId = normalized.match(/<!--\s*lesson-id\s*:\s*([\w-]+)\s*-->/)?.[1];
  const id = explicitId || identifier(title, 'untitled-lesson');
  const description = preambleText
    .replace(/^#\s+.+$/m, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (!rawSteps.length) {
    // Ordinary Markdown remains playable rather than failing a rigid grammar.
    rawSteps.push({
      attributes: { title: '开始学习' },
      lines: normalized.replace(/^#\s+.+$/m, '').split('\n'),
    });
  }
  const usedIds = new Set<string>();
  let total = 0;
  const steps = rawSteps.map((raw, index): LessonStep => {
    const title = raw.attributes.title || `第 ${index + 1} 步`;
    let stepId = identifier(raw.attributes.id || title, `step-${index + 1}`);
    if (usedIds.has(stepId)) {
      if (usesDirectives) warnings.push(`重复的片段 ID “${stepId}”已添加序号。`);
      stepId = `${stepId}-${index + 1}`;
    }
    while (usedIds.has(stepId)) stepId += '-next';
    usedIds.add(stepId);
    const unpacked = unpackBody(raw.lines.join('\n'), warnings, title);
    const requested = Number.parseFloat(raw.attributes.duration || '');
    const inferred = Math.max(8, Math.min(90, Math.ceil(unpacked.narration.length / 4.5)));
    const duration =
      Number.isFinite(requested) && requested >= 1 ? Math.min(requested, 600) : inferred;
    if (raw.attributes.duration && (!Number.isFinite(requested) || requested < 1)) {
      warnings.push(`“${title}”的时长无效，已按讲稿长度估计。`);
    }
    const result = { id: stepId, title, ...unpacked, duration, start: total };
    total += duration;
    return result;
  });
  return { id, title, description, steps, duration: total, source, warnings };
}

export function locateStep(lesson: Lesson, requestedTime: number) {
  const time = Math.max(
    0,
    Math.min(Number.isFinite(requestedTime) ? requestedTime : 0, lesson.duration),
  );
  let index = lesson.steps.findIndex((step) => time < step.start + step.duration);
  if (index < 0) index = lesson.steps.length - 1;
  const step = lesson.steps[index];
  return { step, index, localTime: Math.max(0, Math.min(time - step.start, step.duration)) };
}

export function getPauseContext(
  lesson: Lesson,
  time: number,
  selection?: SceneSelection | null,
): PauseContext {
  const clamped = Math.max(0, Math.min(Number.isFinite(time) ? time : 0, lesson.duration));
  const { step, index, localTime } = locateStep(lesson, clamped);
  return {
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    stepId: step.id,
    stepTitle: step.title,
    stepIndex: index,
    time: Number(clamped.toFixed(2)),
    localTime: Number(localTime.toFixed(2)),
    currentNarration: step.narration,
    priorTimelineSteps: lesson.steps
      .slice(0, index)
      .map(({ id, title, narration }) => ({ id, title, narration })),
    futureStepIds: lesson.steps.slice(index + 1).map(({ id }) => id),
    selection: selection || null,
    presentationBoundary:
      '课堂按片段显示字幕与板书，语音可选。priorTimelineSteps 仅表示时间线上的先前片段，不表示学生实际观看、听完或掌握。futureStepIds 仅表示时间线后续片段；未记录观看历史，不推断它们是否曾经被回看。当前播放位置、画面和字幕不代表已听到的具体字词。',
  };
}

export function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)
    .toString()
    .padStart(2, '0')}:${(whole % 60).toString().padStart(2, '0')}`;
}
