import React, { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import type {
  DailyKlinePoint,
  SupportResistanceLevel,
  VolumeProfileBin,
  WatchlistIntradayData,
} from '../types';

interface IntradayVolumeChartProps {
  intraday: WatchlistIntradayData | null;
  preClose?: number | null;
  pct?: number | null;
  height?: number;
  fillHeight?: boolean;
  interactive?: boolean;
  currencySymbol?: string;
}

export const IntradayVolumeChart: React.FC<IntradayVolumeChartProps> = ({
  intraday,
  preClose,
  pct,
  height = 96,
  fillHeight = false,
  interactive = false,
  currencySymbol = '',
}) => {
  const { upColor, downColor } = useI18n();
  const gradId = useId().replace(/:/g, '');
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [boxSize, setBoxSize] = useState<{ w: number; h: number }>({ w: interactive ? 760 : 320, h: height });
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!fillHeight && !interactive) return;
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const nw = Math.max(240, Math.round(rect.width));
      const nh = fillHeight ? Math.max(110, Math.round(rect.height)) : height;
      setBoxSize((prev) => (prev.w === nw && prev.h === nh ? prev : { w: nw, h: nh }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fillHeight, interactive, height]);

  const points = intraday?.points || [];
  const effectiveH = fillHeight ? boxSize.h : height;
  if (!intraday?.available || points.length < 2) {
    return (
      <div
        ref={boxRef}
        style={{
          height: fillHeight ? '100%' : height,
          minHeight: fillHeight ? 110 : height,
          width: '100%',
          borderRadius: 7,
          background: 'var(--bg-soft)',
          border: '1px dashed var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11.5,
          color: 'var(--text-muted)',
        }}
      >
        暂无盘中分时数据（非交易时段或等待同步）
      </div>
    );
  }

  const W = interactive || fillHeight ? Math.max(320, boxSize.w) : 320;
  const H = Math.max(96, effectiveH);
  const padLeft = interactive ? 48 : 4;
  const padRight = interactive ? 46 : 4;
  const padTop = interactive ? 14 : 6;
  const volTop = Math.round(H * 0.74);
  const priceBottom = volTop - (interactive ? 10 : 6);
  const volBottom = H - (interactive ? 18 : 4);
  const plotW = Math.max(80, W - padLeft - padRight);
  const priceH = Math.max(24, priceBottom - padTop);
  const volH = Math.max(12, volBottom - volTop);

  const refPre = preClose ?? intraday.preClose ?? points[0].p;
  const allPrices = points
    .flatMap((pt) => (pt.a != null ? [pt.p, pt.a] : [pt.p]))
    .concat(refPre ? [refPre] : []);
  const rawMin = Math.min(...allPrices);
  const rawMax = Math.max(...allPrices);
  const maxDev = Math.max(Math.abs(rawMax - refPre), Math.abs(refPre - rawMin), refPre * 0.004, 0.01);
  const minP = refPre - maxDev * 1.08;
  const maxP = refPre + maxDev * 1.08;

  const maxVol = Math.max(...points.map((pt) => pt.v ?? 0), 1);

  const xOf = (i: number) => padLeft + (i / Math.max(points.length - 1, 1)) * plotW;
  const yOf = (price: number) => padTop + ((maxP - price) / (maxP - minP)) * priceH;

  const lastPt = points[points.length - 1];
  const isUp = pct != null ? pct >= 0 : lastPt.p >= refPre;
  const lineColor = isUp ? upColor : downColor;
  const vwapColor = '#d97706';

  const pricePath = points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(pt.p).toFixed(1)}`).join(' ');
  const vwapSegments = points
    .map((pt, i) => (pt.a != null ? { i, a: pt.a } : null))
    .filter((x): x is { i: number; a: number } => x !== null);
  const vwapPath =
    vwapSegments.length >= 2
      ? vwapSegments.map((s, idx) => `${idx === 0 ? 'M' : 'L'}${xOf(s.i).toFixed(1)},${yOf(s.a).toFixed(1)}`).join(' ')
      : '';
  const areaPath = `${pricePath} L${xOf(points.length - 1).toFixed(1)},${priceBottom.toFixed(1)} L${xOf(0).toFixed(1)},${priceBottom.toFixed(1)} Z`;

  const preY = yOf(refPre);
  const barW = Math.max(1.4, Math.min(interactive ? 5.5 : 3.2, (plotW / points.length) * 0.72));

  const activePoint = hoverIdx != null ? points[hoverIdx] : null;
  const activePct = activePoint && refPre ? (((activePoint.p - refPre) / refPre) * 100).toFixed(2) : null;
  const topPct = refPre > 0 ? (((maxP - refPre) / refPre) * 100).toFixed(2) : '0.00';
  const botPct = refPre > 0 ? (((minP - refPre) / refPre) * 100).toFixed(2) : '0.00';

  return (
    <div
      ref={boxRef}
      style={{
        position: 'relative',
        width: '100%',
        height: fillHeight ? '100%' : height,
        minHeight: fillHeight ? 110 : height,
        overflow: 'hidden',
      }}
    >
      {interactive && activePoint && (
        <div
          style={{
            position: 'absolute',
            top: 4,
            left: padLeft + 6,
            zIndex: 4,
            pointerEvents: 'none',
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
            fontSize: 11.5,
            padding: '2px 8px',
            borderRadius: 5,
            background: 'color-mix(in srgb, var(--bg-elev) 92%, transparent)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-xs)',
          }}
        >
          <span className="mono" style={{ fontWeight: 700, color: 'var(--text)' }}>{activePoint.t}</span>
          <span className="mono" style={{ color: 'var(--text)' }}>
            价 <strong>{currencySymbol}{activePoint.p.toFixed(2)}</strong>
          </span>
          {activePct !== null && (
            <span className="mono" style={{ color: Number(activePct) >= 0 ? upColor : downColor, fontWeight: 700 }}>
              {Number(activePct) >= 0 ? '+' : ''}{activePct}%
            </span>
          )}
          <span className="mono" style={{ color: vwapColor }}>
            均 {activePoint.a != null ? `${currencySymbol}${activePoint.a.toFixed(2)}` : '--'}
          </span>
          <span className="mono" style={{ color: 'var(--text-secondary)' }}>
            量 {activePoint.v != null ? activePoint.v.toLocaleString() : '--'}
          </span>
        </div>
      )}

      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: '100%', display: 'block' }}
        onMouseLeave={() => interactive && setHoverIdx(null)}
        onMouseMove={(e) => {
          if (!interactive) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const relX = ((e.clientX - rect.left) / rect.width) * W;
          const idx = Math.round(((relX - padLeft) / plotW) * (points.length - 1));
          setHoverIdx(Math.max(0, Math.min(points.length - 1, idx)));
        }}
      >
        <defs>
          <linearGradient id={`grad-${gradId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.18" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* 水平参考网格 */}
        {interactive && (
          <>
            <line x1={padLeft} y1={padTop} x2={W - padRight} y2={padTop} stroke="var(--border)" strokeWidth="0.6" strokeDasharray="2 3" />
            <line x1={padLeft} y1={priceBottom} x2={W - padRight} y2={priceBottom} stroke="var(--border)" strokeWidth="0.6" strokeDasharray="2 3" />
            <text x={padLeft - 4} y={padTop + 8} textAnchor="end" fontSize="9.5" fill={upColor} fontFamily="var(--font-mono)">{maxP.toFixed(2)}</text>
            <text x={padLeft - 4} y={preY + 3} textAnchor="end" fontSize="9.5" fill="var(--text-muted)" fontFamily="var(--font-mono)">{refPre.toFixed(2)}</text>
            <text x={padLeft - 4} y={priceBottom - 2} textAnchor="end" fontSize="9.5" fill={downColor} fontFamily="var(--font-mono)">{minP.toFixed(2)}</text>
            <text x={W - padRight + 4} y={padTop + 8} textAnchor="start" fontSize="9.5" fill={upColor} fontFamily="var(--font-mono)">+{topPct}%</text>
            <text x={W - padRight + 4} y={preY + 3} textAnchor="start" fontSize="9.5" fill="var(--text-muted)" fontFamily="var(--font-mono)">0.00%</text>
            <text x={W - padRight + 4} y={priceBottom - 2} textAnchor="start" fontSize="9.5" fill={downColor} fontFamily="var(--font-mono)">{botPct}%</text>
          </>
        )}

        {/* 分隔线：分时价区与底部成交量柱区 */}
        <line
          x1={padLeft}
          y1={volTop - 2}
          x2={W - padRight}
          y2={volTop - 2}
          stroke="var(--border)"
          strokeWidth="0.7"
        />

        {/* 昨收虚线基准 */}
        <line
          x1={padLeft}
          y1={preY}
          x2={W - padRight}
          y2={preY}
          stroke="var(--text-muted)"
          strokeWidth="0.9"
          strokeDasharray="3 3"
          opacity="0.7"
        />

        {/* 渐变填充 */}
        <path d={areaPath} fill={`url(#grad-${gradId})`} />

        {/* VWAP 均价线（仅当上游返回真实均价字段时绘制，绝不拿现价冒充） */}
        {vwapPath && (
          <path
            d={vwapPath}
            fill="none"
            stroke={vwapColor}
            strokeWidth={interactive ? 1.45 : 1.05}
            strokeDasharray={interactive ? '4 2' : '2.5 2'}
            opacity="0.88"
          />
        )}

        {/* 分时价格主曲线 */}
        <path
          d={pricePath}
          fill="none"
          stroke={lineColor}
          strokeWidth={interactive ? 1.9 : 1.55}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* 最新价端点 */}
        <circle
          cx={xOf(points.length - 1)}
          cy={yOf(lastPt.p)}
          r={interactive ? 3.2 : 2.4}
          fill={lineColor}
        />

        {/* 底部成交量柱状图（量缺失时留空不补 0） */}
        {points.map((pt, i) => {
          if (pt.v == null) return null;
          const bh = Math.max(1.2, (pt.v / maxVol) * volH);
          const bx = xOf(i) - barW / 2;
          const by = volBottom - bh;
          return (
            <rect
              key={i}
              x={bx}
              y={by}
              width={barW}
              height={bh}
              rx={0.5}
              fill={pt.up ? `${upColor}99` : `${downColor}99`}
            />
          );
        })}

        {/* 交互十字光标 */}
        {interactive && hoverIdx != null && points[hoverIdx] && (
          <>
            <line
              x1={xOf(hoverIdx)}
              y1={padTop}
              x2={xOf(hoverIdx)}
              y2={volBottom}
              stroke="var(--navy)"
              strokeWidth="1"
              strokeDasharray="2 2"
            />
            <line
              x1={padLeft}
              y1={yOf(points[hoverIdx].p)}
              x2={W - padRight}
              y2={yOf(points[hoverIdx].p)}
              stroke="var(--navy)"
              strokeWidth="0.8"
              strokeDasharray="2 2"
              opacity="0.6"
            />
            <circle
              cx={xOf(hoverIdx)}
              cy={yOf(points[hoverIdx].p)}
              r={4}
              fill={lineColor}
              stroke="var(--bg-elev)"
              strokeWidth="1.5"
            />
          </>
        )}

        {/* 大图时间轴标注 */}
        {interactive && (
          <>
            <text x={padLeft} y={H - 4} fontSize="10" fill="var(--text-muted)" fontFamily="var(--font-mono)">
              {intraday.firstTime || points[0].t}
            </text>
            <text
              x={padLeft + plotW / 2}
              y={H - 4}
              textAnchor="middle"
              fontSize="10"
              fill="var(--text-muted)"
              fontFamily="var(--font-mono)"
            >
              {points[Math.floor(points.length / 2)]?.t || ''}
            </text>
            <text
              x={W - padRight}
              y={H - 4}
              textAnchor="end"
              fontSize="10"
              fill="var(--text-muted)"
              fontFamily="var(--font-mono)"
            >
              {intraday.lastTime || lastPt.t}
            </text>
          </>
        )}
      </svg>
    </div>
  );
};

