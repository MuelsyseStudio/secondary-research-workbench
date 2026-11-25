import React from 'react';
import { Copy, KeyRound, Lock, ShieldCheck, Sparkles, X } from 'lucide-react';
import type { UpgradeRequiredEventDetail } from '../types';
import { useI18n } from '../i18n';

interface UpgradeGateModalProps {
  detail: UpgradeRequiredEventDetail | null;
  machineCode?: string;
  onClose: () => void;
  onOpenLicenseModal: () => void;
  onToast: (msg: string) => void;
}

export const UpgradeGateModal: React.FC<UpgradeGateModalProps> = ({
  detail,
  machineCode,
  onClose,
  onOpenLicenseModal,
  onToast,
}) => {
  const { t } = useI18n();
  if (!detail) return null;

  const isMax = detail.requiredTier === 'max';
  const isPartner = detail.requiredTier === 'partner';
  const tierName = isPartner ? t('Partner 机构合作版', 'Partner Edition') : isMax ? t('Max 量化专业版', 'Max Quant Edition') : t('Pro 专业版', 'Pro Edition');
  const effectiveMachine = detail.machineCode || machineCode || '';

  const copyMachine = () => {
    if (!effectiveMachine) return;
    navigator.clipboard?.writeText(effectiveMachine).then(
      () => onToast(t(`已复制本机设备码：${effectiveMachine}`, `Copied machine code: ${effectiveMachine}`)),
      () => onToast(t('复制失败，请手动选中复制', 'Copy failed'))
    );
  };

  return (
    <div className="modal-backdrop" style={{ zIndex: 2100 }} onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 520, width: '92vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ background: 'var(--bg-soft)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Lock size={18} color="var(--amber)" />
            <div>
              <div style={{ fontWeight: 800, fontSize: 15 }}>{t(`解锁 ${tierName} 高阶能力`, `Unlock ${tierName}`)}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                {t('Local-First 本地离线授权 · 含 JetBrains 模式永久回退权', 'Local-First Offline Licensing · JetBrains-Style Perpetual Fallback')}
              </div>
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            style={{
              padding: '11px 13px',
              borderRadius: 8,
              background: 'var(--amber-soft)',
              border: '1px solid color-mix(in srgb, var(--amber) 35%, var(--border))',
              fontSize: 12.5,
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 700, color: 'var(--amber)', marginBottom: 3 }}>
              当前触发受控权益：{detail.featureLabel || detail.feature}
            </div>
            <div style={{ color: 'var(--text-secondary)' }}>{detail.message}</div>
          </div>

          <div
            style={{
              padding: '11px 13px',
              borderRadius: 8,
              background: 'var(--bg-soft)',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 12,
            }}
          >
            <div style={{ fontWeight: 700, color: 'var(--navy)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Sparkles size={14} /> {tierName} 核心包含：
            </div>
            {isMax ? (
              <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)', lineHeight: 1.65 }}>
                <li>包含全部 Pro 专业版能力（AI 复盘/对账、交割单归因、盲测、多图同屏、Webhook）</li>
                <li>解锁 Python + DuckDB 本地策略回测实验室（A 股 T+1/涨跌停/多市场撮合内核）</li>
                <li>支持方法论卡片 AI 转译策略 + 回测交易明细 B/S 联动 K 线复盘</li>
              </ul>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)', lineHeight: 1.65 }}>
                <li>多工作空间热切（兼容 Obsidian / Git）+ AI 自动复盘与数值防幻觉对账</li>
                <li>券商交割单 CSV/AI 归因 + K 线盲测回放 + 短线 2/4 屏同看 + 画线预警</li>
                <li>自动化定时巡检、飞书/企微/钉钉 Webhook 推送与周/月报聚合 HTML</li>
              </ul>
            )}
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
              <ShieldCheck size={13} color="var(--emerald)" />
              核心三库读写、基础盯盘、自定义合规数据源与本地 Webhook 接入在免费基础版永久开放。
            </div>
          </div>

          {effectiveMachine && (
            <div
              style={{
                padding: '8px 11px',
                borderRadius: 7,
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                fontSize: 12,
              }}
            >
              <div>
                <span style={{ color: 'var(--text-muted)' }}>本机脱敏设备码：</span>
                <strong className="mono" style={{ color: 'var(--navy)', letterSpacing: '0.06em' }}>
                  {effectiveMachine}
                </strong>
              </div>
              <button type="button" className="btn btn-sm" onClick={copyMachine}>
                <Copy size={12} /> 复制设备码
              </button>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-sm" onClick={onClose}>
            继续使用免费基础版
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              onClose();
              onOpenLicenseModal();
            }}
          >
            <KeyRound size={14} /> 立即输入 SRW2 授权码激活
          </button>
        </div>
      </div>
    </div>
  );
};
