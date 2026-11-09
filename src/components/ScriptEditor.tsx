import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Download,
  FileCode2,
  HelpCircle,
  Play,
  Upload,
  X,
} from 'lucide-react';
import { parseLesson } from '../lib/lesson';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import '../styles/editor.css';

type ScriptEditorProps = {
  open: boolean;
  source: string;
  onClose: () => void;
  onApply: (source: string) => void;
  title?: string;
};

type Preview = ReturnType<typeof parseLesson>;

const SYNTAX_EXAMPLE = `# 一元一次方程

:::step id="balance" title="认识等式" duration="18"
等号两边，始终保持相等。

\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 900 450">
  <text x="450" y="225"
        text-anchor="middle"
        font-size="64">2x + 3 = 7</text>
</svg>
\`\`\`
:::`;

function readableError(error: unknown) {
  return error instanceof Error ? error.message : '无法读取讲稿，请检查步骤标记与代码块。';
}

function formatDuration(seconds: number) {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

function ToolButton({
  label,
  onClick,
  disabled,
  children,
  expanded,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  expanded?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          aria-label={label}
          aria-expanded={expanded}
          onClick={onClick}
          disabled={disabled}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function ScriptEditor({ open, source, onClose, onApply, title }: ScriptEditorProps) {
  const textareaId = useId();
  const [draft, setDraft] = useState(source);
  const [checkedSource, setCheckedSource] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const numbersRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const latest = useRef({ source, onClose, onApply });
  latest.current = { source, onClose, onApply };

  function checkDraft(text: string) {
    try {
      const lesson = parseLesson(text);
      setPreview(lesson);
      setCheckedSource(text);
      setError('');
      return lesson;
    } catch (reason) {
      setError(readableError(reason));
      setPreview(null);
      setCheckedSource(text);
      return null;
    }
  }

  function applyDraft() {
    if (!draft.trim() || !checkDraft(draft)) return;
    try {
      onApply(draft);
      onClose();
    } catch (reason) {
      setError(readableError(reason));
    }
  }

  useEffect(() => {
    if (!open) return;
    const initialSource = latest.current.source;
    setDraft(initialSource);
    checkDraft(initialSource);
    setHelpOpen(false);
  }, [open]);

  async function importFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setError('请选择小于 1 MB 的文本讲稿。');
      return;
    }
    setImporting(true);
    try {
      const text = await file.text();
      setDraft(text);
      checkDraft(text);
      if (textareaRef.current) textareaRef.current.scrollTop = 0;
      if (numbersRef.current) numbersRef.current.style.transform = 'translateY(0)';
    } catch {
      setError('文件读取失败，请重新选择 Markdown 或文本文件。');
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function exportDraft() {
    const blob = new Blob([draft], { type: 'text/markdown;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const lessonName = (preview?.title || 'lesson')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .slice(0, 72);
    anchor.href = objectUrl;
    anchor.download = `${lessonName}.gpt.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  const lineCount = draft.split('\n').length;
  const isDirty = draft !== checkedSource;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        className="ed-modal"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          triggerRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          event.preventDefault();
          textareaRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (triggerRef.current?.isConnected) triggerRef.current.focus();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            applyDraft();
          }
        }}
      >
        <header className="ed-header">
          <div className="ed-title-line">
            <FileCode2 size={20} strokeWidth={1.7} />
            <DialogTitle>{title || '课堂脚本'}</DialogTitle>
            <Badge variant="secondary">Markdown + SVG</Badge>
          </div>
        </header>

        <div className="ed-toolbar">
          <span className="ed-file-name">
            lesson.gpt.md{isDirty && <span className="ed-modified" aria-label="尚未检查的修改" />}
          </span>
          <div className="ed-tools">
            <ToolButton
              label="导入讲稿"
              onClick={() => fileRef.current?.click()}
              disabled={importing}
            >
              <Upload size={18} />
            </ToolButton>
            <ToolButton label="导出讲稿" onClick={exportDraft} disabled={!draft.trim()}>
              <Download size={18} />
            </ToolButton>
            <span className="ed-toolbar-divider" />
            <ToolButton label="检查讲稿" onClick={() => checkDraft(draft)} disabled={!draft.trim()}>
              <Check size={18} />
            </ToolButton>
            <ToolButton label="格式说明" expanded={helpOpen} onClick={() => setHelpOpen(!helpOpen)}>
              <HelpCircle size={18} />
            </ToolButton>
          </div>
        </div>

        <div className="ed-body">
          <section className="ed-source" aria-label="讲稿源码">
            <label className="ed-visually-hidden" htmlFor={textareaId}>
              扩展 Markdown 课堂讲稿
            </label>
            <div className="ed-code-area">
              <div className="ed-gutter" aria-hidden="true">
                <div ref={numbersRef}>
                  {Array.from({ length: lineCount }, (_, index) => (
                    <div key={index}>{index + 1}</div>
                  ))}
                </div>
              </div>
              <textarea
                id={textareaId}
                className="ed-textarea"
                ref={textareaRef}
                value={draft}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                wrap="off"
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError('');
                }}
                onScroll={(event) => {
                  if (numbersRef.current)
                    numbersRef.current.style.transform = `translateY(-${event.currentTarget.scrollTop}px)`;
                }}
                aria-describedby={error ? `${textareaId}-error` : undefined}
              />
            </div>
          </section>

          <aside className="ed-inspector" aria-label="讲稿结构">
            <div className="ed-inspector-heading">
              <span>片段</span>
              {preview && (
                <span>
                  {preview.steps.length} · {formatDuration(preview.duration)}
                </span>
              )}
            </div>
            {preview && (
              <ol className="ed-step-list">
                {preview.steps.map((step, index) => (
                  <li key={`${step.id}-${index}`}>
                    <span className="ed-step-number">{String(index + 1).padStart(2, '0')}</span>
                    <span>{step.title}</span>
                    <span className="ed-step-time">{Math.round(step.duration)}s</span>
                  </li>
                ))}
              </ol>
            )}
            {!!preview?.warnings?.length && (
              <div className="ed-warning">
                <CircleAlert size={17} />
                <div>
                  {preview.warnings.map((warning, index) => (
                    <p key={index}>{warning}</p>
                  ))}
                </div>
              </div>
            )}
          </aside>

          {helpOpen && (
            <section className="ed-help" aria-label="格式说明">
              <div className="ed-help-header">
                <h3>格式说明</h3>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="关闭格式说明"
                  onClick={() => setHelpOpen(false)}
                >
                  <X size={17} />
                </Button>
              </div>
              <p>
                <code>duration</code> 以秒计。每个片段使用完整 SVG，支持原生 SVG 动画与 CSS。
              </p>
              <pre>
                <code>{SYNTAX_EXAMPLE}</code>
              </pre>
            </section>
          )}
        </div>

        {error && (
          <div className="ed-error" role="alert" id={`${textareaId}-error`}>
            <CircleAlert size={18} />
            <span>{error}</span>
          </div>
        )}
        <footer className="ed-footer">
          <div className="ed-footer-status">
            {isDirty ? (
              <>
                <span className="ed-unsaved-dot" />
                已修改
              </>
            ) : preview ? (
              <>
                <CheckCircle2 size={16} />
                检查通过
              </>
            ) : (
              <>
                <FileCode2 size={16} />
                {lineCount} 行
              </>
            )}
          </div>
          <div className="ed-footer-actions">
            <span className="ed-shortcut">
              <kbd>Ctrl</kbd> + <kbd>Enter</kbd>
            </span>
            <Button type="button" onClick={applyDraft} disabled={!draft.trim() || importing}>
              <Play size={16} fill="currentColor" />
              应用
            </Button>
          </div>
        </footer>
        <input
          className="ed-hidden-input"
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.txt,text/plain,text/markdown"
          onChange={(event) => void importFile(event.target.files?.[0])}
          tabIndex={-1}
          aria-hidden="true"
        />
      </DialogContent>
    </Dialog>
  );
}