interface DailyCandlestickChartProps {
  klines: DailyKlinePoint[];
  height?: number;
  currencySymbol?: string;
}

export const DailyCandlestickChart: React.FC<DailyCandlestickChartProps> = ({
  klines,
  height = 230,
  currencySymbol = '',
}) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!klines || klines.length < 2) {
    return (
      <div
        style={{
          height,
          borderRadius: 8,
          background: 'var(--bg-soft)',
          border: '1px dashed var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          color: 'var(--text-muted)',
        }}
      >
        暂无近期日K数据
      </div>
    );
  }

  const W = 720;
  const H = height;
  const padX = 14;
  const padTop = 14;
  const volTop = Math.round(H * 0.72);
  const priceBottom = volTop - 10;
  const volBottom = H - 20;
  const plotW = W - padX * 2;
  const priceH = priceBottom - padTop;
  const volH = volBottom - volTop;

  const minP = Math.min(...klines.map((k) => k.low)) * 0.992;
  const maxP = Math.max(...klines.map((k) => k.high)) * 1.008;
  const maxVol = Math.max(...klines.map((k) => k.vol || 0), 1);

  const step = plotW / klines.length;
  const xOf = (i: number) => padX + step * i + step / 2;
  const yOf = (p: number) => padTop + ((maxP - p) / Math.max(maxP - minP, 0.01)) * priceH;

  const calcMaPath = (period: number) => {
    const segs: string[] = [];
    for (let i = period - 1; i < klines.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += klines[j].close;
      const ma = sum / period;
      segs.push(`${segs.length === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(ma).toFixed(1)}`);
    }
    return segs.join(' ');
  };

  const ma5Path = calcMaPath(5);
  const ma10Path = calcMaPath(10);
  const ma20Path = calcMaPath(20);
  const candleW = Math.max(4, Math.min(14, step * 0.62));
  const activeK = hoverIdx != null ? klines[hoverIdx] : klines[klines.length - 1];

  return (
    <div>
      {activeK && (
        <div
          style={{
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            fontSize: 12,
            padding: '4px 10px',
            marginBottom: 4,
            borderRadius: 6,
            background: 'var(--bg-soft)',
            border: '1px solid var(--border)',
          }}
        >
          <span className="mono" style={{ fontWeight: 700 }}>{activeK.date}</span>
          <span className="mono">开 {currencySymbol}{activeK.open.toFixed(2)}</span>
          <span className="mono">高 {currencySymbol}{activeK.high.toFixed(2)}</span>
          <span className="mono">低 {currencySymbol}{activeK.low.toFixed(2)}</span>
          <span className="mono" style={{ fontWeight: 700 }}>收 {currencySymbol}{activeK.close.toFixed(2)}</span>
          {activeK.pct != null && (
            <span className="mono" style={{ color: activeK.pct >= 0 ? '#dc2626' : '#16a34a', fontWeight: 700 }}>
              {activeK.pct >= 0 ? '+' : ''}{activeK.pct}%
            </span>
          )}
          {activeK.turnoverPct != null && (
            <span className="mono" style={{ color: 'var(--text-secondary)' }}>换手 {activeK.turnoverPct}%</span>
          )}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, fontSize: 11 }}>
            <span style={{ color: '#f59e0b', fontWeight: 700 }}>— MA5</span>
            <span style={{ color: '#2563eb', fontWeight: 700 }}>— MA10</span>
            <span style={{ color: '#8b5cf6', fontWeight: 700 }}>— MA20</span>
          </span>
        </div>
      )}

      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height, display: 'block', overflow: 'visible' }}
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const relX = ((e.clientX - rect.left) / rect.width) * W;
          const idx = Math.floor((relX - padX) / step);
          setHoverIdx(Math.max(0, Math.min(klines.length - 1, idx)));
        }}
      >
        <line x1={padX} y1={volTop - 2} x2={W - padX} y2={volTop - 2} stroke="var(--border)" strokeWidth="0.7" />

        {klines.map((k, i) => {
          const cx = xOf(i);
          const up = k.close >= k.open;
          const col = up ? '#dc2626' : '#16a34a';
          const bodyTop = yOf(Math.max(k.open, k.close));
          const bodyBot = yOf(Math.min(k.open, k.close));
          const bodyH = Math.max(1.5, bodyBot - bodyTop);
          const vh = Math.max(1.5, ((k.vol || 0) / maxVol) * volH);
          const isHover = hoverIdx === i;

          return (
            <g key={k.date}>
              {isHover && (
                <rect
                  x={cx - step / 2}
                  y={padTop}
                  width={step}
                  height={volBottom - padTop}
                  fill="var(--navy)"
                  opacity="0.06"
                />
              )}
              <line x1={cx} y1={yOf(k.high)} x2={cx} y2={yOf(k.low)} stroke={col} strokeWidth="1.2" />
              <rect
                x={cx - candleW / 2}
                y={bodyTop}
                width={candleW}
                height={bodyH}
                fill={up ? col : col}
                opacity={up ? 0.9 : 0.85}
                rx={1}
              />
              <rect
                x={cx - candleW / 2}
                y={volBottom - vh}
                width={candleW}
                height={vh}
                fill={up ? 'rgba(220,38,38,0.55)' : 'rgba(22,163,74,0.52)'}
                rx={0.8}
              />
            </g>
          );
        })}

        {ma5Path && <path d={ma5Path} fill="none" stroke="#f59e0b" strokeWidth="1.5" />}
        {ma10Path && <path d={ma10Path} fill="none" stroke="#2563eb" strokeWidth="1.35" />}
        {ma20Path && <path d={ma20Path} fill="none" stroke="#8b5cf6" strokeWidth="1.35" />}

        <text x={padX} y={H - 3} fontSize="10" fill="var(--text-muted)" fontFamily="var(--font-mono)">
          {klines[0].date}
        </text>
        <text x={W / 2} y={H - 3} textAnchor="middle" fontSize="10" fill="var(--text-muted)" fontFamily="var(--font-mono)">
          {klines[Math.floor(klines.length / 2)]?.date}
        </text>
        <text x={W - padX} y={H - 3} textAnchor="end" fontSize="10" fill="var(--text-muted)" fontFamily="var(--font-mono)">
          {klines[klines.length - 1].date}
        </text>
      </svg>
    </div>
  );
};

