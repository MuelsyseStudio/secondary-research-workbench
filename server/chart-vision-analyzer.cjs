'use strict';

/**
 * 个股全屏实时识图解盘引擎（Chart Vision & Technical Structure Analyzer）
 *
 * 特点：
 * 1. 多模态识图 + 真实量价数据双底座：同时把浏览器实时 K 线/分时截屏图像（PNG Base64）与服务端实时拉取的
 *    最近 60 根真实 OHLCV、6 流派支撑压力位、POC 筹码峰、维克多/德马克趋势线、海龟 2N、异动红线与三库关联喂给大模型；
 * 2. 诚实模型能力探测与无缝降级：对 Codex CLI / Gemini / OpenAI 视觉模型 / Qwen-VL / GLM-4V / Kimi Vision 走真·多模态识图；
 *    对纯文本模型（如 deepseek-chat / deepseek-reasoner）或拒收图片参数的自定义网关自动无缝降级为「真实量价结构深解」，并明确披露；
 * 3. 严格去荐股化合规红线：仅做客观图面形态、量价结构、支撑/压力观测位、风险与证伪条件分析，严禁输出买卖指令或承诺收益。
 */

const { loadRawConfig, PROVIDER_META } = require('./ai-config.cjs');
const { invokeModel } = require('./ai-provider.cjs');
const { fetchStockFullscreenDossier } = require('./short-term-engine.cjs');

const DISCLAIMER =
  '客观图面与量价结构技术解读（本地投研辅助），不构成任何证券买卖建议、目标价承诺或投资咨询，交易决策与风险请自行独立承担。';

function detectVisionCapability(provider, cfg) {
  if (provider === 'codex_cli') {
    return { supportsVision: true, model: cfg.codex_cli?.model || 'Codex CLI', reason: 'Codex CLI 原生支持 --image 多模态识图' };
  }
  if (provider === 'gemini') {
    const m = String(cfg.gemini?.model || 'gemini-2.5-pro');
    return { supportsVision: true, model: m, reason: `${m} 原生支持多模态识图` };
  }
  if (provider === 'gemini_cli') {
    return { supportsVision: false, model: cfg.gemini_cli?.model || 'Gemini CLI', reason: '本机 Gemini CLI 通道当前采用纯文本标准输入，已切换为真实量价结构深解' };
  }
  const apiCfg = cfg[provider] || {};
  const model = String(apiCfg.model || '').trim();
  const low = model.toLowerCase();
  if (provider === 'deepseek') {
    return {
      supportsVision: false,
      model: model || 'deepseek-chat',
      reason: `当前模型 ${model || 'deepseek-chat'} 为纯文本模型，已自动使用最近 60 根真实 K 线 + 6 流派点位执行结构深解（如需直接识图可切至 Gemini / OpenAI / Qwen-VL / Codex CLI）`,
    };
  }
  if (provider === 'openai') {
    const ok = /(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o1|o3|o4|vision|claude-3|claude-4)/i.test(low);
    return {
      supportsVision: ok,
      model,
      reason: ok ? `${model} 支持多模态识图` : `模型 ${model} 可能不支持图片输入，若接口拒绝将自动降级为量价结构深解`,
    };
  }
  if (provider === 'qwen') {
    const ok = /(vl|omni|qvq)/i.test(low);
    return {
      supportsVision: ok,
      model,
      reason: ok
        ? `${model} 原生支持多模态识图`
        : `当前通义模型 ${model} 为文本模型，已切换为真实量价结构深解（改用 qwen-vl-max / qwen2.5-vl 可开启直接识图）`,
    };
  }
  if (provider === 'zhipu') {
    const ok = /(4v|4\.5v|4\.6v|vision)/i.test(low);
    return {
      supportsVision: ok,
      model,
      reason: ok ? `${model} 支持多模态识图` : `当前智谱模型 ${model} 为文本模型，已切换为真实量价结构深解（改用 glm-4v-plus 可开启直接识图）`,
    };
  }
  if (provider === 'moonshot') {
    const ok = /(vision|k2\.5|kimi-k2\.5)/i.test(low);
    return {
      supportsVision: ok,
      model,
      reason: ok ? `${model} 支持多模态识图` : `当前 Kimi 模型 ${model} 为文本模型，已切换为真实量价结构深解`,
    };
  }
  // custom OpenAI-compatible endpoint: attempt vision first, auto-fallback on HTTP 400/422
  return {
    supportsVision: true,
    model,
    reason: `自定义兼容模型 ${model || 'custom'} 尝试多模态识图（不支持时自动降级为量价结构深解）`,
  };
}

