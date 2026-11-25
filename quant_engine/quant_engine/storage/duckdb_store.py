"""DuckDB local multi-market historical data store (single-writer, read-only backtest safe)."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS bars_daily (
    symbol VARCHAR NOT NULL,
    market VARCHAR NOT NULL,
    trade_date DATE NOT NULL,
    open DOUBLE,
    high DOUBLE,
    low DOUBLE,
    close DOUBLE,
    pre_close DOUBLE,
    volume DOUBLE,
    amount DOUBLE,
    turnover_pct DOUBLE,
    is_suspended BOOLEAN DEFAULT FALSE,
    up_limit DOUBLE,
    down_limit DOUBLE,
    source VARCHAR,
    PRIMARY KEY (symbol, trade_date)
);

CREATE TABLE IF NOT EXISTS bars_minute (
    symbol VARCHAR NOT NULL,
    market VARCHAR NOT NULL,
    freq VARCHAR NOT NULL,
    bar_time TIMESTAMP NOT NULL,
    open DOUBLE,
    high DOUBLE,
    low DOUBLE,
    close DOUBLE,
    volume DOUBLE,
    amount DOUBLE,
    source VARCHAR,
    PRIMARY KEY (symbol, freq, bar_time)
);

CREATE TABLE IF NOT EXISTS adjust_factors (
    symbol VARCHAR NOT NULL,
    trade_date DATE NOT NULL,
    qfq_factor DOUBLE DEFAULT 1.0,
    hfq_factor DOUBLE DEFAULT 1.0,
    source VARCHAR,
    PRIMARY KEY (symbol, trade_date)
);

CREATE TABLE IF NOT EXISTS trade_calendar (
    market VARCHAR NOT NULL,
    trade_date DATE NOT NULL,
    is_open BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (market, trade_date)
);

CREATE TABLE IF NOT EXISTS security_meta (
    symbol VARCHAR PRIMARY KEY,
    market VARCHAR NOT NULL,
    currency VARCHAR NOT NULL DEFAULT 'CNY',
    name VARCHAR,
    exchange VARCHAR,
    board_type VARCHAR,
    lot_size DOUBLE DEFAULT 100.0,
    allow_fractional BOOLEAN DEFAULT FALSE,
    list_date DATE,
    delist_date DATE,
    is_st BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS sync_log (
    symbol VARCHAR NOT NULL,
    freq VARCHAR NOT NULL,
    market VARCHAR NOT NULL,
    min_date VARCHAR,
    max_date VARCHAR,
    row_count BIGINT DEFAULT 0,
    source VARCHAR,
    updated_at VARCHAR,
    PRIMARY KEY (symbol, freq)
);
"""


def resolve_duckdb_path(data_dir: str | Path) -> Path:
    base = Path(data_dir).expanduser().resolve()
    db_dir = base / "duckdb"
    db_dir.mkdir(parents=True, exist_ok=True)
    return db_dir / "market.duckdb"