interface SupportResistanceChartProps {
  klines: DailyKlinePoint[];
  resistances: SupportResistanceLevel[];
  supports: SupportResistanceLevel[];
  poc?: number | null;
  volumeProfileBins?: VolumeProfileBin[];
  turtleStop2N?: number | null;
  currencySymbol?: string;
  height?: number;
}

export const SupportResistanceChart: React.FC<SupportResistanceChartProps> = ({
  klines,
  resistances,
  supports,
  poc,
  volumeProfileBins = [],
  turtleStop2N,
  currencySymbol = '¥',
  height = 330,
}) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!klines || klines.length < 5) {
    return (
      <div
        style={{
          height,
          borderRadius: 8,
          background: 'var(--bg-soft)',
          border: '1px dashed var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12.5,
          color: 'var(--text-muted)',
        }}
      >
        K 线数据不足，无法绘制支撑压力位图谱
      </div>
    );
  }

  const W = 860;
  const H = height;
  const padLeft = 14;
  const padRight = 112; // 右侧留给价格标签 + 筹码峰水平直方图
  const padTop = 16;
  const volTop = Math.round(H * 0.77);
  const priceBottom = volTop - 10;
  const volBottom = H - 20;
  const plotW = W - padLeft - padRight;
  const priceH = priceBottom - padTop;
  const volH = volBottom - volTop;

  const keyLevelPrices = [
    ...resistances.slice(0, 3).map((r) => r.price),
    ...supports.slice(0, 3).map((s) => s.price),
    ...(poc ? [poc] : []),
  ];
  const allHighs = [...klines.map((k) => k.high), ...keyLevelPrices];
  const allLows = [...klines.map((k) => k.low), ...keyLevelPrices];
  const rawMin = Math.min(...allLows);
  const rawMax = Math.max(...allHighs);
  const span = Math.max(rawMax - rawMin, 0.1);
  const minP = rawMin - span * 0.05;
  const maxP = rawMax + span * 0.05;

  const maxVol = Math.max(...klines.map((k) => k.vol || 0), 1);
  const step = plotW / klines.length;
  const xOf = (i: number) => padLeft + step * i + step / 2;
  const yOf = (p: number) => padTop + ((maxP - p) / Math.max(maxP - minP, 0.01)) * priceH;

  const calcMaPath = (period: number) => {
    const segs: string[] = [];
    for (let i = period - 1; i < klines.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += klines[j].close;
      const ma = sum / period;
      segs.push(`${segs.length === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(ma).toFixed(1)}`);
    }
    return segs.join(' ');
  };

  const ma5Path = calcMaPath(5);
  const ma20Path = calcMaPath(20);
  const candleW = Math.max(3, Math.min(10, step * 0.65));
  const activeK = hoverIdx != null ? klines[hoverIdx] : klines[klines.length - 1];
  const vpMaxW = 68;

  // 右侧标签垂直防重叠算法：按自然 Y 排序并推开间距 >= 15px，用细引线连回真实价位线
  const rightTags: {
    key: string;
    text: string;
    color: string;
    bg: string;
    rawY: number;
    labelY: number;
    lineWidth: number;
    dash: string;
    opacity: number;
  }[] = [];

  for (const r of resistances.slice(0, 3)) {
    const ry = yOf(r.price);
    rightTags.push({
      key: `res-${r.code}`,
      text: `${r.code} ${r.price.toFixed(2)}`,
      color: '#dc2626',
      bg: 'rgba(220, 38, 38, 0.12)',
      rawY: ry,
      labelY: ry,
      lineWidth: r.strength === '强共振' ? 1.5 : 1.05,
      dash: '4 3',
      opacity: r.strength === '强共振' ? 0.9 : 0.65,
    });
  }
  if (poc != null) {
    const py = yOf(poc);
    rightTags.push({
      key: 'poc',
      text: `POC ${poc.toFixed(2)}`,
      color: '#7c3aed',
      bg: 'rgba(124, 58, 237, 0.13)',
      rawY: py,
      labelY: py,
      lineWidth: 1.4,
      dash: '6 3',
      opacity: 0.88,
    });
  }
  for (const s of supports.slice(0, 3)) {
    const sy = yOf(s.price);
    rightTags.push({
      key: `sup-${s.code}`,
      text: `${s.code} ${s.price.toFixed(2)}`,
      color: '#16a34a',
      bg: 'rgba(22, 163, 74, 0.12)',
      rawY: sy,
      labelY: sy,
      lineWidth: s.strength === '强共振' ? 1.5 : 1.05,
      dash: '4 3',
      opacity: s.strength === '强共振' ? 0.9 : 0.65,
    });
  }

  rightTags.sort((a, b) => a.rawY - b.rawY);
  const minGap = 15.5;
  for (let i = 1; i < rightTags.length; i++) {
    if (rightTags[i].labelY - rightTags[i - 1].labelY < minGap) {
      rightTags[i].labelY = rightTags[i - 1].labelY + minGap;
    }
  }
  const maxAllowedY = priceBottom - 6;
  if (rightTags.length > 0 && rightTags[rightTags.length - 1].labelY > maxAllowedY) {
    rightTags[rightTags.length - 1].labelY = maxAllowedY;
    for (let i = rightTags.length - 2; i >= 0; i--) {
      if (rightTags[i + 1].labelY - rightTags[i].labelY < minGap) {
        rightTags[i].labelY = Math.max(padTop + 6, rightTags[i + 1].labelY - minGap);
      }
    }
  }

  return (
    <div>
      {activeK && (
        <div
          style={{
            display: 'flex',
            gap: 11,
            flexWrap: 'wrap',
            alignItems: 'center',
            fontSize: 12,
            padding: '5px 10px',
            marginBottom: 6,
            borderRadius: 7,
            background: 'var(--bg-soft)',
            border: '1px solid var(--border)',
          }}
        >
          <span className="mono" style={{ fontWeight: 700 }}>{activeK.date}</span>
          <span className="mono">开 {currencySymbol}{activeK.open.toFixed(2)}</span>
          <span className="mono">高 {currencySymbol}{activeK.high.toFixed(2)}</span>
          <span className="mono">低 {currencySymbol}{activeK.low.toFixed(2)}</span>
          <span className="mono" style={{ fontWeight: 700 }}>收 {currencySymbol}{activeK.close.toFixed(2)}</span>
          {activeK.pct != null && (
            <span className="mono" style={{ color: activeK.pct >= 0 ? '#dc2626' : '#16a34a', fontWeight: 700 }}>
              {activeK.pct >= 0 ? '+' : ''}{activeK.pct}%
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 9, fontSize: 11, flexWrap: 'wrap' }}>
            <span style={{ color: '#dc2626', fontWeight: 700 }}>--- 压力位 R1-R3</span>
            <span style={{ color: '#16a34a', fontWeight: 700 }}>--- 支撑位 S1-S3</span>
            <span style={{ color: '#7c3aed', fontWeight: 700 }}>━ 筹码峰 POC</span>
            <span style={{ color: '#f59e0b', fontWeight: 700 }}>— MA5</span>
            <span style={{ color: '#2563eb', fontWeight: 700 }}>— MA20</span>
          </span>
        </div>
      )}

      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height, display: 'block', overflow: 'visible' }}
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const relX = ((e.clientX - rect.left) / rect.width) * W;
          if (relX < padLeft || relX > padLeft + plotW) return;
          const idx = Math.floor((relX - padLeft) / step);
          setHoverIdx(Math.max(0, Math.min(klines.length - 1, idx)));
        }}
      >
        {/* 右侧筹码分布水平直方图 (Volume Profile) */}
        {volumeProfileBins.map((bin, i) => {
          const yTop = yOf(bin.priceHigh);
          const yBot = yOf(bin.priceLow);
          const bh = Math.max(1.5, yBot - yTop - 1);
          const bw = (bin.pctOfMax / 100) * vpMaxW;
          const isPocBin = poc != null && poc >= bin.priceLow && poc <= bin.priceHigh;
          return (
            <rect
              key={`vp-${i}`}
              x={padLeft + plotW - bw}
              y={yTop}
              width={bw}
              height={bh}
              fill={isPocBin ? 'rgba(124, 58, 237, 0.34)' : 'rgba(100, 116, 139, 0.14)'}
              rx={1}
            />
          );
        })}

        {/* 主图与量区分割线 */}
        <line x1={padLeft} y1={volTop - 2} x2={padLeft + plotW} y2={volTop - 2} stroke="var(--border)" strokeWidth="0.8" />

        {/* 支撑位 / 压力位 / 筹码峰 POC 水平线与防重叠右侧价格标签 */}
        {rightTags.map((tag) => (
          <g key={tag.key}>
            <line
              x1={padLeft}
              y1={tag.rawY}
              x2={padLeft + plotW}
              y2={tag.rawY}
              stroke={tag.color}
              strokeWidth={tag.lineWidth}
              strokeDasharray={tag.dash}
              opacity={tag.opacity}
            />
            <line
              x1={padLeft + plotW}
              y1={tag.rawY}
              x2={padLeft + plotW + 7}
              y2={tag.labelY}
              stroke={tag.color}
              strokeWidth="0.9"
              opacity="0.7"
            />
            <rect
              x={padLeft + plotW + 7}
              y={tag.labelY - 7}
              width={98}
              height={14}
              rx={3}
              fill={tag.bg}
            />
            <text
              x={padLeft + plotW + 11}
              y={tag.labelY + 3.5}
              fontSize="9.8"
              fontWeight="700"
              fill={tag.color}
              fontFamily="var(--font-mono)"
            >
              {tag.text}
            </text>
          </g>
        ))}

        {/* 海龟 2N 硬止损参考虚线 */}
        {turtleStop2N != null && turtleStop2N > minP && turtleStop2N < maxP && (
          <line
            x1={padLeft}
            y1={yOf(turtleStop2N)}
            x2={padLeft + plotW}
            y2={yOf(turtleStop2N)}
            stroke="#d97706"
            strokeWidth="1"
            strokeDasharray="2 4"
            opacity="0.7"
          />
        )}

        {/* K 线蜡烛 + 底部成交量柱 */}
        {klines.map((k, i) => {
          const cx = xOf(i);
          const up = k.close >= k.open;
          const col = up ? '#dc2626' : '#16a34a';
          const bodyTop = yOf(Math.max(k.open, k.close));
          const bodyBot = yOf(Math.min(k.open, k.close));
          const bodyH = Math.max(1.4, bodyBot - bodyTop);
          const vh = Math.max(1.5, ((k.vol || 0) / maxVol) * volH);

          return (
            <g key={k.date}>
              {hoverIdx === i && (
                <rect
                  x={cx - step / 2}
                  y={padTop}
                  width={step}
                  height={volBottom - padTop}
                  fill="var(--navy)"
                  opacity="0.06"
                />
              )}
              <line x1={cx} y1={yOf(k.high)} x2={cx} y2={yOf(k.low)} stroke={col} strokeWidth="1.1" />
              <rect x={cx - candleW / 2} y={bodyTop} width={candleW} height={bodyH} fill={col} rx={0.8} />
              <rect
                x={cx - candleW / 2}
                y={volBottom - vh}
                width={candleW}
                height={vh}
                fill={up ? 'rgba(220,38,38,0.52)' : 'rgba(22,163,74,0.5)'}
                rx={0.6}
              />
            </g>
          );
        })}

        {/* MA5 / MA20 均线 */}
        {ma5Path && <path d={ma5Path} fill="none" stroke="#f59e0b" strokeWidth="1.4" />}
        {ma20Path && <path d={ma20Path} fill="none" stroke="#2563eb" strokeWidth="1.4" />}

        {/* 底部时间轴 */}
        <text x={padLeft} y={H - 3} fontSize="10" fill="var(--text-muted)" fontFamily="var(--font-mono)">
          {klines[0].date}
        </text>
        <text x={padLeft + plotW / 2} y={H - 3} textAnchor="middle" fontSize="10" fill="var(--text-muted)" fontFamily="var(--font-mono)">
          {klines[Math.floor(klines.length / 2)]?.date}
        </text>
        <text x={padLeft + plotW} y={H - 3} textAnchor="end" fontSize="10" fill="var(--text-muted)" fontFamily="var(--font-mono)">
          {klines[klines.length - 1].date}
        </text>
      </svg>
    </div>
  );
};
