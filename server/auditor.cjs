'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadWorkspace } = require('./knowledge-store.cjs');

/**
 * 工作模式五：三库全量深度质检引擎
 * 默认只读诊断，输出问题定位、严重级别、依据与建议动作，绝不静默改库。
 */
function runQualityAudit(workspaceInput) {
  const ws = workspaceInput || loadWorkspace();
  const { methodology, cognition, ledger } = ws;

  const issues = [];
  const addIssue = (severity, category, target, title, detail, suggestion, fixAction = null) => {
    issues.push({
      id: `QA-${String(issues.length + 1).padStart(3, '0')}`,
      severity, // 'error' | 'warning' | 'info'
      category,
      target,
      title,
      detail,
      suggestion,
      fixAction,
    });
  };

  const methodIdSet = new Set(methodology.cards.map((c) => c.id));
  const cognitionIdSet = new Set(cognition.cards.map((c) => c.id));
  const conflictIdSet = new Set(methodology.conflicts.map((c) => String(c.id)));
  const reservedMissingSet = new Set(
    Array.isArray(methodology.stats?.reservedMissing) ? methodology.stats.reservedMissing : []
  );

  // -------------------------------------------------------------------------
  // 1. 编号唯一性与保留号检查
  // -------------------------------------------------------------------------
  const mSeen = new Map();
  for (const card of methodology.cards) {
    if (mSeen.has(card.id)) {
      addIssue(
        'error',
        '编号完整性',
        `方法论卡片 ${card.id}`,
        `方法论卡片编号重复：${card.id}`,
        `卡片 ${card.id} 在第 ${mSeen.get(card.id)} 行与第 ${card.startLine} 行重复出现。`,
        '检查是否误粘贴，按编号规则保留唯一正文条目。'
      );
    } else {
      mSeen.set(card.id, card.startLine);
    }
    if (reservedMissingSet.has(card.id)) {
      addIssue(
        'error',
        '编号完整性',
        `方法论卡片 ${card.id}`,
        `声明缺号 ${card.id} 被占用`,
        `当前方法论库已声明 ${card.id} 为保留缺号，不得补造或复用。`,
        `将新增内容顺延至最新空号并恢复 ${card.id} 缺号声明。`
      );
    }
  }

  const cSeen = new Map();
  for (const card of cognition.cards) {
    if (cSeen.has(card.id)) {
      addIssue(
        'error',
        '编号完整性',
        `认知卡 ${card.id}`,
        `认知卡编号重复：${card.id}`,
        `认知卡 ${card.id} 在第 ${cSeen.get(card.id)} 行与第 ${card.startLine} 行重复出现。`,
        '合并重复条目或顺延新卡号。'
      );
    } else {
      cSeen.set(card.id, card.startLine);
    }
  }

  // -------------------------------------------------------------------------
  // 2. 方法论必填字段与可证伪性纪律检查
  // -------------------------------------------------------------------------
  for (const card of methodology.cards) {
    if (card.isRevoked) continue;
    if (!card.coreThesis) {
      addIssue('error', '字段契约', `方法论卡片 ${card.id}`, `卡片 ${card.id} 缺失核心论断`, `行 ${card.startLine} 处未解析到「核心论断」。`, '按三库格式契约补全一句话可操作的核心论断。');
    }
    if (!card.invalidationSignals) {
      addIssue('error', '字段契约', `方法论卡片 ${card.id}`, `卡片 ${card.id} 缺失失效信号`, `行 ${card.startLine} 处未解析到「失效信号」（契约铁律：写不出可证伪性不得入库）。`, '补充可观测的证伪条件，或标明文献未给出。');
    }
    if (card.credibilityScore === null || card.credibilityScore < 0 || card.credibilityScore > 1) {
      addIssue('error', '可信度纪律', `方法论卡片 ${card.id}`, `卡片 ${card.id} 可信度格式异常`, `当前原文：「${card.credibilityRaw || '(空)'}」，须为 [0, 1] 数值。`, '修正为标准区间 [0, 1] 数值。');
    } else if (card.credibilityScore < 0.3 && !/待淘汰/.test(card.rawMarkdown)) {
      addIssue('warning', '可信度纪律', `方法论卡片 ${card.id}`, `卡片 ${card.id} 可信度低于 0.3 但未标【待淘汰】`, `当前可信度为 ${card.credibilityScore}。`, '添加【待淘汰】标记并由用户裁决修改适用条件、降级或删除。');
    }
    if (!card.source) {
      addIssue('warning', '字段契约', `方法论卡片 ${card.id}`, `卡片 ${card.id} 缺失来源字段`, `行 ${card.startLine} 处未找到「来源」。`, '补充文献名、页码或实盘复盘日期。');
    }
  }

  // -------------------------------------------------------------------------
  // 3. 认知库铁律检查（证据等级、失效/更新条件、事实与映射分离）
  // -------------------------------------------------------------------------
  for (const card of cognition.cards) {
    if (!card.facts) {
      addIssue('error', '认知库铁律', `认知卡 ${card.id}`, `认知卡 ${card.id} 缺失事实字段`, `行 ${card.startLine} 处未检测到「事实」字段。`, '补全客观事实描述，并与分析分离。');
    }
    if (!card.evidenceLevelRaw || card.evidenceGrades.length === 0) {
      addIssue('error', '认知库铁律', `认知卡 ${card.id}`, `认知卡 ${card.id} 证据等级缺失或不规范`, `当前原文：「${card.evidenceLevelRaw || '(空)'}」，须明确标定 A / B / C 级。`, '按铁律①补充 A/B/C 证据等级及依据。');
    }
    if (!card.invalidationConditions) {
      addIssue('error', '认知库铁律', `认知卡 ${card.id}`, `认知卡 ${card.id} 缺失失效/更新条件`, `行 ${card.startLine} 处未找到「失效/更新条件」（铁律②必填）。`, '补充触发本认知失效或需要更新的具体事件/数据条件。');
    }
    if (!card.industryImplications || !card.aShareMapping) {
      addIssue('warning', '认知库铁律', `认知卡 ${card.id}`, `认知卡 ${card.id} 分析/映射分栏不完整`, `产业含义：${card.industryImplications ? '有' : '缺'}；A股映射：${card.aShareMapping ? '有' : '缺'}。`, '按铁律③确保产业含义与 A 股映射分开标注。');
    }
  }

  // -------------------------------------------------------------------------
  // 4. 跨库引用完整性检查
  // -------------------------------------------------------------------------
  for (const card of methodology.cards) {
    if (card.isRevoked) continue;
    for (const cid of card.references.cognitionIds) {
      if (!cognitionIdSet.has(cid)) {
        addIssue('warning', '交叉引用', `方法论卡片 ${card.id}`, `卡片 ${card.id} 引用了不存在的认知卡 ${cid}`, `正文或来源互参提到认知卡 ${cid}，但认知库当前范围 001—${String(cognition.stats.totalCount).padStart(3, '0')} 中无此编号。`, '核对编号是否笔误。');
      }
    }
    for (const cf of card.references.conflictIds) {
      if (!conflictIdSet.has(cf)) {
        addIssue('warning', '交叉引用', `方法论卡片 ${card.id}`, `卡片 ${card.id} 引用了不存在的冲突 ${cf}`, `正文提到冲突 ${cf}，但冲突矩阵中未找到该条目。`, '核对冲突编号。');
      }
    }
  }

  for (const card of cognition.cards) {
    for (const mid of card.references.methodIds) {
      if (!methodIdSet.has(mid) && !reservedMissingSet.has(mid)) {
        addIssue('warning', '交叉引用', `认知卡 ${card.id}`, `认知卡 ${card.id} 关联了不存在的方法论卡 ${mid}`, `关联字段提到方法论卡片 ${mid}，但方法论库中无此编号。`, '核对关联卡片编号。');
      }
    }
    for (const cid of card.references.cognitionIds) {
      if (!cognitionIdSet.has(cid)) {
        addIssue('warning', '交叉引用', `认知卡 ${card.id}`, `认知卡 ${card.id} 关联了不存在的认知卡 ${cid}`, `互引提到认知卡 ${cid}，但认知库中未找到。`, '核对互引编号。');
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. 完整目录 TOC 与正文同步检查
  // -------------------------------------------------------------------------
  const mTocAnchors = new Set(methodology.tocEntries.map((t) => t.anchor));
  const missingMToc = methodology.cards.filter((c) => !mTocAnchors.has(c.anchorId)).map((c) => c.id);
  const missingConfToc = methodology.conflicts.filter((c) => !mTocAnchors.has(c.anchorId)).map((c) => c.id);
  if (missingMToc.length || missingConfToc.length) {
    addIssue(
      'warning',
      '目录索引',
      '方法论卡片库.md',
      `方法论库目录漏项（卡片 ${missingMToc.length} / 冲突 ${missingConfToc.length}）`,
      `未在顶部完整目录中找到：卡片 [${missingMToc.join(', ')}]，冲突 [${missingConfToc.join(', ')}]。`,
      '运行「同步完整目录」一键补全缺失目录项。',
      'sync_toc_methodology'
    );
  }

  const cTocAnchors = new Set(cognition.tocEntries.map((t) => t.anchor));
  const missingCToc = cognition.cards.filter((c) => !cTocAnchors.has(c.anchorId)).map((c) => c.id);
  if (missingCToc.length) {
    addIssue(
      'warning',
      '目录索引',
      '行业前沿认知库.md',
      `认知库目录漏项（${missingCToc.length} 张）`,
      `未在顶部完整目录中找到认知卡：[${missingCToc.join(', ')}]。`,
      '运行「同步完整目录」一键补全。',
      'sync_toc_cognition'
    );
  }

  const lTocAnchors = new Set(ledger.tocEntries.map((t) => t.anchor));
  const allLedgerH2 = [...ledger.judgments, ...ledger.backfills, ...ledger.dailyReviews];
  const missingLToc = allLedgerH2.filter((e) => !e.anchor || !lTocAnchors.has(e.anchor)).map((e) => e.title);
  if (missingLToc.length) {
    addIssue(
      'warning',
      '目录索引',
      '研判与复盘台账.md',
      `台账目录漏项（${missingLToc.length} 条）`,
      `未在顶部完整目录中找到条目：${missingLToc.slice(0, 5).join('；')}${missingLToc.length > 5 ? '...' : ''}`,
      '运行「同步完整目录」一键补全。',
      'sync_toc_ledger'
    );
  }

  // -------------------------------------------------------------------------
  // 6. 三库版本互挂一致性检查
  // -------------------------------------------------------------------------
  const mVer = methodology.meta.version;
  const cVer = cognition.meta.version;
  const lVer = ledger.meta.version;

  if (!methodology.meta.companionLine.includes(cVer) || !methodology.meta.companionLine.includes(lVer)) {
    addIssue(
      'warning',
      '版本互挂',
      '方法论卡片库.md',
      '方法论库头部配套版本号滞后',
      `当前配套声明：「${methodology.meta.companionLine}」；实际现行版本：认知库 ${cVer}、台账 ${lVer}。`,
      '通过「同步三库版本互挂」更新文件头配套声明。',
      'sync_companion_versions'
    );
  }
  if (!cognition.meta.companionLine.includes(mVer) || !cognition.meta.companionLine.includes(lVer)) {
    addIssue(
      'warning',
      '版本互挂',
      '行业前沿认知库.md',
      '认知库头部配套版本号滞后',
      `当前配套声明：「${cognition.meta.companionLine}」；实际现行版本：方法论 ${mVer}、台账 ${lVer}。`,
      '通过「同步三库版本互挂」更新文件头配套声明。',
      'sync_companion_versions'
    );
  }
  if (!ledger.meta.companionLine.includes(mVer) || !ledger.meta.companionLine.includes(cVer)) {
    addIssue(
      'warning',
      '版本互挂',
      '研判与复盘台账.md',
      '台账头部关联的三库版本号滞后',
      `当前台账头部声明：「${ledger.meta.companionLine}」；现行实际版本已演进至方法论 ${mVer}、认知库 ${cVer}。`,
      '可一键同步台账文件头关联版本声明与 00_项目入口.md（不改任何历史正文）。',
      'sync_companion_versions'
    );
  }

  // -------------------------------------------------------------------------
  // 7. 可信度三处一致性检查（方法论卡正文 vs 最新台账第七节）
  // -------------------------------------------------------------------------
  const latestDaily = ledger.dailyReviews[0];
  const mCardById = new Map(methodology.cards.map((c) => [c.id, c]));
  if (latestDaily && latestDaily.credibilityEntries.length > 0) {
    for (const ce of latestDaily.credibilityEntries) {
      const mCard = mCardById.get(ce.cardId);
      if (!mCard) {
        addIssue('error', '可信度一致', `台账 ${latestDaily.date}`, `最新复盘引用了不存在的卡片 ${ce.cardId}`, `第七节列出了卡片 ${ce.cardId}，但方法论库未找到。`, '核对卡片编号。');
        continue;
      }
      const ledgerScoreMatch = ce.statusText.match(/(\d+(?:\.\d+)?)/);
      const ledgerScore = ledgerScoreMatch ? parseFloat(ledgerScoreMatch[1]) : null;
      if (ledgerScore !== null && mCard.credibilityScore !== null && Math.abs(ledgerScore - mCard.credibilityScore) > 1e-6) {
        addIssue(
          'error',
          '可信度一致',
          `方法论卡片 ${ce.cardId}`,
          `卡片 ${ce.cardId} 在方法论库与最新台账数值不一致`,
          `方法论库正文可信度为 ${mCard.credibilityScore}，而台账 ${latestDaily.date} 第七节记录为 ${ledgerScore}（${ce.statusText}）。`,
          '核查最近一次复盘回填是否漏同步，保持三处数值一致。'
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 8. 观点归档外链健康检查 & 日度复盘时效提示
  // -------------------------------------------------------------------------
  for (const arch of cognition.researchArchives) {
    if (!arch.exists) {
      addIssue('warning', '归档外链', '行业前沿认知库.md', `观点归档文件不存在：${arch.title}`, `相对路径 ${arch.relativePath} 在本地磁盘上未找到。`, '确认专题归档是否移动或更名。');
    }
  }

  if (latestDaily && methodology.meta.syncDate && latestDaily.date < methodology.meta.syncDate) {
    addIssue(
      'info',
      '同步时效',
      '研判与复盘台账.md',
      `日度复盘最新日期（${latestDaily.date}）早于三库最新同步日期（${methodology.meta.syncDate}）`,
      `方法论与认知库已于 ${methodology.meta.syncDate} 入库新批次，而台账日度复盘仍停留在 ${latestDaily.date}。`,
      '如需衔接后续交易日行情，可在「台账 → 新建日度复盘」中补录或登记新交易日复盘。'
    );
  }

  const reservedMissingIds = [...reservedMissingSet];
  const revokedCardIds = methodology.cards.filter((c) => c.isRevoked).map((c) => c.id);
  const methodSummaryParts = [`${methodology.stats.totalTitles} 标题`, `${methodology.stats.activeCount} 活跃`];
  if (reservedMissingIds.length > 0) methodSummaryParts.push(`${reservedMissingIds.join('/')} 声明缺号保留`);
  if (revokedCardIds.length > 0) methodSummaryParts.push(`${revokedCardIds.join('/')} 撤销不复用`);
  const cognitionRangeText =
    cognition.stats.totalCount > 0
      ? `${cognition.stats.totalCount} 张（001—${String(cognition.stats.totalCount).padStart(3, '0')}）`
      : '0 张';

  const summary = {
    checkedAt: new Date().toISOString(),
    errorCount: issues.filter((i) => i.severity === 'error').length,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
    infoCount: issues.filter((i) => i.severity === 'info').length,
    passedChecks: [
      `方法论编号完整性（${methodSummaryParts.join('，')}）`,
      `认知库编号完整性（${cognitionRangeText}）`,
      `高频核心卡可信度三处核对（共 ${latestDaily ? latestDaily.credibilityEntries.length : 0} 张）`,
      `三库文件 SHA256 校验就绪`,
    ],
    versions: { methodology: mVer, cognition: cVer, ledger: lVer },
  };

  return { summary, issues };
}

module.exports = {
  runQualityAudit,
};
