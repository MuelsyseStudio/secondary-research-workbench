"""Original Multi-Market Event-Driven Backtest Engine + AST Safety Validator."""

from __future__ import annotations

import ast
import csv
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pandas as pd

from ..protocol import (
    default_benchmark_for_market,
    emit_done,
    emit_error,
    emit_log,
    emit_progress,
    normalize_symbol,
    validate_edition_asset_inputs,
)
from ..storage.adjust import apply_adjustment, audit_symbol_gaps
from ..storage.calendar import generate_calendar_dates, is_symbol_tradable_on
from ..storage.duckdb_store import DuckDBStore
from . import indicators as ind
from .broker import Broker, OrderIntent
from .context import BacktestContext
from .market_profiles import MarketProfile, get_market_profile
from .metrics import compute_performance_metrics
from .risk import RiskConfig, RiskManager
from .rule_compiler import compile_visual_rule
from .screener import wrap_strategy_with_screener

FORBIDDEN_IMPORTS = {
    "subprocess",
    "shutil",
    "socket",
    "ctypes",
    "multiprocessing",
    "pty",
    "fcntl",
    "winreg",
    "webbrowser",
    "http",
    "urllib",
    "requests",
}

FORBIDDEN_CALLS = {
    "eval",
    "exec",
    "compile",
    "__import__",
    "open",
    "input",
    "system",
    "popen",
    "rmtree",
    "remove",
    "unlink",
    "rmdir",
}


def validate_strategy_code_ast(code: str) -> list[str]:
    """Static AST guard blocking destructive OS / shell / file calls in user strategy scripts."""
    issues: list[str] = []
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return [f"Python 语法错误 (第 {exc.lineno} 行): {exc.msg}"]

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root in FORBIDDEN_IMPORTS or root == "os" or root == "sys":
                    issues.append(f"安全限制：策略脚本禁止导入模块 `{alias.name}`")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root in FORBIDDEN_IMPORTS or root == "os" or root == "sys":
                issues.append(f"安全限制：策略脚本禁止从 `{node.module}` 导入")
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in FORBIDDEN_CALLS:
                issues.append(f"安全限制：策略脚本禁止调用 `{node.func.id}()`")
            elif isinstance(node.func, ast.Attribute) and node.func.attr in FORBIDDEN_CALLS:
                issues.append(f"安全限制：策略脚本禁止调用 `.{node.func.attr}()`")
    return issues


def load_python_strategy(code: str) -> tuple[Callable[[BacktestContext], None], Callable[[BacktestContext, str], None], dict[str, Any]]:
    issues = validate_strategy_code_ast(code)
    if issues:
        raise ValueError("；".join(issues))

    safe_builtins = {
        "abs": abs,
        "all": all,
        "any": any,
        "bool": bool,
        "dict": dict,
        "enumerate": enumerate,
        "filter": filter,
        "float": float,
        "int": int,
        "isinstance": isinstance,
        "len": len,
        "list": list,
        "map": map,
        "max": max,
        "min": min,
        "pow": pow,
        "range": range,
        "round": round,
        "set": set,
        "sorted": sorted,
        "str": str,
        "sum": sum,
        "tuple": tuple,
        "zip": zip,
        "True": True,
        "False": False,
        "None": None,
    }
    ns: dict[str, Any] = {
        "__builtins__": safe_builtins,
        "np": np,
        "pd": pd,
        "math": math,
        "ind": ind,
    }
    exec(compile(code, "<strategy>", "exec"), ns)  # noqa: S102 — gated by AST allowlist
    init_fn = ns.get("init") or (lambda ctx: None)
    on_bar_fn = ns.get("on_bar")
    if not callable(on_bar_fn):
        raise ValueError("策略脚本必须定义 `def on_bar(ctx, bar_dt):` 回调函数")
    meta = {
        "cardRefs": list(ns.get("CARD_REFS") or []),
        "strategyName": str(ns.get("STRATEGY_NAME") or ""),
    }
    return init_fn, on_bar_fn, meta


