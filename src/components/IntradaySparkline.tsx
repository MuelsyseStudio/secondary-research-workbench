import React from 'react';
import type { IntradayPoint } from '../types';

interface IntradaySparklineProps {
  points?: IntradayPoint[];
  height?: number;
  highTime?: string;
  lowTime?: string;
}

/**
 * 真实 1 分钟分时 SVG 走势图
 * - 严格以昨收价（0%）虚线为归一化基准
 * - 蓝/红/绿遵循 A 股红涨绿跌视觉语义，叠加黄色日内均价线
 */
export const IntradaySparkline: React.FC<IntradaySparklineProps> = ({
  points,
  height = 64,
  highTime,
  lowTime,
}) => {
  if (!points || points.length < 2) {
    return (
      <div
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          color: 'var(--text-muted)',
          background: 'var(--bg-soft)',
          borderRadius: 6,
        }}
      >
        暂无 1 分钟分时数据
      </div>
    );
  }

  const w = 240;
  const h = height;
  const padX = 4;
  const padY = 6;
  const allVals = points.flatMap((p) => [p.p, p.a, 0]);
  const maxV = Math.max(...allVals);
  const minV = Math.min(...allVals);
  const span = Math.max(0.2, maxV - minV);

  const toX = (idx: number) => padX + (idx / (points.length - 1)) * (w - padX * 2);
  const toY = (val: number) => padY + ((maxV - val) / span) * (h - padY * 2);

  const zeroY = toY(0);
  const lastPct = points[points.length - 1].p;
  const lineColor = lastPct > 0 ? '#dc2626' : lastPct < 0 ? '#16a34a' : '#64748b';
  const fillColor = lastPct > 0 ? 'rgba(220, 38, 38, 0.10)' : lastPct < 0 ? 'rgba(22, 163, 74, 0.10)' : 'rgba(100, 116, 139, 0.08)';

  const priceLine = points.map((pt, i) => `${toX(i).toFixed(1)},${toY(pt.p).toFixed(1)}`).join(' ');
  const avgLine = points.map((pt, i) => `${toX(i).toFixed(1)},${toY(pt.a).toFixed(1)}`).join(' ');
  const areaPoly = `${toX(0).toFixed(1)},${zeroY.toFixed(1)} ${priceLine} ${toX(points.length - 1).toFixed(1)},${zeroY.toFixed(1)}`;

  // 找最接近 highTime / lowTime 的标记点
  const hiIdx = highTime ? points.findIndex((p) => p.t >= highTime) : -1;
  const loIdx = lowTime ? points.findIndex((p) => p.t >= lowTime) : -1;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height, display: 'block', background: 'var(--bg-soft)', borderRadius: 6 }}>
      {/* 昨收 0% 基准线 */}
      <line x1={padX} x2={w - padX} y1={zeroY} y2={zeroY} stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="3 3" />
      {/* 面积填充 */}
      <polygon points={areaPoly} fill={fillColor} />
      {/* 均价线 */}
      <polyline points={avgLine} fill="none" stroke="#d97706" strokeWidth="1.1" strokeOpacity="0.75" />
      {/* 价格分时主线 */}
      <polyline points={priceLine} fill="none" stroke={lineColor} strokeWidth="1.7" strokeLinejoin="round" />
      {hiIdx >= 0 && (
        <circle cx={toX(hiIdx)} cy={toY(points[hiIdx].p)} r="2.6" fill="#dc2626" stroke="#fff" strokeWidth="0.9" />
      )}
      {loIdx >= 0 && (
        <circle cx={toX(loIdx)} cy={toY(points[loIdx].p)} r="2.6" fill="#16a34a" stroke="#fff" strokeWidth="0.9" />
      )}
    </svg>
  );
};
