'use strict';

/**
 * 工作模式二：标的研判 AI 联网一键深度分析与结构化起草引擎
 * - 只需输入标的名称或 6 位代码（如“强一股份”或“688809”），自动联网并发采集：
 *   权威前复权日K/MA5乖离/估值 + A级近5期财报 + A级主营拆解 + A级股东户数与限售解禁 + A级最新交易所公告 + B级券商研报与盈利预测 + 实时财经新闻；
 * - 同时也兼容叠加用户上传的 PDF/DOCX/MD 研报或粘贴的调研纪要；
 * - 全量对照现行《方法论卡片库》《行业前沿认知库》与最新大盘状态，输出严格契合《三库格式契约》的标的研判 JSON；
 * - 二次校验拦截一切无效/已撤销卡片编号（150/175），严禁编造任何未出现于联网资料或用户材料中的数据。
 */

const { invokeModel, parseJsonFromModelOutput } = require('./ai-provider.cjs');
const { collectStockResearchPacket } = require('./stock-researcher.cjs');
const { buildFullTagCrossCheck, reconcileJudgmentDraft } = require('./reconcile-service.cjs');

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function tryCompileJudgmentV2Context(workspace, opts) {
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
    // Graceful fallback to v1 full-title index if KB v2 is unavailable
  }
  return null;
}

