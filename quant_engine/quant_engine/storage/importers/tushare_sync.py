"""Reserved paid adapter: Tushare Pro (supports Token + custom API Base URL proxy)."""

from __future__ import annotations

from typing import Any

import pandas as pd
import requests

from ..calendar import build_default_meta
from ..duckdb_store import DuckDBStore


def sync_tushare_symbol(
    store: DuckDBStore,
    symbol: str,
    start_date: str,
    end_date: str,
    token: str,
    api_base_url: str = "https://api.tushare.pro",
) -> dict[str, Any]:
    """Fetch CN daily bars via Tushare Pro HTTP API (supports custom proxy base URL)."""
    if not token or not token.strip():
        raise ValueError("Tushare Pro Token 未配置，请在「数据源管理」填入 Token 后重试")

    url = (api_base_url or "https://api.tushare.pro").strip()
    is_index = symbol in {"000001.SH", "000300.SH", "000688.SH", "000905.SH", "399001.SZ", "399006.SZ"}
    api_name = "index_daily" if is_index else "daily"
    payload = {
        "api_name": api_name,
        "token": token.strip(),
        "params": {
            "ts_code": symbol,
            "start_date": start_date[:10].replace("-", ""),
            "end_date": end_date[:10].replace("-", ""),
        },
        "fields": "ts_code,trade_date,open,high,low,close,pre_close,vol,amount",
    }
    resp = requests.post(url, json=payload, timeout=12)
    resp.raise_for_status()
    res = resp.json()
    if res.get("code") != 0:
        raise RuntimeError(f"Tushare API error ({res.get('code')}): {res.get('msg')}")

    data = res.get("data") or {}
    fields = data.get("fields") or []
    items = data.get("items") or []
    if not items:
        return {"symbol": symbol, "rows": 0, "source": "tushare"}

    idx = {f: i for i, f in enumerate(fields)}
    recs = []
    for row in items:
        td = str(row[idx["trade_date"]])
        dt_str = f"{td[:4]}-{td[4:6]}-{td[6:8]}"
        # Tushare daily vol is in lots (手), amount is in thousand CNY (千元)
        vol_shares = float(row[idx["vol"]] or 0.0) * (100.0 if not is_index else 1.0)
        amt_cny = float(row[idx["amount"]] or 0.0) * 1000.0
        recs.append(
            {
                "trade_date": dt_str,
                "open": float(row[idx["open"]]),
                "high": float(row[idx["high"]]),
                "low": float(row[idx["low"]]),
                "close": float(row[idx["close"]]),
                "pre_close": float(row[idx["pre_close"]]) if row[idx["pre_close"]] is not None else None,
                "volume": vol_shares,
                "amount": amt_cny,
                "turnover_pct": None,
                "is_suspended": (not is_index) and vol_shares <= 0,
            }
        )
    df = pd.DataFrame(recs).sort_values("trade_date")
    store.upsert_security_meta(build_default_meta(symbol, "CN"))
    count = store.upsert_daily_bars(df, symbol, "CN", "tushare")
    return {"symbol": symbol, "rows": count, "source": "tushare"}
