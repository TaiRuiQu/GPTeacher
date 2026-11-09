import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(source, { async: false }) as string, {
        FORBID_TAGS: [
          'iframe',
          'style',
          'script',
          'form',
          'input',
          'button',
          'svg',
          'img',
          'video',
          'audio',
          'object',
          'embed',
        ],
        FORBID_ATTR: ['style', 'target'],
      }),
    [source],
  );
  return (
    <div className={`markdown-content ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
