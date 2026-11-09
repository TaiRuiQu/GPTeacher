import { useState } from 'react';
import { Check, Copy, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ApiDiagnostics } from '../lib/api';
import '../styles/diagnostics.css';

type Props = {
  message: string;
  diagnostics?: ApiDiagnostics;
  onConfigure?: () => void;
};

function diagnosticText(message: string, diagnostics: ApiDiagnostics) {
  const lines = [
    message,
    `HTTP: ${diagnostics.upstreamStatus}`,
    diagnostics.transport && `协议: ${diagnostics.transport}`,
    diagnostics.endpoint && `请求地址: ${diagnostics.endpoint}`,
    diagnostics.model && `模型: ${diagnostics.model}`,
    diagnostics.providerCode !== undefined && `错误代码: ${diagnostics.providerCode}`,
    diagnostics.providerType && `错误类型: ${diagnostics.providerType}`,
    diagnostics.providerMessage && `服务商消息: ${diagnostics.providerMessage}`,
    diagnostics.requestId && `Request ID: ${diagnostics.requestId}`,
    diagnostics.contentType && `Content-Type: ${diagnostics.contentType}`,
    '',
    '服务商响应正文（密钥已脱敏）:',
    diagnostics.responseBody || '（没有响应正文）',
    diagnostics.truncated && '\n（正文较长，仅显示前 16 KB）',
  ];
  return lines.filter((line) => line !== false && line !== undefined).join('\n');
}

/** Provider output is plain text so JSON and gateway HTML remain useful without executing markup. */
export function ErrorDetails({ message, diagnostics, onConfigure }: Props) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const text = diagnostics ? diagnosticText(message, diagnostics) : message;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  }

  return (
    <div className="error-details" role="alert">
      <p className="error-details-message">{message}</p>
      {onConfigure && (
        <Button type="button" variant="ghost" size="sm" onClick={onConfigure}>
          <Settings2 size={15} />
          检查配置
        </Button>
      )}
      {diagnostics && (
        <details className="error-details-disclosure">
          <summary>查看服务商错误详情</summary>
          <pre tabIndex={0}>{text}</pre>
          <div className="error-details-actions">
            <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
              {copyStatus === 'copied' ? <Check size={14} /> : <Copy size={14} />}
              {copyStatus === 'copied' ? '已复制诊断' : '复制诊断信息'}
            </Button>
            {copyStatus === 'error' && (
              <span role="status">无法复制，请选择上方文字手动复制。</span>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
