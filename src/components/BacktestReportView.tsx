import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  Download,
  Loader2,
  Radio,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react';
import { api } from '../api';
import { CRYPTO_ENABLED } from '../config/edition';
import type { BacktestResultFull, DailyKlinePoint, EntityRef, SymbolTradeMarkers } from '../types';
import { InteractiveKlineChart } from './InteractiveKlineChart';
import { ComplianceDisclaimerBanner } from './ComplianceDisclaimerBanner';

interface BacktestReportViewProps {
  run: BacktestResultFull | null;
  onOpenEntity?: (ref: EntityRef) => void;
  onToast: (msg: string) => void;
}

const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  HKD: 'HK$',
  ...(CRYPTO_ENABLED ? { USDT: 'USDT ' } : {}),
  EUR: '€',
  GBP: '£',
  JPY: '¥',
};

function fmtMoney(val: number, currency: string): string {
  const sym = CURRENCY_SYMBOL[currency] || `${currency} `;
  return `${sym}${Number(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtSignedPct(val: number): string {
  const n = Number(val || 0);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export const BacktestReportView: React.FC<BacktestReportViewProps> = ({ run, onOpenEntity, onToast }) => {
  const [selectedSymbol, setSelectedSymbol] = useState<string>('');
  const [symbolBars, setSymbolBars] = useState<DailyKlinePoint[]>([]);
  const [loadingBars, setLoadingBars] = useState<boolean>(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [detailTab, setDetailTab] = useState<'trades' | 'rejects'>('trades');
  const [publishingLive, setPublishingLive] = useState<boolean>(false);

  const handlePublishRunToLiveOverlay = async () => {
    if (!run) return;
    setPublishingLive(true);
    try {
      const res = await api.publishLiveStrategy({
        strategyId: run.meta.strategyId || '',
        strategyName: run.meta.strategyName,
        strategyMode: run.meta.strategyMode,
        params: run.meta.params || {},
        sourceRunId: run.runId,
        metricsSummary: {
          totalReturnPct: run.metrics.totalReturnPct,
          winRatePct: run.metrics.winRatePct,
          maxDrawdownPct: run.metrics.maxDrawdownPct,
          sharpe: (run.metrics as any).sharpeRatio ?? (run.metrics as any).sharpe ?? null,
        },
        setDefault: true,
      });
      if (res.strategy?.id) {
        try {
          localStorage.setItem('srw_active_live_strategy_id_v1', res.strategy.id);
        } catch {
          // ignore
        }
        window.dispatchEvent(new Event('srw-published-strategies-changed'));
      }
      onToast(`已将「${run.meta.strategyName}」提取为全市场盯盘 B/S 指标！现在打开任意标的 K 线或自选看板即可直接显示「策B / 策S」点位。`);
    } catch (err: any) {
      onToast(`提取实时策略指标失败：${err.message || err}`);
    } finally {
      setPublishingLive(false);
    }
  };

  const symbols = run?.meta?.symbols || [];
  useEffect(() => {
    if (!run) return;
    const tradedSyms = Array.from(new Set(run.trades.map((t) => t.symbol)));
    const first = tradedSyms[0] || run.meta.symbols[0] || '';
    setSelectedSymbol(first);
  }, [run?.runId]);

  useEffect(() => {
    if (!run || !selectedSymbol) {
      setSymbolBars([]);
      return;
    }
    let cancelled = false;
    setLoadingBars(true);
    api
      .getQuantSymbolBars({
        symbol: selectedSymbol,
        market: run.meta.market,
        start: run.meta.startDate,
        end: run.meta.endDate,
        freq: run.meta.freq || '1d',
      })
      .then((res) => {
        if (cancelled) return;
        const pts: DailyKlinePoint[] = [];
        let prevClose: number | null = null;
        for (const b of res.bars || []) {
          const chg = prevClose != null ? Number((b.close - prevClose).toFixed(4)) : null;
          const pct = prevClose != null && prevClose > 0 ? Number((((b.close - prevClose) / prevClose) * 100).toFixed(2)) : null;
          pts.push({
            date: b.time.slice(0, 10),
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            vol: b.volume,
            amt: b.amount,
            ampPct: b.open > 0 ? Number((((b.high - b.low) / b.open) * 100).toFixed(2)) : null,
            pct,
            chg,
            turnoverPct: null,
          });
          prevClose = b.close;
        }
        setSymbolBars(pts);
      })
      .catch(() => {
        if (!cancelled) setSymbolBars([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingBars(false);
      });
    return () => {
      cancelled = true;
    };
  }, [run?.runId, selectedSymbol]);

  const tradeMarkersForChart = useMemo<SymbolTradeMarkers | null>(() => {
    if (!run || !selectedSymbol) return null;
    const symTrades = run.trades.filter((t) => t.symbol === selectedSymbol);
    if (!symTrades.length) return null;
    return {
      code: selectedSymbol,
      markers: symTrades.map((t, idx) => ({
        id: `${run.runId}_${idx}`,
        date: t.date.slice(0, 10),
        time: t.date.length > 10 ? t.date.slice(11, 16) : '09:30',
        side: t.side,
        price: t.price,
        quantity: t.shares,
        emotionTag: t.pnlPct != null ? `${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%` : t.side === 'BUY' ? '信号建仓' : '信号平仓',
        cardIds: run.meta.cardRefs || [],
        note: t.reason || '',
      })),
      holdingQty: 0,
      avgCostPrice: null,
      stopLossPrice: null,
    };
  }, [run, selectedSymbol]);

  // 月度收益热力矩阵 Year × 1..12（兼容引擎返回的按年分组矩阵与平铺数组两种形态）
  const monthlyGrid = useMemo(() => {
    if (!run || !Array.isArray(run.monthlyReturns) || !run.monthlyReturns.length) return [];
    const byYear = new Map<number, { months: Record<number, number>; yearTotalPct: number | null }>();
    for (const item of run.monthlyReturns) {
      if (!byYear.has(item.year)) {
        byYear.set(item.year, { months: {}, yearTotalPct: item.yearTotalPct ?? null });
      }
      const bucket = byYear.get(item.year)!;
      if (item.months && typeof item.months === 'object') {
        for (const [k, v] of Object.entries(item.months)) {
          const numV = Number(v);
          if (Number.isFinite(numV)) bucket.months[Number(k)] = numV;
        }
        if (typeof item.yearTotalPct === 'number' && Number.isFinite(item.yearTotalPct)) {
          bucket.yearTotalPct = item.yearTotalPct;
        }
      } else if (typeof item.month === 'number' && typeof item.returnPct === 'number' && Number.isFinite(item.returnPct)) {
        bucket.months[item.month] = item.returnPct;
      }
    }
    return Array.from(byYear.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([year, data]) => {
        const vals = Object.values(data.months).filter((v) => Number.isFinite(v));
        const computedYtd = vals.length ? (vals.reduce((acc, r) => acc * (1 + r / 100), 1) - 1) * 100 : 0;
        const ytdPct = data.yearTotalPct != null && Number.isFinite(data.yearTotalPct) ? data.yearTotalPct : computedYtd;
        return { year, months: data.months, ytdPct };
      });
  }, [run]);

  if (!run) {
    return (
      <div className="panel" style={{ padding: 36, textAlign: 'center', color: 'var(--text-muted)' }}>
        <BarChart3 size={34} style={{ opacity: 0.35, marginBottom: 8 }} />
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>尚未选中回测报告</div>
        <div style={{ fontSize: 12.5, marginTop: 4 }}>请在「策略工作区」一键运行回测，或在「历史回测对比」中点击任意一条归档记录查看。</div>
      </div>
    );
  }

  const m = run.metrics;
  const cur = run.meta.currency || 'CNY';
  const curve = run.equityCurve || [];
  const W = 920;
  const H = 220;
  const H_DD = 92;
  const PAD_L = 56;
  const PAD_R = 16;
  const PAD_T = 16;
  const PAD_B = 24;

  const navVals = curve.flatMap((c) => [c.nav, c.benchmarkNav]);
  const minNav = navVals.length ? Math.min(...navVals) * 0.97 : 0.9;
  const maxNav = navVals.length ? Math.max(...navVals) * 1.03 : 1.1;
  const spanNav = Math.max(0.01, maxNav - minNav);
  const minDD = curve.length ? Math.min(-5, ...curve.map((c) => c.drawdownPct)) : -10;

  const xOf = (i: number) => PAD_L + (curve.length <= 1 ? 0 : (i / (curve.length - 1)) * (W - PAD_L - PAD_R));
  const yNav = (v: number) => PAD_T + ((maxNav - v) / spanNav) * (H - PAD_T - PAD_B);
  const yDD = (v: number) => 10 + (v / Math.min(-1, minDD)) * (H_DD - 24);

  const stratPath = curve.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yNav(p.nav).toFixed(1)}`).join(' ');
  const benchPath = curve.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yNav(p.benchmarkNav).toFixed(1)}`).join(' ');
  const ddArea = curve.length
    ? `M${xOf(0).toFixed(1)},10 ` +
      curve.map((p, i) => `L${xOf(i).toFixed(1)},${yDD(p.drawdownPct).toFixed(1)}`).join(' ') +
      ` L${xOf(curve.length - 1).toFixed(1)},10 Z`
    : '';

  const activePoint = hoverIdx != null && curve[hoverIdx] ? curve[hoverIdx] : curve[curve.length - 1];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 报告头部元信息与导出 */}
      <div className="panel" style={{ padding: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="badge badge-navy mono">{run.meta.market}</span>
              <span style={{ fontWeight: 700, fontSize: 15.5 }}>{run.meta.strategyName}</span>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{run.runId}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span>区间：<b className="mono">{run.meta.startDate} ~ {run.meta.endDate}</b> ({run.meta.freq})</span>
              <span>撮合：<b>{run.meta.matchMode === 'next_open' ? '次日开盘 (零未来函数)' : '当日收盘'}</b></span>
              <span>初始资金：<b className="mono">{fmtMoney(run.meta.initialCash, cur)}</b></span>
              <span>基准：<b className="mono">{run.meta.benchmark || '-'}</b></span>
              <span>数据源：<b className="mono">{(run.meta.sources || []).join(', ') || 'DuckDB'}</b></span>
            </div>
            {run.meta.cardRefs && run.meta.cardRefs.length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <BookOpen size={12} color="var(--navy)" />
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>关联方法论卡片：</span>
                {run.meta.cardRefs.map((cid) => (
                  <button
                    key={cid}
                    type="button"
                    className="badge badge-gold mono"
                    style={{ cursor: 'pointer', border: 'none' }}
                    onClick={() => onOpenEntity?.({ kind: 'methodology', id: cid })}
                  >
                    卡片 {cid}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={publishingLive}
              onClick={handlePublishRunToLiveOverlay}
              title="将本策略提取为实时指标，在全市场任意标的 K 线与自选/短线盯盘页面显示「策B / 策S」买卖信号"
            >
              {publishingLive ? <Loader2 size={12} className="spin" /> : <Radio size={12} />}
              提取为全市场盯盘 B/S 指标
            </button>
            <a
              className="btn btn-sm"
              href={`/api/quant/runs/${encodeURIComponent(run.runId)}/csv?kind=trades`}
              download
            >
              <Download size={12} /> 导出成交 CSV
            </a>
            <a
              className="btn btn-sm"
              href={`/api/quant/runs/${encodeURIComponent(run.runId)}/csv?kind=equity`}
              download
            >
              <Download size={12} /> 导出净值 CSV
            </a>
          </div>
        </div>

        {/* 缺口警告 */}
        {run.meta.gapWarnings && run.meta.gapWarnings.length > 0 && (
          <div
            style={{
              marginTop: 10,
              padding: '8px 10px',
              borderRadius: 8,
              background: 'var(--amber-soft)',
              color: 'var(--amber)',
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <AlertTriangle size={14} />
            <span>
              数据缺口提示（已按零编造原则原样跳过缺失日）：
              {run.meta.gapWarnings.map((g) => `${g.symbol} 缺 ${g.missingDays} 天 (覆盖 ${g.coveragePct}%)`).join('；')}
            </span>
          </div>
        )}
      </div>

      {/* 核心绩效 KPI 矩阵 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 10 }}>
        {[
          {
            label: '策略累计收益',
            val: fmtSignedPct(m.totalReturnPct),
            sub: `期末 ${fmtMoney(m.finalEquity, cur)}`,
            tone: m.totalReturnPct >= 0 ? 'var(--crimson)' : 'var(--emerald)',
          },
          {
            label: '年化收益率',
            val: fmtSignedPct(m.annualizedReturnPct),
            sub: `基准 ${fmtSignedPct(m.benchmarkReturnPct)}`,
            tone: m.annualizedReturnPct >= 0 ? 'var(--crimson)' : 'var(--emerald)',
          },
          {
            label: '超额收益 (Alpha)',
            val: fmtSignedPct(m.excessReturnPct),
            sub: `对比 ${run.meta.benchmark || '基准'}`,
            tone: m.excessReturnPct >= 0 ? 'var(--crimson)' : 'var(--emerald)',
          },
          {
            label: '最大回撤',
            val: `-${Math.abs(m.maxDrawdownPct).toFixed(2)}%`,
            sub: m.maxDrawdownStart ? `${m.maxDrawdownStart}→${m.maxDrawdownEnd}` : '无回撤',
            tone: 'var(--emerald)',
          },
          {
            label: '夏普 / 索提诺',
            val: `${m.sharpeRatio.toFixed(2)} / ${m.sortinoRatio.toFixed(2)}`,
            sub: `卡玛比率 ${m.calmarRatio.toFixed(2)}`,
            tone: 'var(--navy)',
          },
          {
            label: '胜率 / 盈亏比',
            val: `${m.winRatePct.toFixed(1)}% / ${m.profitLossRatio.toFixed(2)}`,
            sub: `共 ${m.tradeCount} 笔 (${m.closedTradeCount} 已闭环)`,
            tone: 'var(--text-primary)',
          },
          {
            label: '累计手续费 / 拒单',
            val: fmtMoney(m.totalFees, cur),
            sub: `换手 ${m.turnoverRatio.toFixed(2)}x · 拒单 ${m.rejectCount} 笔`,
            tone: 'var(--text-secondary)',
          },
        ].map((k) => (
          <div key={k.label} className="panel" style={{ padding: '10px 12px' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{k.label}</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: k.tone, marginTop: 3 }}>
              {k.val}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {k.sub}
            </div>
          </div>
        ))}
      </div>

      {/* 交互式双线净值曲线 + 水下回撤图 */}
      <div className="panel" style={{ padding: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <TrendingUp size={16} color="var(--navy)" />
            <span style={{ fontWeight: 700, fontSize: 13.5 }}>策略净值 vs 基准净值 & 动态回撤</span>
            <span style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 3, background: '#ef4444', display: 'inline-block' }} /> 策略净值
            </span>
            <span style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)' }}>
              <span style={{ width: 10, height: 2, background: '#64748b', display: 'inline-block' }} /> 基准 ({run.meta.benchmark})
            </span>
          </div>
          {activePoint && (
            <div className="mono" style={{ fontSize: 11.5, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span>日期: <b>{activePoint.date}</b></span>
              <span style={{ color: '#ef4444' }}>策略NAV: <b>{activePoint.nav.toFixed(4)}</b></span>
              <span style={{ color: 'var(--text-muted)' }}>基准NAV: <b>{activePoint.benchmarkNav.toFixed(4)}</b></span>
              <span style={{ color: 'var(--emerald)' }}>回撤: <b>{activePoint.drawdownPct.toFixed(2)}%</b></span>
              <span>仓位: <b>{activePoint.positionPct.toFixed(1)}%</b></span>
            </div>
          )}
        </div>

        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: '100%', height: 215, display: 'block', cursor: 'crosshair' }}
          onMouseLeave={() => setHoverIdx(null)}
          onMouseMove={(e) => {
            if (!curve.length) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const relX = ((e.clientX - rect.left) / rect.width) * W;
            const ratio = Math.max(0, Math.min(1, (relX - PAD_L) / (W - PAD_L - PAD_R)));
            setHoverIdx(Math.round(ratio * (curve.length - 1)));
          }}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((t) => {
            const val = minNav + (1 - t) * spanNav;
            const y = PAD_T + t * (H - PAD_T - PAD_B);
            return (
              <g key={t}>
                <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="var(--border)" strokeDasharray="3 3" />
                <text x={PAD_L - 6} y={y + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)" className="mono">
                  {val.toFixed(2)}
                </text>
              </g>
            );
          })}
          {/* 1.00 基准平线 */}
          {minNav < 1 && maxNav > 1 && (
            <line x1={PAD_L} y1={yNav(1)} x2={W - PAD_R} y2={yNav(1)} stroke="var(--border-strong)" strokeDasharray="4 4" />
          )}
          <path d={benchPath} fill="none" stroke="#64748b" strokeWidth="1.6" strokeDasharray="4 2" />
          <path d={stratPath} fill="none" stroke="#ef4444" strokeWidth="2.2" />
          {hoverIdx != null && curve[hoverIdx] && (
            <>
              <line x1={xOf(hoverIdx)} y1={PAD_T} x2={xOf(hoverIdx)} y2={H - PAD_B} stroke="var(--navy)" strokeDasharray="2 2" />
              <circle cx={xOf(hoverIdx)} cy={yNav(curve[hoverIdx].nav)} r="4" fill="#ef4444" stroke="#fff" strokeWidth="1.5" />
              <circle cx={xOf(hoverIdx)} cy={yNav(curve[hoverIdx].benchmarkNav)} r="3.5" fill="#64748b" stroke="#fff" strokeWidth="1.2" />
            </>
          )}
          {curve.length > 0 && (
            <>
              <text x={PAD_L} y={H - 5} fontSize="10" fill="var(--text-muted)" className="mono">{curve[0].date}</text>
              <text x={W - PAD_R} y={H - 5} textAnchor="end" fontSize="10" fill="var(--text-muted)" className="mono">{curve[curve.length - 1].date}</text>
            </>
          )}
        </svg>

        {/* 水下回撤面积图 */}
        <svg viewBox={`0 0 ${W} ${H_DD}`} style={{ width: '100%', height: 84, display: 'block', marginTop: 4 }}>
          <line x1={PAD_L} y1={10} x2={W - PAD_R} y2={10} stroke="var(--border)" />
          <text x={PAD_L - 6} y={14} textAnchor="end" fontSize="9.5" fill="var(--text-muted)" className="mono">0%</text>
          <text x={PAD_L - 6} y={H_DD - 10} textAnchor="end" fontSize="9.5" fill="var(--text-muted)" className="mono">
            {minDD.toFixed(0)}%
          </text>
          <path d={ddArea} fill="rgba(16, 185, 129, 0.22)" stroke="#10b981" strokeWidth="1.2" />
        </svg>
      </div>

      {/* K 线 B/S 买卖点实战复盘联动（直接复用 Stage 3 InteractiveKlineChart / klinecharts） */}
      <div className="panel" style={{ padding: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>K 线 B/S 买卖点实战复盘联动 (KlineCharts 引擎)</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              直接读取本次回测对应的本地 DuckDB K 线，叠加所有成交 B/S 标记点与盈亏原因，支持拖拽缩放、指标切换与盲测重演
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {symbols.map((sym) => {
              const cnt = run.trades.filter((t) => t.symbol === sym).length;
              return (
                <button
                  key={sym}
                  type="button"
                  className={`btn btn-sm ${selectedSymbol === sym ? 'btn-primary' : ''}`}
                  onClick={() => setSelectedSymbol(sym)}
                >
                  <span className="mono">{sym}</span>
                  <span>{run.meta.symbolNames?.[sym] && run.meta.symbolNames[sym] !== sym ? ` ${run.meta.symbolNames[sym]}` : ''}</span>
                  <span className="badge" style={{ fontSize: 10, padding: '0 4px' }}>{cnt}笔</span>
                </button>
              );
            })}
          </div>
        </div>

        {loadingBars ? (
          <div style={{ padding: 36, textAlign: 'center', color: 'var(--text-muted)' }}>
            <Loader2 size={18} className="spin" /> 正在从本地 DuckDB 加载 {selectedSymbol} K 线...
          </div>
        ) : symbolBars.length > 0 ? (
          <InteractiveKlineChart
            secid={selectedSymbol}
            title={`${selectedSymbol} ${run.meta.symbolNames?.[selectedSymbol] || ''} · 回测 B/S 买卖点复盘`}
            klines={symbolBars}
            timeframe="day"
            currencySymbol={CURRENCY_SYMBOL[cur] || ''}
            tradeMarkers={tradeMarkersForChart}
            height={410}
            onToast={onToast}
          />
        ) : (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
            未读取到 {selectedSymbol} 的 K 线序列。
          </div>
        )}
      </div>

      {/* 月度收益热力表 */}
      {monthlyGrid.length > 0 && (
        <div className="panel" style={{ padding: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>月度收益率热力矩阵 (%)</div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table mono" style={{ width: '100%', fontSize: 11.5, textAlign: 'center' }}>
              <thead>
                <tr>
                  <th>年份</th>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((mo) => (
                    <th key={mo}>{mo}月</th>
                  ))}
                  <th>年度合计</th>
                </tr>
              </thead>
              <tbody>
                {monthlyGrid.map((row) => (
                  <tr key={row.year}>
                    <td style={{ fontWeight: 700 }}>{row.year}</td>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((mo) => {
                      const v = row.months[mo];
                      if (v === undefined) return <td key={mo} style={{ color: 'var(--text-muted)' }}>—</td>;
                      const alpha = Math.min(0.45, Math.abs(v) / 25 + 0.08);
                      const bg = v >= 0 ? `rgba(220, 38, 38, ${alpha.toFixed(2)})` : `rgba(16, 185, 129, ${alpha.toFixed(2)})`;
                      return (
                        <td key={mo} style={{ background: bg, fontWeight: 600 }}>
                          {v >= 0 ? '+' : ''}{v.toFixed(1)}%
                        </td>
                      );
                    })}
                    <td style={{ fontWeight: 800, color: row.ytdPct >= 0 ? 'var(--crimson)' : 'var(--emerald)' }}>
                      {row.ytdPct >= 0 ? '+' : ''}{row.ytdPct.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 成交明细 & 拒单风控日志 */}
      <div className="panel" style={{ padding: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className={`btn btn-sm ${detailTab === 'trades' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setDetailTab('trades')}
            >
              成交明细 ({run.trades.length})
            </button>
            <button
              type="button"
              className={`btn btn-sm ${detailTab === 'rejects' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setDetailTab('rejects')}
            >
              <ShieldAlert size={12} /> 拒单与风控拦截日志 ({run.rejects.length})
            </button>
          </div>
        </div>

        {detailTab === 'trades' ? (
          <div style={{ overflowX: 'auto', maxHeight: 340, overflowY: 'auto' }}>
            <table className="data-table" style={{ width: '100%', fontSize: 12 }}>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>标的</th>
                  <th>方向</th>
                  <th style={{ textAlign: 'right' }}>成交价</th>
                  <th style={{ textAlign: 'right' }}>数量</th>
                  <th style={{ textAlign: 'right' }}>成交额</th>
                  <th style={{ textAlign: 'right' }}>手续费</th>
                  <th style={{ textAlign: 'right' }}>单笔盈亏</th>
                  <th>信号/风控原因</th>
                </tr>
              </thead>
              <tbody>
                {run.trades.map((t, i) => (
                  <tr key={i}>
                    <td className="mono">{t.date}</td>
                    <td className="mono" style={{ fontWeight: 600 }}>{t.symbol}</td>
                    <td>
                      <span className={`badge ${t.side === 'BUY' ? 'badge-crimson' : 'badge-emerald'}`}>{t.side}</span>
                    </td>
                    <td className="mono" style={{ textAlign: 'right' }}>{t.price.toFixed(4)}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{t.shares}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{fmtMoney(t.amount, cur)}</td>
                    <td className="mono" style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{t.fee.toFixed(2)}</td>
                    <td
                      className="mono"
                      style={{
                        textAlign: 'right',
                        fontWeight: 700,
                        color: t.pnl == null ? 'var(--text-muted)' : t.pnl >= 0 ? 'var(--crimson)' : 'var(--emerald)',
                      }}
                    >
                      {t.pnl == null ? '—' : `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)} (${t.pnlPct != null ? fmtSignedPct(t.pnlPct) : ''})`}
                    </td>
                    <td style={{ color: 'var(--text-secondary)' }}>{t.reason}</td>
                  </tr>
                ))}
                {run.trades.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 18 }}>
                      本次回测期间未触发任何成交信号。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ overflowX: 'auto', maxHeight: 300, overflowY: 'auto' }}>
            <table className="data-table" style={{ width: '100%', fontSize: 12 }}>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>标的</th>
                  <th>方向</th>
                  <th style={{ textAlign: 'right' }}>申请数量</th>
                  <th>拒单 / 拦截原因（T+1 / 涨跌停 / 停牌 / 卡片174监管 / 资金）</th>
                </tr>
              </thead>
              <tbody>
                {run.rejects.map((r, i) => (
                  <tr key={i}>
                    <td className="mono">{r.date}</td>
                    <td className="mono" style={{ fontWeight: 600 }}>{r.symbol}</td>
                    <td>{r.side}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{r.requestedShares}</td>
                    <td style={{ color: 'var(--amber)' }}>{r.reason}</td>
                  </tr>
                ))}
                {run.rejects.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 18 }}>
                      本次回测未发生任何涨跌停封死、停牌、T+1 或风控拒单记录。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 合规与回测风险边界页脚 */}
      <ComplianceDisclaimerBanner variant="footer" showExecutionBoundary />
    </div>
  );
};
