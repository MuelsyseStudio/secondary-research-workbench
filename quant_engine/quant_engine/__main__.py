"""Unified CLI entrypoint: python -m quant_engine <doctor|summary|sync|import-csv|backtest>."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from . import __version__
from .protocol import (
    emit_done,
    emit_error,
    emit_log,
    emit_progress,
    is_cn_commercial_edition,
    normalize_symbol,
    validate_edition_asset_inputs,
)
from .storage.duckdb_store import DuckDBStore, resolve_duckdb_path
from .storage.importers import (
    import_csv_or_parquet,
    sync_baostock_symbol,
    sync_cn_calendar_baostock,
    sync_crypto_symbol,
    sync_custom_rest_symbol,
    sync_eastmoney_symbol,
    sync_tushare_symbol,
    sync_yfinance_symbol,
)


def _pkg_version(name: str) -> dict[str, Any]:
    spec = importlib.util.find_spec(name)
    if spec is None:
        return {"installed": False, "version": None}
    try:
        mod = __import__(name)
        return {"installed": True, "version": getattr(mod, "__version__", "installed")}
    except Exception:
        return {"installed": True, "version": "unknown"}


def cmd_doctor(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir).expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    disk = shutil.disk_usage(str(data_dir))
    deps = {
        pkg: _pkg_version(pkg)
        for pkg in ("duckdb", "numpy", "pandas", "requests", "baostock", "yfinance", "pytest")
    }
    required_ok = all(deps[p]["installed"] for p in ("duckdb", "numpy", "pandas", "requests"))
    db_path = resolve_duckdb_path(data_dir)
    report = {
        "ok": required_ok,
        "engineVersion": __version__,
        "pythonVersion": sys.version.split()[0],
        "pythonExecutable": sys.executable,
        "dataDir": str(data_dir),
        "dbPath": str(db_path),
        "dbExists": db_path.exists(),
        "diskFreeGb": round(disk.free / (1024**3), 2),
        "dependencies": deps,
    }
    print(json.dumps(report, ensure_ascii=False))
    return 0 if required_ok else 1


def cmd_summary(args: argparse.Namespace) -> int:
    with DuckDBStore(args.data_dir, read_only=True) as store:
        summary = store.get_data_summary()
    print(json.dumps({"ok": True, **summary}, ensure_ascii=False))
    return 0


def cmd_bars(args: argparse.Namespace) -> int:
    validation_err = validate_edition_asset_inputs([args.symbol], market_hint=args.market)
    if validation_err:
        print(json.dumps({"ok": False, "error": validation_err, "bars": []}, ensure_ascii=False))
        return 1
    sym, mkt = normalize_symbol(args.symbol, args.market)
    if is_cn_commercial_edition() and mkt == "CRYPTO":
        print(json.dumps({"ok": False, "error": "当前版本不支持该资产类型", "bars": []}, ensure_ascii=False))
        return 1
    freq = args.freq or "1d"
    with DuckDBStore(args.data_dir, read_only=True) as store:
        if freq == "1d":
            df = store.query_daily_bars([sym], start_date=args.start, end_date=args.end)
            meta = store.query_security_meta([sym]).get(sym) or {}
            bars = [
                {
                    "time": str(r["trade_date"])[:10],
                    "open": round(float(r["open"]), 4),
                    "high": round(float(r["high"]), 4),
                    "low": round(float(r["low"]), 4),
                    "close": round(float(r["close"]), 4),
                    "volume": float(r["volume"] or 0.0),
                    "amount": float(r["amount"] or 0.0),
                }
                for _, r in df.iterrows()
            ]
        else:
            df = store.query_minute_bars([sym], freq=freq, start_time=args.start, end_time=args.end)
            meta = store.query_security_meta([sym]).get(sym) or {}
            bars = [
                {
                    "time": str(r["bar_time"])[:19],
                    "open": round(float(r["open"]), 4),
                    "high": round(float(r["high"]), 4),
                    "low": round(float(r["low"]), 4),
                    "close": round(float(r["close"]), 4),
                    "volume": float(r["volume"] or 0.0),
                    "amount": float(r["amount"] or 0.0),
                }
                for _, r in df.iterrows()
            ]
    print(json.dumps({"ok": True, "symbol": sym, "market": mkt, "name": meta.get("name", sym), "freq": freq, "bars": bars}, ensure_ascii=False))
    return 0


def _compute_incremental_start(existing_max: str | None, requested_start: str, end_date: str, force: bool) -> str | None:
    """Return effective start_date for incremental sync, or None if already up to date."""
    if force or not existing_max:
        return requested_start[:10]
    try:
        max_d = date.fromisoformat(existing_max[:10])
        end_d = date.fromisoformat(end_date[:10])
        if max_d >= end_d:
            return None
        next_d = max_d + timedelta(days=1)
        return max(next_d, date.fromisoformat(requested_start[:10])).isoformat()
    except Exception:
        return requested_start[:10]


def cmd_sync(args: argparse.Namespace) -> int:
    raw_syms = [s.strip() for s in str(args.symbols or "").split(",") if s.strip()]
    if not raw_syms:
        emit_error("请提供至少一个标的代码 (--symbols)")
        return 1

    validation_err = validate_edition_asset_inputs(raw_syms, market_hint=args.market)
    if validation_err:
        emit_error(validation_err)
        return 1

    start_date = args.start or (date.today() - timedelta(days=730)).isoformat()
    end_date = args.end or date.today().isoformat()
    freq = args.freq or "1d"
    source = (args.source or "auto").lower()
    force = bool(args.force)

    extra_cfg: dict[str, Any] = {}
    if args.config_json and Path(args.config_json).exists():
        extra_cfg = json.loads(Path(args.config_json).read_text(encoding="utf-8"))

    results = []
    has_cn = False
    normalized_list = [normalize_symbol(s, args.market) for s in raw_syms]

    with DuckDBStore(args.data_dir, read_only=False) as store:
        for idx, (sym, mkt) in enumerate(normalized_list):
            if mkt == "CN":
                has_cn = True
            pct = round(((idx) / max(1, len(normalized_list))) * 92.0, 1)
            existing_max = store.get_symbol_max_date(sym, freq)
            eff_start = _compute_incremental_start(existing_max, start_date, end_date, force)
            if eff_start is None:
                emit_progress(pct, f"{sym} 已最新 ({existing_max})，增量跳过")
                results.append({"symbol": sym, "market": mkt, "rows": 0, "skipped": True, "source": "incremental_skip"})
                continue

            emit_progress(pct, f"正在同步 {sym} ({mkt}, {eff_start} → {end_date})...")
            try:
                res: dict[str, Any]
                if source == "tushare":
                    res = sync_tushare_symbol(
                        store,
                        sym,
                        eff_start,
                        end_date,
                        token=extra_cfg.get("tushareToken", ""),
                        api_base_url=extra_cfg.get("tushareBaseUrl", "https://api.tushare.pro"),
                    )
                elif source == "custom_rest":
                    res = sync_custom_rest_symbol(
                        store,
                        sym,
                        mkt,
                        eff_start,
                        end_date,
                        base_url=extra_cfg.get("baseUrl", ""),
                        path_template=extra_cfg.get("pathTemplate", "/api/history?symbol={symbol}&start={start}&end={end}&freq={freq}"),
                        api_key=extra_cfg.get("apiKey", ""),
                        auth_header_name=extra_cfg.get("authHeaderName", "Authorization"),
                        auth_header_prefix=extra_cfg.get("authHeaderPrefix", "Bearer "),
                        freq=freq,
                    )
                elif mkt == "CRYPTO":
                    if is_cn_commercial_edition() or sync_crypto_symbol is None:
                        raise ValueError("当前版本不支持该资产类型的数据同步")
                    res = sync_crypto_symbol(store, sym, eff_start, end_date, freq=freq)
                elif mkt == "CN":
                    if source == "eastmoney":
                        res = sync_eastmoney_symbol(store, sym, mkt, eff_start, end_date, freq=freq)
                    else:
                        # Default CN: BaoStock primary, Eastmoney/Tencent mirror fallback
                        try:
                            res = sync_baostock_symbol(store, sym, eff_start, end_date, freq=freq)
                            if res.get("rows", 0) == 0 and freq == "1d":
                                res = sync_eastmoney_symbol(store, sym, mkt, eff_start, end_date, freq=freq)
                        except Exception as exc:
                            emit_log("warn", f"BaoStock 同步 {sym} 失败 ({exc})，自动回退腾讯/东财镜像")
                            res = sync_eastmoney_symbol(store, sym, mkt, eff_start, end_date, freq=freq)
                else:
                    # US / HK / TW / KR / JP / FR / UK / DE / FUT
                    if source == "eastmoney":
                        res = sync_eastmoney_symbol(store, sym, mkt, eff_start, end_date, freq=freq)
                    else:
                        # Try yfinance first if requested, otherwise Tencent/Eastmoney mirror works seamlessly even in CN
                        try:
                            if source == "yfinance":
                                res = sync_yfinance_symbol(store, sym, mkt, eff_start, end_date, freq=freq)
                            else:
                                res = sync_eastmoney_symbol(store, sym, mkt, eff_start, end_date, freq=freq)
                                if res.get("rows", 0) == 0:
                                    res = sync_yfinance_symbol(store, sym, mkt, eff_start, end_date, freq=freq)
                        except Exception as exc:
                            emit_log("warn", f"{sym} 主源拉取异常 ({exc})，尝试备用源")
                            res = sync_eastmoney_symbol(store, sym, mkt, eff_start, end_date, freq=freq)

                results.append({"market": mkt, "skipped": False, **res})
                emit_log("info", f"✓ {sym} 入库 {res.get('rows', 0)} 条 ({res.get('source', '')})")
            except Exception as exc:
                emit_log("error", f"✗ {sym} 同步失败: {exc}")
                results.append({"symbol": sym, "market": mkt, "rows": 0, "error": str(exc)})

        if has_cn:
            try:
                sync_cn_calendar_baostock(store, start_date, end_date)
            except Exception:
                pass
        summary = store.get_data_summary()

    emit_progress(100, "同步完成")
    emit_done({"results": results, "summary": summary})
    return 0


def cmd_import_csv(args: argparse.Namespace) -> int:
    validation_err = validate_edition_asset_inputs([args.symbol], market_hint=args.market)
    if validation_err:
        emit_error(validation_err)
        return 1
    sym, mkt = normalize_symbol(args.symbol, args.market)
    if is_cn_commercial_edition() and mkt == "CRYPTO":
        emit_error("当前版本不支持该资产类型的导入")
        return 1
    col_map = json.loads(args.col_map) if args.col_map else None
    with DuckDBStore(args.data_dir, read_only=False) as store:
        res = import_csv_or_parquet(
            store,
            args.file,
            sym,
            mkt,
            freq=args.freq or "1d",
            col_map=col_map,
            volume_multiplier=float(args.volume_multiplier or 1.0),
            name=args.name,
        )
        summary = store.get_data_summary()
    emit_done({"result": res, "summary": summary})
    return 0


def cmd_backtest(args: argparse.Namespace) -> int:
    from .core.engine import run_backtest_from_spec_file

    return run_backtest_from_spec_file(args.spec, args.out)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass

    parser = argparse.ArgumentParser(prog="quant_engine", description="Multi-Market DuckDB & Backtest CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_doc = sub.add_parser("doctor")
    p_doc.add_argument("--data-dir", default=os.path.join(os.getcwd(), "quant_data"))
    p_doc.set_defaults(func=cmd_doctor)

    p_sum = sub.add_parser("summary")
    p_sum.add_argument("--data-dir", required=True)
    p_sum.set_defaults(func=cmd_summary)

    p_bars = sub.add_parser("bars")
    p_bars.add_argument("--data-dir", required=True)
    p_bars.add_argument("--symbol", required=True)
    p_bars.add_argument("--market", default=None)
    p_bars.add_argument("--start", default=None)
    p_bars.add_argument("--end", default=None)
    p_bars.add_argument("--freq", default="1d")
    p_bars.set_defaults(func=cmd_bars)

    p_sync = sub.add_parser("sync")
    p_sync.add_argument("--data-dir", required=True)
    p_sync.add_argument("--symbols", required=True)
    p_sync.add_argument("--market", default=None)
    p_sync.add_argument("--start", default=None)
    p_sync.add_argument("--end", default=None)
    p_sync.add_argument("--freq", default="1d")
    p_sync.add_argument("--source", default="auto")
    p_sync.add_argument("--force", action="store_true")
    p_sync.add_argument("--config-json", default=None)
    p_sync.set_defaults(func=cmd_sync)

    p_csv = sub.add_parser("import-csv")
    p_csv.add_argument("--data-dir", required=True)
    p_csv.add_argument("--file", required=True)
    p_csv.add_argument("--symbol", required=True)
    p_csv.add_argument("--market", default=None)
    p_csv.add_argument("--freq", default="1d")
    p_csv.add_argument("--col-map", default=None)
    p_csv.add_argument("--volume-multiplier", default="1.0")
    p_csv.add_argument("--name", default=None)
    p_csv.set_defaults(func=cmd_import_csv)

    p_bt = sub.add_parser("backtest")
    p_bt.add_argument("--spec", required=True)
    p_bt.add_argument("--out", required=True)
    p_bt.set_defaults(func=cmd_backtest)

    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except Exception as exc:
        emit_error(str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
