"""Cross-sectional dynamic stock screening & Top-K rotation layer (100% causal, zero lookahead)."""

from __future__ import annotations

from typing import Any, Callable

import numpy as np

from . import indicators as ind
from .context import BacktestContext


def score_symbol_on_bar(
    hist_df: Any,
    meta: dict[str, Any] | None,
    screener_cfg: dict[str, Any],
) -> tuple[bool, float, str]:
    """Evaluate screener filter criteria & ranking score causally using data <= current bar."""
    if hist_df is None or len(hist_df) < 22:
        return False, -1e9, ""

    if screener_cfg.get("excludeSt", True) and meta and meta.get("is_st"):
        return False, -1e9, ""

    closes = hist_df["close"].to_numpy(dtype=np.float64)
    highs = hist_df["high"].to_numpy(dtype=np.float64)
    vols = hist_df["volume"].to_numpy(dtype=np.float64)
    amts = hist_df["amount"].to_numpy(dtype=np.float64) if "amount" in hist_df.columns else (closes * vols)

    c = float(closes[-1])
    if not np.isfinite(c) or c <= 0:
        return False, -1e9, ""

    min_px = float(screener_cfg.get("minPrice") or 0.0)
    max_px = float(screener_cfg.get("maxPrice") or 0.0)
    if min_px > 0 and c < min_px:
        return False, -1e9, ""
    if max_px > 0 and c > max_px:
        return False, -1e9, ""

    min_amt_wan = float(screener_cfg.get("minAmountWan") or 0.0)
    if min_amt_wan > 0:
        recent_amt = float(np.nanmean(amts[-5:])) if len(amts) >= 5 else float(amts[-1])
        if not np.isfinite(recent_amt) or recent_amt < min_amt_wan * 10000.0:
            return False, -1e9, ""

    ma5 = ind.sma(closes, 5)
    ma20 = ind.sma(closes, 20)
    if screener_cfg.get("requireMaBull", False):
        if np.isnan(ma5[-1]) or np.isnan(ma20[-1]) or not (c > float(ma20[-1]) and float(ma5[-1]) >= float(ma20[-1])):
            return False, -1e9, ""

    max_bias5 = screener_cfg.get("maxBias5Pct")
    if max_bias5 is not None and str(max_bias5).strip() != "":
        b5 = ind.bias(closes, 5)
        if np.isnan(b5[-1]) or float(b5[-1]) > float(max_bias5):
            return False, -1e9, ""

    rank_by = str(screener_cfg.get("rankBy") or "momentum_20d").lower()
    if rank_by == "momentum_5d":
        ref = float(closes[-6]) if len(closes) >= 6 else float(closes[0])
        score = ((c - ref) / ref * 100.0) if ref > 0 else -1e9
        reason = f"5日动量 {score:+.1f}%"
    elif rank_by == "volume_ratio":
        vma20 = float(np.nanmean(vols[-21:-1])) if len(vols) >= 21 else float(np.nanmean(vols))
        score = (float(vols[-1]) / vma20) if vma20 > 0 else 0.0
        reason = f"放量比 {score:.2f}x"
    elif rank_by == "rsi_low":
        r14 = ind.rsi(closes, 14)
        rv = float(r14[-1]) if not np.isnan(r14[-1]) else 50.0
        # Lower RSI ranks higher for mean-reversion screening
        score = -rv
        reason = f"低RSI超跌 ({rv:.1f})"
    elif rank_by == "breakout_20d":
        prev_hi = float(np.nanmax(highs[-21:-1])) if len(highs) >= 21 else float(np.nanmax(highs))
        score = ((c - prev_hi) / prev_hi * 100.0) if prev_hi > 0 else -1e9
        reason = f"20日突破强度 {score:+.1f}%"
    elif rank_by == "amount":
        score = float(amts[-1]) / 1e8 if np.isfinite(amts[-1]) else 0.0
        reason = f"成交额 {score:.1f}亿"
    else:
        # default: momentum_20d
        ref = float(closes[-21]) if len(closes) >= 21 else float(closes[0])
        score = ((c - ref) / ref * 100.0) if ref > 0 else -1e9
        reason = f"20日动量 {score:+.1f}%"

    if not np.isfinite(score):
        return False, -1e9, ""
    return True, float(score), reason


def wrap_strategy_with_screener(
    init_fn: Callable[[BacktestContext], None],
    on_bar_fn: Callable[[BacktestContext, str], None],
    screener_cfg: dict[str, Any],
    symbol_meta: dict[str, dict[str, Any]] | None = None,
    screener_history: list[dict[str, Any]] | None = None,
) -> tuple[Callable[[BacktestContext], None], Callable[[BacktestContext, str], None]]:
    """Wrap any strategy with causal cross-sectional Top-K stock selection & periodic rotation."""
    top_k = max(1, min(30, int(screener_cfg.get("topK") or 5)))
    rebalance_days = max(1, min(60, int(screener_cfg.get("rebalanceDays") or 5)))
    pure_rotation = bool(screener_cfg.get("pureRotation", False))
    meta_map = symbol_meta or {}
    state = {"bar_count": 0, "active_pool": []}

    def wrapped_init(ctx: BacktestContext) -> None:
        ctx.params["_all_universe_symbols"] = list(ctx.symbols)
        init_fn(ctx)

    def wrapped_on_bar(ctx: BacktestContext, bar_dt: str) -> None:
        all_syms = list(ctx.params.get("_all_universe_symbols") or ctx.symbols)
        need_rebalance = (state["bar_count"] % rebalance_days == 0) or (len(state["active_pool"]) == 0)
        state["bar_count"] += 1

        if need_rebalance:
            ranked: list[tuple[float, str, str]] = []
            for sym in all_syms:
                h = ctx.history(sym, 65)
                ok, sc, reason = score_symbol_on_bar(h, meta_map.get(sym), screener_cfg)
                if ok:
                    ranked.append((sc, sym, reason))
            ranked.sort(key=lambda x: x[0], reverse=True)
            picked = ranked[:top_k]
            picked_syms = [x[1] for x in picked]
            state["active_pool"] = picked_syms
            ctx.params["screened_symbols"] = picked_syms

            if screener_history is not None and len(screener_history) < 120:
                screener_history.append(
                    {
                        "date": str(bar_dt)[:10],
                        "candidates": len(all_syms),
                        "passed": len(ranked),
                        "selected": [{"symbol": s, "score": round(sc, 3), "reason": r} for sc, s, r in picked],
                    }
                )

            # Rotate out held positions that dropped out of Top-K
            picked_set = set(picked_syms)
            for held_sym, pos in list(ctx._broker.positions.items()):
                if pos.quantity > 1e-9 and held_sym not in picked_set:
                    ctx.close_position(held_sym, reason="选股轮动剔除离场")

            if pure_rotation and picked_syms:
                w = min(0.92 / len(picked_syms), float(screener_cfg.get("maxWeightPerStock") or 0.30))
                for sc, sym, reason in picked:
                    pos = ctx.position(sym)
                    if pos is None or pos.quantity <= 1e-9:
                        ctx.order_target_percent(sym, w, reason=f"动态选股入选 ({reason})")
                return

        if not pure_rotation:
            # Expose only currently screened Top-K + held symbols to the underlying timing strategy
            held = [s for s, p in ctx._broker.positions.items() if p.quantity > 1e-9]
            active_syms = list(dict.fromkeys([*state["active_pool"], *held]))
            prev_syms = ctx.symbols
            ctx.symbols = active_syms
            try:
                on_bar_fn(ctx, bar_dt)
            finally:
                ctx.symbols = prev_syms

    return wrapped_init, wrapped_on_bar
