"""Unit tests for Stage 4A DuckDB storage, symbol normalization, CSV import, and doctor CLI."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pandas as pd

from quant_engine.protocol import normalize_symbol
from quant_engine.storage.calendar import build_default_meta
from quant_engine.storage.duckdb_store import DuckDBStore
from quant_engine.storage.importers.csv_parquet import import_csv_or_parquet


def test_symbol_normalization_multi_market():
    assert normalize_symbol("300308", "CN") == ("300308.SZ", "CN")
    assert normalize_symbol("600519", "CN") == ("600519.SH", "CN")
    assert normalize_symbol("nvda", "US") == ("NVDA.US", "US")
    assert normalize_symbol("700", "HK") == ("00700.HK", "HK")
    if __import__("importlib.util").util.find_spec("quant_engine.extensions.crypto_ext") is not None:
        assert normalize_symbol("btc/usdt", "CRYPTO") == ("BTC_USDT.CRYPTO", "CRYPTO")


def test_duckdb_upsert_dedup_and_readonly_summary(tmp_path: Path):
    data_dir = tmp_path / "qd"
    df = pd.DataFrame(
        [
            {"trade_date": "2025-01-02", "open": 10.0, "high": 10.5, "low": 9.8, "close": 10.2, "pre_close": 10.0, "volume": 100000, "amount": 1020000, "turnover_pct": 1.2, "is_suspended": False, "up_limit": 11.0, "down_limit": 9.0},
            {"trade_date": "2025-01-03", "open": 10.3, "high": 10.8, "low": 10.1, "close": 10.6, "pre_close": 10.2, "volume": 120000, "amount": 1272000, "turnover_pct": 1.5, "is_suspended": False, "up_limit": 11.22, "down_limit": 9.18},
        ]
    )
    with DuckDBStore(str(data_dir), read_only=False) as store:
        store.upsert_security_meta(build_default_meta("300308.SZ", "CN", name="中际旭创"))
        c1 = store.upsert_daily_bars(df, "300308.SZ", "CN", "test")
        # Second upsert with overlapping dates must deduplicate cleanly
        c2 = store.upsert_daily_bars(df, "300308.SZ", "CN", "test")
        assert c1 == 2 and c2 == 2
        assert store.get_symbol_max_date("300308.SZ", "1d") == "2025-01-03"

    # Concurrent read-only query works cleanly
    with DuckDBStore(str(data_dir), read_only=True) as ro_store:
        out = ro_store.query_daily_bars(["300308.SZ"], start_date="2025-01-01", end_date="2025-01-10")
        assert len(out) == 2
        summary = ro_store.get_data_summary()
        assert summary["totalSeries"] == 1
        assert summary["items"][0]["symbol"] == "300308.SZ"
        assert summary["items"][0]["rowCount"] == 2


def test_csv_importer_chinese_headers_and_doctor_cli(tmp_path: Path):
    data_dir = tmp_path / "qd_csv"
    csv_file = tmp_path / "tdx_sample.csv"
    csv_file.write_text(
        "日期,开盘,最高,最低,收盘,成交量,成交额\n"
        "2025-02-05,100.0,105.0,99.0,104.0,500,5200000\n"
        "2025-02-06,104.0,108.0,103.0,107.5,600,6450000\n",
        encoding="utf-8",
    )
    with DuckDBStore(str(data_dir), read_only=False) as store:
        res = import_csv_or_parquet(store, str(csv_file), "002384.SZ", "CN", volume_multiplier=100.0, name="东山精密")
        assert res["rows"] == 2
        q = store.query_daily_bars(["002384.SZ"])
        assert len(q) == 2
        assert float(q.iloc[0]["volume"]) == 50000.0

    # Verify CLI doctor returns valid diagnostic JSON
    proc = subprocess.run(
        [sys.executable, "-m", "quant_engine", "doctor", "--data-dir", str(data_dir)],
        cwd=str(Path(__file__).resolve().parents[1]),
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    assert payload["ok"] is True
    assert payload["dependencies"]["duckdb"]["installed"] is True
