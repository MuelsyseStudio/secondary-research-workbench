import React, { useEffect, useMemo, useState } from 'react';
import { Calculator, CheckCircle2, ClipboardCopy, ShieldCheck, ArrowRightCircle, X } from 'lucide-react';
import { EXECUTION_BOUNDARY_NOTICE } from '../config/edition';
import { ComplianceDisclaimerBanner } from './ComplianceDisclaimerBanner';

export interface TradePlanSeed {
  code?: string;
  name?: string;
  entryPrice?: number | string;
  stopLossPrice?: number | string;
  targetPrice?: number | string;
  accountCapital?: number;
  maxSinglePct?: number;
  commissionRate?: number;
  note?: string;
}

export interface ComputedTradePlan {
  valid: boolean;
  error?: string;
  boardLabel: string;
  riskBudget: number;
  riskPerShare: number;
  stopLossPct: number;
  sharesByRisk: number;
  sharesByPos: number;
  suggestedShares: number;
  suggestedLots: number;
  bindingConstraint: string;
  plannedAmount: number;
  positionPct: number;
  maxLossAmount: number;
  actualRiskPct: number;
  estCommission: number;
  rewardRiskRatio: number | null;
  targetGainPct: number | null;
  expectedProfit: number | null;
  copyText: string;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}

export function inferAShareBoardLabel(code: string): string {
  const clean = String(code || '').replace(/[^\d]/g, '');
  if (clean.startsWith('688')) return '科创板 (±20%)';
  if (clean.startsWith('300') || clean.startsWith('301')) return '创业板 (±20%)';
  if (clean.startsWith('4') || clean.startsWith('8') || clean.startsWith('92')) return '北交所 (±30%)';
  return '沪深主板 (±10%)';
}

