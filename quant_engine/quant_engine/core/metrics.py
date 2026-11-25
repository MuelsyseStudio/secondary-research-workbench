"""Institutional backtest performance metrics & monthly return heatmap matrix."""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any

import numpy as np

from .broker import RejectRecord, TradeFill


def compute_performance_metrics(
    equity_curve: list[dict[str, Any]],
    trades: list[TradeFill],
    rejects: list[RejectRecord],
    initial_cash: float,
    total_fees: float,
    total_turnover: float,
    annual_days: int = 252,
    risk_free_rate: float = 0.02,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Compute comprehensive metrics + Year×Month return heatmap rows."""
    if not equity_curve:
        return (
            {
                "totalReturnPct": 0.0,
                "annualizedReturnPct": 0.0,
                "benchmarkReturnPct": 0.0,
                "excessReturnPct": 0.0,
                "sharpeRatio": 0.0,
                "sortinoRatio": 0.0,
                "maxDrawdownPct": 0.0,
                "maxDrawdownStart": None,
                "maxDrawdownEnd": None,
                "calmarRatio": 0.0,
                "winRatePct": 0.0,
                "profitLossRatio": 0.0,
                "tradeCount": 0,
                "closedTradeCount": 0,
                "turnoverRatio": 0.0,
                "totalFees": 0.0,
                "rejectCount": len(rejects),
                "finalEquity": round(initial_cash, 2),
            },
            [],
        )

    equities = np.array([float(x["equity"]) for x in equity_curve], dtype=np.float64)
    benches = np.array([float(x.get("benchmarkNav") or 1.0) for x in equity_curve], dtype=np.float64)
    dates = [str(x["date"]) for x in equity_curve]

    final_eq = float(equities[-1])
    total_ret = (final_eq / initial_cash) - 1.0 if initial_cash > 0 else 0.0
    bench_ret = (float(benches[-1]) / float(benches[0])) - 1.0 if benches[0] > 0 else 0.0
    excess_ret = total_ret - bench_ret

    n_periods = max(1, len(equities) - 1)
    years = max(n_periods / float(annual_days), 1.0 / float(annual_days))
    ann_ret = ((1.0 + total_ret) ** (1.0 / years) - 1.0) if total_ret > -0.999 else -1.0

    # Daily / bar returns
    if len(equities) > 1:
        rets = np.diff(equities) / np.where(equities[:-1] > 0, equities[:-1], 1.0)
    else:
        rets = np.array([0.0], dtype=np.float64)

    mean_r = float(np.mean(rets))
    std_r = float(np.std(rets, ddof=1)) if len(rets) > 1 else 0.0
    rf_bar = risk_free_rate / float(annual_days)
    sharpe = ((mean_r - rf_bar) / std_r * math.sqrt(annual_days)) if std_r > 1e-12 else 0.0

    downside = rets[rets < rf_bar] - rf_bar
    down_std = float(np.sqrt(np.mean(downside**2))) if len(downside) > 0 else 0.0
    sortino = ((mean_r - rf_bar) / down_std * math.sqrt(annual_days)) if down_std > 1e-12 else 0.0

    # Max drawdown + dates
    running_max = np.maximum.accumulate(equities)
    dd_arr = np.where(running_max > 0, (equities - running_max) / running_max, 0.0)
    min_dd_idx = int(np.argmin(dd_arr))
    max_dd = abs(float(dd_arr[min_dd_idx]))
    peak_idx = int(np.argmax(equities[: min_dd_idx + 1])) if min_dd_idx >= 0 else 0
    calmar = (ann_ret / max_dd) if max_dd > 1e-9 else 0.0

    # Closed trade stats
    closed = [t for t in trades if t.pnl is not None]
    wins = [t for t in closed if (t.pnl or 0.0) > 0]
    losses = [t for t in closed if (t.pnl or 0.0) < 0]
    win_rate = (len(wins) / len(closed) * 100.0) if closed else 0.0
    avg_win = float(np.mean([t.pnl for t in wins])) if wins else 0.0
    avg_loss = abs(float(np.mean([t.pnl for t in losses]))) if losses else 0.0
    pl_ratio = (avg_win / avg_loss) if avg_loss > 1e-9 else (avg_win if avg_win > 0 else 0.0)

    avg_eq = float(np.mean(equities)) if len(equities) > 0 else initial_cash
    turnover_ratio = (total_turnover / avg_eq) if avg_eq > 0 else 0.0

    # Monthly returns heatmap (year -> month 1..12 -> pct)
    by_ym: dict[tuple[int, int], list[float]] = defaultdict(list)
    for dt_s, eq_val in zip(dates, equities):
        if len(dt_s) >= 7:
            try:
                y = int(dt_s[0:4])
                m = int(dt_s[5:7])
                by_ym[(y, m)].append(float(eq_val))
            except ValueError:
                continue

    years_sorted = sorted({y for (y, _) in by_ym.keys()})
    monthly_matrix: list[dict[str, Any]] = []
    prev_month_end_eq: float | None = None
    for y in years_sorted:
        row: dict[str, Any] = {"year": y, "months": {}, "yearTotalPct": None}
        year_start_eq = prev_month_end_eq
        year_end_eq = None
        for m in range(1, 13):
            vals = by_ym.get((y, m))
            if not vals:
                continue
            start_v = prev_month_end_eq if prev_month_end_eq is not None else vals[0]
            if year_start_eq is None:
                year_start_eq = start_v
            end_v = vals[-1]
            m_ret = ((end_v / start_v) - 1.0) * 100.0 if start_v > 0 else 0.0
            row["months"][str(m)] = round(m_ret, 2)
            prev_month_end_eq = end_v
            year_end_eq = end_v
        if year_start_eq and year_end_eq:
            row["yearTotalPct"] = round(((year_end_eq / year_start_eq) - 1.0) * 100.0, 2)
        monthly_matrix.append(row)

    metrics = {
        "totalReturnPct": round(total_ret * 100.0, 2),
        "annualizedReturnPct": round(ann_ret * 100.0, 2),
        "benchmarkReturnPct": round(bench_ret * 100.0, 2),
        "excessReturnPct": round(excess_ret * 100.0, 2),
        "sharpeRatio": round(sharpe, 2),
        "sortinoRatio": round(sortino, 2),
        "maxDrawdownPct": round(max_dd * 100.0, 2),
        "maxDrawdownStart": dates[peak_idx] if dates else None,
        "maxDrawdownEnd": dates[min_dd_idx] if dates else None,
        "calmarRatio": round(calmar, 2),
        "winRatePct": round(win_rate, 2),
        "profitLossRatio": round(pl_ratio, 2),
        "tradeCount": len(trades),
        "closedTradeCount": len(closed),
        "turnoverRatio": round(turnover_ratio, 2),
        "totalFees": round(total_fees, 2),
        "rejectCount": len(rejects),
        "finalEquity": round(final_eq, 2),
    }
    return metrics, monthly_matrix
