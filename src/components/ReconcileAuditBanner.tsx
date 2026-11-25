import React from 'react';
import { AlertTriangle, CheckCircle2, ShieldCheck, Sparkles } from 'lucide-react';
import type { ReconcileItem, ReconcileReport } from '../types';

interface ReconcileAuditBannerProps {
  reconcile: ReconcileReport | null | undefined;
  applying?: boolean;
  onApplyAutoFix?: (items: ReconcileItem[]) => void;
}

/**
 * P0-2：AI 产出事后数值对账门禁审核条（源自 ai-mock-trade reconcile() 纪律）
 * 自动标红 AI 正文中偏离实盘权威行情包的数字，支持一键替换为权威实盘口径。
 */
export const ReconcileAuditBanner: React.FC<ReconcileAuditBannerProps> = ({
  reconcile,
  applying = false,
  onApplyAutoFix,
}) => {
  if (!reconcile || (reconcile.checkedCount === 0 && !reconcile.fullTagCrossCheck?.regulatory?.hit)) {
    return null;
  }

  const fixableDrifts = reconcile.items.filter((i) => i.status === 'drift' && i.autoFixable);
  const allDrifts = reconcile.items.filter((i) => i.status === 'drift');
  const fullCheck = reconcile.fullTagCrossCheck;

  return (
    <div
      style={{
        marginTop: 10,
        padding: '10px 13px',
        borderRadius: 9,
        background: allDrifts.length > 0 ? 'var(--crimson-soft)' : 'var(--emerald-soft)',
        border: `1px solid ${
          allDrifts.length > 0
            ? 'color-mix(in srgb, var(--crimson) 32%, transparent)'
            : 'color-mix(in srgb, var(--emerald) 30%, transparent)'
        }`,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700 }}>
          {allDrifts.length > 0 ? (
            <AlertTriangle size={15} color="var(--crimson)" />
          ) : (
            <ShieldCheck size={15} color="var(--emerald)" />
          )}
          <span style={{ color: allDrifts.length > 0 ? 'var(--crimson)' : 'var(--emerald)' }}>
            事后数值对账门禁（Reconcile）：核验 {reconcile.checkedCount} 项 · 通过 {reconcile.passCount} 项 · 漂移{' '}
            {reconcile.driftCount} 项
          </span>
        </div>

        {fixableDrifts.length > 0 && onApplyAutoFix && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={applying}
            onClick={() => onApplyAutoFix(fixableDrifts)}
            style={{ padding: '3px 10px', fontSize: 11.5 }}
          >
            <Sparkles size={12} />
            {applying ? '修正中...' : `一键修正 ${fixableDrifts.length} 处为实盘权威口径`}
          </button>
        )}
      </div>

      {reconcile.items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {reconcile.items.map((item) => (
            <div
              key={item.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                padding: '5px 8px',
                borderRadius: 6,
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {item.status === 'drift' ? (
                  <span className="badge badge-crimson" style={{ fontSize: 10, padding: '0 5px' }}>
                    漂移
                  </span>
                ) : item.status === 'pass' ? (
                  <CheckCircle2 size={13} color="var(--emerald)" />
                ) : (
                  <span className="badge badge-amber" style={{ fontSize: 10, padding: '0 5px' }}>
                    提示
                  </span>
                )}
                <strong>{item.metricLabel}</strong>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>[{item.fieldLabel}]</span>
              </div>
              <div className="mono" style={{ fontSize: 11.5, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <span>
                  AI写：<strong style={{ color: item.status === 'drift' ? 'var(--crimson)' : 'var(--text)' }}>{item.aiValue}</strong>
                </span>
                <span>
                  实盘权威：<strong style={{ color: 'var(--emerald)' }}>{item.authValue}</strong>
                </span>
                <span style={{ color: 'var(--text-muted)' }}>({item.diffText})</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {fullCheck && fullCheck.draggingSignals.length > 0 && (
        <div
          style={{
            padding: '6px 9px',
            borderRadius: 6,
            background: 'var(--amber-soft)',
            color: 'var(--text)',
            fontSize: 11.5,
          }}
        >
          <strong>全标签与风险拖累核查（防片面叙事）：</strong>
          {fullCheck.draggingSignals.join('；')}
        </div>
      )}
    </div>
  );
};