export function computeAShareTradePlan(params: {
  code: string;
  name: string;
  accountCapital: number;
  riskPct: number;
  maxSinglePct: number;
  entryPrice: number;
  stopLossPrice: number;
  targetPrice: number | null;
  commissionRate: number;
  note: string;
}): ComputedTradePlan {
  const boardLabel = inferAShareBoardLabel(params.code);
  const { accountCapital, riskPct, maxSinglePct, entryPrice, stopLossPrice, targetPrice, commissionRate } = params;
  const empty = (error: string): ComputedTradePlan => ({
    valid: false,
    error,
    boardLabel,
    riskBudget: 0,
    riskPerShare: 0,
    stopLossPct: 0,
    sharesByRisk: 0,
    sharesByPos: 0,
    suggestedShares: 0,
    suggestedLots: 0,
    bindingConstraint: '--',
    plannedAmount: 0,
    positionPct: 0,
    maxLossAmount: 0,
    actualRiskPct: 0,
    estCommission: 0,
    rewardRiskRatio: null,
    targetGainPct: null,
    expectedProfit: null,
    copyText: '',
  });

  if (!Number.isFinite(accountCapital) || accountCapital <= 0) return empty('请输入大于 0 的账户总资金');
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return empty('请输入大于 0 的计划买入价');
  if (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0) return empty('请输入大于 0 的硬止损价');
  if (Math.abs(entryPrice * 10000 - Math.round(entryPrice * 10000)) > 1e-6 || Math.abs(stopLossPrice * 10000 - Math.round(stopLossPrice * 10000)) > 1e-6) {
    return empty('买入价与硬止损价最多支持 4 位小数精度');
  }
  if (stopLossPrice >= entryPrice) return empty('硬止损价必须严格低于计划买入价');
  const rawRiskPerShare = entryPrice - stopLossPrice;
  if (rawRiskPerShare < 0.0001) return empty('买入价与硬止损价价差过小（需 ≥ ¥0.0001）');
  if (!Number.isFinite(riskPct) || riskPct <= 0 || riskPct > 20) return empty('单笔最大风险比例需在 0% ~ 20% 之间');
  if (!Number.isFinite(maxSinglePct) || maxSinglePct <= 0 || maxSinglePct > 100) return empty('单票最大仓位上限需在 0% ~ 100% 之间');

  const rawRiskBudget = accountCapital * (riskPct / 100);
  if (!Number.isFinite(rawRiskBudget) || rawRiskBudget <= 0) return empty('单笔风险预算必须大于 0');
  const riskBudget = round2(rawRiskBudget);
  const riskPerShare = round4(rawRiskPerShare);
  const stopLossPct = round2((rawRiskPerShare / entryPrice) * 100);

  const sharesByRisk = Math.max(0, Math.floor(rawRiskBudget / rawRiskPerShare / 100) * 100);
  const maxCapitalByPos = round2(accountCapital * (maxSinglePct / 100));
  const sharesByPos = Math.max(0, Math.floor(maxCapitalByPos / entryPrice / 100) * 100);

  const suggestedShares = Math.min(sharesByRisk, sharesByPos);
  const suggestedLots = suggestedShares / 100;
  const bindingConstraint = sharesByRisk <= sharesByPos ? '单笔风险预算约束' : '单票仓位上限约束';

  const plannedAmount = round2(suggestedShares * entryPrice);
  const positionPct = round2((plannedAmount / accountCapital) * 100);
  const maxLossAmount = round2(suggestedShares * rawRiskPerShare);
  const actualRiskPct = round2((maxLossAmount / accountCapital) * 100);
  const estCommission = plannedAmount > 0 ? Math.max(5, round2(plannedAmount * Math.max(0, commissionRate))) : 0;

  let rewardRiskRatio: number | null = null;
  let targetGainPct: number | null = null;
  let expectedProfit: number | null = null;
  if (targetPrice != null && Number.isFinite(targetPrice) && targetPrice > entryPrice) {
    rewardRiskRatio = round2((targetPrice - entryPrice) / rawRiskPerShare);
    targetGainPct = round2(((targetPrice - entryPrice) / entryPrice) * 100);
    expectedProfit = round2(suggestedShares * (targetPrice - entryPrice));
  }

  const title = [params.code.trim().toUpperCase() || '待填代码', params.name.trim()].filter(Boolean).join(' ');
  const lines = [
    `【A股半自动交易计划卡】${title}（${boardLabel}）`,
    `方向：买入计划 | 计划买价：¥${entryPrice.toFixed(2)} | 硬止损价：¥${stopLossPrice.toFixed(2)}（止损幅度 -${stopLossPct.toFixed(2)}%）`,
    rewardRiskRatio != null && targetPrice != null
      ? `目标止盈：¥${targetPrice.toFixed(2)}（+${targetGainPct?.toFixed(2)}% | 盈亏比 ${rewardRiskRatio.toFixed(2)} : 1 | 预期毛利 ¥${expectedProfit?.toLocaleString()}）`
      : '目标止盈：未设（按趋势/分批止盈纪律跟踪）',
    `建议股数：${suggestedShares.toLocaleString()} 股（${suggestedLots} 手，100股整数倍） | 计划金额：¥${plannedAmount.toLocaleString()}（占总资金 ${positionPct.toFixed(2)}%）`,
    `最大止损亏损：¥${maxLossAmount.toLocaleString()}（占总资金 ${actualRiskPct.toFixed(2)}% / 预算 ${riskPct}%） | 主约束：${bindingConstraint} | 预估佣金：¥${estCommission.toFixed(2)}`,
    ...(params.note.trim() ? [`执行逻辑与纪律：${params.note.trim()}`] : []),
    `边界说明：本计划卡仅作个人投研测算与人工核对复制，不构成投资建议；${EXECUTION_BOUNDARY_NOTICE}`,
  ];

  return {
    valid: true,
    boardLabel,
    riskBudget,
    riskPerShare,
    stopLossPct,
    sharesByRisk,
    sharesByPos,
    suggestedShares,
    suggestedLots,
    bindingConstraint,
    plannedAmount,
    positionPct,
    maxLossAmount,
    actualRiskPct,
    estCommission,
    rewardRiskRatio,
    targetGainPct,
    expectedProfit,
    copyText: lines.join('\n'),
  };
}

interface TradePlanCardModalProps {
  open: boolean;
  seed?: TradePlanSeed | null;
  onClose: () => void;
  onApplyToManualTrade?: (draft: {
    code: string;
    name: string;
    price: string;
    quantity: string;
    stopLossPrice: string;
    targetPrice: string;
    note: string;
  }) => void;
  onToast: (msg: string) => void;
}

