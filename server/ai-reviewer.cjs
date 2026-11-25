'use strict';

/**
 * 二级投研 · GPT / Gemini 真实分钟数据驱动的防幻觉日度复盘自动执行引擎
 */

const { invokeModel, parseJsonFromModelOutput, testProviderConnection } = require('./ai-provider.cjs');
const { reconcileDailyReviewDraft } = require('./reconcile-service.cjs');

/**
 * 精炼压缩硬数据包给大模型（保留全部精确数字、分钟转折、集群与个股分时，剔除冗余 241 点数组以节省 Token）
 */
function buildCompactPacketForPrompt(packet) {
  return {
    actualTradeDate: packet.actualTradeDate,
    fetchedAt: packet.fetchedAt,
    totalIntradayBars: packet.totalIntradayBars,
    dateMismatchWarning: packet.dateMismatchWarning,
    marketSummary: {
      twoMarketAmtYi: packet.marketSummary.twoMarketAmtYi,
      prevTwoMarketAmtYi: packet.marketSummary.prevTwoMarketAmtYi,
      volDeltaYi: packet.marketSummary.volDeltaYi,
      volDeltaPct: packet.marketSummary.volDeltaPct,
      breadth: packet.marketSummary.breadth.ok
        ? {
            up: packet.marketSummary.breadth.up,
            down: packet.marketSummary.breadth.down,
            flat: packet.marketSummary.breadth.flat,
            total: packet.marketSummary.breadth.total,
            redRatePct: packet.marketSummary.breadth.redRatePct,
            shAmtYi: packet.marketSummary.breadth.shAmtYi,
            szAmtYi: packet.marketSummary.breadth.szAmtYi,
            bjAmtYi: packet.marketSummary.breadth.bjAmtYi,
          }
        : { ok: false, error: packet.marketSummary.breadth.error },
    },
    indices: packet.indices.map((idx) => ({
      name: idx.name,
      code: idx.code,
      dailyAuth: idx.dailyAuth,
      intraday: idx.intraday.available
        ? {
            barCount: idx.intraday.barCount,
            openPct: idx.intraday.openPct,
            closePct: idx.intraday.closePct,
            amplitudePct: idx.intraday.amplitudePct,
            closePosPct: idx.intraday.closePosPct,
            firstMinAmtYi: idx.intraday.firstMinAmtYi,
            dayHigh: idx.intraday.dayHigh,
            dayLow: idx.intraday.dayLow,
            amSession: idx.intraday.amSession,
            pmEarlyHigh: idx.intraday.pmEarlyHigh,
            maxUp10m: idx.intraday.maxUp10m,
            maxDown10m: idx.intraday.maxDown10m,
            aboveAvgRatioPct: idx.intraday.aboveAvgRatioPct,
            tail30mPct: idx.intraday.tail30mPct,
            tailDirection: idx.intraday.tailDirection,
          }
        : { available: false },
    })),
    limitPools: packet.limitPools.ok
      ? {
          ztCount: packet.limitPools.ztCount,
          dtCount: packet.limitPools.dtCount,
          zbCount: packet.limitPools.zbCount,
          sealRatePct: packet.limitPools.sealRatePct,
          burstRatePct: packet.limitPools.burstRatePct,
          maxBoard: packet.limitPools.maxBoard,
          lianbanCount: packet.limitPools.lianbanCount,
          boardLadder: packet.limitPools.boardLadder.map((b) => ({
            board: b.board,
            count: b.count,
            stocks: b.stocks.map((s) => `${s.name}(${s.code},${s.stat},${s.industry},${s.boardStyle},首封${s.firstSealTime},换手${s.turnoverPct}%,额${s.amountYi}亿)`),
          })),
          clustersGe3: packet.limitPools.clustersGe3,
          dtStocks: packet.limitPools.dtStocks.map((s) => `${s.name}(${s.code},${s.industry},${s.days}连跌,封单${s.sealFundYi}亿)`),
          zbSample: packet.limitPools.zbSample.map((s) => `${s.name}(${s.code},${s.industry},${s.pct}%,首封${s.firstSealTime},炸${s.openCount}次)`),
        }
      : { ok: false, error: packet.limitPools.error },
    watchStocks: packet.watchStocks.map((s) => ({
      name: s.name,
      code: s.code,
      role: s.role,
      dailyAuth: s.dailyAuth,
      intraday: s.intraday.available
        ? {
            barCount: s.intraday.barCount,
            openPct: s.intraday.openPct,
            closePct: s.intraday.closePct,
            closePosPct: s.intraday.closePosPct,
            dayHigh: s.intraday.dayHigh,
            dayLow: s.intraday.dayLow,
            aboveAvgRatioPct: s.intraday.aboveAvgRatioPct,
            tail30mPct: s.intraday.tail30mPct,
            tailDirection: s.intraday.tailDirection,
          }
        : { available: false },
    })),
    usOvernight: packet.usOvernight,
    missingDataGaps: (packet.evidenceRecord?.facts || [])
      .filter((f) => f.state === 'missing')
      .map((f) => ({ metric: f.metric, reason: f.reason })),
  };
}

