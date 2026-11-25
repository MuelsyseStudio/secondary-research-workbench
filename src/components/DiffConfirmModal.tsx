import React from 'react';
import { AlertTriangle, CheckCircle2, FileDiff, ShieldCheck, X } from 'lucide-react';
import type { MutationPreview } from '../types';
import { useI18n } from '../i18n';

interface DiffConfirmModalProps {
  preview: MutationPreview | null;
  committing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 确认门模态框（Confirmation Gate）
 * 严格遵循《三库格式契约》：所有写库前先展示变更摘要、版本号变化与行级 Diff，确认后原子备份再落盘。
 */
export const DiffConfirmModal: React.FC<DiffConfirmModalProps> = ({
  preview,
  committing,
  onCancel,
  onConfirm,
}) => {
  const { t } = useI18n();
  if (!preview) return null;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <FileDiff size={19} color="var(--navy)" />
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{t('三库写回确认门（变更预览）', 'Write Confirmation Gate (Diff Preview)')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t(
                  '落盘前将自动对受影响的现行三库原件创建时间戳快照备份，支持随时一键回滚',
                  'An atomic timestamped snapshot is automatically created before writing; rollback is always one click away.'
                )}
              </div>
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {!preview.ok && (
            <div
              className="field-block field-block-danger"
              style={{ marginBottom: 14 }}
            >
              <div className="field-block-label" style={{ color: 'var(--crimson)' }}>
                <AlertTriangle size={14} /> 契约校验未通过（已拦截落库）
              </div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: 'var(--crimson)', fontSize: 13 }}>
                {preview.validationErrors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}

          {preview.summaryBullets.length > 0 && (
            <div
              className="field-block"
              style={{
                background: 'var(--emerald-soft)',
                borderColor: 'color-mix(in srgb, var(--emerald) 30%, transparent)',
                marginBottom: 14,
              }}
            >
              <div className="field-block-label" style={{ color: 'var(--emerald)' }}>
                <CheckCircle2 size={14} /> 本次变更摘要
              </div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--text)' }}>
                {preview.summaryBullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>
          )}

          {preview.diffs.length === 0 ? (
            <div className="empty-state">无文件差异需要写入。</div>
          ) : (
            preview.diffs.map((item) => (
              <div key={item.key} className="diff-box">
                <div className="diff-header">
                  <span>
                    {item.label}{' '}
                    <span className="badge badge-navy mono" style={{ marginLeft: 6 }}>
                      {item.versionBefore} → {item.versionAfter}
                    </span>
                  </span>
                  <span className="mono" style={{ fontSize: 12 }}>
                    <span style={{ color: 'var(--emerald)', marginRight: 8 }}>+{item.diff.added}</span>
                    <span style={{ color: 'var(--crimson)' }}>-{item.diff.removed}</span>
                  </span>
                </div>
                <div style={{ maxHeight: 300, overflowY: 'auto', background: 'var(--bg-elev)' }}>
                  {item.diff.hunks.map((hunk, hi) => (
                    <div key={hi} style={{ borderBottom: hi < item.diff.hunks.length - 1 ? '1px dashed var(--border)' : undefined }}>
                      <div
                        style={{
                          padding: '3px 10px',
                          background: 'var(--bg-code)',
                          color: 'var(--text-muted)',
                          fontSize: 11,
                        }}
                      >
                        @@ 行 {hunk.oldStart} → {hunk.newStart} @@
                      </div>
                      {hunk.lines.map((line, li) => (
                        <div
                          key={li}
                          className={`diff-line ${
                            line.type === 'add'
                              ? 'diff-line-add'
                              : line.type === 'del'
                              ? 'diff-line-del'
                              : 'diff-line-eq'
                          }`}
                        >
                          <span className="diff-ln">{line.type === 'add' ? line.newLine : line.oldLine}</span>
                          <span style={{ width: 12, flexShrink: 0, userSelect: 'none' }}>
                            {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                          </span>
                          <span>{line.text || ' '}</span>
                        </div>
                      ))}
                      {hunk.truncated > 0 && (
                        <div style={{ padding: '4px 12px', color: 'var(--text-muted)', fontSize: 11.5 }}>
                          ... 其余 {hunk.truncated} 行已折叠显示
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="modal-footer">
          <div style={{ marginRight: 'auto', fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <ShieldCheck size={14} color="var(--teal)" />
            原子写入（先备份至 backups/ 再替换原文件）
          </div>
          <button type="button" className="btn" onClick={onCancel} disabled={committing}>
            取消返回编辑
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!preview.ok || preview.diffs.length === 0 || committing}
            onClick={onConfirm}
          >
            {committing ? '正在备份并落库...' : '确认落库（自动备份）'}
          </button>
        </div>
      </div>
    </div>
  );
};