class DuckDBStore:
    """Safe wrapper over DuckDB supporting read-only concurrent backtest reads."""

    def __init__(self, data_dir: str | Path, read_only: bool = False) -> None:
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.db_path = resolve_duckdb_path(self.data_dir)
        self.read_only = read_only
        if not read_only:
            self.conn = duckdb.connect(str(self.db_path), read_only=False)
            self._init_schema()
        else:
            if not self.db_path.exists():
                # Ensure schema exists before opening read-only
                init_conn = duckdb.connect(str(self.db_path), read_only=False)
                init_conn.execute(SCHEMA_SQL)
                init_conn.close()
            self.conn = duckdb.connect(str(self.db_path), read_only=True)

    def _init_schema(self) -> None:
        self.conn.execute(SCHEMA_SQL)

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:
            pass

    def __enter__(self) -> "DuckDBStore":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    def list_symbols_by_market(self, market: str, freq: str = "1d", exclude_symbols: list[str] | None = None) -> list[str]:
        mkt = str(market or "CN").upper()
        excl = {str(s).upper() for s in (exclude_symbols or []) if s}
        if freq == "1d":
            rows = self.conn.execute(
                "SELECT DISTINCT symbol FROM bars_daily WHERE UPPER(market) = ? ORDER BY symbol",
                [mkt],
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT DISTINCT symbol FROM bars_minute WHERE UPPER(market) = ? AND freq = ? ORDER BY symbol",
                [mkt, freq],
            ).fetchall()
        out: list[str] = []
        for (sym,) in rows:
            s = str(sym or "").strip()
            if not s or s.upper() in excl:
                continue
            # 排除常见指数基准代码，避免选股把指数当个股买入
            if s.upper() in {"000300.SH", "000001.SH", "399001.SZ", "399006.SZ", "000688.SH", "SPY.US", "QQQ.US", "HSI.HK"}:
                continue
            out.append(s)
        return out

    def get_symbol_max_date(self, symbol: str, freq: str = "1d") -> str | None:
        if freq == "1d":
            row = self.conn.execute(
                "SELECT CAST(MAX(trade_date) AS VARCHAR) FROM bars_daily WHERE symbol = ?",
                [symbol],
            ).fetchone()
        else:
            row = self.conn.execute(
                "SELECT CAST(MAX(bar_time) AS VARCHAR) FROM bars_minute WHERE symbol = ? AND freq = ?",
                [symbol, freq],
            ).fetchone()
        return row[0] if row and row[0] else None

    def upsert_security_meta(self, meta: dict[str, Any]) -> None:
        if self.read_only:
            raise RuntimeError("Cannot write to read-only DuckDBStore")
        self.conn.execute(
            """
            INSERT OR REPLACE INTO security_meta
            (symbol, market, currency, name, exchange, board_type, lot_size, allow_fractional, list_date, delist_date, is_st)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                meta["symbol"],
                meta["market"],
                meta.get("currency", "CNY"),
                meta.get("name", meta["symbol"]),
                meta.get("exchange", ""),
                meta.get("board_type", ""),
                float(meta.get("lot_size", 100.0)),
                bool(meta.get("allow_fractional", False)),
                meta.get("list_date") or None,
                meta.get("delist_date") or None,
                bool(meta.get("is_st", False)),
            ],
        )

    def upsert_daily_bars(self, df: pd.DataFrame, symbol: str, market: str, source: str) -> int:
        if self.read_only:
            raise RuntimeError("Cannot write to read-only DuckDBStore")
        if df is None or df.empty:
            return 0
        work = df.copy()
        work["symbol"] = symbol
        work["market"] = market
        work["source"] = source
        for col, default in [
            ("pre_close", None),
            ("amount", 0.0),
            ("turnover_pct", None),
            ("is_suspended", False),
            ("up_limit", None),
            ("down_limit", None),
        ]:
            if col not in work.columns:
                work[col] = default
        work["trade_date"] = pd.to_datetime(work["trade_date"]).dt.date
        work = work.drop_duplicates(subset=["symbol", "trade_date"], keep="last")
        cols = [
            "symbol",
            "market",
            "trade_date",
            "open",
            "high",
            "low",
            "close",
            "pre_close",
            "volume",
            "amount",
            "turnover_pct",
            "is_suspended",
            "up_limit",
            "down_limit",
            "source",
        ]
        work = work[cols]
        self.conn.register("_tmp_daily", work)
        try:
            self.conn.execute(
                """
                INSERT OR REPLACE INTO bars_daily
                SELECT * FROM _tmp_daily
                """
            )
        finally:
            self.conn.unregister("_tmp_daily")

        # Update calendar & sync_log atomically
        self.conn.execute(
            """
            INSERT OR REPLACE INTO trade_calendar (market, trade_date, is_open)
            SELECT DISTINCT market, trade_date, TRUE FROM bars_daily WHERE symbol = ?
            """,
            [symbol],
        )
        self._refresh_sync_log(symbol, market, "1d", source)
        return len(work)

    def upsert_minute_bars(self, df: pd.DataFrame, symbol: str, market: str, freq: str, source: str) -> int:
        if self.read_only:
            raise RuntimeError("Cannot write to read-only DuckDBStore")
        if df is None or df.empty:
            return 0
        work = df.copy()
        work["symbol"] = symbol
        work["market"] = market
        work["freq"] = freq
        work["source"] = source
        if "amount" not in work.columns:
            work["amount"] = 0.0
        work["bar_time"] = pd.to_datetime(work["bar_time"])
        work = work.drop_duplicates(subset=["symbol", "freq", "bar_time"], keep="last")
        cols = ["symbol", "market", "freq", "bar_time", "open", "high", "low", "close", "volume", "amount", "source"]
        work = work[cols]
        self.conn.register("_tmp_min", work)
        try:
            self.conn.execute("INSERT OR REPLACE INTO bars_minute SELECT * FROM _tmp_min")
        finally:
            self.conn.unregister("_tmp_min")
        self._refresh_sync_log(symbol, market, freq, source)
        return len(work)

    def upsert_adjust_factors(self, df: pd.DataFrame, symbol: str, source: str) -> int:
        if self.read_only:
            raise RuntimeError("Cannot write to read-only DuckDBStore")
        if df is None or df.empty:
            return 0
        work = df.copy()
        work["symbol"] = symbol
        work["source"] = source
        work["trade_date"] = pd.to_datetime(work["trade_date"]).dt.date
        if "qfq_factor" not in work.columns:
            work["qfq_factor"] = 1.0
        if "hfq_factor" not in work.columns:
            work["hfq_factor"] = 1.0
        work = work.drop_duplicates(subset=["symbol", "trade_date"], keep="last")
        work = work[["symbol", "trade_date", "qfq_factor", "hfq_factor", "source"]]
        self.conn.register("_tmp_adj", work)
        try:
            self.conn.execute("INSERT OR REPLACE INTO adjust_factors SELECT * FROM _tmp_adj")
        finally:
            self.conn.unregister("_tmp_adj")
        return len(work)

    def upsert_calendar(self, market: str, dates: list[str], is_open: bool = True) -> int:
        if self.read_only:
            raise RuntimeError("Cannot write to read-only DuckDBStore")
        if not dates:
            return 0
        df = pd.DataFrame({"market": market, "trade_date": pd.to_datetime(dates).dt.date, "is_open": bool(is_open)})
        df = df.drop_duplicates(subset=["market", "trade_date"], keep="last")
        self.conn.register("_tmp_cal", df)
        try:
            self.conn.execute("INSERT OR REPLACE INTO trade_calendar SELECT * FROM _tmp_cal")
        finally:
            self.conn.unregister("_tmp_cal")
        return len(df)

    def _refresh_sync_log(self, symbol: str, market: str, freq: str, source: str) -> None:
        if freq == "1d":
            stats = self.conn.execute(
                """
                SELECT CAST(MIN(trade_date) AS VARCHAR), CAST(MAX(trade_date) AS VARCHAR), COUNT(*)
                FROM bars_daily WHERE symbol = ?
                """,
                [symbol],
            ).fetchone()
        else:
            stats = self.conn.execute(
                """
                SELECT CAST(MIN(bar_time) AS VARCHAR), CAST(MAX(bar_time) AS VARCHAR), COUNT(*)
                FROM bars_minute WHERE symbol = ? AND freq = ?
                """,
                [symbol, freq],
            ).fetchone()
        min_d, max_d, cnt = stats if stats else (None, None, 0)
        now_iso = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
        self.conn.execute(
            """
            INSERT OR REPLACE INTO sync_log (symbol, freq, market, min_date, max_date, row_count, source, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [symbol, freq, market, min_d, max_d, int(cnt or 0), source, now_iso],
        )

    def query_daily_bars(
        self,
        symbols: list[str],
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> pd.DataFrame:
        if not symbols:
            return pd.DataFrame()
        placeholders = ",".join(["?"] * len(symbols))
        params: list[Any] = list(symbols)
        where = [f"symbol IN ({placeholders})"]
        if start_date:
            where.append("trade_date >= CAST(? AS DATE)")
            params.append(start_date)
        if end_date:
            where.append("trade_date <= CAST(? AS DATE)")
            params.append(end_date)
        sql = f"""
            SELECT symbol, market, CAST(trade_date AS VARCHAR) AS trade_date,
                   open, high, low, close, pre_close, volume, amount,
                   turnover_pct, is_suspended, up_limit, down_limit, source
            FROM bars_daily
            WHERE {' AND '.join(where)}
            ORDER BY trade_date ASC, symbol ASC
        """
        return self.conn.execute(sql, params).fetchdf()

    def query_minute_bars(
        self,
        symbols: list[str],
        freq: str,
        start_time: str | None = None,
        end_time: str | None = None,
    ) -> pd.DataFrame:
        if not symbols:
            return pd.DataFrame()
        placeholders = ",".join(["?"] * len(symbols))
        params: list[Any] = [freq, *symbols]
        where = ["freq = ?", f"symbol IN ({placeholders})"]
        if start_time:
            where.append("bar_time >= CAST(? AS TIMESTAMP)")
            params.append(start_time)
        if end_time:
            where.append("bar_time <= CAST(? AS TIMESTAMP)")
            params.append(end_time)
        sql = f"""
            SELECT symbol, market, freq, CAST(bar_time AS VARCHAR) AS bar_time,
                   open, high, low, close, volume, amount, source
            FROM bars_minute
            WHERE {' AND '.join(where)}
            ORDER BY bar_time ASC, symbol ASC
        """
        return self.conn.execute(sql, params).fetchdf()

    def query_adjust_factors(self, symbols: list[str]) -> pd.DataFrame:
        if not symbols:
            return pd.DataFrame()
        placeholders = ",".join(["?"] * len(symbols))
        return self.conn.execute(
            f"""
            SELECT symbol, CAST(trade_date AS VARCHAR) AS trade_date, qfq_factor, hfq_factor, source
            FROM adjust_factors
            WHERE symbol IN ({placeholders})
            ORDER BY trade_date ASC
            """,
            list(symbols),
        ).fetchdf()

    def query_security_meta(self, symbols: list[str] | None = None) -> dict[str, dict[str, Any]]:
        if symbols:
            placeholders = ",".join(["?"] * len(symbols))
            df = self.conn.execute(
                f"SELECT * FROM security_meta WHERE symbol IN ({placeholders})",
                list(symbols),
            ).fetchdf()
        else:
            df = self.conn.execute("SELECT * FROM security_meta").fetchdf()
        out: dict[str, dict[str, Any]] = {}
        for _, row in df.iterrows():
            rec = row.to_dict()
            out[str(rec["symbol"])] = rec
        return out

    def get_data_summary(self) -> dict[str, Any]:
        rows = self.conn.execute(
            """
            SELECT s.symbol, s.freq, s.market, s.min_date, s.max_date, s.row_count, s.source, s.updated_at,
                   m.name, m.currency, m.lot_size, m.board_type
            FROM sync_log s
            LEFT JOIN security_meta m ON s.symbol = m.symbol
            ORDER BY s.market ASC, s.symbol ASC, s.freq ASC
            """
        ).fetchall()
        items = []
        markets_count: dict[str, int] = {}
        for r in rows:
            mkt = r[2]
            markets_count[mkt] = markets_count.get(mkt, 0) + 1
            items.append(
                {
                    "symbol": r[0],
                    "freq": r[1],
                    "market": mkt,
                    "minDate": r[3],
                    "maxDate": r[4],
                    "rowCount": int(r[5] or 0),
                    "source": r[6] or "",
                    "updatedAt": r[7] or "",
                    "name": r[8] or r[0],
                    "currency": r[9] or "CNY",
                    "lotSize": float(r[10]) if r[10] is not None else 100.0,
                    "boardType": r[11] or "",
                }
            )

        db_size_mb = round(os.path.getsize(self.db_path) / (1024 * 1024), 2) if self.db_path.exists() else 0.0
        cal_rows = self.conn.execute(
            "SELECT market, COUNT(*), CAST(MIN(trade_date) AS VARCHAR), CAST(MAX(trade_date) AS VARCHAR) FROM trade_calendar WHERE is_open = TRUE GROUP BY market"
        ).fetchall()
        calendars = {
            r[0]: {"openDays": int(r[1]), "minDate": r[2], "maxDate": r[3]}
            for r in cal_rows
        }
        from ..extensions import is_cn_commercial, load_market_extension

        is_cn_edition = is_cn_commercial()
        ext = load_market_extension("crypto")
        if is_cn_edition or ext is None:
            items = [x for x in items if x.get("market") != "CRYPTO"]
            markets_count.pop("CRYPTO", None)
        has_cn_benchmark = any(x["symbol"] == "000300.SH" and x["freq"] == "1d" and x["rowCount"] > 20 for x in items)
        has_us_benchmark = any(x["symbol"] == "SPY.US" and x["freq"] == "1d" and x["rowCount"] > 20 for x in items)
        benchmarks_ready: dict[str, bool] = {
            "CN": has_cn_benchmark,
            "US": has_us_benchmark,
        }
        if not is_cn_edition and ext is not None:
            benchmarks_ready[ext.MARKET_CODE] = ext.has_benchmark_ready(items)

        return {
            "dbPath": str(self.db_path),
            "dbSizeMb": db_size_mb,
            "totalSeries": len(items),
            "marketsCount": markets_count,
            "benchmarksReady": benchmarks_ready,
            "calendars": calendars,
            "items": items,
        }