/**
 * 基于当日行情数据包自动推断市场 Regime（对齐 KB v2 受控词表）
 */
function inferMarketRegimeFromPacket(packet) {
  const dtCount = Number(packet?.limitPools?.ok ? packet.limitPools.dtCount : NaN);
  const ztCount = Number(packet?.limitPools?.ok ? packet.limitPools.ztCount : NaN);
  const redRate = Number(packet?.marketSummary?.breadth?.ok ? packet.marketSummary.breadth.redRatePct : NaN);
  const twoMarketAmtYi = Number(packet?.marketSummary?.twoMarketAmtYi ?? NaN);

  if ((Number.isFinite(dtCount) && dtCount >= 15) || (Number.isFinite(redRate) && redRate < 30)) {
    return 'sentiment_ice_point';
  }
  if (Number.isFinite(ztCount) && ztCount >= 90 && Number.isFinite(redRate) && redRate >= 70) {
    return 'sentiment_climax';
  }
  if (Number.isFinite(redRate) && redRate >= 60 && Number.isFinite(twoMarketAmtYi) && twoMarketAmtYi >= 15000) {
    return 'bull_main_wave';
  }
  if (Number.isFinite(twoMarketAmtYi) && twoMarketAmtYi < 10000) {
    return 'weak_choppy';
  }
  return 'structural_rotation';
}

function extractClusterTopicsQuery(packet, extraNotes = '') {
  const parts = [];
  if (packet?.limitPools?.ok && Array.isArray(packet.limitPools.clustersGe3)) {
    for (const cl of packet.limitPools.clustersGe3.slice(0, 10)) {
      if (cl?.industry) parts.push(String(cl.industry));
      if (Array.isArray(cl?.lianbanStocks)) {
        parts.push(cl.lianbanStocks.slice(0, 3).join(' '));
      }
    }
  }
  if (Array.isArray(packet?.watchStocks)) {
    for (const s of packet.watchStocks.slice(0, 8)) {
      if (s?.name) parts.push(String(s.name));
    }
  }
  if (extraNotes && String(extraNotes).trim()) {
    parts.push(String(extraNotes).trim().slice(0, 400));
  }
  return parts.join(' ').trim();
}

function tryCompileDailyReviewV2Context(workspace, opts) {
  try {
    const { PATHS } = require('./app-paths.cjs');
    const isV2 = workspace?.kbMode ? workspace.kbMode === 'v2' : PATHS.kbMode === 'v2';
    if (!isV2) return null;
    const kbStore = require('./knowledge-store.cjs');
    if (typeof kbStore.compileAiContextForActiveWorkspace === 'function') {
      const ctx = kbStore.compileAiContextForActiveWorkspace(opts);
      if (ctx && ctx.promptText) return ctx;
    }
    const kbDir = workspace?.paths?.kbDir || PATHS.kbDir;
    if (kbDir) {
      const { compileAiContext } = require('./kb/index.cjs');
      if (typeof compileAiContext === 'function') {
        const ctx = compileAiContext(kbDir, opts);
        if (ctx && ctx.promptText) return ctx;
      }
    }
  } catch {
    // Graceful fallback to v1 prompt building
  }
  return null;
}