function buildJudgmentPrompt(workspace, sourceText, meta = {}, researchPacket = null) {
  const activeMethodCards = workspace.methodology.cards.filter((c) => !c.isRevoked);
  const latestDaily = workspace.ledger.dailyReviews[0];
  const recentJudgments = workspace.ledger.judgments.slice(-6).map((j) => ({
    key: j.recordKey,
    target: j.target,
    date: j.date,
    score: j.score,
    conclusion: j.conclusion.slice(0, 120),
  }));

  // 检索同一标的历史研判与回填记录（支持 A股 6 位代码、美股 Ticker 如 NVDA/TSM 及中文简称）
  const rawHint = String(meta.stockCode || meta.targetHint || '');
  const matchCode =
    researchPacket?.target?.code ||
    rawHint.match(/\b(\d{6})\b/)?.[1] ||
    rawHint.match(/\b([A-Za-z]{1,6})\.(?:US|O|N|NASDAQ|NYSE)\b/i)?.[1]?.toUpperCase() ||
    rawHint.match(/^([A-Za-z]{1,6})$/)?.[1]?.toUpperCase() ||
    '';
  const matchName = researchPacket?.target?.name || String(meta.targetHint || '').replace(/[（(][^）)]*[）)]/g, '').trim();

  // KB v2 双模：v2 下优先使用 Layer 3 真相编译器注入实体命中 + 1-Hop 冲突矩阵 CF:NN + 反证卡 + 过期预警
  const conceptText = Array.isArray(researchPacket?.concepts)
    ? researchPacket.concepts
        .slice(0, 8)
        .map((c) => (typeof c === 'string' ? c : c?.name || c?.boardName || ''))
        .filter(Boolean)
        .join(' ')
    : '';
  const v2Query = [matchName, conceptText, String(sourceText || '').slice(0, 1200)].filter(Boolean).join(' ').trim();
  const v2Context = tryCompileJudgmentV2Context(workspace, {
    mode: 'judgment',
    ticker: matchCode,
    query: v2Query,
    charBudget: 12000,
    asOfDate: researchPacket?.snapshot?.tradeDate || todayISO(),
  });

  const kbContextMeta = v2Context
    ? {
        kbMode: 'v2',
        elapsedMs: v2Context.elapsedMs ?? 0,
        methodCount: v2Context.methodCount ?? 0,
        cognitionCount: v2Context.cognitionCount ?? 0,
        conflictCount: v2Context.conflictCount ?? 0,
        refuterCount: v2Context.refuterCount ?? 0,
        topicCount: v2Context.topicCount ?? 0,
      }
    : { kbMode: 'v1' };

  const kbSectionsBlock = v2Context
    ? `=== 5. KB v2 图谱真相编译上下文（检索耗时 ${v2Context.elapsedMs}ms | 方法论 ${v2Context.methodCount} 张 / 认知 ${v2Context.cognitionCount} 张 / 冲突 ${v2Context.conflictCount} 项 / 反证 ${v2Context.refuterCount} 张） ===
${v2Context.promptText}

【KB v2 防幻觉与真相裁决纪律】
- 若上文出现「1-Hop 自动挂载反证卡」（如 C:096 压过 C:040），必须优先采信反证卡并明确指出旧卡已被部分证伪；
- 若上文出现「1-Hop 自动挂载冲突矩阵（CF:NN）」，必须在多空论断中用其判别变量做二选一裁决；
- 若卡片标注「⏰已过建议复核期」，禁止直接当成当前有效事实，须在 gaps 中标明待人工复核。

=== 6. 有效卡片编号白名单（零幻觉约束：methodIds / cognitionIds 仅允许输出以下真实存在的 3 位数字编号，优先选用第 5 节召回的高相关卡） ===
有效方法论卡号（${activeMethodCards.length}张）：${activeMethodCards.map((c) => c.id).join(',')}
有效产业认知卡号（${workspace.cognition.cards.length}张）：${workspace.cognition.cards.map((c) => c.id).join(',')}`
    : `=== 5. 现行《方法论卡片库》有效卡片索引（共 ${workspace.methodology.stats.activeCount} 张，严禁引用未列出编号） ===
${activeMethodCards.map((c) => `${c.id}(${c.credibilityScore ?? '-'}) | ${c.system} | ${c.title}`).join('\n')}

=== 6. 现行《行业前沿认知库》全部认知卡索引（共 ${workspace.cognition.stats.totalCount} 张） ===
${workspace.cognition.cards.map((c) => `${c.id}(${c.evidenceGrades.join('/')}) | ${c.ingestedDate || '-'} | ${c.title}`).join('\n')}`;
  const sameTargetHistory = workspace.ledger.judgments
    .filter(
      (j) =>
        (matchCode && j.stockCode && j.stockCode.toUpperCase() === matchCode.toUpperCase()) ||
        (matchName && matchName.length >= 2 && (j.stockName === matchName || j.target.includes(matchName)))
    )
    .map((j) => ({
      recordKey: j.recordKey,
      date: j.date,
      score: j.score,
      target: j.target,
      conclusion: j.conclusion,
      hypotheses: (j.hypotheses || []).slice(0, 4).map((h) => `${h.id}: ${h.content.slice(0, 100)}`),
    }));

  const stockSnapshot = researchPacket?.snapshot || null;
  const isUS = researchPacket?.target?.marketKind === 'US';
  const isHK = researchPacket?.target?.marketKind === 'HK';

  const crossMarketRule = isUS
    ? `7. 【美股标的与跨市场联动专项要求】
   - 当前目标为美股标的（计价货币为美元 USD，营收/市值以十亿美元 $B 计量，严禁将美元财报误写为人民币亿元！）。
   - 必须单列「中美跨市场联动与 A 股映射观察」：结合 LIVE_WEB_RESEARCH_DOSSIER 中的 GAAP 季报增速/毛利率/美元估值 + 实时美股/SOX 与 A 股指数表现，说明该美股龙头的业绩、CapEx 或股价动量如何向 A 股产业链映射传导；务必对照方法论卡片 159（海外利好高开兑现与拥挤度）与 192（中美产业映射背离与打破信号）以及《行业前沿认知库》已有卡片！`
    : `7. 【跨市场联动观察】
   - 请结合 LIVE_WEB_RESEARCH_DOSSIER 中同步附带的跨市场基准指数（纳指100 / 标普500 / 费城半导体 SOX vs A 股上证/创业板/科创50）及认知库海外线索，在产业定位或交易结构中点明美股/海外产业链映射对本标的的共振或背离影响（如卡片 159 / 192）。`;

  const systemPrompt = `你是专业二级投研首席研究助理，正在执行《项目指令》的“工作模式二：标的深度研判”（全面支持 A 股、美股及港股，并兼顾中美跨市场联动观察）。

【严苛投研铁律——事实零编造、证据分级】
1. 事实严格溯源：所有营收、净利润、增速、毛利率、主营占比、股东户数变化、限售解禁、最新公告、券商一致预期、新闻催化和实时股价/估值/MA5乖离，必须 100% 来源于下方 LIVE_WEB_RESEARCH_DOSSIER（已标注 A/B/C 级实时联网资料）、USER_MATERIAL 或现行《行业前沿认知库》已有卡片。严禁编造未出现的财务数字、客户名单或订单金额；资料未披露的关键细节必须写明“待核”。
2. 必须充分消化并引用 LIVE_WEB_RESEARCH_DOSSIER 中的硬数据：
   - 产业定位中写明公司所属行业、${isUS ? 'GAAP 核心营收/盈利规模与增速（注意美元单位 $B/$M）、全球产业链定价权及对 A 股相关环节的映射关系' : '主营收入构成及占比/毛利率、核心题材与A/H或中美产业链格局'}；
   - 多空论断中必须结合最新几期财报增速与毛利率趋势（A级）、${isUS ? '美股估值 PE/PB、CapEx 周期与竞争格局、实时财经新闻催化及跨市场情绪传导' : '最新交易所公告（如回购/减持/增发/问询函，A级）、筹码股东户数变动与限售解禁压力（A级）、券商盈利预测/PE（B级，须注明系卖方预测非事实）以及实时新闻催化'}；
   - 研究结构观察中必须结合公开股价（${isUS ? '美元 $' : isHK ? '港元 HK$' : '人民币 ¥'}）、MA5/MA20位置、MA5乖离率与近期20日高低点整理关键价量观察节点、逻辑假设证伪边界与风险暴露提示。
3. 卡片编号零幻觉：引用方法论卡片与产业认知卡时，**只能**引用下方索引中真实存在的 3 位编号（严禁引用缺号 150、已撤销 175 或不存在的编号），并结合该卡可信度与适用条件评估当下是否适用。
4. 多空对称与可证伪假设：正面论据与反面风险必须硬核对称（各 3-5 条，带具体公开数据或卡号）；关键假设清单（3-5 条）每条必须写清可执行的验证方式、明确验证时点、以及触发证伪的硬条件。
5. 【合规去荐股化红线】本软件为个人投研笔记、公开数据整理与逻辑假设核验工具，严禁输出“强烈推荐/买入/增持/卖出评级”、严禁给出“目标价预测”、严禁给出“建议抄底/跟买/满仓”等投资顾问式指令！所有结论仅陈述公开信息汇总、逻辑假设与证伪条件、风险暴露提示；评分范围 1.0–10.0 仅代表信息完整度与逻辑共振度笔记标尺（5.0 为中性），不构成任何投资建议。
6. 输出必须是严格合法的单个 JSON 对象，不含 JSON 之外的多余文字。
${crossMarketRule}`;

  const resolvedTargetLabel = researchPacket?.target?.resolved
    ? `${researchPacket.target.name}（${researchPacket.target.secuCode}）`
    : meta.targetHint || meta.stockCode || '';

  const schemaExample = {
    summary: '一句话概括本次搜集的核心公开证据、跨市场联动观察、核心逻辑矛盾与待核缺口（不含买卖评级与目标价）',
    target: resolvedTargetLabel || '标的名称（代码，如 强一股份（688809.SH）或 英伟达（NVDA.US））',
    dataCutoff: stockSnapshot?.tradeDate || todayISO(),
    score: '6.5',
    marketState: '趋势成长观察池 — 简述当前大盘环境与风险暴露特征',
    conclusion: '研究笔记摘要（先归纳公开证据、核心逻辑前提与主要证伪风险；严禁输出买卖评级、目标价或投资建议）',
    industryPosition: '产业链位置、主营构成与毛利率、核心壁垒、最新财报增速与供需格局（分点清晰，带真实公开数据）',
    bullArgs: '① 正面论据...（带A/B级财报/公告数据 + 方法论卡XXX / 认知卡XXX）\n② ...\n③ ...',
    bearArgs: '① 反面风险...（带估值/PE/筹码股东户数/限售解禁/毛利率或行业景气证伪风险）\n② ...\n③ ...',
    tradingStructure: '公开价量观察节点（结合现价/MA5/MA20/乖离率与量能事实）｜假设证伪边界（逻辑失效参考条件）｜风险暴露与仓位纪律框架（仅笔记对照，非下单建议）',
    behavioralCheck: '市场认知偏差（叙事拥挤/线性外推/锚定效应等）＋自身最易犯错误与防错纪律',
    hypotheses: [
      {
        claim: '核心假设 H1 主张（具体可量化）',
        verifyMethod: '验证方式（季报毛利率/公告/出货量/客户认证等）',
        verifyDate: '验证时点（如 2027-04 年报季 / 未来10个交易日）',
        falsifyCond: '硬证伪条件（出现什么客观事实即判假设失效）',
      },
    ],
    methodIds: '引用的真实有效方法论3位卡号（斜杠分隔，如 163/190/212）',
    cognitionIds: '引用的真实有效认知库3位卡号（斜杠分隔，如 129/130/136，无则留空）',
    gaps: ['联网资料与材料中仍未披露、需进一步核查的关键缺口 1', '缺口 2'],
  };

  // 精简联网数据包，保留全部高价值事实字段
  const compactResearch = researchPacket
    ? {
        collectedAt: researchPacket.collectedAt,
        target: researchPacket.target,
        marketQuoteAndTechnicals: researchPacket.snapshot,
        companyProfile_GradeA: researchPacket.profile,
        concepts: researchPacket.concepts,
        coreHighlights_GradeA: researchPacket.coreHighlights,
        financialTrend_GradeA: researchPacket.financials,
        businessBreakdown_GradeA: researchPacket.businessBreakdown,
        shareholdersAndLockups_GradeA: researchPacket.shareholders,
        latestAnnouncements_GradeA: (researchPacket.announcements || []).map((a) => ({
          date: a.date,
          category: a.category,
          title: a.title,
        })),
        brokerReportsAndConsensus_GradeB: (researchPacket.brokerReports || []).map((r) => ({
          date: r.date,
          org: r.org,
          title: r.title,
          rating: r.rating,
          epsThisYear: r.epsThisYear,
          peThisYear: r.peThisYear,
          epsNextYear: r.epsNextYear,
          peNextYear: r.peNextYear,
          epsNextTwoYear: r.epsNextTwoYear,
        })),
        latestFinancialNews_GradeBC: (researchPacket.news || []).map((n) => ({
          date: n.date,
          media: n.media,
          title: n.title,
          summary: n.summary,
        })),
        crossMarketBenchmarks: researchPacket.crossMarketBenchmarks || [],
        fetchErrors: researchPacket.errors,
      }
    : null;

  const fullTagCheck = buildFullTagCrossCheck(researchPacket);

  const userPrompt = `请基于以下实时联网资料包（LIVE_WEB_RESEARCH_DOSSIER）、全标签风险拖累核查、用户补充研判材料（如有）及现行三库索引，为目标标的生成完整的「工作模式二：标的研判」结构化 JSON。

=== 1. 目标标的与元信息 ===
用户指定标的：${meta.targetHint || meta.stockCode || '（请从资料与文本中识别）'}
材料来源/文件名：${meta.sourceName || '联网实时采集 + 用户输入'}
额外分析指令：${meta.hint || '无'}
下一待分配研判编号：${workspace.ledger.stats.nextJudgmentKey}

${fullTagCheck.promptBlock ? `=== 1.5 全标签与监管红线核查（防片面叙事铁律） ===\n${fullTagCheck.promptBlock}\n` : ''}
=== 2. LIVE_WEB_RESEARCH_DOSSIER（实时联网抓取的 A/B/C 级权威金融与公告资料包） ===
${compactResearch ? JSON.stringify(compactResearch, null, 2) : '（未启用联网采集或未查到对应证券资料，请严格依据下方 USER_MATERIAL 与三库索引，缺失信息标“待核”）'}

=== 3. 当前大盘背景（来自台账最新一日复盘） ===
${JSON.stringify(
  latestDaily
    ? {
        date: latestDaily.date,
        title: latestDaily.title,
        score: latestDaily.score,
        marketState: latestDaily.marketState,
      }
    : null,
  null,
  2
)}

=== 4. 同标的历史研判与近期台账参考（若同标的过去有研判，请明确交代相对过往判断的变化与继承） ===
同标的历史研判：${sameTargetHistory.length > 0 ? JSON.stringify(sameTargetHistory, null, 2) : '（台账中暂无该标的过往研判）'}
近期全库研判参考：${JSON.stringify(recentJudgments, null, 2)}

${kbSectionsBlock}

=== 7. USER_MATERIAL（用户额外上传的研报/纪要或粘贴笔记，空则仅以联网资料+三库为准） ===
${sourceText && sourceText.trim() ? sourceText.trim() : '（用户未额外粘贴文档，请充分基于第 2 节 LIVE_WEB_RESEARCH_DOSSIER 实时联网资料与第 5-6 节三库上下文完成深度研判，未覆盖细节如实记入缺口）'}

=== 8. 输出 JSON Schema（严格仅输出单个 JSON 对象） ===
${JSON.stringify(schemaExample, null, 2)}`;

  return { systemPrompt, userPrompt, kbContextMeta };
}

