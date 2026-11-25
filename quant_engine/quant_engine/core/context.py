"""Zero-lookahead strategy execution context."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pandas as pd

from . import indicators as ind
from .broker import Broker, OrderIntent, Position


@dataclass
class BarSnapshot:
    dt: str
    open: float
    high: float
    low: float
    close: float
    pre_close: float | None
    volume: float
    amount: float
    is_suspended: bool = False
    up_limit: float | None = None
    down_limit: float | None = None


class BacktestContext:
    """Strictly time-truncated strategy context preventing any future bar access."""

    def __init__(
        self,
        broker: Broker,
        symbols: list[str],
        bars_by_symbol: dict[str, pd.DataFrame],
        params: dict[str, Any] | None = None,
        log_cb: Any = None,
    ) -> None:
        self._broker = broker
        self.symbols = list(symbols)
        self._bars_by_symbol = bars_by_symbol
        self._dt_col_by_symbol: dict[str, list[str]] = {}
        self._idx_by_symbol_dt: dict[str, dict[str, int]] = {}
        for sym, df in bars_by_symbol.items():
            dts = df["dt"].astype(str).tolist()
            self._dt_col_by_symbol[sym] = dts
            self._idx_by_symbol_dt[sym] = {d: i for i, d in enumerate(dts)}

        self.params: dict[str, Any] = dict(params or {})
        self.state: dict[str, Any] = {}
        self.ind = ind
        self._current_dt: str = ""
        self._current_prices: dict[str, float] = {}
        self._queued_orders: list[OrderIntent] = []
        self._log_cb = log_cb

    def _advance_clock(self, dt: str, latest_prices: dict[str, float]) -> None:
        self._current_dt = dt
        self._current_prices.update(latest_prices)
        self._queued_orders = []

    def _pop_orders(self) -> list[OrderIntent]:
        orders = list(self._queued_orders)
        self._queued_orders = []
        return orders

    @property
    def current_dt(self) -> str:
        return self._current_dt

    @property
    def cash(self) -> float:
        return self._broker.cash

    @property
    def equity(self) -> float:
        return self._broker.total_equity(self._current_prices)

    @property
    def positions(self) -> dict[str, Position]:
        return {k: v for k, v in self._broker.positions.items() if abs(v.quantity) > 1e-9}

    def position(self, symbol: str) -> Position | None:
        pos = self._broker.positions.get(symbol)
        if pos and abs(pos.quantity) > 1e-9:
            return pos
        return None

    def current_price(self, symbol: str) -> float | None:
        return self._current_prices.get(symbol)

    def history(
        self,
        symbol: str,
        count: int = 60,
        freq: str = "1d",
        fields: list[str] | None = None,
    ) -> pd.DataFrame:
        """Return strictly historical bars with dt <= current_dt (ZERO future leakage)."""
        del freq  # reserved for multi-freq extension
        df = self._bars_by_symbol.get(symbol)
        if df is None or df.empty or not self._current_dt:
            return pd.DataFrame()

        idx_map = self._idx_by_symbol_dt.get(symbol, {})
        end_idx = idx_map.get(self._current_dt)
        if end_idx is None:
            # Binary search last bar strictly <= current_dt
            dts = self._dt_col_by_symbol.get(symbol, [])
            lo, hi, pos = 0, len(dts) - 1, -1
            while lo <= hi:
                mid = (lo + hi) // 2
                if dts[mid] <= self._current_dt:
                    pos = mid
                    lo = mid + 1
                else:
                    hi = mid - 1
            end_idx = pos
        if end_idx < 0:
            return pd.DataFrame()

        start_idx = max(0, end_idx - max(1, int(count)) + 1)
        sliced = df.iloc[start_idx : end_idx + 1]
        if fields:
            valid = [f for f in fields if f in sliced.columns]
            if valid:
                return sliced[valid].copy().reset_index(drop=True)
        return sliced.copy().reset_index(drop=True)

    def order_target_percent(self, symbol: str, target_pct: float, reason: str = "") -> None:
        """Queue a target portfolio weight order (0.0 closes long; negative shorts if allowed)."""
        self._queued_orders.append(
            OrderIntent(
                symbol=symbol,
                kind="target_percent",
                value=float(target_pct),
                reason=reason or f"目标仓位 {round(float(target_pct) * 100, 1)}%",
                signal_dt=self._current_dt,
            )
        )

    def order_shares(self, symbol: str, shares: float, reason: str = "") -> None:
        """Queue a delta quantity order (+ buy, - sell)."""
        if abs(float(shares)) <= 1e-12:
            return
        self._queued_orders.append(
            OrderIntent(
                symbol=symbol,
                kind="shares",
                value=float(shares),
                reason=reason or ("买入" if shares > 0 else "卖出"),
                signal_dt=self._current_dt,
            )
        )

    def close_position(self, symbol: str, reason: str = "平仓") -> None:
        self.order_target_percent(symbol, 0.0, reason=reason)

    def log(self, msg: str, level: str = "info") -> None:
        if self._log_cb:
            self._log_cb(level, f"[{self._current_dt}] {msg}")
