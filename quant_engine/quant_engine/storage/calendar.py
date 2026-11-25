"""Multi-market trading calendar utilities and metadata defaults."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pandas as pd

from ..extensions import load_market_extension
from ..protocol import MARKET_DEFAULTS, infer_cn_board_type
from .duckdb_store import DuckDBStore


def generate_calendar_dates(
    store: DuckDBStore,
    market: str,
    start_date: str,
    end_date: str,
    fallback_bars_dates: list[str] | None = None,
) -> list[str]:
    """Return sorted trading dates in [start_date, end_date] for the given market."""
    mkt = market.upper()
    ext = load_market_extension("crypto")
    if ext is not None and mkt == ext.MARKET_CODE:
        return ext.generate_24x7_calendar(start_date, end_date)

    rows = store.conn.execute(
        """
        SELECT CAST(trade_date AS VARCHAR)
        FROM trade_calendar
        WHERE market = ? AND is_open = TRUE
          AND trade_date >= CAST(? AS DATE)
          AND trade_date <= CAST(? AS DATE)
        ORDER BY trade_date ASC
        """,
        [mkt, start_date[:10], end_date[:10]],
    ).fetchall()
    cal = [r[0] for r in rows]
    if cal:
        return cal

    if fallback_bars_dates:
        return sorted({d[:10] for d in fallback_bars_dates if start_date[:10] <= d[:10] <= end_date[:10]})

    # Last-resort weekday schedule if calendar table is empty
    d0 = date.fromisoformat(start_date[:10])
    d1 = date.fromisoformat(end_date[:10])
    out = []
    cur = d0
    while cur <= d1:
        if cur.weekday() < 5:
            out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


def build_default_meta(symbol: str, market: str, name: str | None = None) -> dict[str, Any]:
    mkt = market.upper()
    defaults = MARKET_DEFAULTS.get(mkt, MARKET_DEFAULTS["CN"])
    exchange = symbol.rsplit(".", 1)[-1] if "." in symbol else mkt
    board_type = infer_cn_board_type(symbol, is_st="ST" in (name or "").upper()) if mkt == "CN" else mkt
    return {
        "symbol": symbol,
        "market": mkt,
        "currency": defaults["currency"],
        "name": name or symbol,
        "exchange": exchange,
        "board_type": board_type,
        "lot_size": defaults["lot_size"],
        "allow_fractional": defaults["allow_fractional"],
        "list_date": None,
        "delist_date": None,
        "is_st": "ST" in (name or "").upper(),
    }


def is_symbol_tradable_on(meta: dict[str, Any] | None, trade_date: str) -> bool:
    """Survivorship bias guard: check list_date <= trade_date <= delist_date if present."""
    if not meta:
        return True
    d = trade_date[:10]
    list_date = meta.get("list_date")
    delist_date = meta.get("delist_date")
    if list_date and not pd.isna(list_date):
        if d < str(list_date)[:10]:
            return False
    if delist_date and not pd.isna(delist_date):
        if d > str(delist_date)[:10]:
            return False
    return True