function normalizeIdList(raw, validSet, label, warnings) {
  if (!raw) return '';
  const rawStr = Array.isArray(raw) ? raw.join('/') : String(raw);
  const tokens = rawStr
    .split(/[,，、/\s;；|]+/)
    .map((s) => s.replace(/[^\d]/g, ''))
    .filter((s) => s.length > 0 && s.length <= 3)
    .map((s) => s.padStart(3, '0'));

  const seen = new Set();
  const valid = [];
  for (const id of tokens) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (validSet.has(id)) {
      valid.push(id);
    } else {
      warnings.push(`已拦截模型输出的不存在或已撤销${label}编号：${id}`);
    }
  }
  return valid.join('/');
}

function sanitizeJudgmentDraft(rawObj, workspace, meta = {}, researchPacket = null) {
  const warnings = [];
  const validMethodIds = new Set(workspace.methodology.cards.filter((c) => !c.isRevoked).map((c) => c.id));
  const validCogIds = new Set(workspace.cognition.cards.map((c) => c.id));

  const methodIds = normalizeIdList(rawObj.methodIds, validMethodIds, '方法论卡片', warnings);
  const cognitionIds = normalizeIdList(rawObj.cognitionIds, validCogIds, '产业认知卡', warnings);

  const rawHyps = Array.isArray(rawObj.hypotheses) ? rawObj.hypotheses : [];
  const hypotheses = rawHyps
    .filter((h) => h && String(h.claim || '').trim())
    .slice(0, 6)
    .map((h) => ({
      claim: String(h.claim || '').trim(),
      verifyMethod: String(h.verifyMethod || '待补充验证方式').trim(),
      verifyDate: String(h.verifyDate || '待定').trim(),
      falsifyCond: String(h.falsifyCond || '待补充硬证伪条件').trim(),
    }));

  if (hypotheses.length === 0) {
    warnings.push('模型未输出可证伪假设，已保留空白假设行供人工补充。');
    hypotheses.push({ claim: '', verifyMethod: '', verifyDate: '', falsifyCond: '' });
  }

  const numScore = Number(rawObj.score);
  const safeScore = Number.isFinite(numScore) ? String(Math.max(1, Math.min(10, Number(numScore.toFixed(1))))) : '6.0';

  const snap = researchPacket?.snapshot || null;
  let targetStr = String(rawObj.target || '').trim();
  if (!targetStr) {
    if (researchPacket?.target?.resolved) {
      targetStr = `${researchPacket.target.name}（${researchPacket.target.secuCode}）`;
    } else if (snap?.ok) {
      targetStr = `${snap.name}（${snap.code}）`;
    } else if (meta.targetHint) {
      targetStr = String(meta.targetHint).trim();
    } else {
      targetStr = '待补充标的名称与代码';
    }
  }

  const gaps = Array.isArray(rawObj.gaps) ? rawObj.gaps.map((g) => String(g || '').trim()).filter(Boolean) : [];
  if (gaps.length > 0) {
    warnings.push(`待人工补核缺口：${gaps.join('；')}`);
  }

  const form = {
    recordKey: workspace.ledger.stats.nextJudgmentKey,
    target: targetStr,
    date: todayISO(),
    dataCutoff: String(rawObj.dataCutoff || snap?.tradeDate || todayISO()).trim(),
    score: safeScore,
    marketState: String(rawObj.marketState || '趋势成长池（独立止损，不与短线池混管）').trim(),
    conclusion: String(rawObj.conclusion || '').trim(),
    industryPosition: String(rawObj.industryPosition || '').trim(),
    bullArgs: String(rawObj.bullArgs || '').trim(),
    bearArgs: String(rawObj.bearArgs || '').trim(),
    tradingStructure: String(rawObj.tradingStructure || '').trim(),
    behavioralCheck: String(rawObj.behavioralCheck || '').trim(),
    methodIds,
    cognitionIds,
    hypotheses,
  };

  const reconcile = reconcileJudgmentDraft(form, researchPacket);
  if (reconcile.driftCount > 0) {
    warnings.push(`数值/红线对账门禁检出 ${reconcile.driftCount} 处偏离，请核查下方对账审核条！`);
  }

  return {
    summary: String(rawObj.summary || '').trim(),
    form,
    warnings,
    gaps,
    reconcile,
  };
}