/**
 * 组装严格防幻觉的系统与用户提示词（同时可供前端一键复制用于网页版 GPT/Gemini）
 */
function buildDailyReviewPrompt(workspace, packet, extraNotes = '') {
  const latestDaily = workspace.ledger.dailyReviews[0];
  const highFreqContext = workspace.highFreqCards.slice(0, 14).map((hc) => {
    const full = workspace.methodology.cards.find((c) => c.id === hc.id);
    return {
      id: hc.id,
      title: hc.title,
      score: hc.credibilityScore,
      status: hc.isArchived ? '封存(除非出现新形态默认delta=0)' : hc.isHighPaused ? '高位暂停(默认delta=0)' : '活跃检验',
      applicableConditions: full?.applicableConditions?.slice(0, 140) || '',
      invalidationSignals: full?.invalidationSignals?.slice(0, 140) || '',
      latestLog: hc.latestReviewContent?.slice(0, 140) || '',
    };
  });

  const recentCognition = workspace.cognition.cards.slice(-12).map((c) => ({
    id: c.id,
    date: c.ingestedDate,
    grade: c.evidenceGrades.join('/'),
    title: c.title,
    mapping: c.aShareMapping.slice(0, 100),
  }));

  const compactPacket = buildCompactPacketForPrompt(packet);
  const inferredRegime = inferMarketRegimeFromPacket(packet);
  const clusterTopics = extractClusterTopicsQuery(packet, extraNotes);
  const v2Context = tryCompileDailyReviewV2Context(workspace, {
    mode: 'daily_review',
    regime: inferredRegime,
    query: clusterTopics,
    charBudget: 10000,
    asOfDate: packet?.actualTradeDate || undefined,
  });
  const kbContextMeta = v2Context
    ? {
        kbMode: 'v2',
        inferredRegime,
        elapsedMs: v2Context.elapsedMs ?? 0,
        methodCount: v2Context.methodCount ?? 0,
        cognitionCount: v2Context.cognitionCount ?? 0,
        conflictCount: v2Context.conflictCount ?? 0,
        refuterCount: v2Context.refuterCount ?? 0,
        topicCount: v2Context.topicCount ?? 0,
      }
    : { kbMode: 'v1', inferredRegime };

  const systemPrompt = `你是专业二级投研研究助理，严格执行《三库格式契约》与《执行规则补充》的“工作模式四：每日 A 股复盘”。

【最高红线——严禁编造事实】
1. 你的所有行情数字、涨跌幅、成交额、涨跌停数量、分时精确分钟转折点、个股价格与隔夜美股，必须 100% 来自输入 JSON 中的 REAL_INTRADAY_MARKET_PACKET 或 USER_SUPPLEMENTAL_FACTS。严禁凭记忆或臆测编造任何未提供的数字、新闻、宏观数据或龙虎榜明细。
2. 对 missingDataGaps 中明确缺失的指标（例如 DR001、央行当日逆回购规模、两融余额、龙虎榜明细），若 USER_SUPPLEMENTAL_FACTS 未补充，必须在正文明确写“未获得（已记缺口）”，绝不可填 0 或编造数值。
3. 严格遵守数据口径：指数与个股的开/高/低/收以 dailyAuth 为权威源；盘中四段结构（竞价→早盘→午盘→尾盘）、精确分钟日高/日低与最大10分钟拉升/下杀以 intraday 正式交易 241 条分钟统计为据；分时归一化基准为昨收价。
4. 严格执行框架增订③：穷举 clustersGe3 中所有 ≥3 只的涨停板块集群并逐一定性，无认知库背书的明确标注“无根/待研”。
5. 严格执行双线分治（投机高标 vs 价值成长）与高频卡防通胀纪律：对状态标注“封存”或“高位暂停”的卡片，默认 delta=0（仅记当日盘面验证注记）；只有明确满足独立出样证真(+0.1)或证伪(-0.15)时才可调整非零 delta；未拍板优化建议①—⑧仅记观察，不擅自更改规则。
6. 【合规去荐股化红线】本工具为个人客观复盘记录与公开数据整理框架，严禁输出荐股名单、买卖评级、目标价预测或具体跟单指令；仅陈述公开市场事实、逻辑假设与证伪条件及风险暴露提示。输出必须是严格合法的单个 JSON 对象（不要包含任何 JSON 之外的解释性文字），所有字符串用中文紧凑研报体书写，结论先行，禁止空话套话，所有复盘记录仅供个人研究参考，不构成任何投资建议。
7. 排版可读性要求：不要把大段事实粘成一整块无换行的文字墙！请合理使用 Markdown 分点（如 - **小标题**：...）与换行组织内容，例如「三、指数与盘面事实」按“量能与广度 / 7大指数 / 情绪三池与连板梯队 / 板块集群穷举 / 观察股日K”分点分段，「四、日内结构」按“①竞价与开盘 / ②早盘 / ③午盘 / ④尾盘 / 逐股分时”分行分段，「九、行为金融检视」按偏差类型逐条分点。不要在正文开头重复章节编号（如不要在 macroNotes 里再写“二、隔夜美股｜”）。`;

  const outputSchemaGuide = {
    date: packet.actualTradeDate,
    headline: '一句话定性标题（如：周一 · 隔夜美股暴跌下A股深V修复日/「算力脱钩爆发+汽车通用涨停潮」）',
    dataSource: '数据来源与口径简述（明确标注腾讯日K + 东财1m正式交易241条 + 东财三池 + 用户补充材料等）',
    macroNotes: '二、隔夜美股与宏观事件（含真实隔夜美股数字分析、对A股映射验证；未获得的宏观/货币指标明确写未获得）',
    marketFacts: '三、指数与盘面事实（7大指数、两市放缩量、红盘率、涨跌停/炸板/封板率、连板梯队、穷举所有≥3只板块集群及是否认知背书、重点观察股日K）',
    intradayStructure: '四、日内结构（竞价/开盘 → 早盘 → 午盘 → 尾盘四段精确分钟转折点 + 最大10分钟拉升/下杀 + 收盘位置% + 逐只观察股与龙头分时结构）',
    dualLineSplit: '五、主跌/主升段拆分：投机高标 vs 价值成长 vs 防御/上游 + 双线独立仓位框架',
    anchorChecks: [
      {
        anchor: '上期跟踪锚简述（与输入 previousDaily.nextAnchors 逐条一一对应）',
        preset: '预设原文',
        evidence: '当日真实事实证据（未获得写未获得）',
        verdict: '成立 | 部分成立 | 证伪 | 未获得，不判定',
      },
    ],
    credibilityAdjustments: [
      {
        cardId: '3位卡号（从 highFreqCards 中选取当日有明确盘面映射的卡片，建议覆盖核心高频卡）',
        delta: 0,
        reason: '当日盘面验证依据（说明为何维持/上调/下调，封存与高位暂停卡默认 delta=0）',
      },
    ],
    methodFailure: '方法论失效评估（无 / 具体说明）',
    applicationError: '应用错误评估（无新增 / 具体说明）',
    behavioralReview: '九、行为金融检视（锚定效应、近因效应、处置效应、叙事拥挤等逐条剖析）',
    score: '1-10数字字符串（如 6.8，遵守评分校准：内部结构分±外部事件封顶-1.5）',
    scoreReason: '加分项与扣分项明细（逐条对应真实数据）',
    marketState: '投机=...；趋势成长=...；防御/上游=...',
    nextAnchors: '下一交易日跟踪锚（①...；②...；③...；④...；⑤...，给出可观察触发器）',
    gaps: '缺口登记（列出 missingDataGaps 中未补齐项及影响）',
  };

  const userPrompt = `请基于以下真实分钟级数据包与三库上下文，为交易日 ${packet.actualTradeDate} 生成完整的每日 A 股复盘 JSON。

=== 1. REAL_INTRADAY_MARKET_PACKET (唯一权威行情与分钟级事实来源) ===
${JSON.stringify(compactPacket, null, 2)}

=== 2. USER_SUPPLEMENTAL_FACTS (用户额外提供的宏观/新闻/资金/两融事实，空则无) ===
${extraNotes && extraNotes.trim() ? extraNotes.trim() : '（无额外补充材料；未提供的 DR001/逆回购/两融/龙虎榜/宏观发布请如实标未获得并登记缺口）'}

=== 3. PREVIOUS_DAILY_REVIEW (上一期台账复盘与待核对跟踪锚) ===
${JSON.stringify(
  latestDaily
    ? {
        date: latestDaily.date,
        title: latestDaily.title,
        score: latestDaily.score,
        marketState: latestDaily.marketState,
        nextAnchors: latestDaily.nextAnchors,
      }
    : null,
  null,
  2
)}

=== 4. HIGH_FREQ_METHODOLOGY_CARDS (当前14张高频方法论卡真实状态) ===
${JSON.stringify(highFreqContext, null, 2)}

=== 5. RECENT_COGNITION_CARDS (最新12张产业认知卡，用于判定涨停集群是否有产业背书) ===
${JSON.stringify(recentCognition, null, 2)}
${
  v2Context
    ? `\n=== 5.5 KB_V2_REGIME_TRUTH_CONTEXT (当前推断市场态 regime=${inferredRegime} | 检索耗时 ${v2Context.elapsedMs}ms | 方法论 ${v2Context.methodCount} / 认知 ${v2Context.cognitionCount} / 冲突 ${v2Context.conflictCount} / 反证 ${v2Context.refuterCount}) ===\n${v2Context.promptText}\n【KB v2 复盘防幻觉提醒】请结合当前 regime=${inferredRegime} 路由到的方法论与关联活视图定性当日涨停集群；若命中已部分证伪或已过复核期的认知卡，必须优先采信反证卡并在缺口中标明待复核；若命中 CF:NN 冲突矩阵，须用判别变量说明当日盘面归属。\n`
    : ''
}
=== 6. REQUIRED_JSON_SCHEMA ===
请严格仅输出一个 JSON 对象，字段名与结构完全匹配如下示例：
${JSON.stringify(outputSchemaGuide, null, 2)}`;

  return { systemPrompt, userPrompt, inferredRegime, kbContextMeta };
}

