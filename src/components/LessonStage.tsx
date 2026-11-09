import { useCallback, useEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import type { LessonStep, SceneSelection } from '../lib/lesson';

export interface LessonStageProps {
  step: LessonStep;
  time: number;
  selectedId?: string | null;
  onSelect: (selection: SceneSelection) => void;
  className?: string;
}

function cleanCss(css: string) {
  return css
    .replace(/@import\s+[^;]+;?/gi, '')
    .replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (_whole, _quote, target: string) =>
      target.startsWith('#') ? `url(${target})` : 'none',
    )
    .replace(/<\/style/gi, '<\\/style');
}

/** Rich vector markup and native animation are welcome; executable code is not. */
export function sanitizeLessonSvg(input: string) {
  const cleaned = DOMPurify.sanitize(input, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['animate', 'animateMotion', 'animateTransform', 'mpath', 'set', 'style'],
    ADD_ATTR: [
      'attributeName',
      'attributeType',
      'begin',
      'end',
      'dur',
      'repeatCount',
      'repeatDur',
      'values',
      'from',
      'to',
      'by',
      'keyTimes',
      'keySplines',
      'keyPoints',
      'calcMode',
      'additive',
      'accumulate',
      'path',
      'rotate',
      'type',
      'fill',
      'data-label',
      'data-topic',
      'data-object',
      'tabindex',
      'role',
      'aria-label',
    ],
    FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video'],
    FORBID_ATTR: ['srcdoc', 'target'],
    ALLOW_DATA_ATTR: true,
  });
  const document = new DOMParser().parseFromString(cleaned, 'image/svg+xml');
  const svg = document.documentElement;
  if (svg.localName !== 'svg' || document.querySelector('parsererror')) return '';
  for (const element of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on') || name === 'src' || name === 'srcset')
        element.removeAttribute(attribute.name);
      else if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#'))
        element.removeAttribute(attribute.name);
      else if (name === 'style') element.setAttribute(attribute.name, cleanCss(value));
      else if (
        Array.from(value.matchAll(/url\(\s*(?:'([^']*)'|"([^"]*)"|([^)]*))\s*\)/gi)).some(
          (match) => !(match[1] || match[2] || match[3] || '').trim().startsWith('#'),
        )
      )
        element.removeAttribute(attribute.name);
    }
    if (
      ['animate', 'animatetransform', 'animatemotion', 'set'].includes(
        element.localName.toLowerCase(),
      )
    ) {
      const attribute = element.getAttribute('attributeName') || '';
      if (/^(?:on|href|xlink:href|src|style)/i.test(attribute)) element.remove();
    }
    if (element.localName === 'style') element.textContent = cleanCss(element.textContent || '');
  }
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  return new XMLSerializer().serializeToString(svg);
}

const frameStyle = `
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
  body{display:grid;place-items:center;font-family:"Hanken Grotesk Variable","Microsoft YaHei",system-ui,sans-serif;color:#18181b}
  svg{display:block;width:100%;height:100%}
  [data-topic],[data-label],[data-object]{cursor:pointer}
  [data-topic]:focus-visible,[data-label]:focus-visible,[data-object]:focus-visible{outline:none;filter:drop-shadow(0 0 4px #93c5fd)}
  .stage-selection{fill:#dbeafe;fill-opacity:.23;stroke:#2563eb;stroke-width:1.5;stroke-dasharray:5 5;rx:9;pointer-events:none}
`;

