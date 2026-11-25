import React, { useEffect, useState } from 'react';
import { Lock, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { CRYPTO_ENABLED } from '../config/edition';
import type { DataSourceChannelId, StockOrderBookResponse } from '../types';

interface OrderBookPanelProps {
  secid: string;
  stockName?: string;
  isActive?: boolean;
  onOpenDataSources?: (channel: DataSourceChannelId) => void;
  onOrderBookData?: (data: StockOrderBookResponse | null) => void;
}

export const OrderBookPanel: React.FC<OrderBookPanelProps> = ({
  secid,
  stockName,
  isActive = true,
  onOpenDataSources,
  onOrderBookData,
}) => {
  const { upColor, downColor } = useI18n();
  const [data, setData] = useState<StockOrderBookResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [subTab, setSubTab] = useState<'book' | 'ticks'>('book');

  useEffect(() => {
    if (!secid || !isActive) return;
    let alive = true;
    // 切换标的立即清空上一只股票的盘口/封单缓存，防止短暂显示旧标的数据
    setData(null);
    onOrderBookData?.(null);

    let ws: WebSocket | null = null;
    const attachWs = (wsUrl: string) => {
      if (!wsUrl || ws || typeof WebSocket === 'undefined') return;
      try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          const code = secid.split('.')[1] || secid;
          ws?.send(JSON.stringify({ action: 'subscribe', secid, code }));
        };
        ws.onmessage = (ev) => {
          if (!alive) return;
          try {
            const raw = JSON.parse(String(ev.data || '{}'));
            const node = raw?.data && !Array.isArray(raw.data) ? raw.data : raw;
            if (node?.secid && node.secid !== secid) return;
            setData((prev) => {
              if (!prev) return prev;
              const nextOb =
                prev.orderbook && (node.last != null || node.price != null || Array.isArray(node.bids))
                  ? {
                      ...prev.orderbook,
                      last: node.last ?? node.price ?? prev.orderbook.last,
                      pct: node.pct ?? prev.orderbook.pct,
                      bids: Array.isArray(node.bids) ? node.bids.slice(0, 5) : prev.orderbook.bids,
                      asks: Array.isArray(node.asks) ? node.asks.slice(0, 5) : prev.orderbook.asks,
                      bids6to10: Array.isArray(node.bids) && node.bids.length > 5 ? node.bids.slice(5, 10) : prev.orderbook.bids6to10,
                      asks6to10: Array.isArray(node.asks) && node.asks.length > 5 ? node.asks.slice(5, 10) : prev.orderbook.asks6to10,
                    }
                  : prev.orderbook;
              const next = { ...prev, orderbook: nextOb };
              onOrderBookData?.(next);
              return next;
            });
          } catch {
            // ignore non-JSON frame
          }
        };
        ws.onerror = () => {
          ws?.close();
          ws = null;
        };
      } catch {
        ws = null;
      }
    };

    const fetchOb = async () => {
      setLoading(true);
      try {
        const res = await api.getStockOrderBook(secid);
        if (alive && res.secid === secid) {
          setData(res);
          onOrderBookData?.(res);
          if (res.wsUrl) attachWs(res.wsUrl);
        }
      } catch {
        // 弱网单次抖动保留上次有效五档盘口，避免界面反复闪白清空
      } finally {
        if (alive) setLoading(false);
      }
    };
    fetchOb();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchOb();
    }, 6000);
    return () => {
      alive = false;
      clearInterval(timer);
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };
  }, [secid, isActive]);

  const ob = data?.orderbook;
  const preClose = ob?.preClose ?? null;
  const priceColor = (p: number | null | undefined) => {
    if (p == null || preClose == null) return 'var(--text)';
    if (p > preClose) return upColor;
    if (p < preClose) return downColor;
    return 'var(--text)';
  };

  const hasL2Levels = Boolean((ob?.asks6to10 && ob.asks6to10.length > 0) || (ob?.bids6to10 && ob.bids6to10.length > 0));
  const asksAll = [...(ob?.asks || []), ...(ob?.asks6to10 || [])];
  const bidsAll = [...(ob?.bids || []), ...(ob?.bids6to10 || [])];
  const asks = [...asksAll].reverse(); // 卖10/卖5 -> 卖1
  const bids = bidsAll; // 买1 -> 买5/买10
  const maxVol = Math.max(
    1,
    ...asks.map((x) => x.volume ?? 0),
    ...bids.map((x) => x.volume ?? 0)
  );

  const isCnA = /^(0|1)\.\d{6}$/.test(secid);

  return (
    <div className="st-term-pane num" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div className="st-pane-hdr">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <strong style={{ color: 'var(--text)', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {ob?.name || stockName || secid}
          </strong>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--navy)' }}>
            {ob?.code || secid.split('.')[1] || secid}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <button
            type="button"
            className={`st-mini-tab ${subTab === 'book' ? 'active' : ''}`}
            onClick={() => setSubTab('book')}
          >
            五档盘口
          </button>
          <button
            type="button"
            className={`st-mini-tab ${subTab === 'ticks' ? 'active' : ''}`}
            onClick={() => setSubTab('ticks')}
          >
            分笔({data?.ticks?.length || 0})
          </button>
          {loading && <RefreshCw size={10} className="spin" color="var(--text-muted)" />}
        </div>
      </div>

      {!isCnA ? (
        <div style={{ padding: 14, fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          <div>当前标的为非 A 股个股或指数（{secid}），五档买卖盘仅适用于沪深京 A 股个股。</div>
          {onOpenDataSources && (
            <button
              type="button"
              className="st-slot-pill"
              style={{ marginTop: 8 }}
              onClick={() => onOpenDataSources('global_markets')}
            >
              <Lock size={10} /> {CRYPTO_ENABLED ? '配置海外/加密高阶行情源' : '配置海外股市/期货行情源'}
            </button>
          )}
        </div>
      ) : subTab === 'book' ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {/* Quote Headline & 委比 */}
          {ob && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>
              <div className="mono" style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 17, fontWeight: 800, color: priceColor(ob.last) }}>
                  {ob.last != null ? ob.last.toFixed(2) : '--'}
                </span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: priceColor(ob.last) }}>
                  {ob.pct != null ? `${ob.pct >= 0 ? '+' : ''}${ob.pct.toFixed(2)}%` : '--'}
                </span>
              </div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                委比{' '}
                <b style={{ color: (ob.weibi ?? 0) >= 0 ? upColor : downColor }}>
                  {ob.weibi != null ? `${ob.weibi >= 0 ? '+' : ''}${ob.weibi.toFixed(1)}%` : '--'}
                </b>
              </div>
            </div>
          )}

          {/* 卖10/卖5 - 卖1 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {asks.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: '6px 0' }}>卖盘档位为空</div>
            ) : (
              asks.map((lvl) => (
                <div
                  key={`a-${lvl.level}`}
                  className="st-ob-row"
                  style={lvl.level > 5 ? { background: 'var(--emerald-soft)' } : undefined}
                >
                  <div
                    className="st-ob-bar"
                    style={{
                      width: lvl.volume != null ? `${Math.min(100, Math.round((lvl.volume / maxVol) * 100))}%` : '0%',
                      background: `color-mix(in srgb, ${downColor} 16%, transparent)`,
                    }}
                  />
                  <span style={{ color: lvl.level > 5 ? 'var(--emerald)' : 'var(--text-muted)', zIndex: 1 }}>卖{lvl.level}</span>
                  <span className="mono" style={{ color: priceColor(lvl.price), fontWeight: 700, zIndex: 1 }}>
                    {lvl.price != null ? lvl.price.toFixed(2) : '--'}
                  </span>
                  <span className="mono" style={{ color: 'var(--text)', fontWeight: 600, textAlign: 'right', zIndex: 1 }}>
                    {lvl.volume != null ? lvl.volume : '--'}
                  </span>
                </div>
              ))
            )}
          </div>

          <div style={{ height: 1, background: 'var(--border-strong)', margin: '2px 0' }} />

          {/* 买1 - 买5/买10 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {bids.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: '6px 0' }}>买盘档位为空</div>
            ) : (
              bids.map((lvl) => (
                <div
                  key={`b-${lvl.level}`}
                  className="st-ob-row"
                  style={lvl.level > 5 ? { background: 'var(--crimson-soft)' } : undefined}
                >
                  <div
                    className="st-ob-bar"
                    style={{
                      width: lvl.volume != null ? `${Math.min(100, Math.round((lvl.volume / maxVol) * 100))}%` : '0%',
                      background: `color-mix(in srgb, ${upColor} 16%, transparent)`,
                    }}
                  />
                  <span style={{ color: lvl.level > 5 ? 'var(--crimson)' : 'var(--text-muted)', zIndex: 1 }}>买{lvl.level}</span>
                  <span className="mono" style={{ color: priceColor(lvl.price), fontWeight: 700, zIndex: 1 }}>
                    {lvl.price != null ? lvl.price.toFixed(2) : '--'}
                  </span>
                  <span className="mono" style={{ color: 'var(--text)', fontWeight: 600, textAlign: 'right', zIndex: 1 }}>
                    {lvl.volume != null ? lvl.volume : '--'}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* L2 6-10 档位真实渲染状态 OR 诚实付费槽位引导 */}
          {hasL2Levels ? (
            <div style={{ fontSize: 10.5, color: 'var(--emerald)', textAlign: 'center', padding: '2px 0', fontWeight: 600 }}>
              已点亮 L2 十档盘口 ({ob?.orderbookDepth || Math.max(asks.length, bids.length)} 档)
            </div>
          ) : (
            <button
              type="button"
              className="st-slot-pill"
              onClick={() => onOpenDataSources?.('cn_quotes')}
              title="免费默认源提供实时五档；接入 L2 付费源可点亮买6-10/卖6-10十档与逐笔大单"
            >
              <Lock size={10} />
              <span>十档(6-10) / L2 逐笔 · 待接入付费源</span>
            </button>
          )}

          {/* 筹码分布付费槽位真实展示 OR 诚实引导 */}
          {data?.chips?.available && data.chips.data ? (
            <div
              className="mono"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 10.5,
                padding: '4px 7px',
                borderRadius: 5,
                background: 'var(--teal-soft)',
                color: 'var(--teal)',
                fontWeight: 600,
              }}
            >
              <span>获利 {data.chips.data.profitRatioPct != null ? `${data.chips.data.profitRatioPct}%` : '--'}</span>
              <span>均本 {data.chips.data.avgCost != null ? data.chips.data.avgCost.toFixed(2) : '--'}</span>
              <span>集中 {data.chips.data.concentration90Pct != null ? `${data.chips.data.concentration90Pct}%` : '--'}</span>
            </div>
          ) : (
            <button
              type="button"
              className="st-slot-pill"
              onClick={() => onOpenDataSources?.('cn_short_term')}
              title="在数据源管理 → 通道2配置筹码接口可展示获利盘与筹码集中度"
            >
              <Lock size={10} />
              <span>筹码分布 / 获利盘 · 待接入付费源</span>
            </button>
          )}

          {/* 核心盘口 2 列明细网格 */}
          {ob && (
            <div
              className="mono"
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '3px 10px',
                paddingTop: 5,
                borderTop: '1px solid var(--border)',
                fontSize: 11,
              }}
            >
              {[
                ['开盘', ob.open?.toFixed(2), priceColor(ob.open)],
                ['均价', ob.avgPrice?.toFixed(2), 'var(--amber)'],
                ['最高', ob.high?.toFixed(2), priceColor(ob.high)],
                ['最低', ob.low?.toFixed(2), priceColor(ob.low)],
                ['换手', ob.turnoverPct != null ? `${ob.turnoverPct}%` : '--', 'var(--navy)'],
                ['量比', ob.volumeRatio != null ? `${ob.volumeRatio}` : '--', (ob.volumeRatio ?? 0) >= 2 ? upColor : 'var(--text)'],
                ['金额', ob.amountYi != null ? `${ob.amountYi}亿` : '--', 'var(--text)'],
                ['振幅', ob.amplitudePct != null ? `${ob.amplitudePct}%` : '--', 'var(--text)'],
                ['涨停', ob.limitUp?.toFixed(2), upColor],
                ['跌停', ob.limitDown?.toFixed(2), downColor],
                ['外盘', ob.outVol != null ? `${(ob.outVol / 10000).toFixed(1)}万` : '--', upColor],
                ['内盘', ob.inVol != null ? `${(ob.inVol / 10000).toFixed(1)}万` : '--', downColor],
                ['流通', ob.circCapYi != null ? `${ob.circCapYi}亿` : '--', 'var(--text-secondary)'],
                ['PE', ob.peTtm != null ? `${ob.peTtm}` : '--', 'var(--text-secondary)'],
              ].map(([k, v, col]) => (
                <div key={String(k)} style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{k}</span>
                  <span style={{ color: String(col), fontWeight: 600 }}>{v || '--'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* 分笔 / L2 逐笔明细 Tab */
        <div style={{ flex: 1, overflowY: 'auto', padding: '5px 7px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10.5, color: 'var(--text-muted)', paddingBottom: 3, borderBottom: '1px solid var(--border)' }}>
            <span>{data?.tickSourceLabel || '东财分笔快照'}</span>
            {!data?.slots?.l2BigOrderTicks?.available && (
              <button
                type="button"
                className="st-inline-link"
                onClick={() => onOpenDataSources?.('cn_quotes')}
              >
                接入 L2 逐笔
              </button>
            )}
          </div>
          <div
            className="mono"
            style={{
              display: 'grid',
              gridTemplateColumns: '56px 52px 46px 1fr 16px',
              fontSize: 10,
              color: 'var(--text-muted)',
              padding: '2px 2px',
            }}
          >
            <span>时间</span>
            <span style={{ textAlign: 'right' }}>成交价</span>
            <span style={{ textAlign: 'right' }}>手数</span>
            <span style={{ textAlign: 'right' }}>金额(万)</span>
            <span style={{ textAlign: 'right' }}>向</span>
          </div>
          {(data?.ticks || []).length === 0 ? (
            <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-muted)', padding: 14 }}>暂无分笔成交明细</div>
          ) : (
            (data?.ticks || []).map((tk, i) => (
              <div
                key={`${tk.time}-${i}`}
                className="mono"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '56px 52px 46px 1fr 16px',
                  fontSize: 10.5,
                  padding: '2px 3px',
                  borderRadius: 3,
                  background: tk.isBigOrder ? 'var(--amber-soft)' : i % 2 === 0 ? 'var(--bg-soft)' : 'transparent',
                }}
              >
                <span style={{ color: 'var(--text-muted)' }}>{tk.time}</span>
                <span style={{ textAlign: 'right', color: priceColor(tk.price), fontWeight: 600 }}>
                  {tk.price != null ? tk.price.toFixed(2) : '--'}
                </span>
                <span style={{ textAlign: 'right', color: (tk.volume ?? 0) >= 200 ? 'var(--amber)' : 'var(--text)', fontWeight: (tk.volume ?? 0) >= 200 ? 700 : 400 }}>
                  {tk.volume != null ? tk.volume : '--'}
                </span>
                <span style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                  {tk.amountWan != null ? tk.amountWan.toFixed(0) : '--'}
                </span>
                <span style={{ textAlign: 'right', fontWeight: 800, color: tk.side === 'buy' ? upColor : tk.side === 'sell' ? downColor : 'var(--text-muted)' }}>
                  {tk.side === 'buy' ? 'B' : tk.side === 'sell' ? 'S' : '-'}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
