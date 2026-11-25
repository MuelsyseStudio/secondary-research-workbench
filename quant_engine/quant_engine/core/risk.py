"""Independent Risk Control Layer + Three-Library Integration (Card 174 & Emotion Cycle Cap)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .broker import Broker, OrderIntent, RejectRecord


@dataclass
class RiskConfig:
    max_position_pct: float = 0.35          # Single symbol cap (0..1)
    max_total_exposure_pct: float = 0.95    # Portfolio total exposure cap (0..1)
    max_holdings: int = 10                  # Max concurrent positions
    stop_loss_pct: float | None = None      # e.g. 0.08 -> -8% hard stop
    take_profit_pct: float | None = None    # e.g. 0.25 -> +25% take profit
    trailing_atr_mult: float | None = None  # e.g. 2.0 -> 2N Turtle trailing stop
    max_drawdown_halt_pct: float | None = None  # e.g. 0.20 -> halt new buys if portfolio DD >= 20%
    enable_card174_guard: bool = False
    enable_sentiment_cap: bool = False
    regulatory_blacklist: list[dict[str, Any]] = field(default_factory=list)
    sentiment_caps: dict[str, float] = field(default_factory=dict)  # trade_date -> max_exposure (0..1)


class RiskManager:
    """Evaluates pre-trade limits and intra-bar stop-loss / take-profit exits."""

    def __init__(self, cfg: RiskConfig) -> None:
        self.cfg = cfg
        self.peak_equity: float = 0.0

    def update_peak(self, equity: float) -> float:
        if equity > self.peak_equity:
            self.peak_equity = equity
        if self.peak_equity <= 0:
            return 0.0
        return max(0.0, (self.peak_equity - equity) / self.peak_equity)

    def _is_card174_blocked(self, symbol: str, dt: str) -> str | None:
        if not self.cfg.enable_card174_guard or not self.cfg.regulatory_blacklist:
            return None
        day = dt[:10]
        sym_code = symbol.split(".")[0]
        for item in self.cfg.regulatory_blacklist:
            code = str(item.get("code") or item.get("secid") or "").split(".")[-1]
            if not code or code != sym_code:
                continue
            start_d = str(item.get("startDate") or "")[:10]
            end_d = str(item.get("endDate") or "")[:10]
            if start_d and day < start_d:
                continue
            if end_d and day > end_d:
                continue
            return str(item.get("reason") or "卡片174交易所重点监控/严重异动红线")
        return None

    def effective_total_exposure_cap(self, dt: str) -> float:
        cap = float(self.cfg.max_total_exposure_pct)
        if self.cfg.enable_sentiment_cap and self.cfg.sentiment_caps:
            day_cap = self.cfg.sentiment_caps.get(dt[:10])
            if day_cap is not None:
                cap = min(cap, float(day_cap))
        return max(0.0, min(1.0, cap))

    def check_position_exits(
        self,
        broker: Broker,
        dt: str,
        bars_today: dict[str, dict[str, Any]],
        atr_by_symbol: dict[str, float | None],
    ) -> list[OrderIntent]:
        """Generate automatic risk exit orders (fixed stop, take profit, 2N ATR trailing stop)."""
        exits: list[OrderIntent] = []
        for sym, pos in list(broker.positions.items()):
            if pos.quantity <= 1e-9 or sym not in bars_today:
                continue
            px = float(bars_today[sym]["close"])
            if pos.avg_cost <= 0 or px <= 0:
                continue
            ret = (px - pos.avg_cost) / pos.avg_cost
            if self.cfg.stop_loss_pct and ret <= -abs(self.cfg.stop_loss_pct):
                exits.append(
                    OrderIntent(sym, "target_percent", 0.0, f"触发固定止损 ({ret * 100:.1f}%)", dt)
                )
                continue
            if self.cfg.take_profit_pct and ret >= abs(self.cfg.take_profit_pct):
                exits.append(
                    OrderIntent(sym, "target_percent", 0.0, f"触发止盈离场 (+{ret * 100:.1f}%)", dt)
                )
                continue
            if self.cfg.trailing_atr_mult and atr_by_symbol.get(sym):
                atr_val = float(atr_by_symbol[sym] or 0.0)
                stop_px = pos.highest_price - abs(self.cfg.trailing_atr_mult) * atr_val
                if atr_val > 0 and px <= stop_px:
                    exits.append(
                        OrderIntent(
                            sym,
                            "target_percent",
                            0.0,
                            f"触发 {self.cfg.trailing_atr_mult}N 海龟移动止损 (止损位 {stop_px:.2f})",
                            dt,
                        )
                    )
        return exits

    def compute_max_buy_notional(
        self,
        broker: Broker,
        intent: OrderIntent,
        dt: str,
        prices: dict[str, float],
        exec_price: float,
    ) -> tuple[float | None, str | None]:
        """Validate pre-trade risk limits for BUY intents; returns (max_buy_notional, block_reason)."""
        sym = intent.symbol
        pos = broker.positions.get(sym)
        cur_qty = pos.quantity if pos else 0.0

        # Identify whether this is a buy
        is_buy = False
        if intent.kind == "shares" and intent.value > 0:
            is_buy = True
        elif intent.kind == "target_percent":
            eq = broker.total_equity({**prices, sym: exec_price})
            if eq * intent.value > cur_qty * exec_price + 1e-6:
                is_buy = True
        if not is_buy:
            return None, None

        # 1. Card 174 Regulatory Redline
        c174 = self._is_card174_blocked(sym, dt)
        if c174:
            broker.rejects.append(RejectRecord(sym, dt, "BUY", 0.0, f"风控拦截：{c174}"))
            return 0.0, c174

        # 2. Portfolio drawdown halt
        eq = broker.total_equity({**prices, sym: exec_price})
        dd = self.update_peak(eq)
        if self.cfg.max_drawdown_halt_pct and dd >= abs(self.cfg.max_drawdown_halt_pct):
            reason = f"触发组合回撤熔断 ({dd * 100:.1f}% >= {self.cfg.max_drawdown_halt_pct * 100:.1f}%)，暂停开新仓"
            broker.rejects.append(RejectRecord(sym, dt, "BUY", 0.0, reason))
            return 0.0, reason

        # 3. Max concurrent holdings
        active_syms = [s for s, p in broker.positions.items() if p.quantity > 1e-9]
        if cur_qty <= 1e-9 and len(active_syms) >= self.cfg.max_holdings:
            reason = f"超过最大同时持股数上限 ({self.cfg.max_holdings})"
            broker.rejects.append(RejectRecord(sym, dt, "BUY", 0.0, reason))
            return 0.0, reason

        # 4. Single symbol & total exposure caps (with optional Emotion Cycle dynamic cap)
        cur_sym_val = max(0.0, cur_qty * exec_price)
        single_room = max(0.0, eq * self.cfg.max_position_pct - cur_sym_val)

        total_long_val = sum(
            max(0.0, p.quantity * prices.get(s, p.avg_cost))
            for s, p in broker.positions.items()
            if p.quantity > 1e-9
        )
        eff_total_cap = self.effective_total_exposure_cap(dt)
        total_room = max(0.0, eq * eff_total_cap - total_long_val)
        allowed = min(single_room, total_room)
        if allowed <= 1e-6:
            reason = f"已达仓位风控上限 (单票 {self.cfg.max_position_pct*100:.0f}% / 总仓 {eff_total_cap*100:.0f}%)"
            broker.rejects.append(RejectRecord(sym, dt, "BUY", 0.0, reason))
            return 0.0, reason
        return allowed, None
