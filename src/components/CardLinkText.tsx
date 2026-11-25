import React from 'react';
import type { EntityRef } from '../types';

interface CardLinkTextProps {
  text: string;
  onOpenEntity?: (ref: EntityRef) => void;
}

/**
 * 智能富文本渲染器：
 * - 自动解析 **加粗**、`行内代码`、Markdown 锚点 [044](#cognition-044)
 * - 自动识别正文中的 卡片XXX / 认知卡XXX / 冲突XX 并渲染为可点击的双链芯片
 * - 美化逻辑链条中的 → 箭头
 */
export const CardLinkText: React.FC<CardLinkTextProps> = ({ text, onOpenEntity }) => {
  if (!text) return null;

  // 先按加粗、行内代码、Markdown外链、Markdown锚点和卡片引用做单遍切分
  const tokenRe =
    /(\*\*[^*]+\*\*|`[^`]+`|\[([^\]]+)\]\(<?(https?:\/\/[^)>\s]+)>?\)|\[(\d{3})\]\(#(cognition|method)-(\d{3})\)|(?:认知卡|认知)\s*(\d{3})|(?:方法论)?卡片\s*(\d{3})|冲突\s*(\d{1,2}))/g;

  const nodes: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let keyCounter = 0;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(text.slice(lastIdx, match.index));
    }

    const full = match[0];
    if (full.startsWith('**') && full.endsWith('**')) {
      nodes.push(
        <strong key={keyCounter++} style={{ color: 'var(--text)', fontWeight: 700 }}>
          <CardLinkText text={full.slice(2, -2)} onOpenEntity={onOpenEntity} />
        </strong>
      );
    } else if (full.startsWith('`') && full.endsWith('`')) {
      nodes.push(
        <code
          key={keyCounter++}
          className="mono"
          style={{
            background: 'var(--bg-code)',
            padding: '1px 5px',
            borderRadius: 4,
            fontSize: '0.88em',
          }}
        >
          {full.slice(1, -1)}
        </code>
      );
    } else if (match[2] && match[3]) {
      nodes.push(
        <a
          key={keyCounter++}
          href={match[3]}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--navy)', textDecoration: 'underline', textUnderlineOffset: 2 }}
          onClick={(e) => e.stopPropagation()}
        >
          {match[2]}
        </a>
      );
    } else if (match[4] && match[5] && match[6]) {
      const kind = match[5] === 'cognition' ? 'cognition' : 'methodology';
      const id = match[6];
      nodes.push(
        <button
          key={keyCounter++}
          type="button"
          className={`ref-chip ${kind === 'cognition' ? 'ref-chip-cognition' : 'ref-chip-method'}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenEntity?.({ kind, id });
          }}
        >
          {kind === 'cognition' ? `认知 ${id}` : `卡片 ${id}`}
        </button>
      );
    } else if (match[7]) {
      const id = match[7];
      nodes.push(
        <button
          key={keyCounter++}
          type="button"
          className="ref-chip ref-chip-cognition"
          onClick={(e) => {
            e.stopPropagation();
            onOpenEntity?.({ kind: 'cognition', id });
          }}
        >
          认知卡 {id}
        </button>
      );
    } else if (match[8]) {
      const id = match[8];
      nodes.push(
        <button
          key={keyCounter++}
          type="button"
          className="ref-chip ref-chip-method"
          onClick={(e) => {
            e.stopPropagation();
            onOpenEntity?.({ kind: 'methodology', id });
          }}
        >
          卡片 {id}
        </button>
      );
    } else if (match[9]) {
      const id = String(Number(match[9]));
      nodes.push(
        <button
          key={keyCounter++}
          type="button"
          className="ref-chip ref-chip-conflict"
          onClick={(e) => {
            e.stopPropagation();
            onOpenEntity?.({ kind: 'conflict', id });
          }}
        >
          冲突 {id}
        </button>
      );
    }

    lastIdx = tokenRe.lastIndex;
  }

  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx));
  }

  return <>{nodes}</>;
};
