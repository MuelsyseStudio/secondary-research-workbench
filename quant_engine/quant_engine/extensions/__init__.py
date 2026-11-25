"""Pluggable market extension discovery loader for quant_engine.

Core engine code never hardcodes optional market extension filenames or external domains.
When running under `SRW_EDITION=cn_commercial`, optional extensions gated by feature flags
are disabled and physically excluded during commercial packaging.
"""

from __future__ import annotations

import importlib
import os
from pathlib import Path
from typing import Any


def current_edition() -> str:
    return (os.environ.get("SRW_EDITION") or "personal").strip().lower()


def is_cn_commercial() -> bool:
    return current_edition() == "cn_commercial"


def load_market_extension(feature_flag: str) -> Any | None:
    if is_cn_commercial():
        return None
    ext_dir = Path(__file__).resolve().parent
    for py_file in sorted(ext_dir.glob("*.py")):
        if py_file.name.startswith("_"):
            continue
        mod_name = f"{__package__}.{py_file.stem}"
        try:
            mod = importlib.import_module(mod_name)
            if getattr(mod, "FEATURE_FLAG", None) == feature_flag:
                return mod
        except Exception:
            continue
    return None
