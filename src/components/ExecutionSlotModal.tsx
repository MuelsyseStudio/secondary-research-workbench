import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, PlugZap, Save, ShieldCheck, Sliders, X } from 'lucide-react';
import { api } from '../api';
import type { ExecutionSlotStateResponse, MiniQmtProbeResult } from '../types';
import { ComplianceDisclaimerBanner } from './ComplianceDisclaimerBanner';

interface ExecutionSlotModalProps {
  open: boolean;
  onClose: () => void;
  onUpdated?: (state: ExecutionSlotStateResponse) => void;
  onToast: (msg: string) => void;
}

export const ExecutionSlotModal: React.FC<ExecutionSlotModalProps> = ({
  open,
  onClose,
  onUpdated,
  onToast,
}) => {
  const [state, setState] = useState<ExecutionSlotStateResponse | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [userdataMiniPath, setUserdataMiniPath] = useState('');
  const [accountId, setAccountId] = useState('');
  const [readOnlyConfirmLock, setReadOnlyConfirmLock] = useState(true);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<MiniQmtProbeResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setProbeResult(null);
    api
      .getExecutionSlot()
      .then((res) => {
        setState(res);
        setEnabled(Boolean(res.slot.miniqmt.enabled));
        setUserdataMiniPath(res.slot.miniqmt.userdataMiniPath || '');
        setAccountId('');
        setReadOnlyConfirmLock(res.slot.miniqmt.readOnlyConfirmLock !== false);
        setNotes(res.slot.miniqmt.notes || '');
      })
      .catch((err: any) => onToast(err.message || '加载 MiniQMT 插件槽位状态失败'));
  }, [open, onToast]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await api.saveExecutionSlot({
        miniqmt: {
          enabled,
          mode: enabled ? 'miniqmt_local_slot' : 'plan_card_only',
          userdataMiniPath,
          ...(accountId.trim() ? { accountId: accountId.trim() } : {}),
          accountType: 'STOCK',
          readOnlyConfirmLock,
          notes,
        },
      });
      setState(saved);
      setAccountId('');
      onUpdated?.(saved);
      onToast(
        saved.slot.miniqmt.enabled
          ? 'MiniQMT 本地合规插件槽位配置已保存（仅保存在本机，打包自动排除）'
          : '已保存：MiniQMT 槽位保持关闭，仅启用半自动交易计划卡'
      );
    } catch (err: any) {
      onToast(err.message || '保存 MiniQMT 槽位配置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleProbe = async () => {
    setProbing(true);
    try {
      const res = await api.probeExecutionSlot({
        miniqmt: { enabled, userdataMiniPath },
      });
      setProbeResult(res);
    } catch (err: any) {
      setProbeResult({
        ok: false,
        ready: false,
        status: 'error',
        pathExists: false,
        xtquantInstalled: false,
        message: err.message || '本机环境探测失败',
      });
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="modal-backdrop" style={{ zIndex: 1120 }} onClick={onClose}>
      <div
        className="modal-card"
        style={{ width: 'min(740px, 95vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: '13px 18px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
            background: 'linear-gradient(120deg, var(--bg-elev), var(--bg-soft))',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Sliders size={18} color="var(--teal)" />
            <div>
              <div style={{ fontSize: 15, fontWeight: 800 }}>
                可选券商官方 MiniQMT (xtquant) 本地合规插件槽位
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                默认严格关闭 · 仅对接用户本人合规开通的券商官方极简版 QMT 本地目录
              </div>
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="关闭插件槽位">
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 13 }}>
          <div
            style={{
              padding: '10px 13px',
              borderRadius: 9,
              border: '1px solid var(--border)',
              background: 'var(--bg-soft)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                <ShieldCheck size={15} color={enabled ? 'var(--emerald)' : 'var(--text-muted)'} />
                启用 MiniQMT 本地合规插件槽位（A 股现货 STOCK）
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                默认关闭。未启用时仅使用模拟盘回测与 A 股半自动交易计划卡；本软件不内置任何券商客户端或模拟点击外挂。
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12.5, fontWeight: 700 }}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              {enabled ? '已开启槽位' : '默认关闭'}
            </label>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, opacity: enabled ? 1 : 0.65 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>
                券商官方极简版 QMT 本机 userdata_mini 目录路径
              </span>
              <input
                className="input mono"
                disabled={!enabled}
                placeholder="例如：C:\国金QMT交易端模拟\userdata_mini"
                value={userdataMiniPath}
                onChange={(e) => setUserdataMiniPath(e.target.value)}
              />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>
                  A 股资金账号（仅存本机并脱敏展示{state?.slot.miniqmt.hasAccountId ? `，已存 ${state.slot.miniqmt.maskedAccountId}` : ''}）
                </span>
                <input
                  className="input mono"
                  disabled={!enabled}
                  placeholder={state?.slot.miniqmt.hasAccountId ? '留空保持当前脱敏账号不变' : '填写您本人的券商资金账号'}
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>账户类型（合规锁定）</span>
                <input className="input mono" value="STOCK（仅 A 股现货）" disabled />
              </label>
            </div>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                padding: '8px 10px',
                borderRadius: 8,
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border)',
              }}
            >
              <input
                type="checkbox"
                disabled={!enabled}
                checked={readOnlyConfirmLock}
                onChange={(e) => setReadOnlyConfirmLock(e.target.checked)}
              />
              <span>
                <strong>安全确认锁（推荐默认开启）：</strong>
                仅用于本机环境连接校验、持仓核对与计划卡导出，严禁无人值守静默自动发单。
              </span>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>备注（如所属券商与本机 Python xtquant 路径）</span>
              <input
                className="input"
                disabled={!enabled}
                placeholder="例如：券商官方极简版模拟盘，仅用于盘后持仓对账"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
          </div>

          {probeResult && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 9,
                fontSize: 12,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                background: probeResult.ok ? 'rgba(16,185,129,0.09)' : 'rgba(245,158,11,0.09)',
                border: `1px solid ${probeResult.ok ? 'rgba(16,185,129,0.35)' : 'rgba(245,158,11,0.35)'}`,
              }}
            >
              {probeResult.ok ? (
                <CheckCircle2 size={15} color="#10b981" style={{ marginTop: 1, flexShrink: 0 }} />
              ) : (
                <AlertCircle size={15} color="#d97706" style={{ marginTop: 1, flexShrink: 0 }} />
              )}
              <div>{probeResult.message}</div>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-sm" disabled={probing} onClick={handleProbe}>
              <PlugZap size={13} /> {probing ? '探测本机环境中...' : '探测本机 MiniQMT 环境'}
            </button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
                取消
              </button>
              <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={handleSave}>
                <Save size={13} /> {saving ? '保存中...' : '保存插件槽位设置'}
              </button>
            </div>
          </div>

          <ComplianceDisclaimerBanner variant="footer" showExecutionBoundary />
        </div>
      </div>
    </div>
  );
};
