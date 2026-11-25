"""示例策略 2：RSI 超跌反弹 + 移动止损。"""

STRATEGY_NAME = "RSI 超跌反弹 + 移动止损"
CARD_REFS = ["054", "055"]


def init(ctx):
    ctx.params.setdefault("rsi_period", 14)
    ctx.params.setdefault("oversold", 30.0)
    ctx.params.setdefault("overbought", 72.0)
    ctx.params.setdefault("trend_ma", 60)


def on_bar(ctx, bar_dt):
    p = int(ctx.params.get("rsi_period", 14))
    oversold = float(ctx.params.get("oversold", 30.0))
    overbought = float(ctx.params.get("overbought", 72.0))
    trend_ma = int(ctx.params.get("trend_ma", 60))
    per_weight = min(0.45, 0.90 / max(1, len(ctx.symbols)))

    for sym in ctx.symbols:
        hist = ctx.history(sym, max(trend_ma, p) + 10)
        if hist is None or len(hist) < max(trend_ma, p) + 2:
            continue
        closes = hist["close"].to_numpy()
        rsi_arr = ctx.ind.rsi(closes, p)
        cur_rsi = float(rsi_arr[-1])
        pos = ctx.position(sym)

        if pos is None or pos.quantity <= 0:
            if cur_rsi <= oversold:
                ctx.order_target_percent(sym, per_weight, reason=f"RSI({p})={cur_rsi:.1f} <= {oversold} 超跌吸筹")
        else:
            if cur_rsi >= overbought:
                ctx.close_position(sym, reason=f"RSI({p})={cur_rsi:.1f} >= {overbought} 获利了结")
