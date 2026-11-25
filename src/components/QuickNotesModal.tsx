import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, BookOpen, CalendarClock, Copy, Lightbulb, Plus, StickyNote, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';

export interface QuickNoteItem {
  id: string;
  createdAt: string;
  updatedAt: string;
  symbol: string;
  symbolName: string;
  tag: string;
  text: string;
  convertedTo?: string | null;
}

interface QuickNotesModalProps {
  open: boolean;
  defaultSymbol?: string;
  defaultSymbolName?: string;
  onClose: () => void;
  onConvertToDraft: (target: 'cognition' | 'method' | 'judgment', note: QuickNoteItem) => void;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

const NOTE_TAGS: { id: string; zh: string; en: string }[] = [
  { id: '盘中灵感', zh: '盘中灵感', en: 'Intraday Idea' },
  { id: '异动记录', zh: '异动记录', en: 'Tape Move' },
  { id: '风控自省', zh: '风控自省', en: 'Risk Check' },
  { id: '产业线索', zh: '产业线索', en: 'Industry Cue' },
  { id: '竞价观察', zh: '竞价观察', en: 'Auction Note' },
];

export const QuickNotesModal: React.FC<QuickNotesModalProps> = ({
  open,
  defaultSymbol = '',
  defaultSymbolName = '',
  onClose,
  onConvertToDraft,
  onToast,
}) => {
  const { t } = useI18n();
  const [items, setItems] = useState<QuickNoteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [symbol, setSymbol] = useState('');
  const [tag, setTag] = useState('盘中灵感');
  const [text, setText] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listQuickNotes();
      setItems(res.items || []);
    } catch (err: any) {
      onToast(`${t('加载速记失败：', 'Failed to load notes: ')}${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast, t]);

  // 每次打开或当前盘内标的切换时同步最新活跃标的（不再锁死旧标的）
  useEffect(() => {
    if (open) {
      load();
      if (defaultSymbol) {
        const cleanCode = defaultSymbol.replace(/^\d+\./, '');
        setSymbol(defaultSymbolName ? `${defaultSymbolName} (${cleanCode})` : cleanCode);
      } else {
        setSymbol('');
      }
    }
  }, [open, load, defaultSymbol, defaultSymbolName]);

  if (!open) return null;

  const handleAdd = async () => {
    if (!text.trim()) {
      onToast(t('请输入速记内容', 'Please enter a note'), 'warning');
      return;
    }
    setSaving(true);
    try {
      const res = await api.addQuickNote({
        text: text.trim(),
        symbol: symbol.trim(),
        symbolName: defaultSymbolName || '',
        tag,
      });
      setItems(res.items || []);
      setText('');
      onToast(t('已保存闪念速记至本机 quick-notes.local.json', 'Quick note saved locally'), 'success');
    } catch (err: any) {
      onToast(`${t('保存速记失败：', 'Failed to save note: ')}${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await api.deleteQuickNote(id);
      setItems(res.items || []);
      onToast(t('已删除该条速记', 'Note deleted'), 'info');
    } catch (err: any) {
      onToast(`${t('删除失败：', 'Delete failed: ')}${err.message}`, 'error');
    }
  };

  const handleCopyOnly = async (note: QuickNoteItem) => {
    const formatted = [
      `[${note.tag}]${note.symbol ? ` ${note.symbol}` : ''} (${note.createdAt.slice(0, 19).replace('T', ' ')})`,
      note.text,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(formatted);
      onToast(t('已复制闪念正文到剪贴板', 'Copied note text to clipboard'), 'success');
    } catch {
      onToast(t('剪贴板受限，复制失败，请手动选中文本复制', 'Clipboard access denied — please copy manually'), 'error');
    }
  };

  // 直接把闪念标的与正文注入目标三库草稿表单；仅在目标草稿确认接收后由 App 登记 converted 状态
  const handleConvert = (note: QuickNoteItem, target: 'cognition' | 'method' | 'judgment') => {
    onConvertToDraft(target, note);
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('盘中闪念速记本', 'Intraday Quick Notes')}
      onClick={onClose}
    >
      <div className="modal-box" style={{ maxWidth: 700 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StickyNote size={18} color="var(--amber)" />
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                {t('盘中闪念速记本', 'Intraday Quick Notes')}{' '}
                <span className="kbd mono" style={{ fontSize: 10.5 }}>Ctrl+Shift+N</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                {t(
                  '自动绑定当前盘内标的 · 盘后一键将正文与标的直接预填进三库草稿表单',
                  'Auto-binds active tape symbol · Prefills note body & symbol directly into 3-library draft forms'
                )}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={t('关闭弹窗', 'Close dialog')}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="field-block" style={{ marginBottom: 0, background: 'var(--bg-soft)' }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                className="input mono"
                style={{ width: 210, fontSize: 12 }}
                placeholder={t('关联标的（可选，如 600519 / NVDA）', 'Symbol (optional, e.g. 600519 / NVDA)')}
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {NOTE_TAGS.map((tg) => (
                  <button
                    key={tg.id}
                    type="button"
                    className={`btn btn-sm ${tag === tg.id ? 'btn-primary' : ''}`}
                    style={{ padding: '2px 8px', fontSize: 11 }}
                    onClick={() => setTag(tg.id)}
                  >
                    {t(tg.zh, tg.en)}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              className="textarea"
              rows={3}
              autoFocus
              placeholder={t(
                '记录盘口异动、证伪信号、情绪转折或产业线索…（Ctrl+Enter 快速保存）',
                'Jot down tape notes, falsification signals or thesis cues… (Ctrl+Enter to save)'
              )}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleAdd();
                }
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={saving || !text.trim()} onClick={handleAdd}>
                <Plus size={13} /> {saving ? t('保存中...', 'Saving...') : t('存入速记本 (Ctrl+Enter)', 'Save Note (Ctrl+Enter)')}
              </button>
            </div>
          </div>

          <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {loading && items.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20, fontSize: 12.5 }}>
                {t('正在读取速记记录...', 'Loading notes...')}
              </div>
            ) : items.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24, fontSize: 12.5 }}>
                {t('暂无盘中速记，随时按 Ctrl+Shift+N 记录你的第一条交易灵感。', 'No notes yet. Press Ctrl+Shift+N anytime to capture an idea.')}
              </div>
            ) : (
              items.map((n) => {
                const tagDef = NOTE_TAGS.find((x) => x.id === n.tag);
                return (
                  <div
                    key={n.id}
                    style={{
                      padding: '9px 11px',
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'var(--bg-elev)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span className="badge badge-amber" style={{ fontSize: 10.5 }}>
                          {tagDef ? t(tagDef.zh, tagDef.en) : n.tag}
                        </span>
                        {n.symbol && <span className="badge badge-navy mono" style={{ fontSize: 10.5 }}>{n.symbol}</span>}
                        {n.convertedTo && (
                          <span className="badge badge-emerald" style={{ fontSize: 10 }}>
                            {t(
                              `已转入${n.convertedTo === 'cognition' ? '认知' : n.convertedTo === 'method' ? '方法论' : '台账'}`,
                              `Sent to ${n.convertedTo === 'cognition' ? 'Intel' : n.convertedTo === 'method' ? 'Rules' : 'Ledger'}`
                            )}
                          </span>
                        )}
                        <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {n.createdAt.slice(0, 16).replace('T', ' ')}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: '2px 5px' }}
                          onClick={() => handleCopyOnly(n)}
                          title={t('复制正文', 'Copy text')}
                        >
                          <Copy size={12} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: '2px 5px' }}
                          onClick={() => handleDelete(n.id)}
                          title={t('删除', 'Delete')}
                        >
                          <Trash2 size={12} color="var(--crimson)" />
                        </button>
                      </div>
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{n.text}</div>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 11, padding: '2px 7px' }}
                        onClick={() => handleConvert(n, 'cognition')}
                      >
                        <Lightbulb size={11} color="var(--teal)" /> {t('预填到认知卡草稿', 'Prefill Intel Draft')} <ArrowRight size={10} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 11, padding: '2px 7px' }}
                        onClick={() => handleConvert(n, 'method')}
                      >
                        <BookOpen size={11} color="var(--navy)" /> {t('预填到方法论草稿', 'Prefill Rule Draft')} <ArrowRight size={10} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 11, padding: '2px 7px' }}
                        onClick={() => handleConvert(n, 'judgment')}
                      >
                        <CalendarClock size={11} color="var(--amber)" /> {t('预填到台账研判', 'Prefill Thesis Draft')} <ArrowRight size={10} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
