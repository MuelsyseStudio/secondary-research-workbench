'use strict';

/**
 * 工作模式一：AI 文献/文档/文字智能解析转化引擎
 * 支持面向《方法论卡片库》与《行业前沿认知库》的结构化提炼、语义去重、冲突识别与字段校验。
 * 严格遵循《三库格式契约》：所有结果先作为候选卡呈现，由用户审阅/一键填表并走确认门 Diff 落库。
 */

const { invokeModel, parseJsonFromModelOutput } = require('./ai-provider.cjs');

/**
 * 轻量本地语义/关键词召回（双字 n-gram + 英文/数字词元重叠打分）
 * 解决“卡片超过200张后仅喂标题易重复建卡、认知库只看近60张方法论易漏挂老卡”的痛点
 */
function tokenizeForRecall(text) {
  const s = String(text || '').toLowerCase();
  const tokens = new Set();
  for (const m of s.matchAll(/[a-z0-9]{2,}/g)) tokens.add(m[0]);
  const zhRuns = s.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const run of zhRuns) {
    for (let i = 0; i < run.length - 1; i++) {
      tokens.add(run.slice(i, i + 2));
    }
  }
  return tokens;
}

function recallTopCards(sourceText, cards, textExtractor, limit = 28) {
  const qTokens = tokenizeForRecall(String(sourceText || '').slice(0, 18000));
  if (qTokens.size === 0 || !Array.isArray(cards) || cards.length === 0) return [];
  const scored = [];
  for (const card of cards) {
    const cTokens = tokenizeForRecall(textExtractor(card));
    let overlap = 0;
    for (const tk of cTokens) {
      if (qTokens.has(tk)) overlap += 1;
    }
    if (overlap > 0) {
      const score = overlap / Math.sqrt(Math.max(10, cTokens.size));
      scored.push({ card, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.card);
}

function tryHybridSearchV2(workspace, { query, kinds, limit = 24 }) {
  try {
    const { PATHS } = require('./app-paths.cjs');
    const isV2 = workspace?.kbMode ? workspace.kbMode === 'v2' : PATHS.kbMode === 'v2';
    if (!isV2) return null;
    const kbStore = require('./knowledge-store.cjs');
    if (PATHS.kbMode === 'v2' && typeof kbStore.getKbSearch === 'function') {
      const res = kbStore.getKbSearch({
        q: query,
        query,
        kinds,
        limit,
      });
      if (res && res.ok !== false && Array.isArray(res.results)) return res;
    }
    const kbDir = workspace?.paths?.kbDir || PATHS.kbDir;
    if (kbDir) {
      const { hybridSearch } = require('./kb/index.cjs');
      if (typeof hybridSearch === 'function') {
        const res = hybridSearch(kbDir, { query, kinds, limit });
        if (res && Array.isArray(res.results)) return res;
      }
    }
  } catch {
    // Graceful fallback to v1 2-gram recallTopCards
  }
  return null;
}

function stripKbPrefixTo3Digits(rawId) {
  const digits = String(rawId || '').replace(/[^\d]/g, '');
  if (!digits) return String(rawId || '').trim();
  return digits.padStart(3, '0');
}

function buildMethodologyIngestionPrompt(workspace, sourceText, meta = {}) {
  const activeMethodCards = workspace.methodology.cards.filter((c) => !c.isRevoked);
  // 1) 全量精简标题目录（防重号/跨编目参考）
  const existingIndex = activeMethodCards
    .map((c) => `${c.id} | ${c.system} | ${c.title}`)
    .join('\n');

  // 2) KB v2 下优先走混合图谱检索（实体 + FTS5 BM25 + 投研同义词 + 1-Hop 冲突矩阵）；v1 下回退 2-gram 召回
  const v2Search = tryHybridSearchV2(workspace, {
    query: String(sourceText || '').slice(0, 3000),
    kinds: ['methodology'],
    limit: 24,
  });

  let topRelatedCount = 0;
  let topRelatedDetail = '';
  let v2ExtrasBlock = '';

  if (v2Search && v2Search.results.length > 0) {
    topRelatedCount = v2Search.results.length;
    topRelatedDetail = v2Search.results
      .map((r) => {
        const numId = stripKbPrefixTo3Digits(r.id);
        const warn = Array.isArray(r.warnings) && r.warnings.length ? ` ｜ ${r.warnings.join(' ')}` : '';
        const reasons = Array.isArray(r.reasons) && r.reasons.length ? r.reasons.join(' + ') : 'FTS5';
        return `[卡${numId}·${r.subKind || ''}] ${r.title}${warn}\n  命中依据：${reasons}\n  核心论断：${String(r.coreSummary || '').slice(0, 180)}\n  失效信号：${String(r.invalidationText || '').slice(0, 120)}`;
      })
      .join('\n');

    const extraParts = [];
    if (Array.isArray(v2Search.redirectNotes) && v2Search.redirectNotes.length > 0) {
      extraParts.push(`【真相链重定向】\n${v2Search.redirectNotes.map((n) => `- ${n}`).join('\n')}`);
    }
    if (Array.isArray(v2Search.attachedConflicts) && v2Search.attachedConflicts.length > 0) {
      extraParts.push(
        `【1-Hop 自动挂载冲突矩阵】\n${v2Search.attachedConflicts
          .map((cf) => `- ${cf.id} ${cf.title}：${String(cf.conflictPoint || '').slice(0, 120)}`)
          .join('\n')}`
      );
    }
    if (extraParts.length > 0) {
      v2ExtrasBlock = `\n${extraParts.join('\n')}`;
    }
  } else {
    const topRelated = recallTopCards(
      sourceText,
      activeMethodCards,
      (c) => `${c.system} ${c.title} ${c.coreThesis || ''} ${c.applicableConditions || ''}`,
      28
    );
    topRelatedCount = topRelated.length;
    topRelatedDetail = topRelated
      .map(
        (c) =>
          `[卡${c.id}·${c.system}] ${c.title}\n  核心论断：${String(c.coreThesis || '').slice(0, 160)}\n  失效信号：${String(c.invalidationSignals || '').slice(0, 100)}`
      )
      .join('\n');
  }

  const existingConflicts = workspace.methodology.conflicts
    .map((cf) => `冲突${cf.id}: ${cf.title}`)
    .join('\n');

  const voiceRule = meta.isVoiceInput
    ? `\n5. 语音口述清洗规则：输入文本来自研究员实时语音口述/录音转写，请自动去除口头禅与重复停顿，结合二级投研上下文纠正同音词误识别（如“算力/光模块/探针卡/连板/换手/毛利率/筹码/证伪”等），将其凝练为严谨书面研报语言；但绝不编造口述中未提及的具体数据、公告或历史案例。`
    : '';

  const systemPrompt = `你是专业二级投研研究助理，正在执行《项目指令》的“工作模式一：文献提炼与入库（方法论卡片库方向）”。

【严苛格式与质量铁律】
1. 必须先将输入材料与库内现有卡片做语义比对：
   - 真正全新、可复用的研究/交易方法 → 放入 newCards（建议 1-6 张，宁缺毋滥）；
   - 与库内某张既有卡片高度重叠但有新边界/新案例/新指标增量 → 放入 amendments（标明目标既有 cardId，不覆盖原字段）；
   - 与库内既有卡片正面矛盾 → 放入 conflicts（给出双方、冲突点及“何时用 A、何时用 B”的硬判别变量）；
   - 直接丢弃三类内容并写入 discarded：正确的废话、纯事后解释无法事前适用的内容、写不出适用条件与可证伪失效信号的论断。
2. 每张方法论新卡必须包含可证伪的 invalidationSignals（失效信号），写不出则不得作为新卡入库。
3. 严禁编造输入文本中不存在的数据、页码、个股案例或历史日期；若材料未给出历史案例，写“文献未给出具体实盘案例，待实盘验证”。
4. 输出必须是严格合法的单个 JSON 对象，不含任何 JSON 之外的多余文字。${voiceRule}`;

  const isV2Mode = Boolean(v2Search) || workspace?.kbMode === 'v2';
  const v2OptionalNewCardFields = isV2Mode
    ? {
        domains: ['可选正交领域标签数组，如 industry_research / valuation / short_term_sentiment / trend_trading / risk_position / behavioral'],
        regimes: ['可选适用市场态数组，如 all / bull_main_wave / structural_rotation / weak_choppy / sentiment_ice_point / sentiment_climax'],
        chainNodes: ['可选产业链节点数组，如 ai.optical / semi.testing（无则留空数组）'],
        tickers: ['可选涉及标的标准化代码数组，如 300308.SZ / NVDA.US（无则留空数组）'],
        validUntil: '可选失效日期 YYYY-MM-DD（长期方法论留空字符串 ""）',
        nextCheckDate: '可选下次复核日期 YYYY-MM-DD（无则留空字符串 ""）',
      }
    : {};

  const schemaExample = {
    summary: '一句话概括本份材料核心方法论增量、去重结果与核验边界提示',
    newCards: [
      {
        system: '体系名（如：产业研究 / 估值体系 / 宏观策略 / 短线体系 / 趋势体系 / 行为金融 / 衍生品）',
        topic: '主题名（凝练、一眼看清核心框架）',
        batchNote: meta.batchNote || meta.sourceName || '文献转化入库',
        coreThesis: '核心论断：一句话可操作、可证伪的判断',
        logicChain: '前提 → 中间传导 → 结论',
        applicableConditions: '适用条件：明确市场环境、产业阶段或资金结构',
        invalidationSignals: '失效信号（必填）：出现什么可观测事实即证明论断错误',
        historicalCases: '历史案例：具体日期 + 标的/市场 + 材料中的数据（无则如实注明）',
        credibility: 0.5,
        source: '来源：材料名/作者/机构 + 页码或章节 + 与库内卡片XXX/认知卡XXX互参',
        ...v2OptionalNewCardFields,
      },
    ],
    amendments: [
      {
        cardId: '现有3位卡号（如 014）',
        cardTitle: '对应现有卡片标题',
        batchNote: meta.batchNote || meta.sourceName || '文献增订',
        content: '增量内容（新边界、新反例或新观察变量，不重复原文）',
      },
    ],
    conflicts: [
      {
        title: '观点 A vs 观点 B',
        sides: '双方观点与出处（含库内既有卡号）',
        conflictPoint: '核心分歧所在',
        resolution: '折中思路与硬判别变量（何时用 A、何时用 B）',
      },
    ],
    discarded: [
      {
        item: '被丢弃的观点/章节',
        reason: '丢弃原因（重复现有卡XXX / 正确废话 / 不可证伪 / 评级复述等）',
      },
    ],
  };

  const userPrompt = `请深度分析以下投研文献/文字材料，按契约转化为方法论卡片候选、增订候选、冲突候选与丢弃清单。

=== 1. 来源元信息 ===
文件名/标题：${meta.sourceName || '用户粘贴文本'}
批次标注：${meta.batchNote || '日常文献转化批次'}
额外关注指令：${meta.hint || '无'}

=== 2. ${v2Search ? `KB v2 混合图谱召回最相关的既有方法论卡（Top-${topRelatedCount}，耗时 ${v2Search.elapsedMs}ms，核心论断重合时必须走 amendments 或 conflicts）` : `语义召回最相关的既有方法论卡正文（Top-${topRelatedCount}，核心论断重合时必须走 amendments 增订或 conflicts，严禁换说法重复建卡）`} ===
${topRelatedDetail || '（当前库内暂无高相关卡片）'}${v2ExtrasBlock}

=== 3. 现行《方法论卡片库》全量标题索引（${activeMethodCards.length}张） ===
${existingIndex}

=== 4. 现行冲突矩阵（${workspace.methodology.stats.conflictCount}项） ===
${existingConflicts}

=== 5. 待转化文献原文 ===
${sourceText}

=== 6. 输出 JSON Schema（严格仅输出单个 JSON 对象） ===
${JSON.stringify(schemaExample, null, 2)}`;

  return { systemPrompt, userPrompt };
}

function buildCognitionIngestionPrompt(workspace, sourceText, meta = {}) {
  const existingCogIndex = workspace.cognition.cards
    .map((c) => `${c.id} | ${c.ingestedDate || '-'} | ${c.evidenceGrades.join('/')} | ${c.title}`)
    .join('\n');

  const activeMethodCards = workspace.methodology.cards.filter((c) => !c.isRevoked);

  const v2Search = tryHybridSearchV2(workspace, {
    query: String(sourceText || '').slice(0, 3000),
    kinds: ['cognition', 'methodology'],
    limit: 24,
  });

  let topCogCount = 0;
  let topRelatedCogDetail = '';
  let v2ExtrasBlock = '';
  let recentMethodCount = 0;
  let recentMethodIndex = '';

  if (v2Search && v2Search.results.length > 0) {
    const cogHits = v2Search.results.filter((r) => r.kind === 'cognition');
    const methodHits = v2Search.results.filter((r) => r.kind === 'methodology');
    topCogCount = cogHits.length;
    topRelatedCogDetail = cogHits
      .map((r) => {
        const numId = stripKbPrefixTo3Digits(r.id);
        const warn = Array.isArray(r.warnings) && r.warnings.length ? ` ｜ ${r.warnings.join(' ')}` : '';
        const reasons = Array.isArray(r.reasons) && r.reasons.length ? r.reasons.join(' + ') : 'FTS5';
        return `[认知${numId}·${r.primaryGrade || '-'}·${r.updatedAt || '-'}] ${r.title}${warn}\n  命中依据：${reasons}\n  事实摘要：${String(r.coreSummary || '').slice(0, 180)}\n  失效条件：${String(r.invalidationText || '').slice(0, 120)}`;
      })
      .join('\n');

    const extraParts = [];
    if (Array.isArray(v2Search.attachedRefuters) && v2Search.attachedRefuters.length > 0) {
      extraParts.push(
        `【1-Hop 自动挂载反证卡（注意避免重复已证伪旧结论）】\n${v2Search.attachedRefuters
          .map((rf) => `- [${rf.id} · ${rf.primaryGrade || '-'}级] ${rf.title}：${String(rf.coreSummary || '').slice(0, 140)}`)
          .join('\n')}`
      );
    }
    if (Array.isArray(v2Search.attachedTopics) && v2Search.attachedTopics.length > 0) {
      extraParts.push(
        `【关联产业链活视图】\n${v2Search.attachedTopics
          .map((t) => `- ${t.id}｜${t.title}（${t.memberCount}张卡，状态:${t.status}）`)
          .join('\n')}`
      );
    }
    if (Array.isArray(v2Search.attachedConflicts) && v2Search.attachedConflicts.length > 0) {
      extraParts.push(
        `【1-Hop 冲突矩阵】\n${v2Search.attachedConflicts
          .map((cf) => `- ${cf.id} ${cf.title}：${String(cf.conflictPoint || '').slice(0, 120)}`)
          .join('\n')}`
      );
    }
    if (extraParts.length > 0) v2ExtrasBlock = `\n${extraParts.join('\n')}`;

    const methodList = methodHits.length > 0 ? methodHits : activeMethodCards.slice(-50);
    recentMethodCount = methodList.length;
    recentMethodIndex = methodList
      .map((c) => {
        const id = stripKbPrefixTo3Digits(c.id);
        return `${id} | ${c.system || c.subKind || ''} | ${c.title}`;
      })
      .join('\n');
  } else {
    const topRelatedCog = recallTopCards(
      sourceText,
      workspace.cognition.cards,
      (c) => `${c.title} ${c.facts || ''} ${c.industryImplications || ''} ${c.aShareMapping || ''}`,
      22
    );
    topCogCount = topRelatedCog.length;
    topRelatedCogDetail = topRelatedCog
      .map(
        (c) =>
          `[认知${c.id}·${c.evidenceGrades.join('/') || '-'}·${c.ingestedDate || '-'}] ${c.title}\n  事实摘要：${String(c.facts || '').slice(0, 150)}`
      )
      .join('\n');

    const topRelatedMethod = recallTopCards(
      sourceText,
      activeMethodCards,
      (c) => `${c.system} ${c.title} ${c.coreThesis || ''}`,
      36
    );
    recentMethodCount = topRelatedMethod.length || Math.min(50, activeMethodCards.length);
    recentMethodIndex = (topRelatedMethod.length > 0 ? topRelatedMethod : activeMethodCards.slice(-50))
      .map((c) => `${c.id} | ${c.system} | ${c.title}`)
      .join('\n');
  }

  const voiceRule = meta.isVoiceInput
    ? `\n6. 语音口述清洗规则：输入文本来自研究员语音口述/电话会/路演录音转写，请自动去除口头禅、纠正中文财经同音字并整理为清晰的客观事实 vs 产业含义 vs A 股映射三层结构；口述未提供官方公告出处的，证据等级从严标为 C（调研/口述纪要）并注明待进一步核验。`
    : '';

  const systemPrompt = `你是专业二级投研研究助理，正在执行《项目指令》的“工作模式一：文献提炼与入库（行业前沿认知库方向）”。

【认知库四大铁律】
1. 证据等级必填：A＝公司公告/财报/官方新闻稿；B＝权威研报模型或权威媒体；C＝产业链调研/电话会转写/传闻。严禁夸大证据等级。
2. 失效/更新条件必填：必须写明出现什么具体事实或数据时该认知失效或需更新，写不出不得入库。
3. 事实、产业含义、A 股映射必须严格分离：facts 字段只写材料中的客观事实、数字与出处页码，绝不掺杂主观映射；分析放 industryImplications；具体 A 股标的与逻辑放 aShareMapping。
4. 严格语义去重与弃废：与库内既有认知卡主题相同且只是最新节点/跨源互证的，放入 amendments（指定已有 3 位 cardId）；直接丢弃券商评级/目标价复述、合规披露页、AI二次口水稿与已被库内更新事实覆盖的过时旧预测并记入 discarded。
5. 严禁编造原文未出现的数字、页码、公司名或公告编号；输出必须是严格合法的单个 JSON 对象。${voiceRule}`;

  const isV2Mode = Boolean(v2Search) || workspace?.kbMode === 'v2';
  const v2OptionalCogFields = isV2Mode
    ? {
        domains: ['可选领域标签数组，如 industry_research / macro / policy_event / valuation'],
        regimes: ['可选市场态标签数组，如 structural_rotation / supply_inflation_shock / bull_main_wave'],
        chainNodes: ['可选产业链节点数组，如 ai.optical / ai.power / semi.packaging / semi.testing'],
        tickers: ['可选涉及标的标准化代码数组，如 300308.SZ / 688809.SH / NVDA.US'],
        validUntil: '可选时效截止日 YYYY-MM-DD（一次性事件或季度催化建议填写，长期结构规律可留空 ""）',
        nextCheckDate: '可选下次复核日期 YYYY-MM-DD（建议填写下个关键验证节点）',
      }
    : {};

  const schemaExample = {
    summary: '一句话总结本材料核心产业事实增量、证据质量与去重情况',
    newCards: [
      {
        title: '主题标题（凝练且带核心量化锚点，如：XX行业2026涨价实证与2027产能缺口）',
        categoryTag: '所属编目增补（如：第二编增补 / 第四编增补 / 第六编增补 / 第八编增补 / 第十编增补）',
        batchName: meta.batchNote || meta.sourceName || '日常产业研报批次',
        facts: '纯客观事实与核心量化数据（按①②③分点，标注原文页码或数据口径，不含主观映射）',
        source: '报告名/文章名 + 机构/作者 + 日期 + 页码或原始数据出处',
        evidenceLevel: 'A/B/C 及定级理由（如：A（公司公告/财报）；B（券商行业模型））',
        industryImplications: '产业含义（分析）：产业链供需格局、技术路线与预期差解读',
        aShareMapping: 'A 股映射（分析）：具体相关 A 股标的、产业链卡位与映射逻辑（明确区分非事实）',
        confidence: '高 / 中高 / 中 / 低-中（附理由）',
        invalidationConditions: '失效/更新条件（必填）：①...；②...；③...',
        relatedMethodIds: '关联的方法论卡号（逗号分隔，如 177, 210, 212）',
        relatedCognitionIds: '关联的既有认知卡号（3位数字逗号分隔，如 026, 044, 135）',
        ...v2OptionalCogFields,
      },
    ],
    amendments: [
      {
        cardId: '现有3位认知卡号（如 044）',
        cardTitle: '对应现有认知卡标题',
        batchNote: meta.batchNote || meta.sourceName || '跨源互证增订',
        content: '新增事实/跨源互证/边界校准内容（仅追加，不覆盖原数据）',
      },
    ],
    discarded: [
      {
        item: '被丢弃的内容',
        reason: '丢弃原因（目标价评级复述 / 合规披露 / 已被认知卡XXX覆盖等）',
      },
    ],
  };

  const userPrompt = `请深度分析以下行业研报/纪要/新闻文字，按《行业前沿认知库》四大铁律转化为认知候选卡、既有卡增订与丢弃清单。

=== 1. 来源元信息 ===
文件名/标题：${meta.sourceName || '用户粘贴文本'}
批次标注：${meta.batchNote || '日常产业研报批次'}
额外关注指令：${meta.hint || '无'}

=== 2. ${v2Search ? `KB v2 混合图谱召回最相关的既有认知卡（Top-${topCogCount}，耗时 ${v2Search.elapsedMs}ms，同主题最新进展或跨源互证优先放 amendments）` : `语义召回最相关的既有认知卡正文（Top-${topCogCount}，同主题最新进展或跨源互证请优先放 amendments 增订）`} ===
${topRelatedCogDetail || '（当前库内暂无高相关认知卡）'}${v2ExtrasBlock}

=== 3. 现行《行业前沿认知库》全部已有认知卡索引（${workspace.cognition.stats.totalCount}张，用于去重与互挂） ===
${existingCogIndex}

=== 4. ${v2Search ? `KB v2 关联召回方法论卡片（共${recentMethodCount}张，供关联方法论卡号）` : `语义召回最相关的方法论卡片（共${recentMethodCount}张，供关联方法论卡号）`} ===
${recentMethodIndex}

=== 5. 待转化文献原文 ===
${sourceText}

=== 6. 输出 JSON Schema（严格仅输出单个 JSON 对象） ===
${JSON.stringify(schemaExample, null, 2)}`;

  return { systemPrompt, userPrompt };
}

function buildIngestionPrompt(targetLibrary, workspace, sourceText, meta = {}) {
  if (targetLibrary === 'methodology') {
    return buildMethodologyIngestionPrompt(workspace, sourceText, meta);
  }
  if (targetLibrary === 'cognition') {
    return buildCognitionIngestionPrompt(workspace, sourceText, meta);
  }
  throw new Error(`不支持的目标库类型：${targetLibrary}`);
}

function sanitizeV2OptionalFields(raw) {
  const cleanList = (val) => {
    if (Array.isArray(val)) {
      return [...new Set(val.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 12);
    }
    if (typeof val === 'string' && val.trim()) {
      return [...new Set(val.split(/[,，、;；|]+/).map((x) => x.trim()).filter(Boolean))].slice(0, 12);
    }
    return [];
  };
  const cleanIsoDate = (val) => {
    const s = String(val || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  };

  const out = {};
  const domains = cleanList(raw?.domains);
  const regimes = cleanList(raw?.regimes);
  const chainNodes = cleanList(raw?.chainNodes || raw?.chain_nodes);
  const tickers = cleanList(raw?.tickers);
  const validUntil = cleanIsoDate(raw?.validUntil || raw?.valid_until);
  const nextCheckDate = cleanIsoDate(raw?.nextCheckDate || raw?.next_check_date);

  if (domains.length > 0) out.domains = domains;
  if (regimes.length > 0) out.regimes = regimes;
  if (chainNodes.length > 0) out.chainNodes = chainNodes;
  if (tickers.length > 0) out.tickers = tickers;
  if (validUntil) out.validUntil = validUntil;
  if (nextCheckDate) out.nextCheckDate = nextCheckDate;
  return out;
}

function sanitizeIngestionResult(targetLibrary, rawObj, workspace, meta = {}) {
  const warnings = [];
  const validMethodIds = new Set(workspace.methodology.cards.filter((c) => !c.isRevoked).map((c) => c.id));
  const validCogIds = new Set(workspace.cognition.cards.map((c) => c.id));

  if (targetLibrary === 'methodology') {
    const newCards = (Array.isArray(rawObj.newCards) ? rawObj.newCards : [])
      .filter((c) => c && (c.topic || c.coreThesis))
      .map((c) => {
        if (!c.invalidationSignals || !String(c.invalidationSignals).trim()) {
          warnings.push(`候选卡「${c.topic || '未命名'}」缺少失效信号，落库前请人工补全可证伪条件。`);
        }
        return {
          system: String(c.system || '待分类体系').trim(),
          topic: String(c.topic || '待补充主题').trim(),
          batchNote: String(c.batchNote || meta.batchNote || meta.sourceName || '文献转化入库').trim(),
          newSectionTitle: '',
          coreThesis: String(c.coreThesis || '').trim(),
          logicChain: String(c.logicChain || '').trim(),
          applicableConditions: String(c.applicableConditions || '').trim(),
          invalidationSignals: String(c.invalidationSignals || '').trim(),
          historicalCases: String(c.historicalCases || '待实盘验证补充').trim(),
          credibility: Number.isFinite(Number(c.credibility)) ? String(Number(c.credibility)) : '0.5',
          source: String(c.source || meta.sourceName || '用户导入文献').trim(),
          ...sanitizeV2OptionalFields(c),
        };
      });

    const amendments = (Array.isArray(rawObj.amendments) ? rawObj.amendments : [])
      .filter((a) => a && a.cardId && a.content)
      .map((a) => {
        const cid = stripKbPrefixTo3Digits(a.cardId);
        const exists = validMethodIds.has(cid);
        if (!exists) warnings.push(`增订候选指向的卡片 ${cid} 不存在或已撤销，请核对。`);
        return {
          cardId: cid,
          cardTitle: String(a.cardTitle || workspace.methodology.cards.find((x) => x.id === cid)?.title || '').trim(),
          batchNote: String(a.batchNote || meta.batchNote || '文献增订').trim(),
          content: String(a.content || '').trim(),
          valid: exists,
        };
      });

    const conflicts = (Array.isArray(rawObj.conflicts) ? rawObj.conflicts : [])
      .filter((cf) => cf && cf.title && cf.resolution)
      .map((cf) => ({
        title: String(cf.title || '').trim(),
        sides: String(cf.sides || '').trim(),
        conflictPoint: String(cf.conflictPoint || '').trim(),
        resolution: String(cf.resolution || '').trim(),
      }));

    const discarded = (Array.isArray(rawObj.discarded) ? rawObj.discarded : []).map((d) => ({
      item: String(d?.item || '').trim(),
      reason: String(d?.reason || '').trim(),
    }));

    return {
      summary: String(rawObj.summary || '').trim(),
      newCards,
      amendments,
      conflicts,
      discarded,
      warnings,
    };
  }

  // cognition
  const newCards = (Array.isArray(rawObj.newCards) ? rawObj.newCards : [])
    .filter((c) => c && (c.title || c.facts))
    .map((c) => {
      const ev = String(c.evidenceLevel || '').trim();
      if (!/[ABC]/.test(ev)) warnings.push(`认知候选卡「${c.title}」证据等级未明确含 A/B/C，请人工校核。`);
      if (!c.invalidationConditions || !String(c.invalidationConditions).trim()) {
        warnings.push(`认知候选卡「${c.title}」缺失失效/更新条件，请人工补全。`);
      }
      return {
        title: String(c.title || '待补充认知主题').trim(),
        categoryTag: String(c.categoryTag || '第六编增补').trim(),
        batchName: String(c.batchName || meta.batchNote || meta.sourceName || '日常产业研报批次').trim(),
        newBatchTitle: '',
        facts: String(c.facts || '').trim(),
        source: String(c.source || meta.sourceName || '用户导入文献').trim(),
        evidenceLevel: ev || 'B（待核验定级）',
        industryImplications: String(c.industryImplications || '').trim(),
        aShareMapping: String(c.aShareMapping || '').trim(),
        confidence: String(c.confidence || '中').trim(),
        invalidationConditions: String(c.invalidationConditions || '').trim(),
        relatedMethodIds: String(c.relatedMethodIds || '').trim(),
        relatedCognitionIds: String(c.relatedCognitionIds || '').trim(),
        ...sanitizeV2OptionalFields(c),
      };
    });

  const amendments = (Array.isArray(rawObj.amendments) ? rawObj.amendments : [])
    .filter((a) => a && a.cardId && a.content)
    .map((a) => {
      const cid = stripKbPrefixTo3Digits(a.cardId);
      const exists = validCogIds.has(cid);
      if (!exists) warnings.push(`增订候选指向的认知卡 ${cid} 不存在，请核对。`);
      return {
        cardId: cid,
        cardTitle: String(a.cardTitle || workspace.cognition.cards.find((x) => x.id === cid)?.title || '').trim(),
        batchNote: String(a.batchNote || meta.batchNote || '跨源互证增订').trim(),
        content: String(a.content || '').trim(),
        valid: exists,
      };
    });

  const discarded = (Array.isArray(rawObj.discarded) ? rawObj.discarded : []).map((d) => ({
    item: String(d?.item || '').trim(),
    reason: String(d?.reason || '').trim(),
  }));

  return {
    summary: String(rawObj.summary || '').trim(),
    newCards,
    amendments,
    conflicts: [],
    discarded,
    warnings,
  };
}

async function runAiIngestion({ targetLibrary, workspace, sourceText, meta = {}, providerOverride }) {
  if (!sourceText || sourceText.trim().length < 20) {
    throw new Error('待转化文本内容过短（至少 20 字），请上传文档或粘贴研报/纪要全文。');
  }
  const { systemPrompt, userPrompt } = buildIngestionPrompt(targetLibrary, workspace, sourceText, meta);
  const modelRes = await invokeModel({
    providerOverride,
    systemPrompt,
    userPrompt,
    expectJson: true,
    timeoutMs: 240000,
  });

  const parsed = parseJsonFromModelOutput(modelRes.rawText);
  const sanitized = sanitizeIngestionResult(targetLibrary, parsed, workspace, meta);

  return {
    ok: true,
    targetLibrary,
    result: sanitized,
    auditTrail: {
      provider: modelRes.provider,
      model: modelRes.model,
      latencyMs: modelRes.latencyMs,
      sourceChars: sourceText.length,
      usage: modelRes.usage,
    },
  };
}

module.exports = {
  recallTopCards,
  buildIngestionPrompt,
  sanitizeIngestionResult,
  runAiIngestion,
};
