"""NDJSON streaming protocol and canonical multi-market symbol conversions."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from typing import Any


def emit_event(payload: dict[str, Any]) -> None:
    """Emit one NDJSON line to stdout for Node quant-bridge consumption."""
    line = json.dumps(payload, ensure_ascii=False, default=str)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def emit_progress(pct: float, stage: str, detail: dict[str, Any] | None = None) -> None:
    msg: dict[str, Any] = {
        "type": "progress",
        "pct": max(0, min(100, round(float(pct), 1))),
        "stage": stage,
    }
    if detail:
        msg["detail"] = detail
    emit_event(msg)


def emit_log(level: str, msg: str) -> None:
    emit_event({"type": "log", "level": level, "msg": msg})


def emit_done(data: dict[str, Any]) -> None:
    emit_event({"type": "done", **data})


def emit_error(error: str, detail: str | None = None) -> None:
    payload: dict[str, Any] = {"type": "error", "error": error}
    if detail:
        payload["detail"] = detail
    emit_event(payload)


# ============================================================================
# Canonical Symbol Protocol (e.g. 300308.SZ / NVDA.US / 00700.HK / COMEX.GC.FUT)
# ============================================================================

from .extensions import load_market_extension

_BASE_MARKETS = {"CN", "US", "HK", "TW", "KR", "JP", "FR", "UK", "DE", "FUT"}
_CRYPTO_EXT = load_market_extension("crypto")

VALID_MARKETS = set(_BASE_MARKETS) | ({_CRYPTO_EXT.MARKET_CODE} if _CRYPTO_EXT else set())

_QUOTE_SUFFIX_DIGESTS = {
    "ca9006bd3fb03d35",
    "8591ee9090c0c02c",
    "bd4ef74463ac3c61",
    "42e52be5cde97422",
    "ed26f35d2079033b",
}


def _sha16(val: str) -> str:
    return hashlib.sha256(val.encode("utf-8")).hexdigest()[:16]


def is_cn_commercial_edition(edition: str | None = None) -> bool:
    raw = (edition or os.environ.get("SRW_EDITION") or "personal").strip().lower()
    return raw == "cn_commercial"


def is_unsupported_legacy_asset(raw_symbol: str, market_hint: str | None = None, edition: str | None = None) -> bool:
    """Return True if raw_symbol or market_hint represents an unsupported asset class in CN commercial edition."""
    if not is_cn_commercial_edition(edition):
        return False
    mh = str(market_hint or "").strip().upper()
    if mh and mh not in _BASE_MARKETS:
        return True
    s = str(raw_symbol or "").strip()
    if not s:
        return False
    up = s.upper()
    if up.startswith("CRYPTO.") or up.endswith(".CRYPTO"):
        return True
    if "/" in up:
        return True
    if re.match(r"^[A-Z0-9]{2,12}_[A-Z]{3,6}$", up):
        return True
    if re.match(r"^[A-Z0-9]{2,12}-[A-Z]{3,6}$", up):
        return True
    if re.match(r"^[A-Z0-9]{6,14}$", up):
        if _sha16(up[-4:]) in _QUOTE_SUFFIX_DIGESTS:
            return True
        if len(up) >= 7 and _sha16(up[-5:]) in _QUOTE_SUFFIX_DIGESTS:
            return True
    return False


def validate_edition_asset_inputs(
    symbols: list[str] | tuple[str, ...],
    market_hint: str | None = None,
    edition: str | None = None,
) -> str | None:
    """Validate raw market & symbol inputs BEFORE normalization, DB access, or importer dispatch."""
    if not is_cn_commercial_edition(edition):
        return None
    mh = str(market_hint or "").strip().upper()
    if mh and mh not in _BASE_MARKETS:
        return f"当前国内版不支持该市场类型 ({mh})，仅支持 A 股及全球主流股市与期货"
    for raw in symbols:
        if is_unsupported_legacy_asset(str(raw or ""), market_hint=mh or None, edition=edition):
            return f"当前国内版不支持该资产标识 ({raw})，已拒绝归一化与后续操作"
    return None

MARKET_DEFAULTS = {
    "CN": {"currency": "CNY", "benchmark": "000300.SH", "lot_size": 100.0, "allow_fractional": False},
    "US": {"currency": "USD", "benchmark": "SPY.US", "lot_size": 1.0, "allow_fractional": False},
    "HK": {"currency": "HKD", "benchmark": "HSI.HK", "lot_size": 100.0, "allow_fractional": False},
    "TW": {"currency": "TWD", "benchmark": "2330.TW", "lot_size": 1000.0, "allow_fractional": False},
    "KR": {"currency": "KRW", "benchmark": "005930.KS", "lot_size": 1.0, "allow_fractional": False},
    "JP": {"currency": "JPY", "benchmark": "7203.JP", "lot_size": 100.0, "allow_fractional": False},
    "FR": {"currency": "EUR", "benchmark": "MC.FR", "lot_size": 1.0, "allow_fractional": False},
    "UK": {"currency": "GBP", "benchmark": "SHEL.UK", "lot_size": 1.0, "allow_fractional": False},
    "DE": {"currency": "EUR", "benchmark": "SAP.DE", "lot_size": 1.0, "allow_fractional": False},
    "FUT": {"currency": "USD", "benchmark": "", "lot_size": 1.0, "allow_fractional": False},
}
if _CRYPTO_EXT:
    MARKET_DEFAULTS[_CRYPTO_EXT.MARKET_CODE] = dict(_CRYPTO_EXT.MARKET_DEFAULT)


def default_benchmark_for_market(market: str) -> str:
    return MARKET_DEFAULTS.get(market.upper(), MARKET_DEFAULTS["CN"])["benchmark"]


def default_currency_for_market(market: str) -> str:
    return MARKET_DEFAULTS.get(market.upper(), MARKET_DEFAULTS["CN"])["currency"]


def infer_market(symbol: str, market_hint: str | None = None) -> str:
    s = str(symbol or "").strip().upper()
    ext = load_market_extension("crypto")
    if ext:
        inferred_ext = ext.infer_crypto_market(s)
        if inferred_ext:
            return inferred_ext
    if s.endswith(".FUT"):
        return "FUT"
    if s.endswith((".SH", ".SZ", ".BJ")):
        return "CN"
    if s.endswith(".US"):
        return "US"
    if s.endswith(".HK"):
        return "HK"
    if s.endswith(".TW"):
        return "TW"
    if s.endswith((".KS", ".KR")):
        return "KR"
    if s.endswith((".JP", ".T")):
        return "JP"
    if s.endswith((".FR", ".PA")):
        return "FR"
    if s.endswith((".UK", ".L")):
        return "UK"
    if s.endswith(".DE"):
        return "DE"
    if market_hint and market_hint.upper() in VALID_MARKETS:
        return market_hint.upper()
    if re.match(r"^\d{6}$", s):
        return "CN"
    if re.match(r"^[A-Z]{1,6}$", s):
        return "US"
    return "CN"


def normalize_symbol(raw: str, market_hint: str | None = None) -> tuple[str, str]:
    """Normalize any user / Eastmoney / BaoStock / global ticker into (canonical_symbol, market)."""
    s = str(raw or "").strip()
    if not s:
        raise ValueError("Empty symbol")

    err = validate_edition_asset_inputs([s], market_hint=market_hint)
    if err:
        raise ValueError(err)

    ext = load_market_extension("crypto")
    if ext:
        ext_norm = ext.normalize_crypto_symbol(s, market_hint)
        if ext_norm:
            return ext_norm

    m_em = re.match(r"^(\d+)\.([A-Za-z0-9._-]+)$", s)
    if m_em:
        mkt_num, code = m_em.group(1), m_em.group(2).upper()
        if mkt_num == "1" and re.match(r"^\d{6}$", code):
            return f"{code}.SH", "CN"
        if mkt_num == "0" and re.match(r"^\d{6}$", code):
            suffix = "BJ" if code.startswith(("4", "8", "92")) else "SZ"
            return f"{code}.{suffix}", "CN"
        if mkt_num in ("105", "106", "107", "100") and not code.isdigit():
            return f"{code}.US", "US"
        if mkt_num == "116":
            return f"{code.zfill(5)}.HK", "HK"
        if mkt_num == "178":
            return f"{code}.TW", "TW"
        if mkt_num == "177":
            return f"{code}.KS", "KR"
        if mkt_num == "176":
            return f"{code}.JP", "JP"
        if mkt_num == "186":
            return f"{code}.FR", "FR"
        if mkt_num in ("155", "156"):
            return f"{code}.UK", "UK"
        if mkt_num == "185":
            return f"{code}.DE", "DE"
        if mkt_num in ("101", "102", "103", "104", "108", "109", "112", "113", "114", "115", "118", "142", "220", "225"):
            return f"{mkt_num}_{code}.FUT", "FUT"

    # Handle BaoStock prefix (e.g. sz.300308, sh.000300)
    m_bs = re.match(r"^(sh|sz|bj)\.(\d{6})$", s, re.I)
    if m_bs:
        return f"{m_bs.group(2)}.{m_bs.group(1).upper()}", "CN"

    # Handle Tencent prefix (sh600519, sz300308)
    m_tx = re.match(r"^(sh|sz|bj)(\d{6})$", s, re.I)
    if m_tx:
        return f"{m_tx.group(2)}.{m_tx.group(1).upper()}", "CN"

    up = s.upper()
    if up.endswith((".SH", ".SZ", ".BJ", ".US", ".HK", ".TW", ".KS", ".JP", ".FR", ".UK", ".DE", ".FUT")):
        mkt = infer_market(up, market_hint)
        if mkt == "HK":
            base = up[:-3]
            if base.isdigit():
                return f"{base.zfill(5)}.HK", "HK"
        return up, mkt

    mkt = infer_market(up, market_hint)
    if mkt == "CN":
        if re.match(r"^\d{6}$", up):
            if up.startswith(("6", "9", "5")) or up in ("000001", "000300", "000688", "000905", "000852"):
                return f"{up}.SH", "CN"
            if up.startswith(("4", "8", "92")):
                return f"{up}.BJ", "CN"
            return f"{up}.SZ", "CN"
        return f"{up}.SH", "CN"
    if mkt == "HK":
        return f"{up.zfill(5) if up.isdigit() else up}.HK", "HK"
    return f"{up}.{mkt}", mkt


def canonical_to_baostock(symbol: str) -> str:
    """Convert 300308.SZ -> sz.300308, 000300.SH -> sh.000300."""
    sym, _ = normalize_symbol(symbol, "CN")
    code, suffix = sym.rsplit(".", 1)
    return f"{suffix.lower()}.{code}"


def canonical_to_eastmoney_secid(symbol: str) -> str:
    """Convert canonical symbol into Eastmoney secid."""
    sym, mkt = normalize_symbol(symbol)
    ext = load_market_extension("crypto")
    if ext and mkt == ext.MARKET_CODE:
        return ext.canonical_to_secid(sym)
    if mkt == "CN":
        code, suffix = sym.rsplit(".", 1)
        if suffix == "SH":
            return f"1.{code}"
        return f"0.{code}"
    if mkt == "HK":
        code = sym[:-3]
        if code in ("HSI", "^HSI"):
            return "100.HSI"
        return f"116.{code.zfill(5)}"
    if mkt == "US":
        code = sym[:-3]
        if code in ("SPY", "QQQ", "DIA", "IWM", "TLT", "GLD", "SLV"):
            return f"107.{code}"
        if code in ("SPX", "^GSPC"):
            return "100.SPX"
        if code in ("NDX", "^NDX", "IXIC"):
            return "100.NDX"
        nyse_well_known = {"TSM", "COHR", "BRK.B", "BABA", "JPM", "V", "MA", "WMT", "XOM", "KO", "DIS", "BA", "ORCL", "CRM", "IBM", "UNH", "JNJ", "PG", "HD"}
        if code in nyse_well_known:
            return f"106.{code}"
        return f"105.{code}"
    if mkt == "TW":
        return f"178.{sym[:-3]}"
    if mkt == "KR":
        return f"177.{sym[:-3]}"
    if mkt == "JP":
        return f"176.{sym[:-3]}"
    if mkt == "FR":
        return f"186.{sym[:-3]}"
    if mkt == "UK":
        return f"155.{sym[:-3]}"
    if mkt == "DE":
        return f"185.{sym[:-3]}"
    if mkt == "FUT":
        base = sym[:-4]
        if "_" in base:
            p1, p2 = base.split("_", 1)
            if p1.isdigit():
                return f"{p1}.{p2}"
        fut_map = {
            "COMEX.GC": "101.GC00Y",
            "COMEX.SI": "101.SI00Y",
            "NYMEX.CL": "102.CL00Y",
            "ICE.BRENT": "112.B00Y",
            "SHFE.AU": "113.aum",
            "SHFE.CU": "113.cum",
            "SGX.A50": "104.CN00Y",
            "CME.NQ": "103.NQ00Y",
            "CME.ES": "103.ES00Y",
        }
        return fut_map.get(base, base)
    return sym


def canonical_to_yfinance(symbol: str) -> str:
    """Convert canonical symbol into yfinance ticker."""
    sym, mkt = normalize_symbol(symbol)
    if mkt == "US":
        code = sym[:-3]
        if code == "SPX":
            return "^GSPC"
        if code == "NDX":
            return "^NDX"
        return code.replace(".", "-")
    if mkt == "HK":
        code = sym[:-3]
        if code in ("HSI", "^HSI"):
            return "^HSI"
        return f"{code.lstrip('0').zfill(4)}.HK"
    if mkt == "CN":
        code, suffix = sym.rsplit(".", 1)
        return f"{code}.SS" if suffix == "SH" else f"{code}.{suffix}"
    if mkt == "TW":
        return sym
    if mkt == "KR":
        return sym
    if mkt == "JP":
        return f"{sym[:-3]}.T"
    if mkt == "FR":
        return f"{sym[:-3]}.PA"
    if mkt == "UK":
        return f"{sym[:-3]}.L"
    if mkt == "DE":
        return sym
    ext = load_market_extension("crypto")
    if ext and mkt == ext.MARKET_CODE:
        return ext.canonical_to_yf(sym)
    return sym


def infer_cn_board_type(symbol: str, is_st: bool = False) -> str:
    code = symbol.split(".")[0]
    if is_st:
        return "ST"
    if code.startswith("688"):
        return "STAR"
    if code.startswith("30"):
        return "CHINEXT"
    if code.startswith(("4", "8", "92")) or symbol.endswith(".BJ"):
        return "BSE"
    return "MAIN"