export const TradePlanCardModal: React.FC<TradePlanCardModalProps> = ({
  open,
  seed,
  onClose,
  onApplyToManualTrade,
  onToast,
}) => {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [accountCapital, setAccountCapital] = useState('500000');
  const [riskPct, setRiskPct] = useState('1.5');
  const [maxSinglePct, setMaxSinglePct] = useState('25');
  const [entryPrice, setEntryPrice] = useState('');
  const [stopLossPrice, setStopLossPrice] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [commissionRate, setCommissionRate] = useState('0.00025');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setCode(seed?.code || '');
    setName(seed?.name || '');
    setAccountCapital(String(seed?.accountCapital || 500000));
    setMaxSinglePct(String(seed?.maxSinglePct || 25));
    setCommissionRate(String(seed?.commissionRate ?? 0.00025));
    setEntryPrice(seed?.entryPrice != null && seed.entryPrice !== '' ? String(seed.entryPrice) : '');
    setStopLossPrice(seed?.stopLossPrice != null && seed.stopLossPrice !== '' ? String(seed.stopLossPrice) : '');
    setTargetPrice(seed?.targetPrice != null && seed.targetPrice !== '' ? String(seed.targetPrice) : '');
    setNote(seed?.note || '');
  }, [open, seed]);

  const plan = useMemo(
    () =>
      computeAShareTradePlan({
        code,
        name,
        accountCapital: Number(accountCapital),
        riskPct: Number(riskPct),
        maxSinglePct: Number(maxSinglePct),
        entryPrice: Number(entryPrice),
        stopLossPrice: Number(stopLossPrice),
        targetPrice: targetPrice.trim() ? Number(targetPrice) : null,
        commissionRate: Number(commissionRate),
        note,
      }),
    [code, name, accountCapital, riskPct, maxSinglePct, entryPrice, stopLossPrice, targetPrice, commissionRate, note]
  );

  if (!open) return null;

  const handleCopy = async () => {
    if (!plan.valid || !plan.copyText) return;
    try {
      await navigator.clipboard.writeText(plan.copyText);
      setCopied(true);
      onToast('已复制 A 股半自动交易计划卡到剪贴板，可直接核对下单或贴入复盘台账');
      setTimeout(() => setCopied(false), 2500);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = plan.copyText;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopied(true);
        onToast('已复制 A 股半自动交易计划卡到剪贴板');
        setTimeout(() => setCopied(false), 2500);
      } catch {
        onToast('复制失败，请手动选中下方计划卡文本复制');
      }
    }
  };

  const applyStopPctShortcut = (pct: number) => {
    const ep = Number(entryPrice);
    if (!Number.isFinite(ep) || ep <= 0) return;
    setStopLossPrice(round2(ep * (1 - pct / 100)).toFixed(2));
  };

  return (
    <div className="modal-backdrop" style={{ zIndex: 1120 }} onClick={onClose}>
      <div
        className="modal-card"
        style={{ width: 'min(860px, 95vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
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
            background: 'linear-gradient(120deg, var(--bg-elev), var(--teal-soft))',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Calculator size={18} color="var(--teal)" />
            <div>
              <div style={{ fontSize: 15, fontWeight: 800 }}>
                A 股半自动交易计划卡（仓位 / 硬止损测算 &amp; 一键复制）
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                严格按 A 股 100 股/手整数倍 + 单笔风险预算与单票仓位双红线测算 · {plan.boardLabel}
              </div>
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="关闭交易计划卡">
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* 标的信息与资金风控参数 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>A 股代码</span>
              <input
                className="input mono"
                placeholder="如 300308"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>标的简称</span>
              <input
                className="input"
                placeholder="如 中际旭创"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>账户总资金 (元)</span>
              <input
                type="number"
                className="input mono"
                value={accountCapital}
                onChange={(e) => setAccountCapital(e.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>单票仓位上限 (%)</span>
              <input
                type="number"
                step="1"
                className="input mono"
                value={maxSinglePct}
                onChange={(e) => setMaxSinglePct(e.target.value)}
              />
            </label>
          </div>

          {/* 价格与风险预算 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>计划买入价 (¥)</span>
              <input
                type="number"
                step="0.01"
                className="input mono"
                placeholder="如 142.50"
                value={entryPrice}
                onChange={(e) => setEntryPrice(e.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>硬止损价 (¥)</span>
                <span style={{ display: 'flex', gap: 4 }}>
                  {[3, 5, 8].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      className="btn btn-ghost btn-xs"
                      style={{ padding: '0 4px', fontSize: 10 }}
                      onClick={() => applyStopPctShortcut(pct)}
                    >
                      -{pct}%
                    </button>
                  ))}
                </span>
              </div>
              <input
                type="number"
                step="0.01"
                className="input mono"
                placeholder="必须低于买价"
                value={stopLossPrice}
                onChange={(e) => setStopLossPrice(e.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>目标止盈价 (¥，可选)</span>
              <input
                type="number"
                step="0.01"
                className="input mono"
                placeholder="测算盈亏比 R:R"
                value={targetPrice}
                onChange={(e) => setTargetPrice(e.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>单笔最大风险 (%)</span>
                <span style={{ display: 'flex', gap: 3 }}>
                  {['0.5', '1', '1.5', '2'].map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={`btn btn-xs ${riskPct === v ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ padding: '0 4px', fontSize: 10 }}
                      onClick={() => setRiskPct(v)}
                    >
                      {v}%
                    </button>
                  ))}
                </span>
              </div>
              <input
                type="number"
                step="0.1"
                className="input mono"
                value={riskPct}
                onChange={(e) => setRiskPct(e.target.value)}
              />
            </label>
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>执行逻辑 / 触发条件备注（可选）</span>
            <input
              className="input"
              placeholder="如：回踩 MA5 且板块前排未核按钮时分两笔低吸，有效跌破硬止损价无条件离场"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>

          {/* 实时测算卡片 */}
          {plan.valid ? (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                  gap: 10,
                  padding: 12,
                  borderRadius: 10,
                  background: 'var(--bg-soft)',
                  border: '1px solid var(--border)',
                }}
              >
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>建议买入股数（100股/手）</div>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: 'var(--teal)' }}>
                    {plan.suggestedShares.toLocaleString()} 股
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {plan.suggestedLots} 手 · {plan.bindingConstraint}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>计划买入金额 / 仓位</div>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 800 }}>
                    ¥{plan.plannedAmount.toLocaleString()}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    占总资金 {plan.positionPct.toFixed(2)}%（上限 {maxSinglePct}%）
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>触及硬止损最大亏损</div>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: 'var(--crimson)' }}>
                    -¥{plan.maxLossAmount.toLocaleString()}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    止损幅度 -{plan.stopLossPct.toFixed(2)}% · 占资金 {plan.actualRiskPct.toFixed(2)}%
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>风险收益比 / 预估佣金</div>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: 'var(--emerald)' }}>
                    {plan.rewardRiskRatio != null ? `${plan.rewardRiskRatio.toFixed(2)} : 1` : '未设目标价'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    佣金约 ¥{plan.estCommission.toFixed(2)}
                    {plan.expectedProfit != null ? ` · 预期毛利 +¥${plan.expectedProfit.toLocaleString()}` : ''}
                  </div>
                </div>
              </div>

              {/* 标准化文本预览 */}
              <div style={{ border: '1px solid var(--border)', borderRadius: 9, overflow: 'hidden' }}>
                <div
                  style={{
                    padding: '7px 12px',
                    background: 'var(--bg-subtle)',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <ShieldCheck size={14} color="var(--teal)" /> 标准化交易计划卡（可直接一键复制）
                  </span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {onApplyToManualTrade && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          onApplyToManualTrade({
                            code: code.trim().toUpperCase(),
                            name: name.trim(),
                            price: entryPrice,
                            quantity: String(plan.suggestedShares),
                            stopLossPrice,
                            targetPrice,
                            note: note.trim() || `按交易计划卡测算（仓位 ${plan.positionPct}% / 止损 -${plan.stopLossPct}%）`,
                          });
                          onClose();
                        }}
                      >
                        <ArrowRightCircle size={13} /> 一键带入手动记一笔
                      </button>
                    )}
                    <button type="button" className="btn btn-primary btn-sm" onClick={handleCopy}>
                      {copied ? <CheckCircle2 size={13} /> : <ClipboardCopy size={13} />}
                      {copied ? '已复制计划卡' : '一键复制计划卡'}
                    </button>
                  </div>
                </div>
                <pre
                  className="mono"
                  style={{
                    margin: 0,
                    padding: 12,
                    fontSize: 11.5,
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    background: 'var(--bg-elev)',
                    color: 'var(--text)',
                  }}
                >
                  {plan.copyText}
                </pre>
              </div>
            </>
          ) : (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 9,
                background: 'var(--amber-soft)',
                border: '1px solid color-mix(in srgb, var(--amber) 35%, transparent)',
                fontSize: 12.5,
                color: 'var(--text)',
              }}
            >
              请完善测算参数：{plan.error}
            </div>
          )}

          <ComplianceDisclaimerBanner variant="footer" showExecutionBoundary />
        </div>
      </div>
    </div>
  );
};
