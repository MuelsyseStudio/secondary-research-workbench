import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Award, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';

interface DragonTigerPageProps {
  isActive?: boolean;
  onOpenFullscreenStock: (secidOrQuery: string) => void;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

export const DragonTigerPage: React.FC<DragonTigerPageProps> = ({ isActive = true, onOpenFullscreenStock, onToast }) => {
  const { t, pctColor, formatPct, formatYi, upColor, downColor } = useI18n();
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'net_buy' | 'net_sell' | 'three_day'>('all');
  const [q, setQ] = useState('');
  const prevActiveRef = useRef(isActive);

  const loadLhb = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getDragonTigerList();
      setData(res);
    } catch (err: any) {
      onToast(err.message || '加载龙虎榜失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    loadLhb();
  }, [loadLhb]);

  useEffect(() => {
    if (isActive && !prevActiveRef.current) {
      loadLhb();
    }
    prevActiveRef.current = isActive;
  }, [isActive, loadLhb]);

  const trend = data?.trend || [];
  const items = (data?.items || []).filter((it: any) => {
    if (filter === 'net_buy' && (it.netYi ?? 0) <= 0) return false;
    if (filter === 'net_sell' && (it.netYi ?? 0) >= 0) return false;
    if (filter === 'three_day' && !it.isThreeDay) return false;
    if (q.trim() && !`${it.name} ${it.code}`.toLowerCase().includes(q.trim().toLowerCase())) return false;
    return true;
  });

  const maxNetAbs = Math.max(1, ...trend.map((x: any) => Math.abs(x.netAmtYi || 0)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Top 10-Day LHB Trend */}
      <div className="card" style={{ padding: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Award size={16} color="#d97706" />
            <strong style={{ fontSize: 14 }}>
              {t('A 股龙虎榜 · 近 10 日上榜数与净额趋势', 'Dragon-Tiger List · 10-Day Volume & Net Flow')}
            </strong>
            {data?.latestDate && <span className="badge badge-navy mono">{data.latestDate}</span>}
          </div>
          <button type="button" className="btn btn-sm" onClick={loadLhb}>
            <RefreshCw size={12} className={loading ? 'spin' : ''} /> {t('刷新', 'Refresh')}
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, trend.length)}, minmax(0, 1fr))`, gap: 6, alignItems: 'end', height: 110, paddingTop: 10 }}>
          {trend.map((day: any) => {
            const hPct = Math.max(12, Math.round((Math.abs(day.netAmtYi || 0) / maxNetAbs) * 70));
            const pos = (day.netAmtYi ?? 0) >= 0;
            return (
              <div key={day.date} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <span className="mono" style={{ fontSize: 10, color: pos ? upColor : downColor, fontWeight: 700 }}>
                  {day.netAmtYi > 0 ? '+' : ''}{day.netAmtYi}亿
                </span>
                <div style={{ width: '65%', height: hPct, borderRadius: 4, background: pos ? upColor : downColor, opacity: 0.85 }} />
                <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {day.date.slice(5)} ({day.stockCount})
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Filters & Table */}
      <div className="card" style={{ padding: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {[
              { id: 'all', label: t('全部上榜', 'All Listed') },
              { id: 'net_buy', label: t('净买入', 'Net Buy') },
              { id: 'net_sell', label: t('净卖出', 'Net Sell') },
              { id: 'three_day', label: t('三日榜', '3-Day List') },
            ].map((f) => (
              <button key={f.id} type="button" className={`btn btn-sm ${filter === f.id ? 'btn-primary' : ''}`} onClick={() => setFilter(f.id as any)}>
                {f.label}
              </button>
            ))}
          </div>
          <input
            className="input"
            style={{ width: 200, height: 30, fontSize: 12 }}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('搜索龙虎榜股票或代码...', 'Filter LHB stock...')}
          />
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>{t('上榜个股', 'Stock')}</th>
                <th>{t('上榜原因', 'Reason')}</th>
                <th>{t('买入额', 'Buy')}</th>
                <th>{t('卖出额', 'Sell')}</th>
                <th>{t('净额', 'Net')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it: any) => (
                <tr key={it.code} style={{ cursor: 'pointer' }} onClick={() => onOpenFullscreenStock(it.secid)}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <strong>{it.name}</strong>
                      <span className="mono" style={{ color: pctColor(it.pct), fontWeight: 700 }}>{formatPct(it.pct)}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
                      <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{it.code} · {t('换手', 'TO')} {it.turnoverPct ?? '-'}%</span>
                      {(it.tags || []).map((tg: string) => (
                        <span key={tg} className="badge badge-amber" style={{ fontSize: 9.5, padding: '0 4px' }}>{tg}</span>
                      ))}
                    </div>
                  </td>
                  <td style={{ maxWidth: 340, fontSize: 11.5, color: 'var(--text-secondary)' }}>
                    {(it.reasons || []).join('；')}
                  </td>
                  <td className="mono" style={{ color: upColor, fontWeight: 700 }}>{formatYi(it.buyYi)}</td>
                  <td className="mono" style={{ color: downColor, fontWeight: 700 }}>{formatYi(it.sellYi)}</td>
                  <td className="mono" style={{ color: pctColor(it.netYi), fontWeight: 800 }}>
                    {it.netYi > 0 ? '+' : ''}{formatYi(it.netYi)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