export function LessonStage({
  step,
  time,
  selectedId,
  onSelect,
  className = '',
}: LessonStageProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const currentRef = useRef({ time, selectedId, onSelect });
  currentRef.current = { time, selectedId, onSelect };
  const svg = useMemo(() => sanitizeLessonSvg(step.svg), [step.svg]);
  const source = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><style>${frameStyle}\n${cleanCss(step.css || '')}</style></head><body>${svg || '<div style="text-align:center;padding:24px;color:#71717a">跟着讲解，慢慢理解。</div>'}</body></html>`,
    [svg, step.css],
  );

  const synchronize = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const current = currentRef.current;
    try {
      svg.pauseAnimations?.();
      svg.setCurrentTime?.(Math.max(0, current.time));
      for (const animation of svg.ownerDocument.getAnimations()) {
        animation.pause();
        animation.currentTime = current.time * 1000;
      }
    } catch {
      /* The static SVG remains useful on engines without SMIL support. */
    }
    svg.querySelector('[data-stage-selection]')?.remove();
    if (!current.selectedId) return;
    const target = Array.from(
      svg.querySelectorAll<SVGGraphicsElement>('[data-topic],[data-object],[id]'),
    ).find(
      (node) =>
        (node.getAttribute('data-topic') || node.getAttribute('data-object') || node.id) ===
        current.selectedId,
    );
    if (!target || !target.getBoundingClientRect || !svg.getScreenCTM()) return;
    const bounds = target.getBoundingClientRect();
    const inverse = svg.getScreenCTM()!.inverse();
    const first = svg.createSVGPoint();
    const last = svg.createSVGPoint();
    first.x = bounds.left;
    first.y = bounds.top;
    last.x = bounds.right;
    last.y = bounds.bottom;
    const a = first.matrixTransform(inverse);
    const b = last.matrixTransform(inverse);
    if (!Number.isFinite(a.x + a.y + b.x + b.y)) return;
    const rect = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('data-stage-selection', '');
    rect.setAttribute('class', 'stage-selection');
    rect.setAttribute('x', String(a.x - 9));
    rect.setAttribute('y', String(a.y - 8));
    rect.setAttribute('width', String(Math.max(0, b.x - a.x) + 18));
    rect.setAttribute('height', String(Math.max(0, b.y - a.y) + 16));
    rect.setAttribute('rx', '9');
    rect.setAttribute('aria-hidden', 'true');
    svg.append(rect);
  }, []);

  const initialize = useCallback(() => {
    cleanupRef.current?.();
    const document = frameRef.current?.contentDocument;
    const svg = document?.querySelector('svg') as SVGSVGElement | null;
    svgRef.current = svg;
    if (!document || !svg) return;
    const choose = (event: Event) => {
      if (event.type === 'keydown' && !['Enter', ' '].includes((event as KeyboardEvent).key))
        return;
      const node = (event.target as Element | null)?.closest(
        '[data-topic],[data-label],[data-object]',
      );
      if (!node || !svg.contains(node)) {
        if ((event.target as Element | null)?.closest('a')) event.preventDefault();
        return;
      }
      event.preventDefault();
      const id = node.getAttribute('data-topic') || node.getAttribute('data-object') || node.id;
      if (!id) return;
      const label =
        node.getAttribute('data-label') ||
        node.textContent?.replace(/\s+/g, ' ').trim().slice(0, 100) ||
        id;
      currentRef.current.onSelect({ id, label });
    };
    for (const node of svg.querySelectorAll('[data-topic],[data-label],[data-object]')) {
      node.setAttribute('tabindex', '0');
      node.setAttribute('role', 'button');
      node.setAttribute(
        'aria-label',
        node.getAttribute('data-label') || node.textContent?.trim().slice(0, 100) || '选择板书对象',
      );
    }
    document.addEventListener('click', choose);
    document.addEventListener('keydown', choose);
    cleanupRef.current = () => {
      document.removeEventListener('click', choose);
      document.removeEventListener('keydown', choose);
    };
    synchronize();
  }, [synchronize]);

  useEffect(() => synchronize(), [time, selectedId, synchronize]);
  useEffect(
    () => () => {
      cleanupRef.current?.();
      svgRef.current = null;
    },
    [],
  );

  return (
    <div className={`lesson-stage ${className}`}>
      <iframe
        ref={frameRef}
        title={`${step.title} · 可交互板书`}
        sandbox="allow-same-origin"
        srcDoc={source}
        onLoad={initialize}
        style={{ width: '100%', aspectRatio: '2 / 1', border: 0, display: 'block' }}
      />
      {step.svg && !svg && (
        <p className="stage-warning" role="status">
          这段 SVG 暂时无法显示，你仍然可以阅读讲解或修改讲稿。
        </p>
      )}
    </div>
  );
}

export default LessonStage;