/**
 * 测试 AI 引擎连通性（统一转发至 ai-provider.cjs）
 */
async function testAiConnection(providerOverride) {
  return testProviderConnection(providerOverride);
}

/**
 * 后置校验与归一化（确保 AI 输出 100% 匹配三库契约与表单字段）
 */
function sanitizeDraft(draft, workspace, packet) {
  const validCardIds = new Set(workspace.methodology.cards.filter((c) => !c.isRevoked).map((c) => c.id));
  const archivedOrPaused = new Set(
    workspace.methodology.cards.filter((c) => c.isArchived || c.isHighPaused).map((c) => c.id)
  );
  const warnings = [];

  const rawAdjusts = Array.isArray(draft.credibilityAdjustments) ? draft.credibilityAdjustments : [];
  const cleanAdjusts = [];
  for (const adj of rawAdjusts) {
    const rawDigits = String(adj?.cardId || '').replace(/[^\d]/g, '');
    const cid = rawDigits ? rawDigits.padStart(3, '0') : String(adj?.cardId || '').trim();
    if (!validCardIds.has(cid)) {
      warnings.push(`已拦截模型输出的无效/已撤销卡片编号：${adj?.cardId}`);
      continue;
    }
    let delta = Number(adj?.delta ?? 0);
    if (![-0.15, 0, 0.1].includes(delta)) {
      delta = delta > 0 ? 0.1 : delta < 0 ? -0.15 : 0;
    }
    if (delta > 0 && archivedOrPaused.has(cid)) {
      warnings.push(`卡片 ${cid} 当前为封存/高位暂停状态，模型建议 +${delta}，请人工重点复核是否确属全新独立形态。`);
    }
    cleanAdjusts.push({
      cardId: cid,
      delta,
      reason: String(adj?.reason || '').trim(),
    });
  }

  const rawAnchors = Array.isArray(draft.anchorChecks) ? draft.anchorChecks : [];
  const cleanAnchors = rawAnchors.map((a) => ({
    anchor: String(a?.anchor || '').trim(),
    preset: String(a?.preset || a?.anchor || '').trim(),
    evidence: String(a?.evidence || '待核').trim(),
    verdict: ['成立', '部分成立', '证伪', '未获得，不判定'].includes(a?.verdict) ? a.verdict : '未获得，不判定',
  }));

  const numericScore = Number(draft.score);
  const safeScore = Number.isFinite(numericScore) ? String(Math.max(1, Math.min(10, Number(numericScore.toFixed(1))))) : '5.5';

  const formObj = {
      date: packet.actualTradeDate,
      headline: String(draft.headline || `${packet.actualTradeDate} 盘面复盘草稿`).trim(),
      dataSource: String(
        draft.dataSource ||
          `腾讯日K(权威开高低收) + 东财1m正式交易241条分时 + 东财涨跌停炸板池（抓取于 ${packet.fetchedAt}）`
      ).trim(),
      evidenceCutoff: packet.fetchedAt,
      macroNotes: String(draft.macroNotes || '').trim(),
      marketFacts: String(draft.marketFacts || '').trim(),
      intradayStructure: String(draft.intradayStructure || '').trim(),
      dualLineSplit: String(draft.dualLineSplit || '').trim(),
      anchorChecks: cleanAnchors,
      credibilityAdjustments: cleanAdjusts,
      methodFailure: String(draft.methodFailure || '无').trim(),
      applicationError: String(draft.applicationError || '无新增').trim(),
      behavioralReview: String(draft.behavioralReview || '').trim(),
      score: safeScore,
      scoreReason: String(draft.scoreReason || '').trim(),
      marketState: String(draft.marketState || '').trim(),
      nextAnchors: String(draft.nextAnchors || '').trim(),
      gaps: String(draft.gaps || '').trim(),
      syncMethodology: true,
    };

  const reconcile = reconcileDailyReviewDraft(formObj, packet);
  if (reconcile.driftCount > 0) {
    warnings.push(`数值对账门禁检出 ${reconcile.driftCount} 处 AI 数字偏离实盘权威源，请在下方审核条一键修正！`);
  }

  return {
    form: formObj,
    warnings,
    reconcile,
  };
}

