"""Multi-market data importers package."""

import importlib
from pathlib import Path

from ...extensions import is_cn_commercial
from .baostock_sync import sync_baostock_symbol, sync_cn_calendar_baostock
try:
    from .eastmoney_sync import sync_eastmoney_symbol
except ImportError:
    sync_eastmoney_symbol = None
try:
    from .yfinance_sync import sync_yfinance_symbol
except ImportError:
    sync_yfinance_symbol = None
from .tushare_sync import sync_tushare_symbol
from .custom_rest import sync_custom_rest_symbol
from .csv_parquet import import_csv_or_parquet


def _discover_optional_importer(feature_flag: str):
    if is_cn_commercial():
        return None
    pkg_dir = Path(__file__).resolve().parent
    for py_file in sorted(pkg_dir.glob("*.py")):
        if py_file.name.startswith("_"):
            continue
        try:
            mod = importlib.import_module(f"{__package__}.{py_file.stem}")
            if getattr(mod, "FEATURE_FLAG", None) == feature_flag:
                for attr in dir(mod):
                    if attr.startswith("sync_") and callable(getattr(mod, attr)):
                        return getattr(mod, attr)
        except Exception:
            continue
    return None


sync_crypto_symbol = _discover_optional_importer("crypto")

__all__ = [
    "sync_baostock_symbol",
    "sync_cn_calendar_baostock",
    "sync_eastmoney_symbol",
    "sync_yfinance_symbol",
    "sync_crypto_symbol",
    "sync_tushare_symbol",
    "sync_custom_rest_symbol",
    "import_csv_or_parquet",
]
