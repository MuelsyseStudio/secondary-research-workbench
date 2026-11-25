import React from 'react';
import { ShieldCheck, X } from 'lucide-react';
import {
  EDITION_DISPLAY_LABEL,
  EXECUTION_BOUNDARY_NOTICE,
  IS_COMMERCIAL_EDITION,
  LOCAL_TOOL_DISCLAIMER,
} from '../config/edition';

interface ComplianceDisclaimerBannerProps {
  variant?: 'banner' | 'footer' | 'card';
  showExecutionBoundary?: boolean;
  dismissible?: boolean;
  onDismiss?: () => void;
  compact?: boolean;
}

export const ComplianceDisclaimerBanner: React.FC<ComplianceDisclaimerBannerProps> = ({
  variant = 'footer',
  showExecutionBoundary = false,
  dismissible = false,
  onDismiss,
  compact = false,
}) => {
  if (variant === 'banner') {
    return (
      <div
        style={{
          padding: compact ? '7px 11px' : '9px 13px',
          borderRadius: 9,
          border: '1px solid var(--border)',
          background: IS_COMMERCIAL_EDITION ? 'rgba(30, 58, 138, 0.06)' : 'var(--bg-subtle)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 10,
          fontSize: 11.5,
          lineHeight: 1.55,
          color: 'var(--text-secondary)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
          <ShieldCheck size={15} color="var(--navy)" style={{ marginTop: 2, flexShrink: 0 }} />
          <div>
            <strong style={{ color: 'var(--text)', marginRight: 6 }}>
              本地投研工具声明（{EDITION_DISPLAY_LABEL}）
            </strong>
            <span>{LOCAL_TOOL_DISCLAIMER}</span>
            {showExecutionBoundary && (
              <div style={{ marginTop: 3, color: 'var(--text-muted)', fontSize: 11 }}>
                {EXECUTION_BOUNDARY_NOTICE}
              </div>
            )}
          </div>
        </div>
        {dismissible && onDismiss && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ padding: '2px 5px', flexShrink: 0 }}
            onClick={onDismiss}
            title="已阅并收起"
          >
            <X size={13} />
          </button>
        )}
      </div>
    );
  }

  if (variant === 'card') {
    return (
      <div
        className="panel panel-pad"
        style={{
          background: 'var(--bg-subtle)',
          borderColor: 'var(--border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          fontSize: 11.5,
          lineHeight: 1.6,
          color: 'var(--text-secondary)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: 'var(--text)' }}>
          <ShieldCheck size={14} color="var(--navy)" />
          <span>产品定位与合规免责声明（{EDITION_DISPLAY_LABEL}）</span>
        </div>
        <div>{LOCAL_TOOL_DISCLAIMER}</div>
        {showExecutionBoundary && (
          <div style={{ color: 'var(--text-muted)', paddingTop: 4, borderTop: '1px dashed var(--border)' }}>
            {EXECUTION_BOUNDARY_NOTICE}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: 10,
        padding: '8px 11px',
        borderRadius: 7,
        border: '1px dashed var(--border)',
        background: 'var(--bg-subtle)',
        fontSize: 11,
        lineHeight: 1.55,
        color: 'var(--text-muted)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <ShieldCheck size={13} style={{ marginTop: 2, flexShrink: 0, color: 'var(--navy)' }} />
        <div>
          <span>{LOCAL_TOOL_DISCLAIMER}</span>
          {showExecutionBoundary && <div style={{ marginTop: 3 }}>{EXECUTION_BOUNDARY_NOTICE}</div>}
        </div>
      </div>
    </div>
  );
};
