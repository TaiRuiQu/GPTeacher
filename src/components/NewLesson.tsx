import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Code2, LoaderCircle, Settings2, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { lessonSources } from '../content/lessons';
import { ApiError, apiJson, type ApiDiagnostics } from '../lib/api';
import { ErrorDetails } from './ErrorDetails';
import { parseLesson } from '../lib/lesson';
import type { ModelSettingsValue } from '../lib/settings';

type Props = {
  settings: ModelSettingsValue['text'];
  onCreated: (source: string) => void;
  onSelectDemo: (id: string) => void;
  onEdit: () => void;
  onConfigure: () => void;
};

export function NewLesson({ settings, onCreated, onSelectDemo, onEdit, onConfigure }: Props) {
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('零基础，用中文讲解');
  const [duration, setDuration] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [diagnostics, setDiagnostics] = useState<ApiDiagnostics>();
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);

  function cancel(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    controllerRef.current?.abort();
    controllerRef.current = null;
    setBusy(false);
    setError('已取消生成，可以修改主题后重试。');
    setDiagnostics(undefined);
  }

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (!topic.trim() || busy) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError('');
    setDiagnostics(undefined);
    try {
      const result = await apiJson<{ source: string }>(
        '/api/lesson',
        { settings, topic: topic.trim(), audience: audience.trim(), durationMinutes: duration },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (typeof result.source !== 'string') throw new Error('服务没有返回有效课程，请重试。');
      parseLesson(result.source);
      onCreated(result.source);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '生成失败，请稍后重试。');
        setDiagnostics(reason instanceof ApiError ? reason.diagnostics : undefined);
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <div className="new-lesson-content">
      <form className="generate-form" onSubmit={generate} aria-busy={busy}>
        <div className="generate-field">
          <Label htmlFor="course-topic">想学习什么？</Label>
          <Textarea
            id="course-topic"
            placeholder="例如：用生活中的例子讲清楚贝叶斯定理"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            maxLength={800}
            rows={3}
            required
            disabled={busy}
          />
        </div>
        <div className="generate-details">
          <div className="generate-field">
            <Label htmlFor="course-audience">学习基础与要求</Label>
            <Input
              id="course-audience"
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
              maxLength={200}
              disabled={busy}
            />
          </div>
          <div className="generate-field">
            <Label htmlFor="course-duration">预计分钟数</Label>
            <Input
              id="course-duration"
              type="number"
              min={1}
              max={30}
              step={1}
              value={duration}
              onChange={(event) => setDuration(Number(event.target.value))}
              required
              disabled={busy}
            />
          </div>
        </div>
        {error && <ErrorDetails message={error} diagnostics={diagnostics} />}
        {busy && (
          <p className="flow-status" role="status">
            <LoaderCircle size={17} className="is-spinning" />
            正在生成讲稿、板书与练习，通常需要几十秒…
          </p>
        )}
        <div className="generate-actions">
          <Button type="button" variant="ghost" onClick={onConfigure} disabled={busy}>
            <Settings2 size={17} />
            配置教学模型
          </Button>
          {busy ? (
            <Button key="cancel" type="button" variant="outline" onClick={cancel}>
              <X size={17} />
              取消生成
            </Button>
          ) : (
            <Button key="generate" type="submit" disabled={!topic.trim()}>
              <Sparkles size={17} />
              生成课程
            </Button>
          )}
        </div>
      </form>
      <div className="new-course-divider">也可以打开示例课</div>
      <div className="new-course-options">
        {lessonSources.map((item, index) => (
          <button key={item.id} onClick={() => onSelectDemo(item.id)} disabled={busy}>
            <div className="new-course-illustration">
              <span>{index === 0 ? '2x + 3 = 7' : 'F = ma'}</span>
            </div>
            <div className="new-course-title">
              <span>{item.title}</span>
              <ArrowUpRight size={19} />
            </div>
          </button>
        ))}
      </div>
      <Button variant="outline" className="create-script-button" onClick={onEdit} disabled={busy}>
        <Code2 size={19} />
        手动创建课堂脚本
      </Button>
    </div>
  );
}
