"""示例策略 1：双均线趋势跟踪（支持 A股 / 美股 / 港股 / 全球期货全市场通用）。"""

STRATEGY_NAME = "双均线趋势跟踪 (MA5/MA20)"
CARD_REFS = ["053", "062"]


def init(ctx):
    ctx.params.setdefault("fast", 5)
    ctx.params.setdefault("slow", 20)
    ctx.params.setdefault("weight", 0.45)


def on_bar(ctx, bar_dt):
    fast = int(ctx.params.get("fast", 5))
    slow = int(ctx.params.get("slow", 20))
    n = max(1, len(ctx.symbols))
    per_weight = min(float(ctx.params.get("weight", 0.45)), 0.90 / n)

    for sym in ctx.symbols:
        hist = ctx.history(sym, slow + 5)
        if hist is None or len(hist) < slow + 2:
            continue
        closes = hist["close"].to_numpy()
        ma_fast = ctx.ind.sma(closes, fast)
        ma_slow = ctx.ind.sma(closes, slow)
        pos = ctx.position(sym)

        if ctx.ind.crossover(ma_fast, ma_slow) and (pos is None or pos.quantity <= 0):
            ctx.order_target_percent(sym, per_weight, reason=f"MA{fast} 上穿 MA{slow} 金叉开仓")
        elif ctx.ind.crossunder(ma_fast, ma_slow) and pos is not None and pos.quantity > 0:
            ctx.close_position(sym, reason=f"MA{fast} 下穿 MA{slow} 死叉离场")
