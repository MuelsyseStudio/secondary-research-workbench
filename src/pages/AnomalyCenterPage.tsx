import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BellPlus, ExternalLink, Loader2, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { ComplianceDisclaimerBanner } from '../components/ComplianceDisclaimerBanner';

interface AnomalyCenterPageProps {
  isActive?: boolean;
  onOpenFullscreenStock: (secidOrQuery: string) => void;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

export const AnomalyCenterPage: React.FC<AnomalyCenterPageProps> = ({ isActive = true, onOpenFullscreenStock, onToast }) => {
  const { t, pctColor, formatPct } = useI18n();
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [queryInput, setQueryInput] = useState('');
  const [singleResult, setSingleResult] = useState<any | null>(null);
  const [searching, setSearching] = useState(false);
  const [riskFilter, setRiskFilter] = useState<'all' | 'triggered' | 'critical' | 'warning'>('all');
  const prevActiveRef = useRef(isActive);

  const loadCenter = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getShortTermAnomaly();
      setData(res);
    } catch (err: any) {
      onToast(err.message || '加载异动中心失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    loadCenter();
  }, [loadCenter]);

  useEffect(() => {
    if (isActive && !prevActiveRef.current) {
      loadCenter();
    }
    prevActiveRef.current = isActive;
  }, [isActive, loadCenter]);

  const handleSingleCheck = async () => {
    const q = queryInput.trim();
    if (!q) return;
    setSearching(true);
    try {
      const res = await api.getShortTermAnomaly(q);
      setSingleResult(res.single || null);
    } catch (err: any) {
      onToast(err.message || '查询异动失败', 'error');
    } finally {
      setSearching(false);
    }
  };

  const handleAddToCard174 = async (item: any) => {
    try {
      const cur = await api.getRegulatoryWatchlist();
      if (cur.items.some((x) => x.code === item.code)) {
        onToast(t(`${item.name} 已在卡片 174 重点监控红线名单中`, `${item.name} is already on Card 174 redline list`), 'info');
        return;
      }
      const next = [
        ...cur.items,
        {
          id: `reg-${Date.now()}`,
          code: item.code,
          name: item.name,
          reason: `10日偏离 ${item.dev10dPct}% / 30日偏离 ${item.dev30dPct}%（自动雷达同步·卡片174）`,
          level: (item.riskLevel === 'triggered' ? 'ban' : 'monitor') as 'ban' | 'monitor',
          startDate: new Date().toISOString().slice(0, 10),
          endDate: '',
          active: true,
        },
      ];
      await api.saveRegulatoryWatchlist(next);
      onToast(t(`已将 ${item.name} 同步至「卡片 174 监管红线名单」`, `Synced ${item.name} to Card 174 Redline`), 'success');
      loadCenter();
    } catch (err: any) {
      onToast(err.message || '同步监管红线名单失败', 'error');
    }
  };

  const handleQuickBotAlert = async (item: any) => {
    try {
      const targetPrice = item.price ? Number((item.price * (1 + Math.max(0.03, (item.nextDaySafeMaxPct || 5) / 100))).toFixed(2)) : 0;
      await api.mutateBotWatchAlert({
        secid: item.secid,
        code: item.code,
        name: item.name,
        condition: 'pct_above',
        threshold: Math.max(3, Math.min(9.5, Number(item.nextDaySafeMaxPct || 7))),
        note: `临近严重异动红线预警（当前10日偏离 ${item.dev10dPct}%）`,
      });
      onToast(t(`已交给 Bot 实时盯防 ${item.name} 异动触发阈值（参考价 ${targetPrice}）`, `Bot alert created for ${item.name}`), 'success');
    } catch (err: any) {
      onToast(err.message || '创建 Bot 预警失败', 'error');
    }
  };

