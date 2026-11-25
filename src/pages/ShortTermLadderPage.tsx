import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Flame, Layers, RefreshCw, TrendingUp, Zap } from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';

interface ShortTermLadderPageProps {
  isActive?: boolean;
  onOpenFullscreenStock: (secidOrQuery: string) => void;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

const MiniLineChart: React.FC<{
  title: string;
  dates: string[];
  series: { label: string; color: string; values: (number | null)[] }[];
  unit?: string;
}> = ({ title, dates, series, unit = '' }) => {
  const validVals = series.flatMap((s) => s.values.filter((v): v is number => v != null && Number.isFinite(v)));
  const minV = validVals.length ? Math.min(...validVals) : 0;
  const maxV = validVals.length ? Math.max(...validVals) : 10;
  const pad = Math.max(1, (maxV - minV) * 0.15);
  const lo = minV - pad;
  const hi = maxV + pad;
  const span = Math.max(0.001, hi - lo);
  const w = 440;
  const h = 128;

  return (
    <div className="card" style={{ padding: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
        <strong style={{ fontSize: 12.5 }}>{title}</strong>
        <div style={{ display: 'flex', gap: 10, fontSize: 10.5 }}>
          {series.map((s) => {
            const lastVal = [...s.values].reverse().find((v) => v != null);
            return (
              <span key={s.label} style={{ color: s.color, fontWeight: 700 }}>
                ● {s.label}: {lastVal != null ? `${lastVal}${unit}` : '--'}
              </span>
            );
          })}
        </div>
      </div>
      {dates.length < 2 ? (
        <div style={{ height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, color: 'var(--text-muted)' }}>
          数据累积中（每日看盘自动追加记录）
        </div>
      ) : (
        <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: h, display: 'block' }}>
          {[0.2, 0.5, 0.8].map((r) => (
            <line key={r} x1={0} y1={h * r} x2={w} y2={h * r} stroke="var(--border)" strokeDasharray="3 3" strokeWidth={0.8} />
          ))}
          {series.map((s) => {
            const pts = s.values
              .map((v, idx) => {
                if (v == null || !Number.isFinite(v)) return null;
                const x = (idx / Math.max(1, dates.length - 1)) * (w - 20) + 10;
                const y = h - 18 - ((v - lo) / span) * (h - 28);
                return { x, y, v };
              })
              .filter(Boolean) as { x: number; y: number; v: number }[];
            if (pts.length < 2) return null;
            const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
            return (
              <g key={s.label}>
                <path d={pathD} fill="none" stroke={s.color} strokeWidth={2} />
                {pts.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r={2.4} fill={s.color} />
                ))}
              </g>
            );
          })}
          <text x={8} y={h - 3} fontSize={9.5} fill="var(--text-muted)">{dates[0]?.slice(5)}</text>
          <text x={w - 42} y={h - 3} fontSize={9.5} fill="var(--text-muted)">{dates[dates.length - 1]?.slice(5)}</text>
        </svg>
      )}
    </div>
  );
};

