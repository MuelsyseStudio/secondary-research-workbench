import React, { useState } from 'react';
import { CheckCircle2, FileCheck2, ShieldAlert } from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type { EulaStatusInfo } from '../types';

interface EulaOnboardingModalProps {
  eula: EulaStatusInfo | null;
  onAccepted: (next: EulaStatusInfo) => void;
  onToast: (msg: string) => void;
}

export const EulaOnboardingModal: React.FC<EulaOnboardingModalProps> = ({ eula, onAccepted, onToast }) => {
  const { t } = useI18n();
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!eula || !eula.required || eula.accepted) return null;

  const handleAccept = async () => {
    if (!checked) return;
    setSubmitting(true);
    try {
      const res = await api.acceptEula();
      onAccepted(res.eula);
      onToast('已确认签署《软件许可与工具中立免责协议》');
    } catch (err: any) {
      onToast(`签署保存失败：${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      style={{ zIndex: 2200, backdropFilter: 'blur(6px)', background: 'rgba(10, 16, 26, 0.72)' }}
    >
      <div
        className="modal-box"
        style={{ maxWidth: 680, width: '94vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="modal-header" style={{ background: 'var(--bg-soft)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <ShieldAlert size={20} color="var(--amber)" />
            <div>
              <div style={{ fontWeight: 800, fontSize: 15.5 }}>{eula.title}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                协议版本 {eula.version} · 首次启动商业发行版需阅读并确认以下合规边界
              </div>
            </div>
          </div>
          <span className="badge badge-amber mono">{eula.edition}</span>
        </div>

        <div
          className="modal-body"
          style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: '16px 20px',
          }}
        >
          {(eula.clauses || []).map((cl, idx) => (
            <div
              key={idx}
              style={{
                padding: '11px 13px',
                borderRadius: 8,
                background: 'var(--bg-soft)',
                border: '1px solid var(--border)',
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--navy)', marginBottom: 4 }}>{cl.title}</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-secondary)' }}>{cl.body}</div>
            </div>
          ))}
        </div>

        <div
          className="modal-footer"
          style={{
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 10,
            background: 'var(--bg-elev)',
            borderTop: '1px solid var(--border)',
          }}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              cursor: 'pointer',
              fontSize: 12.5,
              color: 'var(--text)',
              lineHeight: 1.5,
            }}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              style={{ marginTop: 3, width: 15, height: 15 }}
            />
            <span>
              我已完整阅读并同意上述《软件许可协议与工具中立免责声明》，明确知晓本软件仅为本地个人投研笔记与策略研究框架，不提供证券投资咨询、荐股或代客理财服务，一切投资决策与风险由本人自行承担。
            </span>
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!checked || submitting}
              onClick={handleAccept}
            >
              {submitting ? <FileCheck2 size={15} /> : <CheckCircle2 size={15} />}
              {submitting ? t('正在保存签署记录...', 'Saving consent...') : t('我已阅读并同意，进入工作台', 'I Agree & Continue')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
