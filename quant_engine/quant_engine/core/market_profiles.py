"""MarketProfile configuration layer: decouples trading rules from the core backtest loop."""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from ..extensions import load_market_extension


@dataclass(frozen=True)
class MarketProfile:
    market: str
    currency: str
    settlement_days: int            # 1 = strict T+1 (CN), 0 = T+0 (US/HK/FUT)
    price_limit_mode: str           # 'cn_board' | 'none'
    step_size: float                # 100 (CN), 1 (US/FUT), per-symbol lot_size (HK)
    allow_fractional: bool          # fractional share support flag
    allow_short: bool               # False default for CN, True optional for US/HK/FUT
    commission_rate: float          # e.g. 0.00025 (万2.5)
    min_commission: float           # e.g. 5.0 CNY, 1.0 USD
    buy_stamp_duty: float           # 0.0 for CN/US, 0.001 for HK
    sell_stamp_duty: float          # 0.0005 for CN, 0.001 for HK, 0.0 for US
    slippage_bps: float             # default slippage in basis points (e.g. 5 bps = 0.05%)
    calendar_mode: str              # 'exchange_calendar' | 'continuous_24x7'
    annual_trading_days: int        # 252 for equities/fut
    default_benchmark: str
    margin_rate: float = 1.0        # V2 extension slot for leveraged futures


PROFILES: dict[str, MarketProfile] = {
    "CN": MarketProfile(
        market="CN",
        currency="CNY",
        settlement_days=1,
        price_limit_mode="cn_board",
        step_size=100.0,
        allow_fractional=False,
        allow_short=False,
        commission_rate=0.00025,
        min_commission=5.0,
        buy_stamp_duty=0.0,
        sell_stamp_duty=0.0005,
        slippage_bps=5.0,
        calendar_mode="exchange_calendar",
        annual_trading_days=252,
        default_benchmark="000300.SH",
    ),
    "US": MarketProfile(
        market="US",
        currency="USD",
        settlement_days=0,
        price_limit_mode="none",
        step_size=1.0,
        allow_fractional=False,
        allow_short=True,
        commission_rate=0.0003,
        min_commission=1.0,
        buy_stamp_duty=0.0,
        sell_stamp_duty=0.0,
        slippage_bps=3.0,
        calendar_mode="exchange_calendar",
        annual_trading_days=252,
        default_benchmark="SPY.US",
    ),
    "HK": MarketProfile(
        market="HK",
        currency="HKD",
        settlement_days=0,
        price_limit_mode="none",
        step_size=100.0,
        allow_fractional=False,
        allow_short=True,
        commission_rate=0.0003,
        min_commission=3.0,
        buy_stamp_duty=0.001,
        sell_stamp_duty=0.001,
        slippage_bps=5.0,
        calendar_mode="exchange_calendar",
        annual_trading_days=252,
        default_benchmark="HSI.HK",
    ),
    "FUT": MarketProfile(
        market="FUT",
        currency="USD",
        settlement_days=0,
        price_limit_mode="none",
        step_size=1.0,
        allow_fractional=False,
        allow_short=True,
        commission_rate=0.0002,
        min_commission=0.0,
        buy_stamp_duty=0.0,
        sell_stamp_duty=0.0,
        slippage_bps=3.0,
        calendar_mode="exchange_calendar",
        annual_trading_days=252,
        default_benchmark="",
        margin_rate=1.0,
    ),
}

_EXT = load_market_extension("crypto")
if _EXT is not None:
    PROFILES[_EXT.MARKET_CODE] = MarketProfile(**_EXT.PROFILE_KWARGS)


def get_market_profile(market: str, overrides: dict[str, Any] | None = None) -> MarketProfile:
    mkt = str(market or "CN").upper()
    base = PROFILES.get(mkt)
    if base is None:
        # Global equity defaults (TW / KR / JP / FR / UK / DE)
        base = replace(
            PROFILES["US"],
            market=mkt,
            currency={"TW": "TWD", "KR": "KRW", "JP": "JPY", "FR": "EUR", "UK": "GBP", "DE": "EUR"}.get(mkt, "USD"),
            step_size=1000.0 if mkt == "TW" else 100.0 if mkt == "JP" else 1.0,
            default_benchmark="",
        )

    if not overrides:
        return base

    valid_fields = {f.name for f in base.__dataclass_fields__.values()}
    patch = {}
    for k, v in overrides.items():
        if k in valid_fields and v is not None:
            patch[k] = v
    return replace(base, **patch) if patch else base
