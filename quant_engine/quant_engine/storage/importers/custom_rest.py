"""Reserved generic paid/custom REST historical bar importer (Polygon / Finnhub / Custom Gateway)."""

from __future__ import annotations

from typing import Any

import pandas as pd
import requests

from ..calendar import build_default_meta
from ..duckdb_store import DuckDBStore


def sync_custom_rest_symbol(
    store: DuckDBStore,
    symbol: str,
    market: str,
    start_date: str,
    end_date: str,
    base_url: str,
    path_template: str = "/api/history?symbol={symbol}&start={start}&end={end}&freq={freq}",
    api_key: str = "",
    auth_header_name: str = "Authorization",
    auth_header_prefix: str = "Bearer ",
    freq: str = "1d",
) -> dict[str, Any]:
    """Fetch standard OHLCV JSON rows from any user-configured REST gateway."""
    if not base_url:
        raise ValueError("自定义历史数据网关 Base URL 未配置")

    path = (
        path_template.replace("{symbol}", symbol)
        .replace("{code}", symbol.split(".")[0])
        .replace("{start}", start_date[:10])
        .replace("{end}", end_date[:10])
        .replace("{freq}", freq)
        .replace("{token}", api_key or "")
    )
    url = path if path.startswith(("http://", "https://")) else f"{base_url.rstrip('/')}/{path.lstrip('/')}"
    headers = {"Accept": "application/json", "User-Agent": "SecondaryResearchWorkbench-Quant/0.1"}
    if auth_header_name and api_key:
        headers[auth_header_name] = f"{auth_header_prefix}{api_key}"

    resp = requests.get(url, headers=headers, timeout=12)
    resp.raise_for_status()
    payload = resp.json()
    rows = payload if isinstance(payload, list) else payload.get("bars") or payload.get("results") or payload.get("data") or []
    if not isinstance(rows, list) or not rows:
        return {"symbol": symbol, "rows": 0, "source": "custom_rest"}

    recs = []
    for r in rows:
        dt = r.get("trade_date") or r.get("date") or r.get("time") or r.get("t")
        if not dt:
            continue
        recs.append(
            {
                "trade_date": str(dt)[:10],
                "open": float(r.get("open", r.get("o"))),
                "high": float(r.get("high", r.get("h"))),
                "low": float(r.get("low", r.get("l"))),
                "close": float(r.get("close", r.get("c"))),
                "pre_close": float(r["pre_close"]) if r.get("pre_close") is not None else None,
                "volume": float(r.get("volume", r.get("v", 0.0))),
                "amount": float(r.get("amount", r.get("amt", 0.0))),
            }
        )
    store.upsert_security_meta(build_default_meta(symbol, market))
    count = store.upsert_daily_bars(pd.DataFrame(recs), symbol, market, "custom_rest")
    return {"symbol": symbol, "rows": count, "source": "custom_rest"}
