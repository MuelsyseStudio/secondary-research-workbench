import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Flame, Grid, Layers, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';

interface CloudTreemapPageProps {
  isActive?: boolean;
  onOpenFullscreenStock: (secidOrQuery: string) => void;
  onNavigateTheme?: (themeCode: string) => void;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

function heatBg(pct: number, isGlobalGreenUp: boolean): { bg: string; fg: string } {
  const up = isGlobalGreenUp;
  if (pct >= 3) return { bg: up ? '#15803d' : '#b91c1c', fg: '#ffffff' };
  if (pct >= 1.5) return { bg: up ? '#22c55e' : '#ef4444', fg: '#ffffff' };
  if (pct > 0.05) return { bg: up ? '#bbf7d0' : '#fecaca', fg: '#0f172a' };
  if (pct <= -3) return { bg: up ? '#b91c1c' : '#15803d', fg: '#ffffff' };
  if (pct <= -1.5) return { bg: up ? '#ef4444' : '#22c55e', fg: '#ffffff' };
  if (pct < -0.05) return { bg: up ? '#fecaca' : '#bbf7d0', fg: '#0f172a' };
  return { bg: '#e2e8f0', fg: '#334155' };
}

function sealBg(sealYi: number): { bg: string; fg: string } {
  if (sealYi >= 3) return { bg: '#991b1b', fg: '#ffffff' };
  if (sealYi >= 1) return { bg: '#dc2626', fg: '#ffffff' };
  if (sealYi >= 0.3) return { bg: '#f87171', fg: '#ffffff' };
  return { bg: '#fca5a5', fg: '#1e293b' };
}

export const CloudTreemapPage: React.FC<CloudTreemapPageProps> = ({
  isActive = true,
  onOpenFullscreenStock,
  onToast,
}) => {
  const { t, formatPct, formatYi, colorConvention } = useI18n();
  const [tab, setTab] = useState<'theme' | 'emotion'>('theme');
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState('');
  const prevActiveRef = useRef(isActive);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getCloudTreemaps();
      setData(res);
    } catch (err: any) {
      onToast(err.message || '加载云图失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (isActive && !prevActiveRef.current) {
      loadData();
    }
    prevActiveRef.current = isActive;
  }, [isActive, loadData]);

  const isGlobal = colorConvention === 'global_green_up';
  const themeBlocks = (data?.themeBlocks || []).filter(
    (b: any) => !filterText.trim() || b.name.toLowerCase().includes(filterText.trim().toLowerCase())
  );
  const maxAmt = Math.max(1, ...themeBlocks.map((b: any) => b.amountYi || 1));

  const emotionGroups = (data?.emotionGroups || []).filter(
    (g: any) =>
      !filterText.trim() ||
      g.theme.toLowerCase().includes(filterText.trim().toLowerCase()) ||
      g.stocks.some((s: any) => s.name.toLowerCase().includes(filterText.trim().toLowerCase()))
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card" style={{ padding: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className={`btn btn-sm ${tab === 'theme' ? 'btn-primary' : ''}`} onClick={() => setTab('theme')}>
            <Grid size={13} /> {t('题材云图（成交额面积 × 涨跌幅色）', 'Theme Treemap (Turnover × Change)')}
          </button>
          <button type="button" className={`btn btn-sm ${tab === 'emotion' ? 'btn-primary' : ''}`} onClick={() => setTab('emotion')}>
            <Flame size={13} /> {t('情绪云图（涨停封单金额 × 题材分组）', 'Emotion Seal-Order Cloud')}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className="input"
            style={{ width: 190, height: 30, fontSize: 12 }}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder={t('筛选题材或涨停个股...', 'Filter theme or ticker...')}
          />
          <button type="button" className="btn btn-sm" onClick={loadData}>
            <RefreshCw size={12} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {tab === 'theme' ? (
        <div className="card" style={{ padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, fontSize: 11.5, color: 'var(--text-muted)' }}>
            <span>
              <Layers size={12} style={{ verticalAlign: -2 }} /> {t('面积代表板块成交额，颜色代表当日涨跌幅（自动同步当前红/绿涨跌色习惯）', 'Tile size = Turnover, Color = Daily Return')}
            </span>
            <span>{t('共展示热门核心题材', 'Showing Top Themes')}: {themeBlocks.length}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {themeBlocks.map((b: any) => {
              const weight = Math.max(0.18, Math.sqrt((b.amountYi || 1) / maxAmt));
              const basisPx = Math.round(115 + weight * 165);
              const minH = Math.round(78 + weight * 58);
              const { bg, fg } = heatBg(b.pct ?? 0, isGlobal);
              return (
                <div
                  key={b.code}
                  style={{
                    flex: `${Math.round(weight * 100)} 1 ${basisPx}px`,
                    minHeight: minH,
                    background: bg,
                    color: fg,
                    borderRadius: 8,
                    padding: '10px 10px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    alignItems: 'center',
                    textAlign: 'center',
                    gap: 2,
                    border: '1px solid rgba(255,255,255,0.22)',
                  }}
                  title={`${b.name} · 涨幅 ${formatPct(b.pct)} · 成交 ${formatYi(b.amountYi)} · 主力净额 ${formatYi(b.mainNetYi)} · 领涨 ${b.leaderName}`}
                >
                  <div style={{ fontWeight: 800, fontSize: weight > 0.6 ? 15 : 12.5 }}>{b.name}</div>
                  <div className="mono" style={{ fontWeight: 800, fontSize: weight > 0.6 ? 14 : 12 }}>{formatPct(b.pct)}</div>
                  <div className="mono" style={{ fontSize: 10.5, opacity: 0.9 }}>{t('成交', 'Vol')} {formatYi(b.amountYi)}</div>
                  {b.totalCount > 0 && (
                    <div style={{ fontSize: 10, opacity: 0.85 }}>
                      {t('涨', 'Up')} {b.upCount}/{b.totalCount} · {b.leaderName}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, fontSize: 12 }}>
            <strong>
              {t('全市场涨停封单云图', 'Market Limit-Up Seal Cloud')} · {data?.emotionSummary?.ztCount ?? 0} {t('只涨停', 'stocks')} · {t('封单合计', 'Total Seal')}{' '}
              <span className="mono" style={{ color: '#dc2626' }}>{formatYi(data?.emotionSummary?.totalSealYi)}</span>
            </strong>
            <div style={{ display: 'flex', gap: 6, fontSize: 10.5 }}>
              <span style={{ padding: '1px 6px', borderRadius: 4, background: '#fca5a5', color: '#1e293b' }}>&lt;0.3亿</span>
              <span style={{ padding: '1px 6px', borderRadius: 4, background: '#f87171', color: '#fff' }}>0.3-1亿</span>
              <span style={{ padding: '1px 6px', borderRadius: 4, background: '#dc2626', color: '#fff' }}>1-3亿</span>
              <span style={{ padding: '1px 6px', borderRadius: 4, background: '#991b1b', color: '#fff' }}>≥3亿</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {emotionGroups.map((g: any) => {
              const gWeight = Math.max(1, Math.round(Math.sqrt(Math.max(0.2, g.totalSealYi)) * 40));
              return (
                <div
                  key={g.theme}
                  style={{
                    flex: `${gWeight} 1 240px`,
                    border: '1px solid var(--border-strong)',
                    borderRadius: 8,
                    padding: 8,
                    background: 'var(--bg-subtle)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, fontWeight: 800, marginBottom: 6 }}>
                    <span>{g.theme} ({g.stocks.length})</span>
                    <span className="mono" style={{ color: '#dc2626' }}>{formatYi(g.totalSealYi)}</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {g.stocks.map((st: any) => {
                      const sw = Math.max(1, Math.round(Math.sqrt(Math.max(0.05, st.sealFundYi)) * 35));
                      const { bg, fg } = sealBg(st.sealFundYi);
                      return (
                        <div
                          key={st.code}
                          onClick={() => onOpenFullscreenStock(st.secid)}
                          style={{
                            cursor: 'pointer',
                            flex: `${sw} 1 88px`,
                            minHeight: st.sealFundYi >= 1 ? 66 : 52,
                            background: bg,
                            color: fg,
                            borderRadius: 6,
                            padding: 6,
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'center',
                            alignItems: 'center',
                            textAlign: 'center',
                          }}
                          title={`${st.name} (${st.code}) · ${st.lbc}板 · 封单 ${st.sealFundYi}亿 · 封流比 ${st.sealToFloatPct ?? '-'}% · 流通 ${st.floatCapYi}亿`}
                        >
                          <div style={{ fontWeight: 800, fontSize: 12 }}>{st.name}</div>
                          <div className="mono" style={{ fontSize: 11, fontWeight: 700 }}>{st.sealFundYi}亿</div>
                          <div style={{ fontSize: 9.5, opacity: 0.9 }}>
                            {st.lbc}{t('板', 'B')} · {st.sealToFloatPct != null ? `${st.sealToFloatPct}%` : ''}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