function buildCompactBarsTable(klines = [], maxBars = 36) {
  const slice = (klines || []).slice(-maxBars);
  if (!slice.length) return '(无K线序列)';
  const header = '日期 | 开 | 高 | 低 | 收 | 涨跌% | 成交量 | 换手%';
  const rows = slice.map((k) => {
    const pct = k.pct != null ? `${k.pct > 0 ? '+' : ''}${Number(k.pct).toFixed(2)}%` : '-';
    const turn = k.turnoverPct != null ? `${Number(k.turnoverPct).toFixed(2)}%` : '-';
    return `${k.date} | ${k.open} | ${k.high} | ${k.low} | ${k.close} | ${pct} | ${k.vol ?? '-'} | ${turn}`;
  });
  return [header, ...rows].join('\n');
}

function buildVisionSystemPrompt(hasImage) {
  return [
    '你是一位严谨的二级市场技术结构与量价研究分析师，服务于《二级投研 · 三库研究工作台》的「全屏实时识图解盘」面板。',
    hasImage
      ? '你同时收到了【当前实时 K 线/分时画布截图】与【同源实时量化指标及最近 K 线明细】。请先结合截图直观读取当前图面形态（实体强弱、上下影线、均线/布林/筹码峰视觉分布、趋势线突破/回踩位置、副图 MACD/RSI/成交量柱视觉背离、自定义画线或策略 B/S 标记），再与下方精确量化数据交叉核对。'
      : '你收到了当前标的的【真实实时量化指标与最近 60 根 K 线明细】。请基于精确量价序列与 6 流派支撑压力数据进行客观技术结构拆解。',
    '',
    '【不可突破的铁律与合规红线】',
    '1. 事实零编造：所有提及的价格、均线、支撑/压力位、RSI/MACD、筹码峰、涨跌幅必须严格与提供的数据/截图一致，缺失字段写“未提供”，绝不凭空编造数字或事件。',
    '2. 严禁荐股与喊单：绝对禁止输出“建议买入/卖出/满仓/抄底/清仓/必涨/目标价看到XX”等投资建议或收益承诺；改用客观研究语言（如“结构偏强/承压”“若放量站稳 R1 可观察延续性”“若有效跌破 S1/2N 止损位则多头结构破坏”）。',
    '3. 输出要简洁高密度、直击重点（适合交易员在全屏看盘侧栏 30 秒扫读），严格使用中文 Markdown，包含以下 4 个清晰小节（若用户追问特定问题，可紧扣追问展开）：',
    '   - **一、图面形态与趋势结构**（当前周期定位、K 线形态、均线/通道结构）',
    '   - **二、量价动能与指标核查**（放量/缩量特征、RSI/MACD/乖离率、有无顶底背离或高危过热）',
    '   - **三、关键观察位（支撑 / 压力 / 防守边界）**（引用精确 R1–R2、S1–S2、POC 筹码峰、2N 止损位与盈亏比）',
    '   - **四、风险信号与证伪条件**（异动监管进度、失效边界与三库已有研判/认知卡的呼应）',
  ].join('\n');
}

