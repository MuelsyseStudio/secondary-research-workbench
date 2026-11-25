"""Comprehensive pytest suite verifying multi-market trading rules & zero lookahead."""

from __future__ import annotations

import pandas as pd
import pytest

from quant_engine.core.engine import run_backtest_core, validate_strategy_code_ast
from quant_engine.core.market_profiles import get_market_profile
from quant_engine.core.risk import RiskConfig
from quant_engine.core.rule_compiler import compile_visual_rule


def _make_df(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    if "dt" not in df.columns:
        df["dt"] = df["trade_date"]
    return df


def test_cn_t_plus_1_blocks_same_day_sell():
    """A-share T+1 rule: shares bought on day 1 cannot be sold on day 1 (close match mode)."""
    df = _make_df(
        [
            {"trade_date": "2025-01-02", "open": 10.0, "high": 10.2, "low": 9.9, "close": 10.0, "volume": 100000, "up_limit": 11.0, "down_limit": 9.0},
            {"trade_date": "2025-01-03", "open": 10.5, "high": 10.8, "low": 10.4, "close": 10.6, "volume": 100000, "up_limit": 11.0, "down_limit": 9.0},
        ]
    )

    def on_bar(ctx, dt):
        if dt == "2025-01-02":
            # Buy AND attempt immediate same-day sell -> sell MUST be rejected by CN T+1!
            ctx.order_shares("000001.SZ", 1000, reason="买入")
            ctx.order_shares("000001.SZ", -1000, reason="试图当日卖出")
        elif dt == "2025-01-03":
            ctx.close_position("000001.SZ", reason="次日正常卖出")

    res = run_backtest_core(
        {"000001.SZ": df},
        ["000001.SZ"],
        "CN",
        "2025-01-02",
        "2025-01-03",
        lambda ctx: None,
        on_bar,
        initial_cash=100_000.0,
        match_mode="close",
    )
    assert len(res["trades"]) == 2
    assert res["trades"][0]["date"] == "2025-01-02" and res["trades"][0]["side"] == "BUY"
    assert res["trades"][1]["date"] == "2025-01-03" and res["trades"][1]["side"] == "SELL"
    assert any("T+1" in r["reason"] for r in res["rejects"])


def test_cn_limit_up_limit_down_and_suspension_rejects():
    """A-share one-line limit-up rejects BUY; suspended bar rejects orders; one-line limit-down rejects SELL."""
    df = _make_df(
        [
            {"trade_date": "2025-01-02", "open": 11.0, "high": 11.0, "low": 11.0, "close": 11.0, "volume": 50000, "up_limit": 11.0, "down_limit": 9.0, "is_suspended": False},
            {"trade_date": "2025-01-03", "open": 11.0, "high": 11.0, "low": 11.0, "close": 11.0, "volume": 0, "up_limit": 12.1, "down_limit": 9.9, "is_suspended": True},
            {"trade_date": "2025-01-06", "open": 11.0, "high": 11.5, "low": 10.8, "close": 11.2, "volume": 200000, "up_limit": 12.1, "down_limit": 9.9, "is_suspended": False},
            {"trade_date": "2025-01-07", "open": 10.08, "high": 10.08, "low": 10.08, "close": 10.08, "volume": 30000, "up_limit": 12.32, "down_limit": 10.08, "is_suspended": False},
        ]
    )

    def on_bar(ctx, dt):
        if dt in ("2025-01-02", "2025-01-03", "2025-01-06"):
            if ctx.position("300308.SZ") is None:
                ctx.order_shares("300308.SZ", 1000, reason="尝试买入")
        elif dt == "2025-01-07":
            ctx.close_position("300308.SZ", reason="跌停尝试卖出")

    res = run_backtest_core(
        {"300308.SZ": df},
        ["300308.SZ"],
        "CN",
        "2025-01-02",
        "2025-01-07",
        lambda ctx: None,
        on_bar,
        initial_cash=100_000.0,
        match_mode="close",
    )
    # Day 1 limit-up rejected, Day 2 suspended rejected, Day 3 bought, Day 4 limit-down sell rejected
    assert len(res["trades"]) == 1
    assert res["trades"][0]["date"] == "2025-01-06"
    reasons = " | ".join(r["reason"] for r in res["rejects"])
    assert "涨停" in reasons
    assert "停牌" in reasons
    assert "跌停" in reasons


def test_cn_100_share_lot_and_fees_stamp_duty():
    """A-share buys round down to 100-share lots; min commission ¥5; sell incurs 0.05% stamp duty."""
    df = _make_df(
        [
            {"trade_date": "2025-01-02", "open": 10.0, "high": 10.1, "low": 9.9, "close": 10.0, "volume": 500000, "up_limit": 11.0, "down_limit": 9.0},
            {"trade_date": "2025-01-03", "open": 20.0, "high": 20.2, "low": 19.8, "close": 20.0, "volume": 500000, "up_limit": 22.0, "down_limit": 18.0},
        ]
    )

    def on_bar(ctx, dt):
        if dt == "2025-01-02":
            # Request 155 shares -> must round down to 100 shares!
            ctx.order_shares("600519.SH", 155, reason="测试100股整手")
        elif dt == "2025-01-03":
            ctx.close_position("600519.SH", reason="卖出检验印花税")

    res = run_backtest_core(
        {"600519.SH": df},
        ["600519.SH"],
        "CN",
        "2025-01-02",
        "2025-01-03",
        lambda ctx: None,
        on_bar,
        initial_cash=50_000.0,
        match_mode="close",
        profile_overrides={"slippage_bps": 0.0},
    )
    buy, sell = res["trades"][0], res["trades"][1]
    assert buy["shares"] == 100
    assert buy["fee"] == pytest.approx(5.0, abs=1e-2)  # min commission ¥5
    # Sell notional = 2000; commission = max(5.0, 0.5) = 5.0; stamp duty = 2000 * 0.0005 = 1.0 -> total 6.0
    assert sell["shares"] == 100
    assert sell["fee"] == pytest.approx(6.0, abs=1e-2)


def test_us_t_plus_0_no_limit_and_1_share_step():
    """US profile allows T+0 same-day buy & sell, 1-share step size, and +35% jump with no price limit."""
    df = _make_df(
        [
            {"trade_date": "2025-01-02", "open": 100.0, "high": 140.0, "low": 100.0, "close": 135.0, "volume": 10_000_000},
            {"trade_date": "2025-01-03", "open": 136.0, "high": 138.0, "low": 134.0, "close": 137.0, "volume": 10_000_000},
        ]
    )

    def on_bar(ctx, dt):
        if dt == "2025-01-02":
            ctx.order_shares("NVDA.US", 7, reason="US 7股买入")
            ctx.order_shares("NVDA.US", -7, reason="US T+0 当日卖出")

    res = run_backtest_core(
        {"NVDA.US": df},
        ["NVDA.US"],
        "US",
        "2025-01-02",
        "2025-01-03",
        lambda ctx: None,
        on_bar,
        initial_cash=10_000.0,
        match_mode="close",
        profile_overrides={"slippage_bps": 0.0},
    )
    assert len(res["trades"]) == 2
    assert res["trades"][0]["shares"] == 7
    assert res["trades"][1]["date"] == "2025-01-02"
    assert res["trades"][1]["side"] == "SELL"
    assert len(res["rejects"]) == 0


def test_hk_custom_lot_size_and_bilateral_stamp():
    """HK respects per-symbol lot_size (e.g. 00700.HK = 100, custom 400-share lot) and 0.1% bilateral stamp."""
    df = _make_df(
        [
            {"trade_date": "2025-01-02", "open": 100.0, "high": 102.0, "low": 99.0, "close": 100.0, "volume": 1_000_000},
            {"trade_date": "2025-01-03", "open": 110.0, "high": 112.0, "low": 109.0, "close": 110.0, "volume": 1_000_000},
        ]
    )

    def on_bar(ctx, dt):
        if dt == "2025-01-02":
            ctx.order_shares("09988.HK", 550, reason="港股自定义每手400股测试")

    res = run_backtest_core(
        {"09988.HK": df},
        ["09988.HK"],
        "HK",
        "2025-01-02",
        "2025-01-03",
        lambda ctx: None,
        on_bar,
        initial_cash=200_000.0,
        match_mode="close",
        symbol_meta={"09988.HK": {"lot_size": 400.0}},
        profile_overrides={"slippage_bps": 0.0},
    )
    assert res["trades"][0]["shares"] == 400
    # 40,000 HKD: comm 40000*0.0003=12.0 + buy stamp 40000*0.001=40.0 => 52.0
    assert res["trades"][0]["fee"] == pytest.approx(52.0, abs=1e-2)


@pytest.mark.skipif(
    __import__("importlib.util").util.find_spec("quant_engine.extensions.crypto_ext") is None,
    reason="Optional crypto extension not bundled in open-source core",
)
def test_crypto_fractional_position_and_24x7_weekend_bars():
    """Crypto supports fractional BTC positions (0.0001 step) and continuous Saturday/Sunday 24/7 bars."""
    df = _make_df(
        [
            {"trade_date": "2025-01-04", "open": 60000.0, "high": 61000.0, "low": 59500.0, "close": 60000.0, "volume": 1200.5},  # Saturday
            {"trade_date": "2025-01-05", "open": 62000.0, "high": 63000.0, "low": 61500.0, "close": 62000.0, "volume": 1400.8},  # Sunday
        ]
    )

    def on_bar(ctx, dt):
        if dt == "2025-01-04":
            ctx.order_target_percent("BTC_USDT.CRYPTO", 0.5, reason="周六小数买入BTC")
        elif dt == "2025-01-05":
            ctx.close_position("BTC_USDT.CRYPTO", reason="周日平仓BTC")

    res = run_backtest_core(
        {"BTC_USDT.CRYPTO": df},
        ["BTC_USDT.CRYPTO"],
        "CRYPTO",
        "2025-01-04",
        "2025-01-05",
        lambda ctx: None,
        on_bar,
        initial_cash=10_000.0,
        match_mode="close",
        profile_overrides={"slippage_bps": 0.0},
        risk_config=RiskConfig(max_position_pct=0.8),
    )
    assert len(res["equityCurve"]) == 2
    assert len(res["trades"]) == 2
    btc_qty = float(res["trades"][0]["shares"])
    assert 0.08 < btc_qty < 0.09  # ~5000 / 60000 = 0.0833 BTC fractional!
    assert res["trades"][1]["pnl"] > 0


def test_zero_lookahead_and_next_open_execution():
    """Verify ctx.history() NEVER returns future bars > current_dt and next_open fills at t+1 open."""
    df = _make_df(
        [
            {"trade_date": "2025-01-02", "open": 10.0, "high": 10.5, "low": 9.8, "close": 10.2, "volume": 100000},
            {"trade_date": "2025-01-03", "open": 12.0, "high": 12.5, "low": 11.8, "close": 12.3, "volume": 100000},
            {"trade_date": "2025-01-06", "open": 13.0, "high": 13.5, "low": 12.8, "close": 13.2, "volume": 100000},
        ]
    )
    seen_max_dts = []

    def on_bar(ctx, dt):
        hist = ctx.history("NVDA.US", 100)
        max_dt = str(hist["dt"].iloc[-1])
        assert max_dt <= dt, f"FUTURE LEAKAGE: saw {max_dt} at {dt}"
        seen_max_dts.append((dt, max_dt))
        if dt == "2025-01-02":
            ctx.order_shares("NVDA.US", 10, reason="信号在Day1触发")

    res = run_backtest_core(
        {"NVDA.US": df},
        ["NVDA.US"],
        "US",
        "2025-01-02",
        "2025-01-06",
        lambda ctx: None,
        on_bar,
        initial_cash=10_000.0,
        match_mode="next_open",
        profile_overrides={"slippage_bps": 0.0},
    )
    assert len(seen_max_dts) == 3
    # Signal on 2025-01-02 MUST fill on 2025-01-03 at open price 12.0 (NOT 10.2!)
    assert len(res["trades"]) == 1
    assert res["trades"][0]["date"] == "2025-01-03"
    assert res["trades"][0]["price"] == pytest.approx(12.0, abs=1e-4)


def test_card174_guard_and_visual_rule_compiler_and_ast_safety():
    """Verify Card 174 blacklist blocks opening, visual rules compile & run, and unsafe Python is blocked."""
    # 1. AST safety guard
    issues = validate_strategy_code_ast("import os\ndef on_bar(ctx, dt): os.system('rm -rf /')")
    assert len(issues) >= 1

    # 2. Card 174 blacklist + Visual rule compiler
    df = _make_df(
        [
            {"trade_date": f"2025-01-{i:02d}", "open": 10.0 + i * 0.2, "high": 10.3 + i * 0.2, "low": 9.9 + i * 0.2, "close": 10.1 + i * 0.2, "volume": 100000}
            for i in range(2, 16)
        ]
    )
    init_fn, on_bar_fn = compile_visual_rule(
        {
            "name": "测试积木规则",
            "entryLogic": "AND",
            "entryConditions": [{"left": {"type": "CLOSE"}, "op": ">", "right": {"type": "MA", "period": 3}}],
            "exitLogic": "OR",
            "exitConditions": [{"left": {"type": "CLOSE"}, "op": "<", "right": {"type": "MA", "period": 3}}],
            "targetWeight": 0.3,
        }
    )
    res_blocked = run_backtest_core(
        {"300308.SZ": df},
        ["300308.SZ"],
        "CN",
        "2025-01-06",
        "2025-01-15",
        init_fn,
        on_bar_fn,
        initial_cash=100_000.0,
        risk_config=RiskConfig(
            enable_card174_guard=True,
            regulatory_blacklist=[{"code": "300308", "startDate": "2025-01-01", "endDate": "2025-01-31", "reason": "10日严重异动红线"}],
        ),
    )
    assert len(res_blocked["trades"]) == 0
    assert any("异动红线" in r["reason"] for r in res_blocked["rejects"])