/**
 * P2-1：投委会多空对抗辩论模式（源自 TradingAgents / ai-hedge-fund）
 * 阶段 1：并发运行「多头研究员」与「空头质疑员」，强制极致立场交锋；
 * 阶段 2：「风控主理人」拿到双方论据与原始数据包，无谄媚终审定稿。
 */
async function runInvestmentCommitteeDebate({ workspace, sourceText, meta, effectivePacket, enableWebResearch, providerOverride }) {
  const started = Date.now();
  const basePrompts = buildJudgmentPrompt(workspace, sourceText, meta, effectivePacket);

  const complianceLine = '【合规去荐股化红线】仅做基于公开数据的客观多空逻辑推演与风险对照研究，严禁输出任何具体买入/卖出指令、具体目标价、仓位占比指令或收益承诺。';

  const bullSys = `你是二级投研研究小组的【多头视角研究员】。你的职责是：在严格尊重给定 A/B 级硬数据（禁止编造）的前提下，客观梳理该标的潜在的积极产业逻辑、景气边际变化、相对估值特征与催化观测点。${complianceLine} 输出 JSON：{"thesis":"核心看多观察主线","catalysts":["催化观测点1","观测点2","观测点3"],"keyNumbers":["硬数据支撑1","硬数据支撑2"],"cardRefs":["方法论或认知卡3位编号"],"upsideScenario":"乐观情景假设与关键验证指标（非目标价或收益承诺）"}`;

  const bearSys = `你是二级投研研究小组的【空头风险质疑员 / 魔鬼代言人】。你的职责是：专门梳理该标的潜在的证伪点、估值透支风险、毛利率/周期拐点、限售解禁/减持/监管关注红线、海外映射背离与拥挤交易风险，拆穿单边乐观叙事漏洞。严禁编造数据。${complianceLine} 输出 JSON：{"thesis":"核心质疑主线","killSwitches":["关键证伪风险1","风险2","风险3"],"crowdingRisks":["估值/拥挤/监管风险点1","风险点2"],"cardRefs":["方法论3位卡号"],"downsideScenario":"悲观情景假设与风险边界观察指标"}`;

  const [bullRes, bearRes] = await Promise.all([
    invokeModel({
      providerOverride,
      systemPrompt: bullSys,
      userPrompt: basePrompts.userPrompt,
      expectJson: true,
      enableWebSearch: Boolean(enableWebResearch),
      timeoutMs: 180000,
    }),
    invokeModel({
      providerOverride,
      systemPrompt: bearSys,
      userPrompt: basePrompts.userPrompt,
      expectJson: true,
      enableWebSearch: false,
      timeoutMs: 180000,
    }),
  ]);

  let bullBrief = {};
  let bearBrief = {};
  try {
    bullBrief = parseJsonFromModelOutput(bullRes.rawText);
  } catch {
    bullBrief = { thesis: bullRes.rawText.slice(0, 600), catalysts: [] };
  }
  try {
    bearBrief = parseJsonFromModelOutput(bearRes.rawText);
  } catch {
    bearBrief = { thesis: bearRes.rawText.slice(0, 600), killSwitches: [] };
  }

  const chiefUserPrompt = `${basePrompts.userPrompt}

=== 9. 投委会多空对抗辩论实录（请作为【风控终审官】公正裁决，严禁和稀泥） ===
【多头研究员核心陈述】：
${JSON.stringify(bullBrief, null, 2)}

【空头质疑员核心反驳】：
${JSON.stringify(bearBrief, null, 2)}

【终审官要求】：
1. 逐条审视多空双方最尖锐的分歧，明确裁决「当下谁的证据链更硬」；
2. 严禁迎合多头给虚高评分，若空头指出的监管红线/MA5乖离/业绩证伪成立，必须在 tradingStructure 给出硬约束与低仓位边界；
3. 按第 8 节 Schema 输出完整 JSON，并可额外附带 "chiefArbitration": "一句话裁决多空胜负与关键胜负手"。`;

  const chiefRes = await invokeModel({
    providerOverride,
    systemPrompt: `${basePrompts.systemPrompt}\n\n【附加角色：投委会风控终审官】你正在主持多空对抗终审，必须综合多头研究员与空头质疑员的交锋给出锋利、可证伪、不和稀泥的最终研判 JSON。`,
    userPrompt: chiefUserPrompt,
    expectJson: true,
    enableWebSearch: false,
    timeoutMs: 240000,
  });

  const parsed = parseJsonFromModelOutput(chiefRes.rawText);
  const sanitized = sanitizeJudgmentDraft(parsed, workspace, meta, effectivePacket);

  return {
    modelRes: chiefRes,
    sanitized,
    kbContextMeta: basePrompts.kbContextMeta || null,
    debateTranscript: {
      enabled: true,
      totalLatencyMs: Date.now() - started,
      bullBrief,
      bearBrief,
      chiefArbitration: String(parsed.chiefArbitration || sanitized.summary || '').trim(),
    },
  };
}

