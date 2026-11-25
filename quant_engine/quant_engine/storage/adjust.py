"""Price adjustment (qfq / hfq / none) and missing-day data quality auditor."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd


def apply_adjustment(
    bars_df: pd.DataFrame,
    factors_df: pd.DataFrame | None,
    adjust_mode: str = "qfq",
) -> pd.DataFrame:
    """Apply qfq/hfq factor scaling when raw bars + factors exist.

    Note: If source already delivers qfq bars (factor=1.0), scaling is an identity op.
    """
    if bars_df is None or bars_df.empty or adjust_mode == "none":
        return bars_df
    if factors_df is None or factors_df.empty:
        return bars_df

    col = "qfq_factor" if adjust_mode == "qfq" else "hfq_factor"
    if col not in factors_df.columns:
        return bars_df

    merged = bars_df.merge(
        factors_df[["symbol", "trade_date", col]],
        on=["symbol", "trade_date"],
        how="left",
    )
    merged[col] = merged[col].fillna(1.0).astype(float)
    # Only rescale if factor deviates meaningfully from 1.0
    if np.allclose(merged[col].to_numpy(), 1.0, atol=1e-6):
        return bars_df

    for price_col in ("open", "high", "low", "close", "pre_close", "up_limit", "down_limit"):
        if price_col in merged.columns:
            merged[price_col] = (merged[price_col].astype(float) * merged[col]).round(4)
    return merged.drop(columns=[col])


def audit_symbol_gaps(
    bars_df: pd.DataFrame,
    calendar_dates: list[str],
    symbol: str,
) -> dict[str, Any]:
    """Check how many market calendar days are missing from a symbol's stored history."""
    if not calendar_dates:
        return {"symbol": symbol, "expectedDays": 0, "presentDays": 0, "missingDays": 0, "coveragePct": 100.0}
    sub = bars_df[bars_df["symbol"] == symbol] if not bars_df.empty else pd.DataFrame()
    present_set = set(sub["trade_date"].astype(str).str.slice(0, 10).tolist()) if not sub.empty else set()
    cal_set = set(d[:10] for d in calendar_dates)
    present_in_range = len(present_set & cal_set)
    expected = len(cal_set)
    missing = max(0, expected - present_in_range)
    cov = round((present_in_range / expected) * 100.0, 2) if expected > 0 else 100.0
    return {
        "symbol": symbol,
        "expectedDays": expected,
        "presentDays": present_in_range,
        "missingDays": missing,
        "coveragePct": cov,
    }
