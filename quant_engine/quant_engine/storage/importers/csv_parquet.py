"""Offline universal CSV / Parquet history importer (compatible with TDX / QMT / JoinQuant / Exchange exports)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd

from ..calendar import build_default_meta
from ..duckdb_store import DuckDBStore


DEFAULT_COL_ALIASES = {
    "trade_date": ["trade_date", "date", "日期", "时间", "datetime", "timestamp", "bar_time"],
    "open": ["open", "开盘", "开盘价"],
    "high": ["high", "最高", "最高价"],
    "low": ["low", "最低", "最低价"],
    "close": ["close", "收盘", "收盘价"],
    "pre_close": ["pre_close", "preclose", "昨收", "前收盘"],
    "volume": ["volume", "vol", "成交量", "总量"],
    "amount": ["amount", "amt", "成交额", "总额"],
    "turnover_pct": ["turnover_pct", "turnover", "换手率"],
}


def _resolve_col(df: pd.DataFrame, target: str, col_map: dict[str, str] | None) -> str | None:
    if col_map and col_map.get(target) in df.columns:
        return col_map[target]
    lower_cols = {str(c).strip().lower(): c for c in df.columns}
    for alias in DEFAULT_COL_ALIASES.get(target, [target]):
        if alias.lower() in lower_cols:
            return lower_cols[alias.lower()]
    return None


def import_csv_or_parquet(
    store: DuckDBStore,
    file_path: str | Path,
    symbol: str,
    market: str,
    freq: str = "1d",
    col_map: dict[str, str] | None = None,
    volume_multiplier: float = 1.0,
    name: str | None = None,
) -> dict[str, Any]:
    """Import local CSV or Parquet history bars directly into DuckDB."""
    p = Path(file_path).expanduser().resolve()
    if not p.exists():
        raise FileNotFoundError(f"历史数据文件不存在: {p}")

    if p.suffix.lower() in (".parquet", ".pq"):
        raw = pd.read_parquet(p)
    else:
        try:
            raw = pd.read_csv(p, encoding="utf-8-sig")
        except UnicodeDecodeError:
            raw = pd.read_csv(p, encoding="gbk")

    if raw.empty:
        return {"symbol": symbol, "rows": 0, "source": "csv_import"}

    c_date = _resolve_col(raw, "trade_date", col_map)
    c_open = _resolve_col(raw, "open", col_map)
    c_high = _resolve_col(raw, "high", col_map)
    c_low = _resolve_col(raw, "low", col_map)
    c_close = _resolve_col(raw, "close", col_map)
    c_vol = _resolve_col(raw, "volume", col_map)
    c_amt = _resolve_col(raw, "amount", col_map)
    c_pre = _resolve_col(raw, "pre_close", col_map)
    c_turn = _resolve_col(raw, "turnover_pct", col_map)

    if not all([c_date, c_open, c_high, c_low, c_close]):
        raise ValueError(f"无法自动识别必需列 (date/open/high/low/close)，现有列: {list(raw.columns)}")

    store.upsert_security_meta(build_default_meta(symbol, market, name=name or symbol))

    out = pd.DataFrame()
    if freq == "1d":
        out["trade_date"] = pd.to_datetime(raw[c_date]).dt.strftime("%Y-%m-%d")
        out["open"] = pd.to_numeric(raw[c_open], errors="coerce")
        out["high"] = pd.to_numeric(raw[c_high], errors="coerce")
        out["low"] = pd.to_numeric(raw[c_low], errors="coerce")
        out["close"] = pd.to_numeric(raw[c_close], errors="coerce")
        out["pre_close"] = pd.to_numeric(raw[c_pre], errors="coerce") if c_pre else out["close"].shift(1)
        out["volume"] = (pd.to_numeric(raw[c_vol], errors="coerce").fillna(0.0) * float(volume_multiplier)) if c_vol else 0.0
        out["amount"] = pd.to_numeric(raw[c_amt], errors="coerce").fillna(0.0) if c_amt else (out["close"] * out["volume"])
        out["turnover_pct"] = pd.to_numeric(raw[c_turn], errors="coerce") if c_turn else None
        out = out.dropna(subset=["open", "high", "low", "close"])
        count = store.upsert_daily_bars(out, symbol, market, "csv_import")
        return {"symbol": symbol, "rows": count, "source": "csv_import"}

    out["bar_time"] = pd.to_datetime(raw[c_date]).dt.strftime("%Y-%m-%d %H:%M:%S")
    out["open"] = pd.to_numeric(raw[c_open], errors="coerce")
    out["high"] = pd.to_numeric(raw[c_high], errors="coerce")
    out["low"] = pd.to_numeric(raw[c_low], errors="coerce")
    out["close"] = pd.to_numeric(raw[c_close], errors="coerce")
    out["volume"] = (pd.to_numeric(raw[c_vol], errors="coerce").fillna(0.0) * float(volume_multiplier)) if c_vol else 0.0
    out["amount"] = pd.to_numeric(raw[c_amt], errors="coerce").fillna(0.0) if c_amt else (out["close"] * out["volume"])
    out = out.dropna(subset=["open", "high", "low", "close"])
    count = store.upsert_minute_bars(out, symbol, market, freq, "csv_import")
    return {"symbol": symbol, "rows": count, "source": "csv_import"}
