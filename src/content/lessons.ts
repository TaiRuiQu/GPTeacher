import { parseLesson } from '../lib/lesson.ts';

const fence = '```';
const ink = '#18181b';
const wash = '#dbeafe';
const accent = '#2563eb';

function scene(content: string, label: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 450" role="img" aria-label="${label}">
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke="${ink}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>
  <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".7" fill="#e4e4e7" opacity=".55"/></pattern>
</defs>
<style>
  text{font-family:"Hanken Grotesk Variable","Microsoft YaHei",system-ui,sans-serif;fill:${ink}}
  .math{font-family:Georgia,"Times New Roman",serif;font-size:58px}
  .caption{font-size:24px;fill:#71717a}
  .rule{stroke:#e4e4e7;stroke-width:1}
</style>
<rect x="0" y="0" width="900" height="450" fill="#ffffff"/>
<rect x="45" y="167" width="810" height="245" fill="url(#dots)"/>
${content}
</svg>`;
}

const balance = scene(
  `
<g data-topic="variable-term" data-label="2x：两个相同的未知数"><text x="307" y="121" class="math">2x</text></g>
<g data-topic="constant-three" data-label="左边的 +3"><text x="393" y="121" class="math">+ 3</text><path d="M394 135Q438 145 483 134" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round" stroke-dasharray="95" stroke-dashoffset="95"><animate attributeName="stroke-dashoffset" from="95" to="0" begin="1s" dur="1.1s" fill="freeze"/></path></g>
<g data-topic="equal-sign" data-label="等号：左右两边的值相等"><text x="506" y="121" class="math">=</text></g>
<g data-topic="right-seven" data-label="等式右边的 7"><text x="576" y="121" class="math">7</text></g>
<line x1="90" y1="159" x2="810" y2="159" class="rule"/>
<g data-topic="balance-beam" data-label="平衡的天平：两边的总重量相同">
  <path d="M450 230V352M418 366H482M450 225L436 246H464Z" fill="${wash}" stroke="${ink}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
  <g>
    <path d="M240 232H660" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>
    <path d="M240 232L153 307M240 232L342 307M660 232L558 307M660 232L747 307" fill="none" stroke="#a1a1aa" stroke-width="1.5"/>
    <path d="M147 307Q245 337 348 307M552 307Q653 337 753 307" fill="${wash}" stroke="${ink}" stroke-width="2"/>
    <g data-topic="unknown-weights" data-label="两个 x 方块和三个单位砝码">
      <rect x="170" y="268" width="43" height="38" rx="7" fill="${wash}" stroke="#93c5fd"/>
      <rect x="219" y="268" width="43" height="38" rx="7" fill="${wash}" stroke="#93c5fd"/>
      <text x="191" y="293" text-anchor="middle" font-size="23" font-family="Georgia,serif">x</text><text x="240" y="293" text-anchor="middle" font-size="23" font-family="Georgia,serif">x</text>
      <circle cx="282" cy="296" r="8" fill="${accent}"/><circle cx="303" cy="296" r="8" fill="${accent}"/><circle cx="324" cy="296" r="8" fill="${accent}"/>
    </g>
    <g data-topic="seven-weights" data-label="右边的七个单位砝码" fill="${accent}">
      <circle cx="591" cy="296" r="8"/><circle cx="612" cy="296" r="8"/><circle cx="633" cy="296" r="8"/><circle cx="654" cy="296" r="8"/><circle cx="675" cy="296" r="8"/><circle cx="696" cy="296" r="8"/><circle cx="717" cy="296" r="8"/>
    </g>
  </g>
  <g transform="translate(450 232)" aria-hidden="true" pointer-events="none">
    <g>
      <animateTransform attributeName="transform" type="scale" from=".8" to="1" begin=".5s" dur="1.5s" fill="freeze"/>
      <circle r="20" fill="none" stroke="#93c5fd" stroke-width="1.5" opacity=".6"/>
    </g>
  </g>
</g>
<text x="245" y="371" class="caption" text-anchor="middle">2x + 3</text><text x="655" y="371" class="caption" text-anchor="middle">7</text>
`,
  '用平衡天平理解方程 2x 加 3 等于 7',
);

const subtract = scene(
  `
<g data-topic="subtract-equation" data-label="等式两边同时减去 3">
  <text x="170" y="130" class="math" style="font-size:51px">2x + 3 − 3 = 7 − 3</text>
  <path d="M310 142Q376 150 443 142M588 142Q632 150 677 142" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
</g>
<g data-topic="cancel-three" data-label="左边加 3 与减 3 相互抵消">
  <path d="M303 91L445 126" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-dasharray="150" stroke-dashoffset="150"><animate attributeName="stroke-dashoffset" from="150" to="0" begin="1.5s" dur="1s" fill="freeze"/></path>
</g>
<path d="M450 181V233" fill="none" stroke="#a1a1aa" stroke-width="1.5" marker-end="url(#arrow)"/>
<rect x="360" y="194" width="180" height="31" rx="15" fill="#ffffff"/>
<text x="450" y="216" font-size="16" text-anchor="middle">两边同时 −3</text>
<g data-topic="simplified-equation" data-label="化简后得到 2x 等于 4" opacity="0">
 <animate attributeName="opacity" from="0" to="1" begin="3s" dur=".6s" fill="freeze"/>
 <text x="450" y="326" class="math" text-anchor="middle">2x = 4</text>
 <path d="M340 344H560" stroke="${wash}" stroke-width="14" stroke-linecap="round"/>
</g>
`,
  '等式两边减去三后，得到二 x 等于四',
);

const divide = scene(
  `
<g data-topic="divide-left" data-label="左边 2x 除以 2，只剩 x">
 <text x="337" y="112" class="math" text-anchor="middle">2x</text><path d="M294 128H381" stroke="${ink}" stroke-width="2"/><text x="337" y="185" class="math" text-anchor="middle">2</text>
</g>
<text x="450" y="143" class="math" text-anchor="middle">=</text>
<g data-topic="divide-right" data-label="右边 4 除以 2，等于 2">
 <text x="562" y="112" class="math" text-anchor="middle">4</text><path d="M526 128H598" stroke="${ink}" stroke-width="2"/><text x="562" y="185" class="math" text-anchor="middle">2</text>
</g>
<path d="M450 217V257" fill="none" stroke="#a1a1aa" stroke-width="1.5" marker-end="url(#arrow)"/>
<text x="585" y="242" font-size="16" fill="#71717a">两边同时 ÷2</text>
<g data-topic="solution" data-label="方程的解是 x 等于 2" opacity="0">
 <animate attributeName="opacity" from="0" to="1" begin="2s" dur=".7s" fill="freeze"/>
 <rect x="329" y="278" width="242" height="87" rx="14" fill="${wash}"/>
 <text x="450" y="340" class="math" text-anchor="middle">x = 2</text>
</g>
`,
  '等式两边除以二，得到 x 等于二',
);

const verify = scene(
  `
<g data-topic="answer" data-label="求出的解 x 等于 2"><text x="450" y="122" class="math" text-anchor="middle">x = 2</text></g>
<line x1="90" y1="160" x2="810" y2="160" class="rule"/>
<text x="450" y="218" class="caption" text-anchor="middle">代回原来的方程</text>
<g data-topic="substitution" data-label="代入验证：二乘二加三等于七">
 <text x="450" y="299" class="math" text-anchor="middle" style="font-size:53px">2 × 2 + 3 = 7</text>
</g>
<g opacity="0"><animate attributeName="opacity" from="0" to="1" begin="2s" dur=".5s" fill="freeze"/>
 <circle cx="397" cy="363" r="16" fill="${wash}"/>
 <path d="M389 363L395 369L406 356" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
 <text x="427" y="370" font-size="18">左右相等，解成立</text>
</g>
`,
  '把 x 等于二代回原式，验证左右相等',
);

function movingBlock(
  x: number,
  y: number,
  mass: string,
  force: string,
  distance: number,
  duration: number,
  arrowLength = 118,
  id = 'block',
) {
  return `<g data-topic="${id}" data-label="质量 ${mass} 千克，水平外力 ${force} 牛顿">
  <animateTransform attributeName="transform" type="translate" from="0 0" to="${distance} 0" begin="1s" dur="${duration}s" calcMode="spline" keyTimes="0;1" keySplines=".55 0 1 .6" fill="freeze"/>
  <rect x="${x}" y="${y}" width="92" height="66" rx="10" fill="${wash}" stroke="#93c5fd" stroke-width="1.4"/>
  <text x="${x + 46}" y="${y + 39}" text-anchor="middle" font-size="22" style="font-family:Georgia,serif">${mass} kg</text>
  <path d="M${x + 94} ${y + 32}H${x + 94 + arrowLength}" fill="none" stroke="${ink}" stroke-width="2.5" marker-end="url(#arrow)"/>
  <text x="${x + 101 + arrowLength / 2}" y="${y + 12}" text-anchor="middle" font-size="17">F = ${force} N</text>
</g>`;
}

const force = scene(
  `
<g data-topic="newton-formula" data-label="牛顿第二定律：合力等于质量乘以加速度"><text x="450" y="124" class="math" text-anchor="middle">F = ma</text></g>
<line x1="90" y1="162" x2="810" y2="162" class="rule"/>
<path d="M165 317H762" fill="none" stroke="#a1a1aa" stroke-width="1.5"/>
${movingBlock(258, 249, '2', '4', 120, 12, 118, 'force-mass-block')}
<g data-topic="acceleration" data-label="由 a 等于 F 除以 m，求得加速度二米每二次方秒">
 <text x="450" y="383" text-anchor="middle" font-size="23" style="font-family:Georgia,serif">a = F / m = 2 m/s²</text>
</g>
`,
  '用受到水平合力的滑块理解牛顿第二定律',
);

const moreForce = scene(
  `
<text x="450" y="107" class="math" text-anchor="middle" style="font-size:46px">F ↑　→　a ↑</text>
<text x="106" y="219" class="caption">m = 2 kg</text>
<path d="M224 248H777" fill="none" stroke="#a1a1aa" stroke-width="1.5"/>
${movingBlock(261, 181, '2', '4', 110, 13, 96, 'force-four')}
<text x="106" y="345" class="caption">m = 2 kg</text>
<path d="M224 374H777" fill="none" stroke="#a1a1aa" stroke-width="1.5"/>
${movingBlock(261, 307, '2', '8', 170, 9, 158, 'force-eight')}
`,
  '相同质量的滑块在不同合力下，加速度随合力增大',
);

const moreMass = scene(
  `
<text x="450" y="107" class="math" text-anchor="middle" style="font-size:46px">m ↑　→　a ↓</text>
<text x="106" y="219" class="caption">F = 4 N</text>
<path d="M224 248H777" fill="none" stroke="#a1a1aa" stroke-width="1.5"/>
${movingBlock(261, 181, '2', '4', 170, 9, 118, 'mass-two')}
<text x="106" y="345" class="caption">F = 4 N</text>
<path d="M224 374H777" fill="none" stroke="#a1a1aa" stroke-width="1.5"/>
${movingBlock(261, 307, '4', '4', 90, 13, 118, 'mass-four')}
`,
  '相同合力下质量增大，加速度减小',
);

const physicsCheck = scene(
  `
<text x="450" y="112" class="math" text-anchor="middle" style="font-size:48px">F = 6 N　　m = 3 kg</text>
<line x1="90" y1="161" x2="810" y2="161" class="rule"/>
<g data-topic="physics-question" data-label="当合力六牛顿，质量三千克时，加速度是多少？"><text x="450" y="262" class="math" text-anchor="middle">a = ?</text></g>
<g opacity="0" data-topic="physics-answer" data-label="加速度是二米每二次方秒">
 <animate attributeName="opacity" from="0" to="1" begin="7s" dur=".6s" fill="freeze"/>
 <rect x="273" y="300" width="354" height="67" rx="12" fill="${wash}"/>
 <text x="450" y="346" text-anchor="middle" font-size="30" style="font-family:Georgia,serif">a = 6 / 3 = 2 m/s²</text>
</g>
`,
  '给定合力六牛顿，质量三千克，检验能否求出加速度',
);

function step(id: string, title: string, duration: number, narration: string, svg: string) {
  return `:::step id="${id}" title="${title}" duration="${duration}"
${narration}

${fence}svg
${svg}
${fence}
:::`;
}

export const lessonSources = [
  {
    id: 'linear-equations',
    title: '一元一次方程',
    subject: '数学',
    subtitle: '从平衡，到解开方程',
    source: `# 从平衡，到解开方程
<!-- lesson-id: linear-equations -->
用等式的性质，理解每一次变形。

${step('balance', '认识等式', 18, '等式就像一架平衡的天平。左边是两个 x 加三，右边是七。我们的目标，是让未知数 x 单独留下来，同时始终保持两边相等。', balance)}

${step('subtract', '两边同时减 3', 22, '先去掉左边的加三。为了保持平衡，我们在等式两边同时减去三。左边加三和减三相互抵消，右边七减三等于四，于是得到 **2x = 4**。', subtract)}

${step('divide', '两边同时除以 2', 18, '现在，两个相同的 x 加起来等于四。我们把等式两边同时除以二，左边只剩一个 x，右边是四除以二，所以 **x = 2**。', divide)}

${step('verify', '带回原式验证', 16, '最后把 x 等于二代回原来的方程：二乘二加三，确实等于七。解方程的每一步都在保持相等。接下来，你可以试着独立解出 **3x + 2 = 11**。', verify)}
`,
  },
  {
    id: 'newtons-law',
    title: '牛顿第二定律',
    subject: '物理',
    subtitle: '看见力，理解运动的改变',
    source: `# 看见力，理解运动的改变
<!-- lesson-id: newtons-law -->
用一个滑块，理解合力、质量与加速度的关系。

${step('force', '力与运动的改变', 20, '这里是一个光滑水平面上的滑块，竖直方向的支持力与重力相互平衡，水平方向只有恒定合力。牛顿第二定律说 **F = ma**。四牛顿的合力作用在两千克的滑块上，产生二米每二次方秒的加速度。', force)}

${step('more-force', '质量不变，改变力', 20, '先保持两个滑块的质量相同。下面的滑块受到八牛顿的合力，是上面四牛顿的两倍。根据 **a = F / m**，合力加倍，加速度也加倍。图中的位移用于示意加速的差异，并非按真实比例计时。', moreForce)}

${step('more-mass', '合力不变，改变质量', 20, '这次给两个滑块相同的水平合力，下面的滑块质量加倍。因为 **a = F / m**，在合力不变时，质量越大，加速度越小；质量加倍，加速度减半。', moreMass)}

${step('physics-check', '独立检验一下', 18, '轮到你试一试：光滑水平面上，一个三千克的物体受到六牛顿的水平合力，它的加速度是多少？可以先暂停想一想，再用 **a = F / m** 检查自己的答案。', physicsCheck)}
`,
  },
];

export const demoLessons = lessonSources.map(({ id, source }) => ({ ...parseLesson(source), id }));