export const ShortTermLadderPage: React.FC<ShortTermLadderPageProps> = ({ isActive = true, onOpenFullscreenStock, onToast }) => {
  const { t, pctColor, formatPct, formatYi, upColor, downColor } = useI18n();
  const [subTab, setSubTab] = useState<'ladder' | 'cycle' | 'auction'>('ladder');
  const [data, setData] = useState<any | null>(null);
  const [auction, setAuction] = useState<any | null>(null);
  const [themeFilter, setThemeFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const prevActiveRef = useRef(isActive);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [lad, auc] = await Promise.all([
        api.getShortTermLadder(),
        api.getAuctionRadar().catch(() => null),
      ]);
      setData(lad);
      setAuction(auc);
    } catch (err: any) {
      onToast(err.message || '加载连板天梯失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (isActive && !prevActiveRef.current) {
      loadAll();
    }
    prevActiveRef.current = isActive;
  }, [isActive, loadAll]);

  const summary = data?.summary || {};
  const history = data?.cycleHistory || [];
  const dates = history.map((h: any) => h.date);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header & Sub-tabs */}
      <div className="card" style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className={`btn btn-sm ${subTab === 'ladder' ? 'btn-primary' : ''}`} onClick={() => setSubTab('ladder')}>
            <Layers size={13} /> {t('经典连板天梯', 'Board Streak Ladder')}
          </button>
          <button type="button" className={`btn btn-sm ${subTab === 'cycle' ? 'btn-primary' : ''}`} onClick={() => setSubTab('cycle')}>
            <TrendingUp size={13} /> {t('4 联龙头情绪周期', '4-Chart Emotion Cycle')}
          </button>
          <button type="button" className={`btn btn-sm ${subTab === 'auction' ? 'btn-primary' : ''}`} onClick={() => setSubTab('auction')}>
            <Zap size={13} /> {t('竞价与封单强度雷达', 'Auction & Seal Radar')}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <span className="badge badge-crimson">{t('涨停', 'ZT')} {summary.ztCount ?? '-'}</span>
          <span className="badge badge-amber">{t('连板', 'Streak')} {summary.lianbanCount ?? '-'} · {t('高度', 'Max')} {summary.maxBoard ?? '-'}{t('板', 'B')}</span>
          <span className="badge badge-teal">{t('封板率', 'Seal')} {summary.sealRatePct ?? '-'}%</span>
          <span className="badge badge-muted">{t('跌停', 'DT')} {summary.dtCount ?? '-'} / {t('炸板', 'Burst')} {summary.zbCount ?? '-'}</span>
          <button type="button" className="btn btn-sm" onClick={loadAll}>
            <RefreshCw size={12} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {/* Sub-tab 1: 弈盘经典连板天梯 */}
      {subTab === 'ladder' && (
        <>
          {/* Theme Aggregation Filter Pills */}
          <div className="card" style={{ padding: 10, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)' }}>
              <Flame size={12} color="#dc2626" /> {t('今日涨停题材分布：', 'Limit-Up Themes:')}
            </span>
            <button
              type="button"
              className={`btn btn-sm ${!themeFilter ? 'btn-primary' : ''}`}
              style={{ fontSize: 11, padding: '2px 8px' }}
              onClick={() => setThemeFilter('')}
            >
              {t('全部', 'All')} ({summary.ztCount ?? 0})
            </button>
            {(data?.themes || []).slice(0, 14).map((th: any) => (
              <button
                key={th.name}
                type="button"
                className={`btn btn-sm ${themeFilter === th.name ? 'btn-primary' : ''}`}
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => setThemeFilter(themeFilter === th.name ? '' : th.name)}
              >
                {th.name} <b>{th.count}</b>
              </button>
            ))}
          </div>

          {/* Ladder Tiers */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(data?.levels || []).map((lvl: any) => {
              const filteredStocks = (lvl.stocks || []).filter((s: any) => !themeFilter || s.industry === themeFilter);
              if (filteredStocks.length === 0) return null;
              return (
                <div key={lvl.board} className="card" style={{ padding: 12, display: 'grid', gridTemplateColumns: '108px 1fr', gap: 12 }}>
                  <div style={{ borderRight: '2px solid var(--navy)', paddingRight: 10, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    <div style={{ fontSize: 20, fontWeight: 900, color: lvl.board >= 3 ? '#dc2626' : 'var(--navy)' }}>
                      {lvl.board}{t('板', 'B')}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {lvl.board > 1 && lvl.promotionRatePct != null
                        ? `${lvl.count}/${lvl.prevCount} = ${lvl.promotionRatePct}%`
                        : `${lvl.count} ${t('家首板', 'stocks')}`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {filteredStocks.map((st: any) => (
                      <div
                        key={st.code}
                        onClick={() => onOpenFullscreenStock(st.secid)}
                        style={{
                          cursor: 'pointer',
                          width: 118,
                          padding: '7px 8px',
                          borderRadius: 8,
                          border: st.boardStyle === '一字' ? '1.5px solid #d97706' : '1px solid var(--border-strong)',
                          background: st.boardStyle === '一字' ? 'rgba(245,158,11,0.08)' : 'var(--bg-subtle)',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: 2,
                        }}
                        title={`${st.name} (${st.code}) · ${st.stat} · 封单 ${st.sealFundYi}亿 · 换手 ${st.turnoverPct}%`}
                      >
                        <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                          {st.boardStyle !== '换手' && (
                            <span style={{ fontSize: 9.5, fontWeight: 700, color: '#b45309' }}>{st.boardStyle}</span>
                          )}
                          {st.is20cm && <span style={{ fontSize: 9.5, fontWeight: 700, color: '#dc2626' }}>20cm</span>}
                        </div>
                        <div style={{ fontWeight: 800, fontSize: 12.5 }}>{st.name}</div>
                        <div style={{ fontSize: 10.5, color: '#dc2626', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                          {st.industry}
                        </div>
                        <div className="mono" style={{ fontSize: 10.5, color: '#0284c7', fontWeight: 700 }}>
                          {st.firstSealTime} · {st.sealFundYi > 0 ? `${st.sealFundYi}亿` : `${st.turnoverPct ?? '-'}%`}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Sub-tab 2: 弈盘 4 联短线龙头情绪周期图 */}
      {subTab === 'cycle' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {history.some((h: any) => h.fromLedger) && (
            <div style={{ padding: '7px 12px', borderRadius: 8, background: 'var(--bg-soft)', border: '1px solid var(--border)', fontSize: 11.5, color: 'var(--text-secondary)' }}>
              数据口径说明：历史早期节点来自台账正文明确记录的实测字段（未记录字段留空不插值），实盘开市期间每日自动采集完整涨跌停/炸板/溢价快照并持续累积。
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <MiniLineChart
            title={t('01 龙头连板高度（最高板 vs 次高板）', '01 Leader Streak Height (Max vs 2nd)')}
            dates={dates}
            series={[
              { label: t('最高连板', 'Max Board'), color: '#dc2626', values: history.map((h: any) => h.maxBoard ?? null) },
              { label: t('次高连板', '2nd Board'), color: '#0284c7', values: history.map((h: any) => h.secondBoard ?? null) },
              { label: t('连板家数', 'Streaks'), color: '#d97706', values: history.map((h: any) => h.lianbanCount ?? null) },
            ]}
          />
          <MiniLineChart
            title={t('02 涨跌停与炸板家数周期', '02 Limit-Up / Limit-Down / Burst')}
            dates={dates}
            series={[
              { label: t('涨停家数', 'Limit-Up'), color: upColor, values: history.map((h: any) => h.ztCount ?? null) },
              { label: t('炸板家数', 'Burst'), color: '#f59e0b', values: history.map((h: any) => h.zbCount ?? null) },
              { label: t('跌停家数', 'Limit-Down'), color: downColor, values: history.map((h: any) => h.dtCount ?? null) },
            ]}
          />
          <MiniLineChart
            title={t('03 情绪温度 & 封板率轨迹', '03 Sentiment Temp & Seal Rate')}
            dates={dates}
            unit="%"
            series={[
              { label: t('情绪温度', 'Temp'), color: '#7c3aed', values: history.map((h: any) => h.sentimentScore ?? null) },
              { label: t('封板率', 'Seal Rate'), color: '#0ea5e9', values: history.map((h: any) => h.sealRatePct ?? null) },
            ]}
          />
          <MiniLineChart
            title={t('04 短线赚钱效应（昨日涨停 & 昨日连板溢价）', '04 Profit Effect (Yest ZT & Streak Premium)')}
            dates={dates}
            unit="%"
            series={[
              { label: t('昨日涨停溢价', 'Yest ZT%'), color: '#dc2626', values: history.map((h: any) => h.yestZtPremiumPct ?? null) },
              { label: t('昨日连板溢价', 'Yest LB%'), color: '#8b5cf6', values: history.map((h: any) => h.yestLianbanPremiumPct ?? null) },
            ]}
          />
          </div>
        </div>
      )}

      {/* Sub-tab 3: 弈盘竞价与封单强度雷达 */}
      {subTab === 'auction' && auction && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {/* 封单额 Top 10 */}
            <div className="card" style={{ padding: 12 }}>
              <strong style={{ fontSize: 13 }}>{t('涨停封单金额 Top 10', 'Top 10 Limit-Up Seal Orders')}</strong>
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(auction.topSealAmount || []).map((st: any) => {
                  const maxVal = auction.topSealAmount[0]?.sealFundYi || 1;
                  return (
                    <div
                      key={st.code}
                      onClick={() => onOpenFullscreenStock(st.secid)}
                      style={{ cursor: 'pointer', display: 'grid', gridTemplateColumns: '84px 1fr 68px', alignItems: 'center', gap: 8, fontSize: 11.5 }}
                    >
                      <span style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {st.name} <small style={{ color: '#dc2626' }}>{st.lbc}B</small>
                      </span>
                      <div style={{ height: 14, background: 'var(--bg-subtle)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{ width: `${Math.max(4, (st.sealFundYi / maxVal) * 100)}%`, height: '100%', background: '#dc2626' }} />
                      </div>
                      <span className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{st.sealFundYi}亿</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 封单/实际流通市值 Top 10 */}
            <div className="card" style={{ padding: 12 }}>
              <strong style={{ fontSize: 13 }}>{t('封流比（封单额 / 流通市值）Top 10', 'Top 10 Seal / Float Cap Ratio')}</strong>
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(auction.topSealRatio || []).map((st: any) => {
                  const maxVal = auction.topSealRatio[0]?.sealRatioPct || 1;
                  return (
                    <div
                      key={st.code}
                      onClick={() => onOpenFullscreenStock(st.secid)}
                      style={{ cursor: 'pointer', display: 'grid', gridTemplateColumns: '84px 1fr 68px', alignItems: 'center', gap: 8, fontSize: 11.5 }}
                    >
                      <span style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{st.name}</span>
                      <div style={{ height: 14, background: 'var(--bg-subtle)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{ width: `${Math.max(4, (st.sealRatioPct / maxVal) * 100)}%`, height: '100%', background: '#d97706' }} />
                      </div>
                      <span className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{st.sealRatioPct}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* 竞价高开抢筹异动表 */}
          <div className="card" style={{ padding: 12 }}>
            <strong style={{ fontSize: 13 }}>{t('早盘高开抢筹 / 爆量异动榜（点击全屏看盘）', 'Opening Gap & High Volume Ratio Movers')}</strong>
            <div style={{ marginTop: 8, overflowX: 'auto' }}>
              <table className="table" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>{t('标的', 'Stock')}</th>
                    <th>{t('板块', 'Industry')}</th>
                    <th>{t('开盘高开%', 'Open Gap%')}</th>
                    <th>{t('实时涨幅', 'Live Chg%')}</th>
                    <th>{t('量比', 'Vol Ratio')}</th>
                    <th>{t('成交额', 'Turnover')}</th>
                    <th>{t('主力净额', 'Main Net')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(auction.openMovers || []).map((m: any) => (
                    <tr key={m.code} style={{ cursor: 'pointer' }} onClick={() => onOpenFullscreenStock(m.secid)}>
                      <td><b>{m.name}</b> <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{m.code}</span></td>
                      <td>{m.industry}</td>
                      <td className="mono" style={{ fontWeight: 700, color: pctColor(m.openGapPct) }}>{formatPct(m.openGapPct)}</td>
                      <td className="mono" style={{ fontWeight: 700, color: pctColor(m.pct) }}>{formatPct(m.pct)}</td>
                      <td className="mono">{m.volumeRatio ?? '-'}x</td>
                      <td className="mono">{formatYi(m.amountYi)}</td>
                      <td className="mono" style={{ color: pctColor(m.mainNetYi), fontWeight: 700 }}>{formatYi(m.mainNetYi)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
