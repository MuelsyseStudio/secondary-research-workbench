"""示例策略 3：均线乖离过滤 + 2N 海龟移动止损（深度贴合三库方法论纪律）。"""

STRATEGY_NAME = "均线乖离过滤 + 2N 海龟止损（三库纪律版）"
CARD_REFS = ["053", "054", "061", "196"]


def init(ctx):
    ctx.params.setdefault("ma_trend", 20)
    ctx.params.setdefault("ma5_bias_max", 8.0)
    ctx.params.setdefault("ma5_bias_take_profit", 15.0)
    ctx.params.setdefault("atr_mult", 2.0)


def on_bar(ctx, bar_dt):
    ma_n = int(ctx.params.get("ma_trend", 20))
    bias_max = float(ctx.params.get("ma5_bias_max", 8.0))
    bias_tp = float(ctx.params.get("ma5_bias_take_profit", 15.0))
    atr_mult = float(ctx.params.get("atr_mult", 2.0))
    per_weight = min(0.40, 0.90 / max(1, len(ctx.symbols)))

    for sym in ctx.symbols:
        hist = ctx.history(sym, ma_n + 20)
        if hist is None or len(hist) < ma_n + 5:
            continue
        closes = hist["close"].to_numpy()
        highs = hist["high"].to_numpy()
        lows = hist["low"].to_numpy()
        ma5 = ctx.ind.sma(closes, 5)
        ma20 = ctx.ind.sma(closes, ma_n)
        bias5 = ctx.ind.bias(closes, 5)
        atr14 = ctx.ind.atr(highs, lows, closes, 14)

        cur_c = float(closes[-1])
        cur_ma5 = float(ma5[-1])
        cur_ma20 = float(ma20[-1])
        prev_ma20 = float(ma20[-2])
        cur_bias5 = float(bias5[-1])
        cur_atr = float(atr14[-1]) if not ctx.ind.np.isnan(atr14[-1]) else 0.0
        pos = ctx.position(sym)

        if pos is None or pos.quantity <= 0:
            # 站稳 MA20 且均线拐头向上，同时拒绝 MA5 过度乖离追高
            if cur_c > cur_ma20 and cur_ma20 >= prev_ma20 and cur_c >= cur_ma5 and cur_bias5 <= bias_max:
                ctx.order_target_percent(sym, per_weight, reason=f"站稳MA{ma_n}且MA5乖离={cur_bias5:.1f}%可控，右侧入场")
        else:
            stop_px = pos.highest_price - atr_mult * cur_atr
            if cur_atr > 0 and cur_c <= stop_px:
                ctx.close_position(sym, reason=f"跌破 {atr_mult}N 海龟止损线 ({stop_px:.2f})")
            elif cur_bias5 >= bias_tp:
                ctx.close_position(sym, reason=f"MA5 乖离率达 +{cur_bias5:.1f}% 触发高位止盈")
            elif cur_c < cur_ma20:
                ctx.close_position(sym, reason=f"跌破 MA{ma_n} 生命线纪律离场")
