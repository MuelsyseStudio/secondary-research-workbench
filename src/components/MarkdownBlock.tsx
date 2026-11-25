import React from 'react';
import type { EntityRef } from '../types';
import { CardLinkText } from './CardLinkText';

interface MarkdownBlockProps {
  content: string;
  onOpenEntity?: (ref: EntityRef) => void;
}

/**
 * 轻量干净的 Markdown 块渲染器（支持标题、表格、无序/有序列表、引用块、分隔线、双链）
 */
export const MarkdownBlock: React.FC<MarkdownBlockProps> = ({ content, onOpenEntity }) => {
  if (!content) return null;

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || /^<a id="[^"]+"><\/a>$/.test(trimmed)) {
      i++;
      continue;
    }

    if (trimmed === '---') {
      elements.push(<div key={key++} className="divider" />);
      i++;
      continue;
    }

    // 标题
    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      const lvl = hMatch[1].length;
      const sizes = [18, 16, 14.5, 13.5];
      elements.push(
        <div
          key={key++}
          style={{
            fontSize: sizes[lvl - 1] || 14,
            fontWeight: 700,
            color: 'var(--text)',
            margin: '14px 0 6px',
            borderBottom: lvl <= 2 ? '1px solid var(--border)' : undefined,
            paddingBottom: lvl <= 2 ? 4 : undefined,
          }}
        >
          <CardLinkText text={hMatch[2]} onOpenEntity={onOpenEntity} />
        </div>
      );
      i++;
      continue;
    }

    // 表格
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      const headerCells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const row = lines[i]
          .trim()
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim());
        bodyRows.push(row);
        i++;
      }
      elements.push(
        <div key={key++} style={{ overflowX: 'auto', margin: '10px 0', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
          <table className="data-table">
            <thead>
              <tr>
                {headerCells.map((hc, ci) => (
                  <th key={ci}>
                    <CardLinkText text={hc} onOpenEntity={onOpenEntity} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci}>
                      <CardLinkText text={cell} onOpenEntity={onOpenEntity} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // 引用块
    if (trimmed.startsWith('>')) {
      const quotes: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quotes.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      elements.push(
        <blockquote
          key={key++}
          style={{
            margin: '8px 0',
            padding: '8px 13px',
            borderLeft: '3px solid var(--navy)',
            background: 'var(--bg-soft)',
            borderRadius: '0 6px 6px 0',
            fontSize: 13,
            color: 'var(--text-secondary)',
          }}
        >
          {quotes.map((q, qi) => (
            <div key={qi}>
              <CardLinkText text={q} onOpenEntity={onOpenEntity} />
            </div>
          ))}
        </blockquote>
      );
      continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items: { indent: number; text: string }[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)[-*]\s+(.*)$/);
        if (m) items.push({ indent: m[1].length, text: m[2] });
        i++;
      }
      elements.push(
        <ul key={key++} style={{ margin: '6px 0 10px', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {items.map((it, idx) => (
            <li
              key={idx}
              style={{
                marginLeft: it.indent >= 2 ? 16 : 0,
                color: 'var(--text-secondary)',
                lineHeight: 1.65,
              }}
            >
              <CardLinkText text={it.text} onOpenEntity={onOpenEntity} />
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      elements.push(
        <ol key={key++} style={{ margin: '6px 0 10px', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {items.map((it, idx) => (
            <li key={idx} style={{ color: 'var(--text-secondary)', lineHeight: 1.65 }}>
              <CardLinkText text={it} onOpenEntity={onOpenEntity} />
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // 普通段落
    elements.push(
      <p key={key++} style={{ margin: '6px 0', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        <CardLinkText text={trimmed} onOpenEntity={onOpenEntity} />
      </p>
    );
    i++;
  }

  return <div>{elements}</div>;
};
