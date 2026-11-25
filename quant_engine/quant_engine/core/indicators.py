"""Original vectorized technical indicators (pure NumPy, zero third-party license risk)."""

from __future__ import annotations

import numpy as np


def _as_float_array(values: list[float] | np.ndarray) -> np.ndarray:
    return np.asarray(values, dtype=np.float64)


def sma(values: list[float] | np.ndarray, period: int) -> np.ndarray:
    arr = _as_float_array(values)
    out = np.full(len(arr), np.nan, dtype=np.float64)
    if period <= 0 or len(arr) < period:
        return out
    csum = np.cumsum(np.insert(arr, 0, 0.0))
    out[period - 1 :] = (csum[period:] - csum[:-period]) / float(period)
    return out


def ema(values: list[float] | np.ndarray, period: int) -> np.ndarray:
    arr = _as_float_array(values)
    out = np.full(len(arr), np.nan, dtype=np.float64)
    if period <= 0 or len(arr) == 0:
        return out
    alpha = 2.0 / (period + 1.0)
    out[0] = arr[0]
    for i in range(1, len(arr)):
        out[i] = alpha * arr[i] + (1.0 - alpha) * out[i - 1]
    return out


def boll(values: list[float] | np.ndarray, period: int = 20, k: float = 2.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    arr = _as_float_array(values)
    mid = sma(arr, period)
    upper = np.full(len(arr), np.nan, dtype=np.float64)
    lower = np.full(len(arr), np.nan, dtype=np.float64)
    if period <= 1 or len(arr) < period:
        return upper, mid, lower
    for i in range(period - 1, len(arr)):
        std = float(np.std(arr[i - period + 1 : i + 1], ddof=0))
        upper[i] = mid[i] + k * std
        lower[i] = mid[i] - k * std
    return upper, mid, lower


def macd(
    values: list[float] | np.ndarray,
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    arr = _as_float_array(values)
    if len(arr) == 0:
        empty = np.array([], dtype=np.float64)
        return empty, empty, empty
    dif = ema(arr, fast) - ema(arr, slow)
    dea = ema(dif, signal)
    hist = (dif - dea) * 2.0
    return dif, dea, hist


def rsi(values: list[float] | np.ndarray, period: int = 14) -> np.ndarray:
    arr = _as_float_array(values)
    out = np.full(len(arr), np.nan, dtype=np.float64)
    if period <= 0 or len(arr) <= period:
        return out
    deltas = np.diff(arr)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    avg_gain = float(np.mean(gains[:period]))
    avg_loss = float(np.mean(losses[:period]))
    out[period] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        out[i + 1] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    return out


def kdj(
    highs: list[float] | np.ndarray,
    lows: list[float] | np.ndarray,
    closes: list[float] | np.ndarray,
    n: int = 9,
    m1: int = 3,
    m2: int = 3,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    h = _as_float_array(highs)
    l = _as_float_array(lows)
    c = _as_float_array(closes)
    length = len(c)
    k_arr = np.full(length, 50.0, dtype=np.float64)
    d_arr = np.full(length, 50.0, dtype=np.float64)
    j_arr = np.full(length, 50.0, dtype=np.float64)
    for i in range(length):
        start = max(0, i - n + 1)
        lo = float(np.min(l[start : i + 1]))
        hi = float(np.max(h[start : i + 1]))
        rsv = 50.0 if hi == lo else ((c[i] - lo) / (hi - lo)) * 100.0
        prev_k = 50.0 if i == 0 else k_arr[i - 1]
        prev_d = 50.0 if i == 0 else d_arr[i - 1]
        k_arr[i] = ((m1 - 1) * prev_k + rsv) / m1
        d_arr[i] = ((m2 - 1) * prev_d + k_arr[i]) / m2
        j_arr[i] = 3.0 * k_arr[i] - 2.0 * d_arr[i]
    return k_arr, d_arr, j_arr


def atr(
    highs: list[float] | np.ndarray,
    lows: list[float] | np.ndarray,
    closes: list[float] | np.ndarray,
    period: int = 14,
) -> np.ndarray:
    h = _as_float_array(highs)
    l = _as_float_array(lows)
    c = _as_float_array(closes)
    length = len(c)
    out = np.full(length, np.nan, dtype=np.float64)
    if length == 0:
        return out
    tr = np.zeros(length, dtype=np.float64)
    tr[0] = h[0] - l[0]
    for i in range(1, length):
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
    if length < period:
        return out
    out[period - 1] = float(np.mean(tr[:period]))
    for i in range(period, length):
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
    return out


def bias(values: list[float] | np.ndarray, period: int = 20) -> np.ndarray:
    arr = _as_float_array(values)
    ma = sma(arr, period)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = ((arr - ma) / ma) * 100.0
    return out


def fractals(highs: list[float] | np.ndarray, lows: list[float] | np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Causal 3-bar top/bottom fractal detection (confirmed at bar i using i-2, i-1, i with zero lookahead)."""
    h = _as_float_array(highs)
    l = _as_float_array(lows)
    length = len(h)
    top = np.zeros(length, dtype=bool)
    bot = np.zeros(length, dtype=bool)
    for i in range(2, length):
        if h[i - 1] > h[i - 2] and h[i - 1] > h[i]:
            top[i] = True
        if l[i - 1] < l[i - 2] and l[i - 1] < l[i]:
            bot[i] = True
    return top, bot


def crossover(series_a: np.ndarray, series_b: np.ndarray) -> bool:
    if len(series_a) < 2 or len(series_b) < 2:
        return False
    a0, a1 = float(series_a[-2]), float(series_a[-1])
    b0, b1 = float(series_b[-2]), float(series_b[-1])
    if any(np.isnan(x) for x in (a0, a1, b0, b1)):
        return False
    return a0 <= b0 and a1 > b1


def crossunder(series_a: np.ndarray, series_b: np.ndarray) -> bool:
    if len(series_a) < 2 or len(series_b) < 2:
        return False
    a0, a1 = float(series_a[-2]), float(series_a[-1])
    b0, b1 = float(series_b[-2]), float(series_b[-1])
    if any(np.isnan(x) for x in (a0, a1, b0, b1)):
        return False
    return a0 >= b0 and a1 < b1