function buildVisionUserPrompt({ dossier, timeframe, chartTab, userQuestion, history, strategySignals, hasImage }) {
  const target = dossier?.target || {};
  const tech = dossier?.technical || {};
  const ind = tech.indicators || {};
  const levels = tech.levels || {};
  const anomaly = dossier?.anomaly || null;
  const links = dossier?.threeLibraryLinks || {};

  const summaryBlock = {
    标的: `${target.name || ''} (${target.secuCode || target.code || target.secid || ''})`,
    市场: target.marketKind || 'CN',
    当前视图: chartTab === 'intraday' ? '全屏分时图' : `全屏 K 线 (${timeframe})`,
    最新价: ind.price ?? null,
    涨跌幅Pct: ind.pct ?? null,
    趋势状态: ind.trendRegime || null,
    均线: { ma5: ind.ma5, ma10: ind.ma10, ma20: ind.ma20, ma60: ind.ma60, ma5BiasPct: ind.ma5BiasPct },
    动能指标: { rsi6: ind.rsi6, rsi14: ind.rsi14, macdDif: ind.macdDif, macdDea: ind.macdDea, macdHist: ind.macdHist, atrPct: ind.atrPct, volRatio5d: ind.volRatio5d },
    区间涨跌: { ret5dPct: ind.ret5dPct, ret20dPct: ind.ret20dPct },
    压力位: (levels.resistances || []).slice(0, 3).map((r) => ({ code: r.code, price: r.price, distPct: r.distPct, label: r.primaryLabel })),
    支撑位: (levels.supports || []).slice(0, 3).map((s) => ({ code: s.code, price: s.price, distPct: s.distPct, label: s.primaryLabel })),
    POC筹码峰: levels.volumeProfile?.poc ?? null,
    海龟2N防守位: levels.turtleStop2N ?? null,
    R1_S1盈亏比: levels.rewardRiskRatio ?? null,
    已触发技术预警: (tech.triggeredAlerts || []).slice(0, 5).map((a) => `${a.ruleName}: ${a.actionAdvice || a.message || ''}`),
    严重异动进度: anomaly
      ? {
          status: anomaly.statusText,
          dev10dPct: anomaly.dev10dPct,
          gapTo100Pct: anomaly.gapTo100Pct,
          dev30dPct: anomaly.dev30dPct,
        }
      : null,
    当前叠加量化策略信号: Array.isArray(strategySignals) && strategySignals.length
      ? strategySignals.slice(-6).map((s) => `${s.date} ${s.side} @${s.price} (${s.reason || s.strategyName || ''})`)
      : null,
    三库关联研判: (links.judgments || []).slice(0, 3).map((j) => `${j.date} ${j.title} [${j.direction}/${j.status}] 失效:${j.invalidation || '-'}`),
    三库关联认知卡: (links.cognitionCards || []).slice(0, 3).map((c) => `[${c.id}] ${c.title}`),
  };

  const parts = [
    `【实时图面与量化基准事实（${hasImage ? '已附当前画布截图' : '纯量化数据模式'}）】`,
    JSON.stringify(summaryBlock, null, 2),
    '',
    '【最近 36 根真实 K 线明细】',
    buildCompactBarsTable(tech.klines || [], 36),
  ];

  if (Array.isArray(history) && history.length > 0) {
    parts.push('', '【本轮对话前序记录】');
    for (const msg of history.slice(-6)) {
      const role = msg.role === 'user' ? '用户' : 'AI解盘';
      parts.push(`${role}：${String(msg.content || '').slice(0, 600)}`);
    }
  }

  parts.push(
    '',
    `【用户本次问题】`,
    String(userQuestion || '').trim() || '请结合当前截屏画面与量价结构，全面解读当前走势形态、量价动能、关键支撑压力观测位及主要风险信号。'
  );
  return parts.join('\n');
}

