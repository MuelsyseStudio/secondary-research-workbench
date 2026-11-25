"""A-share free default importer via BaoStock (silences stdout noise for clean NDJSON)."""

from __future__ import annotations

import contextlib
import io
from typing import Any

import pandas as pd

from ...protocol import canonical_to_baostock, infer_cn_board_type
from ..calendar import build_default_meta
from ..duckdb_store import DuckDBStore

CN_INDEX_CODES = {"000001.SH", "000300.SH", "000688.SH", "000905.SH", "000852.SH", "399001.SZ", "399006.SZ", "899050.BJ"}


def _cn_limit_ratio(board_type: str, is_st: bool) -> float:
    if is_st or board_type == "ST":
        return 0.05
    if board_type in ("STAR", "CHINEXT"):
        return 0.20
    if board_type == "BSE":
        return 0.30
    return 0.10


def _compute_limits(pre_close: float | None, board_type: str, is_st: bool, is_index: bool) -> tuple[float | None, float | None]:
    if is_index or pre_close is None or pre_close <= 0:
        return None, None
    ratio = _cn_limit_ratio(board_type, is_st)
    up = round(pre_close * (1.0 + ratio) + 1e-8, 2)
    down = round(pre_close * (1.0 - ratio) + 1e-8, 2)
    return up, down


def sync_cn_calendar_baostock(store: DuckDBStore, start_date: str, end_date: str) -> int:
    import baostock as bs

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        lg = bs.login()
    if lg.error_code != "0":
        return 0
    try:
        with contextlib.redirect_stdout(buf):
            rs = bs.query_trade_dates(start_date=start_date[:10], end_date=end_date[:10])
        open_dates: list[str] = []
        while rs.error_code == "0" and rs.next():
            row = rs.get_row_data()
            if len(row) >= 2 and row[1] == "1":
                open_dates.append(row[0])
        return store.upsert_calendar("CN", open_dates, is_open=True)
    finally:
        with contextlib.redirect_stdout(buf):
            bs.logout()


def sync_baostock_symbol(
    store: DuckDBStore,
    symbol: str,
    start_date: str,
    end_date: str,
    freq: str = "1d",
) -> dict[str, Any]:
    """Fetch A-share daily or minute bars from BaoStock and upsert into DuckDB."""
    import baostock as bs

    bs_code = canonical_to_baostock(symbol)
    is_index = symbol in CN_INDEX_CODES
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        lg = bs.login()
    if lg.error_code != "0":
        raise RuntimeError(f"BaoStock login failed: {lg.error_msg}")

    try:
        # Query basic metadata (name / list_date / delist_date)
        meta = build_default_meta(symbol, "CN")
        try:
            with contextlib.redirect_stdout(buf):
                rs_basic = bs.query_stock_basic(code=bs_code)
            if rs_basic.error_code == "0" and rs_basic.next():
                b = rs_basic.get_row_data()
                # fields: code, code_name, ipoDate, outDate, type, status
                if len(b) >= 4:
                    meta["name"] = b[1] or symbol
                    meta["list_date"] = b[2] or None
                    meta["delist_date"] = b[3] or None
                    meta["is_st"] = "ST" in (b[1] or "").upper()
                    meta["board_type"] = "INDEX" if is_index else infer_cn_board_type(symbol, meta["is_st"])
        except Exception:
            pass
        store.upsert_security_meta(meta)

        if freq == "1d":
            fields = (
                "date,open,high,low,close,preclose,volume,amount,turn,tradestatus,isST"
                if not is_index
                else "date,open,high,low,close,preclose,volume,amount"
            )
            with contextlib.redirect_stdout(buf):
                rs = bs.query_history_k_data_plus(
                    bs_code,
                    fields,
                    start_date=start_date[:10],
                    end_date=end_date[:10],
                    frequency="d",
                    adjustflag="2" if not is_index else "3",  # 2 = qfq forward adjusted
                )
            rows = []
            while rs.error_code == "0" and rs.next():
                rows.append(rs.get_row_data())
            if not rows:
                return {"symbol": symbol, "rows": 0, "source": "baostock"}

            records = []
            for r in rows:
                try:
                    c_val = float(r[4])
                    o_val = float(r[1])
                    h_val = float(r[2])
                    l_val = float(r[3])
                except (ValueError, TypeError):
                    continue
                pre_c = float(r[5]) if r[5] not in ("", None) else None
                vol = float(r[6]) if r[6] not in ("", None) else 0.0
                amt = float(r[7]) if r[7] not in ("", None) else 0.0
                turn = float(r[8]) if (not is_index and len(r) > 8 and r[8] not in ("", None)) else None
                is_susp = (not is_index and len(r) > 9 and r[9] == "0") or (not is_index and vol <= 0)
                is_st = (not is_index and len(r) > 10 and r[10] == "1") or bool(meta["is_st"])
                up_lim, dn_lim = _compute_limits(pre_c, meta["board_type"], is_st, is_index)
                records.append(
                    {
                        "trade_date": r[0],
                        "open": o_val,
                        "high": h_val,
                        "low": l_val,
                        "close": c_val,
                        "pre_close": pre_c,
                        "volume": vol,
                        "amount": amt,
                        "turnover_pct": turn,
                        "is_suspended": is_susp,
                        "up_limit": up_lim,
                        "down_limit": dn_lim,
                    }
                )
            df = pd.DataFrame(records)
            count = store.upsert_daily_bars(df, symbol, "CN", "baostock")
            return {"symbol": symbol, "rows": count, "source": "baostock"}

        # Minute bars (5m / 15m / 30m / 60m)
        freq_map = {"5m": "5", "15m": "15", "30m": "30", "60m": "60"}
        bs_freq = freq_map.get(freq, "15")
        with contextlib.redirect_stdout(buf):
            rs = bs.query_history_k_data_plus(
                bs_code,
                "date,time,open,high,low,close,volume,amount",
                start_date=start_date[:10],
                end_date=end_date[:10],
                frequency=bs_freq,
                adjustflag="2" if not is_index else "3",
            )
        rows = []
        while rs.error_code == "0" and rs.next():
            rows.append(rs.get_row_data())
        if not rows:
            return {"symbol": symbol, "rows": 0, "source": "baostock"}

        records = []
        for r in rows:
            try:
                t_raw = str(r[1])  # YYYYMMDDHHMMSSsss
                bt = f"{t_raw[0:4]}-{t_raw[4:6]}-{t_raw[6:8]} {t_raw[8:10]}:{t_raw[10:12]}:00"
                records.append(
                    {
                        "bar_time": bt,
                        "open": float(r[2]),
                        "high": float(r[3]),
                        "low": float(r[4]),
                        "close": float(r[5]),
                        "volume": float(r[6]) if r[6] else 0.0,
                        "amount": float(r[7]) if r[7] else 0.0,
                    }
                )
            except Exception:
                continue
        df = pd.DataFrame(records)
        count = store.upsert_minute_bars(df, symbol, "CN", freq, "baostock")
        return {"symbol": symbol, "rows": count, "source": "baostock"}
    finally:
        with contextlib.redirect_stdout(buf):
            bs.logout()