def _order_execution_sequence(orders: list[OrderIntent], broker: Broker) -> list[OrderIntent]:
    """Run closing sells for already-held symbols first to free cash for rebalancing,
    while preserving exact order for same-symbol buy-then-sell sequences."""
    bought_syms: set[str] = set()
    early_sells: list[OrderIntent] = []
    rest: list[OrderIntent] = []
    for o in orders:
        is_sell = (o.kind == "shares" and o.value < 0) or (o.kind == "target_percent" and o.value <= 0)
        pos = broker.positions.get(o.symbol)
        has_long = pos is not None and pos.quantity > 1e-9
        if is_sell and has_long and o.symbol not in bought_syms:
            early_sells.append(o)
        else:
            if not is_sell:
                bought_syms.add(o.symbol)
            rest.append(o)
    return [*early_sells, *rest]


def run_backtest_core(
    bars_by_symbol: dict[str, pd.DataFrame],
    symbols: list[str],
    market: str,
    start_date: str,
    end_date: str,
    init_fn: Callable[[BacktestContext], None],
    on_bar_fn: Callable[[BacktestContext, str], None],
    *,
    profile: MarketProfile | None = None,
    profile_overrides: dict[str, Any] | None = None,
    initial_cash: float = 1_000_000.0,
    match_mode: str = "next_open",
    risk_config: RiskConfig | None = None,
    benchmark_df: pd.DataFrame | None = None,
    benchmark_symbol: str = "",
    symbol_meta: dict[str, dict[str, Any]] | None = None,
    params: dict[str, Any] | None = None,
    timeline: list[str] | None = None,
    progress_cb: Callable[[float, str], None] | None = None,
    log_cb: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """Pure in-memory event-driven multi-market backtest loop (directly unit-testable)."""
    prof = profile or get_market_profile(market, profile_overrides)
    r_cfg = risk_config or RiskConfig()
    risk_mgr = RiskManager(r_cfg)

    meta_map = symbol_meta or {}
    lot_sizes = {
        sym: float(meta_map[sym]["lot_size"])
        for sym in symbols
        if sym in meta_map and meta_map[sym].get("lot_size")
    }
    broker = Broker(prof, initial_cash=initial_cash, symbol_lot_sizes=lot_sizes)

    # Standardize bar DataFrames with a unified `dt` string column
    norm_bars: dict[str, pd.DataFrame] = {}
    bar_lookup: dict[str, dict[str, dict[str, Any]]] = {}
    all_dts: set[str] = set()
    for sym in symbols:
        df = bars_by_symbol.get(sym)
        if df is None or df.empty:
            continue
        w = df.copy()
        if "dt" not in w.columns:
            w["dt"] = w["trade_date"].astype(str) if "trade_date" in w.columns else w["bar_time"].astype(str)
        w["dt"] = w["dt"].astype(str)
        w = w.sort_values("dt").drop_duplicates(subset=["dt"], keep="last").reset_index(drop=True)
        norm_bars[sym] = w
        lookup: dict[str, dict[str, Any]] = {}
        for _, row in w.iterrows():
            d_str = str(row["dt"])
            lookup[d_str] = row.to_dict()
            if start_date <= d_str[:10] <= end_date:
                all_dts.add(d_str)
        bar_lookup[sym] = lookup

    eval_timeline = list(timeline) if timeline else sorted(all_dts)
    if not eval_timeline:
        raise ValueError(f"选定区间 {start_date} ~ {end_date} 内在本地 DuckDB 未找到任何 K 线数据，请先同步历史数据")

    # Benchmark nav lookup
    bench_map: dict[str, float] = {}
    if benchmark_df is not None and not benchmark_df.empty:
        b_col = "dt" if "dt" in benchmark_df.columns else ("trade_date" if "trade_date" in benchmark_df.columns else "bar_time")
        for _, r in benchmark_df.iterrows():
            bench_map[str(r[b_col])] = float(r["close"])
            bench_map[str(r[b_col])[:10]] = float(r["close"])

    ctx = BacktestContext(broker, symbols, norm_bars, params=params, log_cb=log_cb)
    init_fn(ctx)

    pending_next_open: list[OrderIntent] = []
    latest_prices: dict[str, float] = {}
    equity_curve: list[dict[str, Any]] = []
    bench_base: float | None = None
    last_bench_px: float | None = None
    running_peak_eq = float(initial_cash)
    total_steps = len(eval_timeline)

    for step_idx, dt in enumerate(eval_timeline):
        broker.on_new_day(dt)
        bars_today: dict[str, dict[str, Any]] = {}
        for sym in symbols:
            b = bar_lookup.get(sym, {}).get(dt)
            if b is not None and is_symbol_tradable_on(meta_map.get(sym), dt):
                bars_today[sym] = b

        # 1. Execute queued next_open orders at TODAY'S OPEN before today's close signal
        if match_mode == "next_open" and pending_next_open:
            open_prices = {**latest_prices, **{s: float(b["open"]) for s, b in bars_today.items()}}
            for intent in _order_execution_sequence(pending_next_open, broker):
                b = bars_today.get(intent.symbol)
                if b is None:
                    continue
                max_buy, _ = risk_mgr.compute_max_buy_notional(broker, intent, dt, open_prices, float(b["open"]))
                if max_buy == 0.0:
                    continue
                broker.execute_order(intent, dt, b, open_prices, match_mode="next_open", max_buy_notional=max_buy)
            pending_next_open = []

        # 2. Update close prices & trailing highs for today
        for sym, b in bars_today.items():
            latest_prices[sym] = float(b["close"])
        broker.update_trailing_highs(bars_today)
        ctx._advance_clock(dt, latest_prices)

        # 3. Compute causal ATR if trailing stop enabled
        atr_map: dict[str, float | None] = {}
        if r_cfg.trailing_atr_mult:
            for sym in broker.positions:
                h_df = ctx.history(sym, 25)
                if h_df is not None and len(h_df) >= 15:
                    a_arr = ind.atr(h_df["high"].to_numpy(), h_df["low"].to_numpy(), h_df["close"].to_numpy(), 14)
                    if not np.isnan(a_arr[-1]):
                        atr_map[sym] = float(a_arr[-1])

        # 4. Run risk exits + user strategy on_bar(ctx, dt)
        risk_exits = risk_mgr.check_position_exits(broker, dt, bars_today, atr_map)
        on_bar_fn(ctx, dt)
        strategy_orders = ctx._pop_orders()
        combined_orders = [*risk_exits, *strategy_orders]

        if combined_orders:
            if match_mode == "close":
                for intent in _order_execution_sequence(combined_orders, broker):
                    b = bars_today.get(intent.symbol)
                    if b is None:
                        continue
                    max_buy, _ = risk_mgr.compute_max_buy_notional(broker, intent, dt, latest_prices, float(b["close"]))
                    if max_buy == 0.0:
                        continue
                    broker.execute_order(intent, dt, b, latest_prices, match_mode="close", max_buy_notional=max_buy)
            else:
                # Queue for next bar open (strictly zero lookahead)
                pending_next_open.extend(combined_orders)

        # 5. Mark-to-market daily snapshot
        eq = broker.total_equity(latest_prices)
        risk_mgr.update_peak(eq)
        if eq > running_peak_eq:
            running_peak_eq = eq
        dd_pct = ((eq - running_peak_eq) / running_peak_eq * 100.0) if running_peak_eq > 0 else 0.0
        pos_val = sum(abs(p.quantity) * latest_prices.get(s, p.avg_cost) for s, p in broker.positions.items() if abs(p.quantity) > 1e-9)
        pos_pct = (pos_val / eq * 100.0) if eq > 0 else 0.0

        b_px = bench_map.get(dt) or bench_map.get(dt[:10]) or last_bench_px
        if b_px is not None:
            last_bench_px = b_px
            if bench_base is None and b_px > 0:
                bench_base = b_px
        bench_nav = (last_bench_px / bench_base) if (last_bench_px and bench_base) else 1.0

        equity_curve.append(
            {
                "date": dt,
                "equity": round(eq, 2),
                "nav": round(eq / initial_cash, 4) if initial_cash > 0 else 1.0,
                "benchmarkNav": round(bench_nav, 4),
                "drawdownPct": round(dd_pct, 2),
                "positionPct": round(pos_pct, 2),
                "cash": round(broker.cash, 2),
            }
        )

        if progress_cb and (step_idx % max(1, total_steps // 20) == 0 or step_idx == total_steps - 1):
            pct = 10.0 + (step_idx + 1) / total_steps * 85.0
            progress_cb(pct, f"回测推进 {dt} ({step_idx + 1}/{total_steps})")

    metrics, monthly_returns = compute_performance_metrics(
        equity_curve=equity_curve,
        trades=broker.trades,
        rejects=broker.rejects,
        initial_cash=initial_cash,
        total_fees=broker.total_fees,
        total_turnover=broker.total_turnover,
        annual_days=prof.annual_trading_days,
    )

    return {
        "metrics": metrics,
        "equityCurve": equity_curve,
        "monthlyReturns": monthly_returns,
        "trades": [t.to_dict() for t in broker.trades],
        "rejects": [r.to_dict() for r in broker.rejects],
        "profile": {
            "market": prof.market,
            "currency": prof.currency,
            "settlementDays": prof.settlement_days,
            "priceLimitMode": prof.price_limit_mode,
            "stepSize": prof.step_size,
            "allowFractional": prof.allow_fractional,
            "allowShort": prof.allow_short,
            "commissionRate": prof.commission_rate,
            "minCommission": prof.min_commission,
            "sellStampDuty": prof.sell_stamp_duty,
            "buyStampDuty": prof.buy_stamp_duty,
            "slippageBps": prof.slippage_bps,
            "calendarMode": prof.calendar_mode,
        },
        "benchmarkSymbol": benchmark_symbol,
    }


def run_backtest_from_spec_file(spec_path: str, out_dir: str) -> int:
    spec_file = Path(spec_path).expanduser().resolve()
    out_path = Path(out_dir).expanduser().resolve()
    out_path.mkdir(parents=True, exist_ok=True)
    spec = json.loads(spec_file.read_text(encoding="utf-8"))

    run_id = str(spec.get("runId") or f"bt_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    edition = str(spec.get("edition") or os.environ.get("SRW_EDITION") or "personal").strip().lower()
    data_dir = str(spec["dataDir"])
    market = str(spec.get("market") or "CN").upper()
    universe_mode = str(spec.get("universeMode") or "explicit").lower()
    screener_cfg = spec.get("screener") if isinstance(spec.get("screener"), dict) else {}
    raw_symbols = spec.get("symbols") or []
    benchmark_raw = spec.get("benchmark")
    check_list = [*raw_symbols, *([benchmark_raw] if benchmark_raw else [])]
    validation_err = validate_edition_asset_inputs(check_list, market_hint=market, edition=edition)
    if validation_err:
        emit_error(validation_err)
        return 1

    start_date = str(spec.get("startDate") or "2024-01-01")[:10]
    end_date = str(spec.get("endDate") or datetime.now().strftime("%Y-%m-%d"))[:10]
    freq = str(spec.get("freq") or "1d")
    adjust_mode = str(spec.get("adjust") or "qfq")
    match_mode = str(spec.get("matchMode") or "next_open")
    initial_cash = float(spec.get("initialCash") or 1_000_000.0)
    benchmark_sym = normalize_symbol(benchmark_raw, market)[0] if benchmark_raw else default_benchmark_for_market(market)

    symbols = [normalize_symbol(s, market)[0] for s in raw_symbols if str(s).strip()]

    # 支持「全库选股池 / 动态选股轮动」模式：未显式指定标的时自动拉取本地 DuckDB 同市场全部已入库标的
    if universe_mode in ("duckdb_all", "screener") and not symbols:
        with DuckDBStore(data_dir, read_only=True) as store:
            symbols = store.list_symbols_by_market(market, freq=freq, exclude_symbols=[benchmark_sym] if benchmark_sym else [])
        if not symbols:
            emit_error(f"本地 DuckDB 中暂无 {market} 市场的 {freq} 历史标的，请先在「本地数据仓管理」同步核心股票池后再执行选股回测")
            return 1

    if not symbols:
        emit_error("回测标的列表不能为空")
        return 1

    emit_progress(4, f"只读加载 DuckDB ({market}, {len(symbols)} 候选标的, 模式={universe_mode})...")

    # Load historical bars read-only (safe for concurrent backtests on Windows)
    with DuckDBStore(data_dir, read_only=True) as store:
        query_syms = list(dict.fromkeys([*symbols, *([benchmark_sym] if benchmark_sym else [])]))
        # Warm-up window: pull extra 120 bars before start_date so MA60/RSI work on day 1!
        warm_start = f"{int(start_date[:4]) - 1}{start_date[4:]}"
        if freq == "1d":
            raw_df = store.query_daily_bars(query_syms, start_date=warm_start, end_date=end_date)
            factors_df = store.query_adjust_factors(query_syms)
            raw_df = apply_adjustment(raw_df, factors_df, adjust_mode=adjust_mode)
            cal_dates = generate_calendar_dates(
                store,
                market,
                start_date,
                end_date,
                fallback_bars_dates=raw_df["trade_date"].astype(str).tolist() if not raw_df.empty else [],
            )
        else:
            raw_df = store.query_minute_bars(query_syms, freq=freq, start_time=f"{warm_start} 00:00:00", end_time=f"{end_date} 23:59:59")
            cal_dates = []
        meta_map = store.query_security_meta(query_syms)

    if raw_df.empty:
        emit_error(f"本地 DuckDB 中未找到标的 {', '.join(symbols)} 的 {freq} 历史数据，请先在「本地数据仓管理」一键下载")
        return 1

    bars_by_symbol: dict[str, pd.DataFrame] = {}
    gap_warnings: list[dict[str, Any]] = []
    sources_used: set[str] = set()
    for sym in symbols:
        sub = raw_df[raw_df["symbol"] == sym].copy()
        if sub.empty:
            gap_warnings.append({"symbol": sym, "missingDays": len(cal_dates), "coveragePct": 0.0, "note": "本地库缺失该标的"})
            continue
        if "source" in sub.columns:
            sources_used.update(sub["source"].dropna().astype(str).unique().tolist())
        bars_by_symbol[sym] = sub
        if freq == "1d":
            g = audit_symbol_gaps(sub, cal_dates, sym)
            if g["missingDays"] > 0:
                gap_warnings.append(g)

    benchmark_df = raw_df[raw_df["symbol"] == benchmark_sym].copy() if benchmark_sym else None
    if benchmark_df is not None and benchmark_df.empty and symbols[0] in bars_by_symbol:
        # Fallback benchmark to buy-and-hold of first target symbol (e.g. FUT / single stock without index)
        benchmark_df = bars_by_symbol[symbols[0]].copy()
        benchmark_sym = f"{symbols[0]} (买入持有)"

    # Compile strategy (visual rule JSON or Python script)
    strategy_mode = str(spec.get("strategyMode") or "python")
    strategy_name = str(spec.get("strategyName") or "未命名策略")
    card_refs: list[str] = list(spec.get("cardRefs") or [])

    if strategy_mode == "visual":
        rule_json = spec.get("ruleConfig") or {}
        init_fn, on_bar_fn = compile_visual_rule(rule_json)
        if rule_json.get("name"):
            strategy_name = str(rule_json["name"])
    else:
        code = str(spec.get("code") or "")
        if not code.strip():
            emit_error("Python 策略代码为空")
            return 1
        init_fn, on_bar_fn, py_meta = load_python_strategy(code)
        if py_meta.get("cardRefs"):
            card_refs = list(dict.fromkeys([*card_refs, *py_meta["cardRefs"]]))
        if not spec.get("strategyName") and py_meta.get("strategyName"):
            strategy_name = py_meta["strategyName"]

    screener_history: list[dict[str, Any]] = []
    if universe_mode == "screener" or bool(screener_cfg.get("enabled", False)):
        init_fn, on_bar_fn = wrap_strategy_with_screener(
            init_fn,
            on_bar_fn,
            screener_cfg,
            symbol_meta=meta_map,
            screener_history=screener_history,
        )

    risk_spec = spec.get("risk") or {}
    r_cfg = RiskConfig(
        max_position_pct=float(risk_spec.get("maxPositionPct", 0.35)),
        max_total_exposure_pct=float(risk_spec.get("maxTotalExposurePct", 0.95)),
        max_holdings=int(risk_spec.get("maxHoldings", 10)),
        stop_loss_pct=float(risk_spec["stopLossPct"]) if risk_spec.get("stopLossPct") else None,
        take_profit_pct=float(risk_spec["takeProfitPct"]) if risk_spec.get("takeProfitPct") else None,
        trailing_atr_mult=float(risk_spec["trailingAtrMult"]) if risk_spec.get("trailingAtrMult") else None,
        max_drawdown_halt_pct=float(risk_spec["maxDrawdownHaltPct"]) if risk_spec.get("maxDrawdownHaltPct") else None,
        enable_card174_guard=bool(risk_spec.get("enableCard174Guard", False)),
        enable_sentiment_cap=bool(risk_spec.get("enableSentimentCap", False)),
        regulatory_blacklist=list(risk_spec.get("regulatoryBlacklist") or []),
        sentiment_caps=dict(risk_spec.get("sentimentCaps") or {}),
    )

    fee_overrides = spec.get("feeOverrides") or {}
    prof_overrides: dict[str, Any] = {}
    for src_k, dst_k in [
        ("commissionRate", "commission_rate"),
        ("minCommission", "min_commission"),
        ("sellStampDuty", "sell_stamp_duty"),
        ("buyStampDuty", "buy_stamp_duty"),
        ("slippageBps", "slippage_bps"),
        ("allowShort", "allow_short"),
    ]:
        if fee_overrides.get(src_k) is not None:
            prof_overrides[dst_k] = fee_overrides[src_k]

    core_out = run_backtest_core(
        bars_by_symbol=bars_by_symbol,
        symbols=symbols,
        market=market,
        start_date=start_date,
        end_date=end_date,
        init_fn=init_fn,
        on_bar_fn=on_bar_fn,
        profile_overrides=prof_overrides,
        initial_cash=initial_cash,
        match_mode=match_mode,
        risk_config=r_cfg,
        benchmark_df=benchmark_df,
        benchmark_symbol=benchmark_sym,
        symbol_meta=meta_map,
        params=spec.get("params") or {},
        progress_cb=emit_progress,
        log_cb=emit_log,
    )

    now_iso = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    result_payload = {
        "ok": True,
        "runId": run_id,
        "createdAt": now_iso,
        "meta": {
            "strategyId": spec.get("strategyId") or "",
            "strategyName": strategy_name,
            "strategyMode": strategy_mode,
            "universeMode": universe_mode,
            "screener": screener_cfg if (universe_mode == "screener" or screener_cfg.get("enabled")) else None,
            "screenerRebalances": len(screener_history),
            "market": market,
            "currency": core_out["profile"]["currency"],
            "symbols": symbols,
            "symbolNames": {s: (meta_map.get(s) or {}).get("name", s) for s in symbols},
            "startDate": start_date,
            "endDate": end_date,
            "freq": freq,
            "adjust": adjust_mode,
            "matchMode": match_mode,
            "initialCash": initial_cash,
            "benchmark": core_out["benchmarkSymbol"],
            "sources": sorted(sources_used),
            "gapWarnings": gap_warnings,
            "cardRefs": card_refs,
            "profile": core_out["profile"],
            "params": spec.get("params") or {},
            "risk": {
                "maxPositionPct": r_cfg.max_position_pct,
                "maxTotalExposurePct": r_cfg.max_total_exposure_pct,
                "stopLossPct": r_cfg.stop_loss_pct,
                "takeProfitPct": r_cfg.take_profit_pct,
                "trailingAtrMult": r_cfg.trailing_atr_mult,
                "enableCard174Guard": r_cfg.enable_card174_guard,
                "enableSentimentCap": r_cfg.enable_sentiment_cap,
            },
        },
        "metrics": core_out["metrics"],
        "equityCurve": core_out["equityCurve"],
        "monthlyReturns": core_out["monthlyReturns"],
        "trades": core_out["trades"],
        "rejects": core_out["rejects"],
        "screenerHistory": screener_history,
    }

    # Archive spec.json, result.json, trades.csv, equity.csv
    (out_path / "spec.json").write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_path / "result.json").write_text(json.dumps(result_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    with (out_path / "trades.csv").open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["symbol", "date", "side", "price", "shares", "amount", "fee", "pnl", "pnlPct", "reason"])
        w.writeheader()
        for t in core_out["trades"]:
            w.writerow(t)

    with (out_path / "equity.csv").open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["date", "equity", "nav", "benchmarkNav", "drawdownPct", "positionPct", "cash"])
        w.writeheader()
        for pt in core_out["equityCurve"]:
            w.writerow(pt)

    emit_progress(100, "回测完成并已归档")
    emit_done({"runId": run_id, "summary": result_payload["metrics"], "meta": result_payload["meta"]})
    return 0