async function runAiJudgmentDraft({
  workspace,
  sourceText,
  meta = {},
  researchPacket = null,
  enableWebResearch = true,
  debateMode = false,
  providerOverride,
}) {
  const text = String(sourceText || '').trim();
  const queryStr = String(meta.stockCode || meta.targetHint || '').trim();

  if (text.length < 15 && !queryStr) {
    throw new Error('请输入标的名称/6位代码（支持自动联网搜集资料），或上传/粘贴至少 15 字的研判材料。');
  }

  // 若开启联网搜索且前端尚未传入现成资料包，则实时并发采集 A/B/C 级全维公开资料
  let effectivePacket = researchPacket;
  if (enableWebResearch && !effectivePacket && queryStr) {
    effectivePacket = await collectStockResearchPacket(queryStr);
  }

  let modelRes;
  let sanitized;
  let debateTranscript = null;
  let kbContextMeta = null;

  if (debateMode) {
    const ic = await runInvestmentCommitteeDebate({
      workspace,
      sourceText: text,
      meta,
      effectivePacket,
      enableWebResearch,
      providerOverride,
    });
    modelRes = ic.modelRes;
    sanitized = ic.sanitized;
    debateTranscript = ic.debateTranscript;
    kbContextMeta = ic.kbContextMeta || null;
  } else {
    const built = buildJudgmentPrompt(workspace, text, meta, effectivePacket);
    kbContextMeta = built.kbContextMeta || null;
    modelRes = await invokeModel({
      providerOverride,
      systemPrompt: built.systemPrompt,
      userPrompt: built.userPrompt,
      expectJson: true,
      enableWebSearch: Boolean(enableWebResearch),
      timeoutMs: 240000,
    });
    const parsed = parseJsonFromModelOutput(modelRes.rawText);
    sanitized = sanitizeJudgmentDraft(parsed, workspace, meta, effectivePacket);
  }

  return {
    ok: true,
    summary: sanitized.summary,
    form: sanitized.form,
    warnings: sanitized.warnings,
    gaps: sanitized.gaps,
    reconcile: sanitized.reconcile,
    debateTranscript,
    stockSnapshot: effectivePacket?.snapshot || null,
    researchPacket: effectivePacket || null,
    auditTrail: {
      provider: modelRes.provider,
      model: modelRes.model,
      latencyMs: modelRes.latencyMs,
      debateMode: Boolean(debateMode),
      kbContext: kbContextMeta,
      sourceChars: text.length,
      webGrounded: Boolean(effectivePacket?.ok),
      webCounts: effectivePacket?.counts || null,
      groundedStock: effectivePacket?.target?.resolved
        ? `${effectivePacket.target.name} (${effectivePacket.target.secuCode}) @ ${effectivePacket.snapshot?.tradeDate || todayISO()}`
        : null,
      groundingSources: (modelRes.groundingChunks || [])
        .map((c) => c?.web)
        .filter(Boolean)
        .map((w) => ({ title: w.title, uri: w.uri })),
      warnings: sanitized.warnings,
    },
  };
}

module.exports = {
  buildJudgmentPrompt,
  sanitizeJudgmentDraft,
  runAiJudgmentDraft,
};