  const summary = data?.summary || {};
  const rows = (data?.items || []).filter((x: any) => riskFilter === 'all' || x.riskLevel === riskFilter);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Top Summary + Instant Single-Stock Calculator */}
      <div className="card" style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ShieldAlert size={16} color="#dc2626" />
            <strong style={{ fontSize: 14 }}>{t('A 股异动中心 · 严重异动与重点监控参考雷达', 'A-Share Severe Anomaly & Exchange Monitor Radar')}</strong>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
            {t('自动对照板块基准指数估算 10 日(+100%) 与 30 日(+200%) 累计偏离值（参考估算，非交易所官方停牌标准，请以交易所公告为准）', 'Reference 10D (+100%) & 30D (+200%) benchmark-adjusted deviation estimate (for reference only; subject to official exchange announcements)')}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            className="input"
            style={{ width: 200, height: 32, fontSize: 12 }}
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSingleCheck()}
            placeholder={t('单股异动测算：输入代码或简称...', 'Check single stock code/name...')}
          />
          <button type="button" className="btn btn-sm btn-primary" disabled={searching} onClick={handleSingleCheck}>
            {searching ? <Loader2 size={13} className="spin" /> : <Search size={13} />} {t('测算', 'Check')}
          </button>
          <button type="button" className="btn btn-sm" onClick={loadCenter}>
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {/* Single-stock Instant Result Card */}
      {singleResult && (
        <div className="card" style={{ padding: 12, border: '1.5px solid #dc2626', background: 'rgba(220,38,38,0.04)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div>
              <strong style={{ fontSize: 14, cursor: 'pointer' }} onClick={() => onOpenFullscreenStock(singleResult.secid)}>
                {singleResult.name} ({singleResult.code})
              </strong>{' '}
              <span className="badge badge-navy">{singleResult.board}</span>{' '}
              <span className={`badge ${singleResult.riskLevel === 'triggered' ? 'badge-crimson' : 'badge-amber'}`}>
                {singleResult.statusText}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="btn btn-sm" onClick={() => handleAddToCard174(singleResult)}>
                {t('同步至卡片174红线', 'Add to Card 174')}
              </button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => onOpenFullscreenStock(singleResult.secid)}>
                {t('全屏研究', 'Fullscreen')}
              </button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginTop: 8, fontSize: 12 }}>
            <div>10日偏离：<b className="mono">{singleResult.dev10dPct}%</b>（余量 {singleResult.gapTo100Pct}%）</div>
            <div>30日偏离：<b className="mono">{singleResult.dev30dPct}%</b>（余量 {singleResult.gapTo200Pct}%）</div>
            <div>次日安全涨幅上限：<b className="mono">+{singleResult.nextDaySafeMaxPct}%</b></div>
            <div>近10日普通异动：<b className="mono">{singleResult.recentNormalAnomalies} 次</b></div>
          </div>
        </div>
      )}

      {/* KPI Strip + Filter Pills */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[
            { id: 'all', label: `${t('全部扫描', 'All Scanned')} (${summary.scannedCount ?? 0})` },
            { id: 'triggered', label: `${t('已触发 / 重点监控红线', 'Triggered / Redline')} (${summary.triggeredCount ?? 0})` },
            { id: 'critical', label: `${t('临近红线 (<15%余量)', 'Critical <15%')} (${summary.criticalCount ?? 0})` },
            { id: 'warning', label: `${t('加速预警', 'Warning')} (${summary.warningCount ?? 0})` },
          ].map((f) => (
            <button
              key={f.id}
              type="button"
              className={`btn btn-sm ${riskFilter === f.id ? 'btn-primary' : ''}`}
              onClick={() => setRiskFilter(f.id as any)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          {t('本地卡片 174 监控名单', 'Card 174 Redline List')}: <b>{summary.manualRedlineCount ?? 0}</b> {t('只', 'stocks')}
        </span>
      </div>

      {/* Main Deviation Radar Table */}
      <div className="card" style={{ padding: 10, overflowX: 'auto' }}>
        <table className="table" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              <th>{t('股票 / 板块', 'Stock / Board')}</th>
              <th>{t('现价 / 涨幅', 'Price / Chg')}</th>
              <th>{t('10日偏离进度 (+100%)', '10D Dev (+100%)')}</th>
              <th>{t('30日偏离进度 (+200%)', '30D Dev (+200%)')}</th>
              <th>{t('次日触发空间', 'Next-Day Room')}</th>
              <th>{t('状态与公告', 'Status & Filings')}</th>
              <th>{t('联动操作', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((it: any) => (
              <tr key={it.secid}>
                <td style={{ cursor: 'pointer' }} onClick={() => onOpenFullscreenStock(it.secid)}>
                  <div style={{ fontWeight: 700 }}>
                    {it.name} {it.lbc >= 2 && <span className="badge badge-crimson" style={{ fontSize: 10 }}>{it.lbc}板</span>}
                  </div>
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{it.code} · {it.board}</div>
                </td>
                <td className="mono">
                  <div style={{ fontWeight: 700 }}>{it.price ?? '--'}</div>
                  <div style={{ color: pctColor(it.pct), fontWeight: 700 }}>{formatPct(it.pct)}</div>
                </td>
                <td style={{ minWidth: 155 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <b className="mono" style={{ color: it.dev10dPct >= 85 ? '#dc2626' : 'var(--text-primary)' }}>{it.dev10dPct}%</b>
                    <span className="mono" style={{ color: 'var(--text-muted)' }}>{t('余', 'Gap')} {it.gapTo100Pct}%</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 4, background: 'var(--bg-subtle)', overflow: 'hidden', marginTop: 3 }}>
                    <div
                      style={{
                        width: `${Math.min(100, Math.max(2, it.progress10Pct))}%`,
                        height: '100%',
                        background: it.dev10dPct >= 100 ? '#991b1b' : it.dev10dPct >= 85 ? '#dc2626' : it.dev10dPct >= 65 ? '#f59e0b' : '#0ea5e9',
                      }}
                    />
                  </div>
                </td>
                <td style={{ minWidth: 155 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <b className="mono">{it.dev30dPct}%</b>
                    <span className="mono" style={{ color: 'var(--text-muted)' }}>{t('余', 'Gap')} {it.gapTo200Pct}%</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 4, background: 'var(--bg-subtle)', overflow: 'hidden', marginTop: 3 }}>
                    <div
                      style={{
                        width: `${Math.min(100, Math.max(2, it.progress30Pct))}%`,
                        height: '100%',
                        background: it.dev30dPct >= 200 ? '#991b1b' : it.dev30dPct >= 170 ? '#dc2626' : '#6366f1',
                      }}
                    />
                  </div>
                </td>
                <td className="mono" style={{ fontWeight: 700, color: it.nextDaySafeMaxPct <= 5 ? '#dc2626' : 'var(--text-primary)' }}>
                  {it.gapTo100Pct <= 0 ? t('已触及', 'Triggered') : `+${it.nextDaySafeMaxPct}%`}
                </td>
                <td style={{ maxWidth: 230 }}>
                  <span className={`badge ${it.riskLevel === 'triggered' ? 'badge-crimson' : it.riskLevel === 'critical' ? 'badge-amber' : 'badge-muted'}`} style={{ fontSize: 10.5 }}>
                    {it.statusText}
                  </span>
                  {(it.announcements || []).slice(0, 1).map((a: any, idx: number) => (
                    <div key={idx} style={{ fontSize: 10.5, marginTop: 3 }}>
                      <a href={a.url || '#'} target="_blank" rel="noreferrer" style={{ color: 'var(--navy)' }}>
                        {a.date} {a.title.slice(0, 22)}... <ExternalLink size={9} />
                      </a>
                    </div>
                  ))}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button type="button" className="btn btn-sm" style={{ padding: '2px 6px', fontSize: 10.5 }} onClick={() => handleAddToCard174(it)}>
                      {t('+红线', '+174')}
                    </button>
                    <button type="button" className="btn btn-sm" style={{ padding: '2px 6px', fontSize: 10.5 }} onClick={() => handleQuickBotAlert(it)} title={t('交给Bot预警', 'Alert via Bot')}>
                      <BellPlus size={11} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ComplianceDisclaimerBanner variant="footer" />
    </div>
  );
};
