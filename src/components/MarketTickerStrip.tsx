import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Database, Maximize2, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type { DataSourceChannelId } from '../types';

interface MarketTickerStripProps {
  onSelectStock?: (secid: string, name?: string) => void;
  onOpenFullscreenStock?: (secid: string) => void;
  onOpenDataSources?: (channel?: DataSourceChannelId) => void;
  customSourceCount?: number;
}

const CORE_INDEX_ORDER = ['1.000001', '0.399001', '0.399006', '1.000688', '0.899050'];

function formatAsOfClock(isoOrTime?: string | null): string {
  if (!isoOrTime) return '';
  const s = String(isoOrTime).trim();
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(s)) return s;
  const m = s.match(/T(\d{2}:\d{2}:\d{2})/);
  if (m) return m[1];
  return s.slice(0, 16);
}

export const MarketTickerStrip: React.FC<MarketTickerStripProps> = ({
  onSelectStock,
  onOpenFullscreenStock,
  onOpenDataSources,
  customSourceCount = 0,
}) => {
  const { pctColor, formatPct, formatYi, upColor, downColor, t } = useI18n();
  const [snap, setSnap] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const inFlightRef = React.useRef(false);
  const failCountRef = React.useRef(0);

  const load = useCallback(async (force = false) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      const dash = await api.getMarketTickerStrip(force);
      setSnap(dash);
      if (dash?.dataStatus === 'error' || dash?.ok === false) {
        failCountRef.current = Math.min(4, failCountRef.current + 1);
        setLoadError(
          Object.values(dash?.sectionErrors || {}).join('；') ||
            t('上游行情源暂不可用', 'Upstream market feeds unavailable')
        );
      } else {
        failCountRef.current = 0;
      }
    } catch (err: any) {
      failCountRef.current = Math.min(4, failCountRef.current + 1);
      setLoadError(err?.message || t('行情请求超时', 'Market feed timeout'));
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (!alive) return;
      const delayMs = 30000 * Math.pow(2, Math.min(2, failCountRef.current));
      timer = setTimeout(async () => {
        if (!alive) return;
        if (typeof document === 'undefined' || !document.hidden) {
          await load(false);
        }
        schedule();
      }, delayMs);
    };
    load(false).finally(schedule);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const benchmarks: any[] = snap?.benchmarks || [];
  const temp = snap?.temperature || {};
  const dataStatus: string = loadError
    ? snap?.dataStatus === 'degraded'
      ? 'degraded'
      : 'error'
    : snap?.dataStatus || (snap ? 'delayed' : 'loading');
  const asOfLabel = formatAsOfClock(snap?.asOf || snap?.fetchedAt);
  const degradedList: string[] = Array.isArray(snap?.degradedSections) ? snap.degradedSections : [];

  const statusMeta = (() => {
    if (dataStatus === 'live') return { label: t('实时', 'Live'), color: 'var(--emerald)' };
    if (dataStatus === 'delayed') return { label: t('收盘/延迟', 'Delayed'), color: 'var(--navy)' };
    if (dataStatus === 'cached') return { label: t('缓存', 'Cached'), color: 'var(--amber)' };
    if (dataStatus === 'degraded') return { label: t('部分降级', 'Degraded'), color: 'var(--amber)' };
    if (dataStatus === 'demo') return { label: t('演示', 'Demo'), color: 'var(--violet)' };
    if (dataStatus === 'error') return { label: t('异常', 'Error'), color: 'var(--crimson)' };
    return { label: t('加载中', 'Loading'), color: 'var(--text-muted)' };
  })();

  const orderedIndices = CORE_INDEX_ORDER.map((sec) => benchmarks.find((b) => b.secid === sec)).filter(Boolean);
  const displayIndices = orderedIndices.length >= 3 ? orderedIndices : benchmarks.slice(0, 5);

  return (
    <div className="st-ticker-strip num">
      <div className="st-ticker-indices">
        {displayIndices.length === 0 ? (
          <span className="st-muted" style={{ fontSize: 11.5 }}>
            {loadError ? t('指数行情暂不可用', 'Index quotes unavailable') : t('正在获取核心指数...', 'Loading index quotes...')}
          </span>
        ) : (
          displayIndices.map((idx: any) => (
            <button
              key={idx.secid}
              type="button"
              className="st-ticker-chip"
              onClick={() => (onSelectStock ? onSelectStock(idx.secid, idx.name) : onOpenFullscreenStock?.(idx.secid))}
              title={t(`点击联动查看 ${idx.name}`, `Inspect ${idx.name}`)}
            >
              <span className="st-ticker-name">{idx.name.replace('指数', '').replace('成指', '')}</span>
              <span className="mono" style={{ fontWeight: 700, color: pctColor(idx.pct) }}>
                {idx.price != null ? Number(idx.price).toFixed(2) : '—'}
              </span>
              <span className="mono" style={{ fontWeight: 700, color: pctColor(idx.pct) }}>
                {idx.pct != null ? formatPct(idx.pct) : '—'}
              </span>
            </button>
          ))
        )}
      </div>

      <div className="st-ticker-stats">
        <span className="st-ticker-metric">
          <span className="st-muted">{t('两市', 'Turnover')}</span>
          <b className="mono" style={{ color: 'var(--navy)' }}>
            {temp.twoMarketAmtYi != null ? formatYi(temp.twoMarketAmtYi) : '—'}
          </b>
          {temp.estFullDayAmtYi != null && temp.estFullDayAmtYi !== temp.twoMarketAmtYi && (
            <span className="mono st-muted">({t('预', 'Est')}{formatYi(temp.estFullDayAmtYi)})</span>
          )}
        </span>
        <span className="st-ticker-sep" />
        <span className="st-ticker-metric">
          <span className="st-muted">{t('涨跌', 'A/D')}</span>
          <b className="mono" style={{ color: upColor }}>{temp.up != null ? temp.up : '—'}</b>
          {temp.up != null && temp.down != null && temp.up + temp.down > 0 && (
            <span
              style={{
                display: 'inline-flex',
                width: 44,
                height: 5,
                borderRadius: 99,
                overflow: 'hidden',
                background: downColor,
              }}
              title={t(`红盘率 ${temp.redRatePct ?? '—'}%`, `Advancing ${temp.redRatePct ?? '—'}%`)}
            >
              <span
                style={{
                  width: `${Math.round((temp.up / (temp.up + temp.down)) * 100)}%`,
                  background: upColor,
                }}
              />
            </span>
          )}
          <b className="mono" style={{ color: downColor }}>{temp.down != null ? temp.down : '—'}</b>
        </span>
        <span className="st-ticker-sep" />
        <span className="st-ticker-metric">
          <span className="st-muted">{t('涨停', 'LU')}</span>
          <b className="mono" style={{ color: upColor }}>{temp.ztCount != null ? temp.ztCount : '—'}</b>
          <span className="st-muted">{t('炸', 'Brk')}</span>
          <b className="mono" style={{ color: downColor }}>{temp.zbCount != null ? temp.zbCount : '—'}</b>
          <span className="st-muted">{t('高', 'Max')}</span>
          <b className="mono" style={{ color: 'var(--amber)' }}>
            {temp.maxBoard != null ? `${temp.maxBoard}B` : '—'}
          </b>
        </span>
        <span className="st-ticker-sep" />
        <span className="st-ticker-metric">
          <span className="st-muted">{t('温度', 'Temp')}</span>
          <b
            className="mono"
            style={{
              color:
                temp.sentimentScore == null
                  ? 'var(--text-muted)'
                  : temp.sentimentScore >= 60
                  ? upColor
                  : 'var(--amber)',
            }}
          >
            {temp.sentimentScore != null ? temp.sentimentScore : '—'}
          </b>
        </span>

        {onOpenDataSources && (
          <button
            type="button"
            className="st-strip-btn"
            onClick={() => onOpenDataSources('cn_quotes')}
            title={t(
              `数据源：${snap?.source || '默认公开源'}（点击管理可插拔数据源 / L2 / Webhook）`,
              `Source: ${snap?.source || 'Default public feed'} (Configure pluggable feeds / L2 / Webhook)`
            )}
          >
            <Database size={11} />
            <span>
              {customSourceCount > 0
                ? t(`自定义(${customSourceCount})`, `Custom(${customSourceCount})`)
                : t('免费源', 'Free')}
            </span>
          </button>
        )}

        <button
          type="button"
          className="st-strip-btn"
          style={
            dataStatus === 'error'
              ? { color: 'var(--crimson)', borderColor: 'var(--crimson)' }
              : dataStatus === 'degraded' || dataStatus === 'cached'
              ? { color: 'var(--amber)', borderColor: 'var(--amber)' }
              : undefined
          }
          onClick={() => load(true)}
          title={
            loadError
              ? t(`行情异常：${loadError}（点击强制重试）`, `Feed error: ${loadError} (Click to retry)`)
              : degradedList.length > 0
              ? t(
                  `部分分区降级：${degradedList.join(', ')}｜数据时点 ${asOfLabel || '—'}（点击强制刷新）`,
                  `Degraded sections: ${degradedList.join(', ')} | As of ${asOfLabel || '—'} (Click to retry)`
                )
              : t(
                  `状态：${statusMeta.label}｜数据时点：${asOfLabel || '—'}｜来源：${snap?.source || '公开源'}（点击强制刷新）`,
                  `Status: ${statusMeta.label} | As of: ${asOfLabel || '—'} | Source: ${snap?.source || 'public'} (Click to refresh)`
                )
          }
        >
          {dataStatus === 'error' || dataStatus === 'degraded' ? (
            <AlertTriangle size={11} />
          ) : (
            <RefreshCw size={11} className={loading ? 'spin' : ''} />
          )}
          <span style={{ color: statusMeta.color, fontWeight: 700 }}>{statusMeta.label}</span>
          {asOfLabel && (
            <span className="mono" style={{ fontSize: 10 }}>
              {asOfLabel}
            </span>
          )}
        </button>

        {onOpenFullscreenStock && (
          <button
            type="button"
            className="st-strip-btn"
            onClick={() => onOpenFullscreenStock('1.000001')}
            title={t('全屏研究上证指数', 'Open SSE Composite fullscreen chart')}
          >
            <Maximize2 size={11} />
          </button>
        )}
      </div>
    </div>
  );
};