async function runChartVisionAnalysis(payload = {}) {
  const secidOrQuery = String(payload.secid || payload.query || '').trim();
  if (!secidOrQuery) {
    throw new Error('缺少目标标的 secid 或代码');
  }
  const timeframe = String(payload.timeframe || 'day').trim() || 'day';
  const chartTab = payload.chartTab === 'intraday' ? 'intraday' : 'kline';
  const providerOverride = payload.provider ? String(payload.provider).trim() : undefined;
  const rawImageB64 = typeof payload.imageBase64 === 'string' ? payload.imageBase64.trim() : '';
  const imageMimeType = String(payload.imageMimeType || 'image/png').trim() || 'image/png';

  // 安全大小上限（单张截屏不超过 6MB base64）
  if (rawImageB64.length > 8 * 1024 * 1024) {
    throw new Error('图表截屏数据过大，请缩小窗口或重试截屏');
  }

  const dossier = await fetchStockFullscreenDossier(secidOrQuery, timeframe);
  const cfg = loadRawConfig();
  const activeProvider = providerOverride || cfg.provider;
  const cap = detectVisionCapability(activeProvider, cfg);
  const hasPayloadImage = rawImageB64.length > 100;

  let useImage = hasPayloadImage && cap.supportsVision;
  let visionMode = useImage ? 'multimodal' : 'quant_grounded_text';
  let visionNotice = useImage
    ? `多模态识图已启用（${PROVIDER_META[activeProvider]?.label || activeProvider} · ${cap.model}）：结合实时画布截屏 + 真实量价数据双核解盘`
    : hasPayloadImage
    ? cap.reason
    : '未附带画布截图，已基于真实 K 线序列与 6 流派点位执行结构深解';

  const execute = async (attachImg) => {
    const systemPrompt = buildVisionSystemPrompt(attachImg);
    const userPrompt = buildVisionUserPrompt({
      dossier,
      timeframe,
      chartTab,
      userQuestion: payload.userQuestion,
      history: payload.history,
      strategySignals: payload.strategySignals,
      hasImage: attachImg,
    });
    return invokeModel({
      providerOverride: activeProvider,
      systemPrompt,
      userPrompt,
      expectJson: false,
      timeoutMs: 120000,
      imageInput: attachImg ? { base64: rawImageB64, mimeType: imageMimeType } : null,
    });
  };

  let res;
  try {
    res = await execute(useImage);
  } catch (err) {
    const msg = String(err?.message || '');
    // 若自定义网关或特定模型不支持 image_url / 多模态输入，自动无缝降级为真实量价结构深解并诚实告知
    if (useImage && /(HTTP 400|HTTP 422|image|vision|multimodal|unsupported|content.*string)/i.test(msg)) {
      useImage = false;
      visionMode = 'quant_grounded_text';
      visionNotice = `当前模型 (${cap.model}) 接口暂不接收图片输入，已自动切换为「60 根真实 K 线 + 6 流派点位结构深解」`;
      res = await execute(false);
    } else {
      throw err;
    }
  }

  const ind = dossier?.technical?.indicators || {};
  return {
    ok: true,
    analyzedAt: new Date().toISOString(),
    target: dossier?.target || null,
    timeframe,
    chartTab,
    provider: res.provider,
    providerLabel: PROVIDER_META[res.provider]?.label || res.provider,
    model: res.model,
    visionMode,
    visionNotice,
    answerMarkdown: String(res.rawText || '').trim(),
    latencyMs: res.latencyMs,
    keyTelemetry: {
      price: ind.price ?? null,
      pct: ind.pct ?? null,
      trendRegime: ind.trendRegime || null,
      r1: dossier?.technical?.levels?.resistances?.[0]?.price ?? null,
      s1: dossier?.technical?.levels?.supports?.[0]?.price ?? null,
      poc: dossier?.technical?.levels?.volumeProfile?.poc ?? null,
      stop2N: dossier?.technical?.levels?.turtleStop2N ?? null,
    },
    disclaimer: DISCLAIMER,
  };
}

module.exports = {
  detectVisionCapability,
  runChartVisionAnalysis,
};
