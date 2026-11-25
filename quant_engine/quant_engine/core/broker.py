"""Multi-market simulated execution broker (T+0/T+1, CN limits, float/lot sizing, fees, slippage)."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from .market_profiles import MarketProfile


@dataclass
class OrderIntent:
    symbol: str
    kind: str           # 'target_percent' | 'shares'
    value: float
    reason: str = ""
    signal_dt: str = ""


@dataclass
class Position:
    symbol: str
    quantity: float = 0.0
    locked_qty: float = 0.0          # Bought today under T+1 (CN) -> cannot be sold until next trading day
    avg_cost: float = 0.0
    entry_dt: str = ""
    highest_price: float = 0.0       # For ATR / trailing stop tracking

    @property
    def sellable_qty(self) -> float:
        if self.quantity <= 0:
            return 0.0
        return max(0.0, self.quantity - self.locked_qty)


@dataclass
class TradeFill:
    symbol: str
    date: str
    side: str           # 'BUY' | 'SELL'
    price: float
    shares: float
    amount: float
    fee: float
    pnl: float | None
    pnlPct: float | None
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "date": self.date,
            "side": self.side,
            "price": round(self.price, 4),
            "shares": round(self.shares, 6) if self.shares % 1 != 0 else int(round(self.shares)),
            "amount": round(self.amount, 2),
            "fee": round(self.fee, 2),
            "pnl": round(self.pnl, 2) if self.pnl is not None else None,
            "pnlPct": round(self.pnlPct, 2) if self.pnlPct is not None else None,
            "reason": self.reason,
        }


@dataclass
class RejectRecord:
    symbol: str
    date: str
    side: str
    requestedShares: float
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "date": self.date,
            "side": self.side,
            "requestedShares": round(self.requestedShares, 6),
            "reason": self.reason,
        }


class Broker:
    """MarketProfile-driven execution engine with float quantity support."""

    def __init__(
        self,
        profile: MarketProfile,
        initial_cash: float,
        symbol_lot_sizes: dict[str, float] | None = None,
    ) -> None:
        self.profile = profile
        self.initial_cash = float(initial_cash)
        self.cash = float(initial_cash)
        self.symbol_lot_sizes = dict(symbol_lot_sizes or {})
        self.positions: dict[str, Position] = {}
        self.trades: list[TradeFill] = []
        self.rejects: list[RejectRecord] = []
        self.total_fees: float = 0.0
        self.total_turnover: float = 0.0
        self._last_unlocked_day: str = ""

    def step_size_for(self, symbol: str) -> float:
        if symbol in self.symbol_lot_sizes and self.symbol_lot_sizes[symbol] > 0:
            return float(self.symbol_lot_sizes[symbol])
        return float(self.profile.step_size)

    def on_new_day(self, dt: str) -> None:
        """Unlock T+1 shares when the trading date advances."""
        day_str = dt[:10]
        if day_str != self._last_unlocked_day:
            self._last_unlocked_day = day_str
            for pos in self.positions.values():
                pos.locked_qty = 0.0

    def update_trailing_highs(self, bars_today: dict[str, dict[str, Any]]) -> None:
        for sym, pos in self.positions.items():
            if pos.quantity > 1e-9 and sym in bars_today:
                hi = float(bars_today[sym].get("high") or bars_today[sym].get("close") or 0.0)
                if hi > pos.highest_price:
                    pos.highest_price = hi

    def total_equity(self, prices: dict[str, float]) -> float:
        mv = 0.0
        for sym, pos in self.positions.items():
            if abs(pos.quantity) <= 1e-12:
                continue
            px = prices.get(sym, pos.avg_cost)
            mv += pos.quantity * px
        return self.cash + mv

    def position_value(self, symbol: str, price: float) -> float:
        pos = self.positions.get(symbol)
        if not pos or abs(pos.quantity) <= 1e-12:
            return 0.0
        return pos.quantity * price

    def _round_qty(self, qty: float, symbol: str) -> float:
        step = self.step_size_for(symbol)
        if step <= 0:
            return max(0.0, qty)
        if self.profile.allow_fractional:
            steps = math.floor((qty + 1e-12) / step)
            return round(max(0.0, steps * step), 8)
        steps = math.floor((qty + 1e-9) / step)
        return float(max(0, steps) * step)

    def _calc_fee(self, notional: float, side: str) -> float:
        comm = max(self.profile.min_commission, notional * self.profile.commission_rate) if notional > 0 else 0.0
        stamp = notional * (self.profile.buy_stamp_duty if side == "BUY" else self.profile.sell_stamp_duty)
        return round(comm + stamp, 4)

    def _check_market_reject(self, bar: dict[str, Any], side: str, exec_price: float) -> str | None:
        if bool(bar.get("is_suspended")) or float(bar.get("volume") or 0.0) <= 0.0:
            return "标的停牌或无成交量，订单被拒"

        if self.profile.price_limit_mode == "cn_board":
            up_lim = bar.get("up_limit")
            dn_lim = bar.get("down_limit")
            o_px = float(bar.get("open") or exec_price)
            h_px = float(bar.get("high") or exec_price)
            l_px = float(bar.get("low") or exec_price)
            if side == "BUY" and up_lim is not None and float(up_lim) > 0:
                ul = float(up_lim)
                # One-line limit-up OR executing directly at limit-up ceiling
                if (l_px >= ul - 1e-4) or (exec_price >= ul - 1e-4 and o_px >= ul - 1e-4):
                    return f"A股涨停板封死 ({ul:.2f})，买单无法成交"
            if side == "SELL" and dn_lim is not None and float(dn_lim) > 0:
                dl = float(dn_lim)
                if (h_px <= dl + 1e-4) or (exec_price <= dl + 1e-4 and o_px <= dl + 1e-4):
                    return f"A股跌停板封死 ({dl:.2f})，卖单无法成交"
        return None

    def execute_order(
        self,
        intent: OrderIntent,
        dt: str,
        bar: dict[str, Any],
        prices: dict[str, float],
        match_mode: str = "next_open",
        max_buy_notional: float | None = None,
    ) -> TradeFill | None:
        sym = intent.symbol
        raw_px = float(bar["open"] if match_mode == "next_open" else bar["close"])
        if not math.isfinite(raw_px) or raw_px <= 0:
            return None

        pos = self.positions.get(sym)
        cur_qty = pos.quantity if pos else 0.0

        # Resolve delta shares
        if intent.kind == "target_percent":
            target_pct = float(intent.value)
            if target_pct < 0 and not self.profile.allow_short:
                target_pct = 0.0
            eq = self.total_equity({**prices, sym: raw_px})
            target_val = eq * target_pct
            cur_val = cur_qty * raw_px
            delta_val = target_val - cur_val
            if abs(delta_val) < 1e-6:
                return None
            side = "BUY" if delta_val > 0 else "SELL"
            slip_px = raw_px * (1.0 + self.profile.slippage_bps / 10000.0) if side == "BUY" else raw_px * (1.0 - self.profile.slippage_bps / 10000.0)
            if side == "BUY":
                if max_buy_notional is not None:
                    delta_val = min(delta_val, max(0.0, max_buy_notional))
                # Account for commission & stamp buffer
                eff_rate = 1.0 + self.profile.commission_rate + self.profile.buy_stamp_duty
                affordable_cash = max(0.0, (self.cash - self.profile.min_commission) / eff_rate)
                buy_budget = min(delta_val, affordable_cash)
                qty = self._round_qty(buy_budget / slip_px, sym)
            else:
                if target_pct == 0.0 and cur_qty > 0:
                    qty = cur_qty  # Full close (also respects odd-lot remainder on CN!)
                else:
                    qty = self._round_qty(abs(delta_val) / slip_px, sym)
        else:
            side = "BUY" if intent.value > 0 else "SELL"
            slip_px = raw_px * (1.0 + self.profile.slippage_bps / 10000.0) if side == "BUY" else raw_px * (1.0 - self.profile.slippage_bps / 10000.0)
            if side == "BUY":
                req_qty = self._round_qty(abs(intent.value), sym)
                if max_buy_notional is not None and req_qty * slip_px > max_buy_notional:
                    req_qty = self._round_qty(max(0.0, max_buy_notional) / slip_px, sym)
                qty = req_qty
            else:
                if cur_qty > 0 and abs(intent.value) >= cur_qty - 1e-9:
                    qty = cur_qty
                else:
                    qty = self._round_qty(abs(intent.value), sym)

        if qty <= 1e-12:
            if intent.kind == "shares" and abs(intent.value) > 0:
                self.rejects.append(RejectRecord(sym, dt, side, abs(intent.value), f"委托数量不足最小交易步长 ({self.step_size_for(sym)})"))
            return None

        # Market rules check (suspension / zero vol / CN limit-up & limit-down)
        rej = self._check_market_reject(bar, side, raw_px)
        if rej:
            self.rejects.append(RejectRecord(sym, dt, side, qty, rej))
            return None

        # T+1 settlement & shorting guard on SELL
        if side == "SELL":
            if cur_qty > 0:
                sellable = pos.sellable_qty if pos else 0.0
                if self.profile.settlement_days >= 1 and sellable <= 1e-9:
                    self.rejects.append(RejectRecord(sym, dt, "SELL", qty, "A股 T+1 制度限制：当日买入持仓不可当日卖出"))
                    return None
                if not self.profile.allow_short:
                    if self.profile.settlement_days >= 1 and qty > sellable + 1e-9:
                        qty = sellable
                    else:
                        qty = min(qty, cur_qty)
            elif not self.profile.allow_short:
                self.rejects.append(RejectRecord(sym, dt, "SELL", qty, "当前市场模式不允许做空"))
                return None

        notional = qty * slip_px
        fee = self._calc_fee(notional, side)

        if side == "BUY":
            if notional + fee > self.cash + 1e-6:
                eff_rate = 1.0 + self.profile.commission_rate + self.profile.buy_stamp_duty
                avail = max(0.0, (self.cash - self.profile.min_commission) / eff_rate)
                qty = self._round_qty(avail / slip_px, sym)
                if qty <= 1e-12:
                    self.rejects.append(RejectRecord(sym, dt, "BUY", 0.0, "可用资金不足最小成交单位"))
                    return None
                notional = qty * slip_px
                fee = self._calc_fee(notional, "BUY")

            self.cash -= notional + fee
            self.total_fees += fee
            self.total_turnover += notional

            pnl = None
            pnl_pct = None
            if pos is None:
                pos = Position(symbol=sym)
                self.positions[sym] = pos

            if pos.quantity < 0:
                # Covering a short position
                cover_qty = min(qty, abs(pos.quantity))
                pnl = (pos.avg_cost - slip_px) * cover_qty - fee
                pnl_pct = ((pos.avg_cost - slip_px) / pos.avg_cost) * 100.0 if pos.avg_cost > 0 else 0.0
                new_qty = pos.quantity + qty
                if abs(new_qty) <= 1e-9:
                    pos.quantity = 0.0
                    pos.avg_cost = 0.0
                elif new_qty > 0:
                    pos.quantity = new_qty
                    pos.avg_cost = slip_px
                    pos.entry_dt = dt
                    pos.highest_price = slip_px
                    if self.profile.settlement_days >= 1:
                        pos.locked_qty += new_qty
                else:
                    pos.quantity = new_qty
            else:
                new_qty = pos.quantity + qty
                pos.avg_cost = ((pos.quantity * pos.avg_cost) + notional) / new_qty if new_qty > 0 else slip_px
                if pos.quantity <= 1e-9:
                    pos.entry_dt = dt
                    pos.highest_price = slip_px
                else:
                    pos.highest_price = max(pos.highest_price, slip_px)
                pos.quantity = new_qty
                if self.profile.settlement_days >= 1:
                    pos.locked_qty += qty

            fill = TradeFill(sym, dt, "BUY", slip_px, qty, notional, fee, pnl, pnl_pct, intent.reason)
            self.trades.append(fill)
            return fill

        # SELL execution
        self.cash += notional - fee
        self.total_fees += fee
        self.total_turnover += notional

        pnl = None
        pnl_pct = None
        if pos is None:
            pos = Position(symbol=sym)
            self.positions[sym] = pos

        if pos.quantity > 0:
            close_qty = min(qty, pos.quantity)
            pnl = (slip_px - pos.avg_cost) * close_qty - fee
            pnl_pct = ((slip_px - pos.avg_cost) / pos.avg_cost) * 100.0 if pos.avg_cost > 0 else 0.0
            new_qty = pos.quantity - qty
            if abs(new_qty) <= 1e-9:
                pos.quantity = 0.0
                pos.locked_qty = 0.0
                pos.avg_cost = 0.0
                pos.highest_price = 0.0
            elif new_qty > 0:
                pos.quantity = new_qty
            else:
                # Reversed into short
                pos.quantity = new_qty
                pos.locked_qty = 0.0
                pos.avg_cost = slip_px
                pos.entry_dt = dt
        else:
            # Opening or adding short
            new_abs = abs(pos.quantity) + qty
            pos.avg_cost = ((abs(pos.quantity) * pos.avg_cost) + notional) / new_abs if new_abs > 0 else slip_px
            pos.quantity = -new_abs
            if not pos.entry_dt:
                pos.entry_dt = dt

        fill = TradeFill(sym, dt, "SELL", slip_px, qty, notional, fee, pnl, pnl_pct, intent.reason)
        self.trades.append(fill)
        return fill