/**
 * 主入口：调用 Codex CLI / Gemini CLI / Gemini API / OpenAI API 基于真实分钟数据包执行自动日度复盘
 */
async function runAutoDailyReview({ workspace, packet, extraNotes = '', providerOverride }) {
  if (!packet || !packet.indices || packet.totalIntradayBars === 0) {
    throw new Error('缺少真实分钟级数据包！按投研铁律，必须先拉取当日真实日K与1分钟分时数据后才能执行 AI 自动复盘。');
  }

  const { systemPrompt, userPrompt, kbContextMeta } = buildDailyReviewPrompt(workspace, packet, extraNotes);
  const modelRes = await invokeModel({
    providerOverride,
    systemPrompt,
    userPrompt,
    expectJson: true,
    timeoutMs: 240000,
  });

  const parsed = parseJsonFromModelOutput(modelRes.rawText);
  const { form, warnings, reconcile } = sanitizeDraft(parsed, workspace, packet);

  return {
    ok: true,
    form,
    reconcile,
    auditTrail: {
      provider: modelRes.provider,
      model: modelRes.model,
      latencyMs: modelRes.latencyMs,
      tradeDate: packet.actualTradeDate,
      intradayBarsGrounded: packet.totalIntradayBars,
      fetchedAt: packet.fetchedAt,
      kbContext: kbContextMeta,
      usage: modelRes.usage,
      groundingSources: (modelRes.groundingChunks || [])
        .map((c) => c?.web)
        .filter(Boolean)
        .map((w) => ({ title: w.title, uri: w.uri })),
      warnings,
    },
  };
}

module.exports = {
  inferMarketRegimeFromPacket,
  buildDailyReviewPrompt,
  parseJsonFromModelOutput,
  sanitizeDraft,
  testAiConnection,
  runAutoDailyReview,
};
