import assert from 'node:assert/strict';
import test from 'node:test';
import { getPauseContext, locateStep, parseLesson } from './lesson.ts';

const source = `# 平衡与方程
一节测试课。

:::step id="one" title="第一步" duration="10"
先观察等式。
\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg"><text>2x+3=7</text></svg>
\`\`\`
:::

:::step id="two" title="第二步" duration="15"
接下来，两边减去三。
:::
`;

test('parses prose and arbitrary SVG as separate tracks', () => {
  const lesson = parseLesson(source);
  assert.equal(lesson.title, '平衡与方程');
  assert.equal(lesson.description, '一节测试课。');
  assert.equal(lesson.steps.length, 2);
  assert.equal(lesson.duration, 25);
  assert.equal(lesson.steps[1].start, 10);
  assert.equal(lesson.steps[0].narration, '先观察等式。');
  assert.match(lesson.steps[0].svg, /2x\+3=7/);
  assert.equal(lesson.steps[1].svg, '');
});

test('seek boundaries resolve to exactly one step and clamp safely', () => {
  const lesson = parseLesson(source);
  assert.equal(locateStep(lesson, -5).localTime, 0);
  assert.equal(locateStep(lesson, 9.9).index, 0);
  assert.equal(locateStep(lesson, 10).index, 1);
  assert.equal(locateStep(lesson, 10).localTime, 0);
  assert.equal(locateStep(lesson, 500).localTime, 15);
  assert.equal(locateStep(lesson, Number.NaN).index, 0);
});

test('pause context separates timeline positions without claiming viewing evidence', () => {
  const lesson = parseLesson(source);
  const context = getPauseContext(lesson, 4, { id: 'constant', label: '加三' });
  assert.equal(context.priorTimelineSteps.length, 0);
  assert.deepEqual(context.futureStepIds, ['two']);
  assert.equal(context.currentNarration, '先观察等式。');
  assert.equal(context.selection?.id, 'constant');
  assert.doesNotMatch(JSON.stringify(context), /接下来，两边减去三/);
  assert.equal(getPauseContext(lesson, 12).priorTimelineSteps[0].id, 'one');
  assert.match(context.presentationBoundary, /不表示学生实际观看/);
  assert.equal('completedSteps' in context, false);
});

test('accepts ordinary Markdown without directives', () => {
  const lesson = parseLesson('# 自由讲稿\n\n直接从一段说明开始。');
  assert.equal(lesson.steps.length, 1);
  assert.equal(lesson.steps[0].narration, '直接从一段说明开始。');
  assert.ok(lesson.duration > 0);
});

test('turns simple Markdown headings into playable sections with optional SVG', () => {
  const lesson = parseLesson(`# 认识方程

用相等关系寻找未知数。

## 从一个问题开始
一支笔加三元是七元，笔价是多少？

### 想一想
先用自己的话描述数量关系。

## 写成等式
设笔价为 x 元，得到 x + 3 = 7。
\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg"><text>x + 3 = 7</text></svg>
\`\`\`

## 检查结果
把 4 代入，4 + 3 = 7，等式成立。`);
  assert.equal(lesson.description, '用相等关系寻找未知数。');
  assert.deepEqual(
    lesson.steps.map((step) => step.title),
    ['从一个问题开始', '写成等式', '检查结果'],
  );
  assert.match(lesson.steps[0].narration, /### 想一想/);
  assert.equal(lesson.steps[0].svg, '');
  assert.match(lesson.steps[1].svg, /x \+ 3 = 7/);
  assert.doesNotMatch(lesson.steps[1].narration, /<svg/);
  assert.ok(lesson.steps[1].start > 0);
  assert.equal(lesson.warnings.length, 0);
});

test('ignores section headings and directive examples inside fenced code', () => {
  const lesson = parseLesson(`# 写作标记
介绍常用标记。

## 观察例子
\`\`\`markdown
## 这不是课程片段
:::step title="也不是片段"
:::
\`\`\`

## 动手试试
写一个标题。`);
  assert.equal(lesson.steps.length, 2);
  assert.match(lesson.steps[0].narration, /## 这不是课程片段/);
  assert.match(lesson.steps[0].narration, /:::step/);
  assert.equal(lesson.warnings.length, 0);
});

test('assigns stable unique ids to repeated simple section headings', () => {
  const source = '# 复习\n\n## 练一练\n第一题。\n\n## 练一练\n第二题。\n\n## 练一练\n第三题。';
  const lesson = parseLesson(source);
  assert.equal(new Set(lesson.steps.map((step) => step.id)).size, 3);
  assert.deepEqual(
    lesson.steps.map((step) => step.id),
    parseLesson(source).steps.map((step) => step.id),
  );
  assert.deepEqual(lesson.warnings, []);
});

test('keeps legacy directive sections intact when they contain Markdown headings', () => {
  const lesson = parseLesson(
    '# 旧课程\n:::step id="one" title="完整片段"\n## 段内标题\n讲解内容。\n:::',
  );
  assert.equal(lesson.steps.length, 1);
  assert.equal(lesson.steps[0].title, '完整片段');
  assert.match(lesson.steps[0].narration, /## 段内标题/);
  assert.equal(lesson.warnings.length, 0);
});

test('repairs unfinished steps and keeps delimiters inside fences intact', () => {
  const lesson = parseLesson(
    '# 例子\n:::step title="场景"\n```svg\n<svg><text>:::</text></svg>\n```',
  );
  assert.equal(lesson.steps.length, 1);
  assert.match(lesson.steps[0].svg, /:::/);
  assert.ok(lesson.warnings.length);
});

test('normalizes duplicate ids, rejects empty input and estimates invalid duration', () => {
  const lesson = parseLesson(
    '# 课\n:::step id="x" duration="oops"\n一句话。\n:::\n:::step id="x"\n第二句话。\n:::',
  );
  assert.notEqual(lesson.steps[0].id, lesson.steps[1].id);
  assert.equal(lesson.warnings.length, 2);
  assert.throws(() => parseLesson('   '), /讲稿还是空的/);
});
