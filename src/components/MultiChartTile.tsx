import React, { useEffect, useMemo, useState } from 'react';
import { BellPlus, Link2, Loader2, Maximize2, Unlink2 } from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type { KlineTimeframe, SecurityDetailData } from '../types';
import { IntradayVolumeChart } from './IntradayVolumeChart';
import { InteractiveKlineChart } from './InteractiveKlineChart';
import { useSlimeBot } from '../contexts/SlimeBotContext';

export type TileChartMode = 'intraday' | KlineTimeframe;

interface MultiChartTileProps {
  paneLabel: string;
  secid: string;
  linked: boolean;
  onToggleLink?: () => void;
  onChangeSecid?: (nextSecid: string) => void;
  initialMode?: TileChartMode;
  height?: number;
  compact?: boolean;
  isActive?: boolean;
  onOpenFullscreen?: (secid: string) => void;
  onToast?: (msg: string) => void;
}

const MODE_OPTIONS: { key: TileChartMode; label: string }[] = [
  { key: 'intraday', label: '分时' },
  { key: 'day', label: '日K' },
  { key: '60m', label: '60分' },
  { key: '15m', label: '15分' },
  { key: '1m', label: '1分' },
  { key: 'week', label: '周K' },
];

export const MultiChartTile: React.FC<MultiChartTileProps> = ({
  paneLabel,
  secid,
  linked,
  onToggleLink,
  onChangeSecid,
  initialMode = 'day',
  height = 240,
  compact = false,
  isActive = true,
  onOpenFullscreen,
  onToast,
}) => {
  const { pctColor, formatPct } = useI18n();
  const { watchState, addPriceAlertQuick, deleteWatchAlertQuick } = useSlimeBot();
  const [chartMode, setChartMode] = useState<TileChartMode>(initialMode);
  const [detail, setDetail] = useState<SecurityDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [editingTicker, setEditingTicker] = useState(false);
  const [tickerDraft, setTickerDraft] = useState('');

  const klineTf: KlineTimeframe = chartMode === 'intraday' ? 'day' : chartMode;

  useEffect(() => {
    if (!secid) return;
    let alive = true;
    setLoading(true);
    api
      .getSecurityDetail(secid, klineTf)
      .then((res) => {
        if (alive) setDetail(res);
      })
      .catch(() => {
        if (alive) setDetail(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [secid, klineTf]);

  const submitCustomTicker = async () => {
    const q = tickerDraft.trim();
    setEditingTicker(false);
    setTickerDraft('');
    if (!q || !onChangeSecid) return;
    try {
      const res = await api.searchSecurities(q);
      const best = (res.items || [])[0];
      if (best?.secid) {
        onChangeSecid(best.secid);
      } else {
        onToast?.(`未找到标的「${q}」`);
      }
    } catch {
      onToast?.(`搜索标的失败：${q}`);
    }
  };

  const botPriceAlerts = (watchState?.alertsStore?.alerts || [])
    .filter((a) => a.secid === secid && (a.condition === 'price_above' || a.condition === 'price_below') && a.enabled)
    .map((a) => ({
      id: a.id,
      price: a.threshold,
      condition: a.condition as 'price_above' | 'price_below',
      note: a.note,
    }));

  const q = detail?.quote;
  const stockName = detail?.name || secid;

  return (
    <div className="st-term-pane num" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="st-pane-hdr" style={{ gap: 6, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', padding: '0 4px', border: '1px solid var(--border-strong)', borderRadius: 4 }}>
            {paneLabel}
          </span>
          {editingTicker ? (
            <input
              autoFocus
              className="st-inline-input mono"
              value={tickerDraft}
              onChange={(e) => setTickerDraft(e.target.value)}
              onBlur={submitCustomTicker}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCustomTicker();
                if (e.key === 'Escape') setEditingTicker(false);
              }}
              placeholder="代码/名称回车"
              style={{ width: 110 }}
            />
          ) : (
            <button
              type="button"
              onClick={() => !linked && onChangeSecid && setEditingTicker(true)}
              style={{
                border: 'none',
                background: 'transparent',
                padding: 0,
                cursor: !linked && onChangeSecid ? 'pointer' : 'default',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
              title={!linked ? '点击输入代码或名称切换本窗格标的' : '当前已联动主标的'}
            >
              <strong style={{ color: 'var(--text)', fontSize: 12 }}>{stockName}</strong>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--navy)' }}>
                {detail?.code || secid.split('.')[1] || ''}
              </span>
            </button>
          )}
          {q && (
            <span className="mono" style={{ fontSize: 11.5, fontWeight: 800, color: pctColor(q.pct) }}>
              {q.price != null ? q.price.toFixed(2) : '--'} {formatPct(q.pct)}
            </span>
          )}
          {loading && <Loader2 size={11} className="spin" color="var(--text-muted)" />}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          {MODE_OPTIONS.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`st-mini-tab ${chartMode === m.key ? 'active' : ''}`}
              onClick={() => setChartMode(m.key)}
            >
              {m.label}
            </button>
          ))}
          {onToggleLink && (
            <button
              type="button"
              className="st-mini-tab"
              onClick={onToggleLink}
              title={linked ? '已联动主标的（点击解除独立选股）' : '独立选股模式（点击重新联动主标的）'}
              style={{ color: linked ? 'var(--navy)' : 'var(--amber)' }}
            >
              {linked ? <Link2 size={11} /> : <Unlink2 size={11} />}
            </button>
          )}
          {q?.price != null && (
            <button
              type="button"
              className="st-mini-tab"
              onClick={() =>
                addPriceAlertQuick({
                  secid,
                  name: stockName,
                  price: Number((q.price! * 1.02).toFixed(2)),
                  condition: 'price_above',
                  note: `${paneLabel}快捷突破预警`,
                })
              }
              title="一键新增当前标的 +2% Bot 突破预警"
            >
              <BellPlus size={11} color="var(--amber)" />
            </button>
          )}
          {onOpenFullscreen && (
            <button
              type="button"
              className="st-mini-tab"
              onClick={() => onOpenFullscreen(secid)}
              title="全屏 K 线研究工作台"
            >
              <Maximize2 size={11} />
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: compact ? '4px 6px' : '6px 8px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {chartMode === 'intraday' ? (
          <IntradayVolumeChart
            intraday={detail?.intraday || null}
            currencySymbol=""
            fillHeight
            interactive
          />
        ) : (
          <InteractiveKlineChart
            secid={secid}
            title={stockName}
            klines={detail?.klines || []}
            timeframe={klineTf}
            onChangeTimeframe={(tf) => setChartMode(tf)}
            loadingTimeframe={loading}
            trendlines={detail?.trendlines || null}
            tradeMarkers={detail?.tradeMarkers || null}
            initialDrawings={detail?.drawings || []}
            initialDrawingAlerts={detail?.drawingAlerts || []}
            botPriceAlerts={botPriceAlerts}
            onAddBotPriceAlert={(price, cond) =>
              addPriceAlertQuick({ secid, name: stockName, price, condition: cond })
            }
            onDeleteBotPriceAlert={(id) => deleteWatchAlertQuick(id)}
            onToast={onToast}
            defaultShowSR={false}
            defaultShowVictor={false}
            defaultShowDemark={false}
            defaultShowRegression={false}
            isActive={isActive}
            compact
            fillHeight
            height={height}
          />
        )}
      </div>
    </div>
  );
};
