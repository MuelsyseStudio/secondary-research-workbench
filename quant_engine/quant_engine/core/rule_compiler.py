"""No-code Visual JSON Rule Compiler -> Executable strategy hooks."""

from __future__ import annotations

from typing import Any, Callable

import numpy as np

from . import indicators as ind
from .context import BacktestContext


def _eval_operand(op_spec: dict[str, Any], df_close: np.ndarray, df_high: np.ndarray, df_low: np.ndarray, df_vol: np.ndarray) -> np.ndarray:
    kind = str(op_spec.get("type") or "CONST").upper()
    period = int(op_spec.get("period") or 20)
    if kind == "CONST":
        val = float(op_spec.get("value") or 0.0)
        return np.full(len(df_close), val, dtype=np.float64)
    if kind == "CLOSE":
        return df_close
    if kind == "MA":
        return ind.sma(df_close, period)
    if kind == "EMA":
        return ind.ema(df_close, period)
    if kind == "RSI":
        return ind.rsi(df_close, period)
    if kind == "BIAS":
        return ind.bias(df_close, period)
    if kind == "MACD_HIST":
        _, _, h = ind.macd(df_close)
        return h
    if kind == "MACD_DIF":
        d, _, _ = ind.macd(df_close)
        return d
    if kind == "MACD_DEA":
        _, dea, _ = ind.macd(df_close)
        return dea
    if kind == "BOLL_UPPER":
        u, _, _ = ind.boll(df_close, period)
        return u
    if kind == "BOLL_LOWER":
        _, _, l = ind.boll(df_close, period)
        return l
    if kind == "VOL_RATIO":
        vma = ind.sma(df_vol, period)
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.where(vma > 0, df_vol / vma, np.nan)
    if kind == "PCT_CHG":
        out = np.full(len(df_close), np.nan, dtype=np.float64)
        if len(df_close) > 1:
            out[1:] = ((df_close[1:] - df_close[:-1]) / np.where(df_close[:-1] > 0, df_close[:-1], np.nan)) * 100.0
        return out
    return np.full(len(df_close), np.nan, dtype=np.float64)


def _normalize_condition_operands(cond: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Support both {left, right} and UI StrategyRuleBuilder {indicator, period, rhsType, rhsIndicator, rhsPeriod, value}."""
    if isinstance(cond.get("left"), dict) and isinstance(cond.get("right"), dict):
        return cond["left"], cond["right"]
    left = {"type": str(cond.get("indicator") or "CLOSE").upper(), "period": int(cond.get("period") or 20)}
    rhs_type = str(cond.get("rhsType") or "value").lower()
    if rhs_type == "indicator":
        right = {"type": str(cond.get("rhsIndicator") or "MA").upper(), "period": int(cond.get("rhsPeriod") or 20)}
    else:
        right = {"type": "CONST", "value": float(cond.get("value") or 0.0)}
    return left, right


def _eval_condition(cond: dict[str, Any], df_close: np.ndarray, df_high: np.ndarray, df_low: np.ndarray, df_vol: np.ndarray) -> bool:
    left_spec, right_spec = _normalize_condition_operands(cond)
    left = _eval_operand(left_spec, df_close, df_high, df_low, df_vol)
    right = _eval_operand(right_spec, df_close, df_high, df_low, df_vol)
    if len(left) == 0 or len(right) == 0:
        return False
    op = str(cond.get("op") or ">").strip().lower()
    if op == "cross_above":
        return ind.crossover(left, right)
    if op == "cross_below":
        return ind.crossunder(left, right)
    a, b = float(left[-1]), float(right[-1])
    if np.isnan(a) or np.isnan(b):
        return False
    if op == ">":
        return a > b
    if op == ">=":
        return a >= b
    if op == "<":
        return a < b
    if op == "<=":
        return a <= b
    if op in ("==", "="):
        return abs(a - b) < 1e-6
    return False


def compile_visual_rule(rule_json: dict[str, Any]) -> tuple[Callable[[BacktestContext], None], Callable[[BacktestContext, str], None]]:
    """Compile a structured visual JSON rule config into (init_fn, on_bar_fn)."""
    entry_logic = str(rule_json.get("entryLogic") or "AND").upper()
    exit_logic = str(rule_json.get("exitLogic") or "OR").upper()
    entry_conds: list[dict[str, Any]] = list(rule_json.get("entryConditions") or [])
    exit_conds: list[dict[str, Any]] = list(rule_json.get("exitConditions") or [])
    pos_mode = str(rule_json.get("positionMode") or "equal_weight")
    fixed_weight = float(rule_json.get("targetWeight") or 0.30)
    lookback = int(rule_json.get("lookback") or 120)

    def init_fn(ctx: BacktestContext) -> None:
        ctx.params["rule_name"] = rule_json.get("name", "可视化规则策略")

    def on_bar_fn(ctx: BacktestContext, bar_dt: str) -> None:
        del bar_dt
        n_syms = max(1, len(ctx.symbols))
        target_w = min(0.95 / n_syms, fixed_weight) if pos_mode == "equal_weight" else min(0.95, fixed_weight)

        for sym in ctx.symbols:
            hist = ctx.history(sym, lookback)
            if hist is None or len(hist) < 5:
                continue
            closes = hist["close"].to_numpy(dtype=np.float64)
            highs = hist["high"].to_numpy(dtype=np.float64)
            lows = hist["low"].to_numpy(dtype=np.float64)
            vols = hist["volume"].to_numpy(dtype=np.float64)

            pos = ctx.position(sym)
            has_pos = pos is not None and pos.quantity > 1e-9

            if has_pos and exit_conds:
                evals = [_eval_condition(c, closes, highs, lows, vols) for c in exit_conds]
                should_exit = all(evals) if exit_logic == "AND" else any(evals)
                if should_exit:
                    ctx.close_position(sym, reason="满足可视化离场条件")
                    continue

            if not has_pos and entry_conds:
                evals = [_eval_condition(c, closes, highs, lows, vols) for c in entry_conds]
                should_enter = all(evals) if entry_logic == "AND" else any(evals)
                if should_enter:
                    ctx.order_target_percent(sym, target_w, reason="满足可视化入场条件")

    return init_fn, on_bar_fn
