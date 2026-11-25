'use strict';

/**
 * P0-2：AI 产出事后数值对账门禁（Reconcile）+ 全标签/跨市场检查 + 交易所重点监管红线（卡片174）
 * 灵感源自 ai-mock-trade verdict.ts reconcile() 与 buy.ts 全标签扫描纪律：
 * - 代码拿权威行情包/联网资料包核对 AI 输出正文中出现的关键数字；
 * - 发现数值漂移立即标红告警，并提供一键修正为实盘权威口径；
 * - 维护本地交易所重点监管/严重异动名单，落地台账待办建议②（卡片174）。
 */

const fs = require('node:fs');
const path = require('node:path');

const { stateFile } = require('./app-paths.cjs');
const REGULATORY_PATH = stateFile('regulatory-watchlist.local.json');

function nowOffsetISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// 1. 交易所重点监管 / 严重异动名单管理（卡片 174 监管高度天花板红线）
// ============================================================================

const DEFAULT_REGULATORY_ITEMS = [
  {
    id: 'reg-demo-rule',
    code: '',
    name: '（示例说明：可将交易所公告的严重异动/重点监控标的录入此处）',
    reason: '10日4次异动 / 30日涨幅偏离超200% 重点监控红线（卡片174）',
    level: 'monitor',
    startDate: '',
    endDate: '',
    active: false,
  },
];

function loadRegulatoryWatchlist() {
  try {
    if (fs.existsSync(REGULATORY_PATH)) {
      const raw = JSON.parse(fs.readFileSync(REGULATORY_PATH, 'utf8'));
      if (Array.isArray(raw.items)) {
        return {
          items: raw.items,
          updatedAt: raw.updatedAt || null,
        };
      }
    }
  } catch {
    // fallback
  }
  return { items: [], updatedAt: null };
}

function saveRegulatoryWatchlist(items) {
  const clean = (Array.isArray(items) ? items : [])
    .filter((x) => x && (String(x.code || '').trim() || String(x.name || '').trim()))
    .map((x, idx) => ({
      id: String(x.id || `reg-${Date.now()}-${idx}`),
      code: String(x.code || '').trim().toUpperCase(),
      name: String(x.name || '').trim(),
      reason: String(x.reason || '交易所重点监控/严重异动红线（卡片174）').trim(),
      level: ['ban', 'monitor', 'warning'].includes(x.level) ? x.level : 'ban',
      startDate: String(x.startDate || '').trim(),
      endDate: String(x.endDate || '').trim(),
      active: x.active !== false,
    }));
  const payload = { updatedAt: nowOffsetISO(), items: clean };
  fs.writeFileSync(REGULATORY_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

function checkRegulatoryRedline(code, name) {
  const { items } = loadRegulatoryWatchlist();
  const today = new Date().toISOString().slice(0, 10);
  const cNorm = String(code || '').replace(/\.(SH|SZ|BJ|US|HK)$/i, '').trim().toUpperCase();
  const nNorm = String(name || '').trim();
  const hits = items.filter((item) => {
    if (item.active === false) return false;
    if (item.endDate && item.endDate < today) return false;
    const ic = String(item.code || '').replace(/\.(SH|SZ|BJ|US|HK)$/i, '').trim().toUpperCase();
    if (cNorm && ic && cNorm === ic) return true;
    if (nNorm && item.name && (nNorm.includes(item.name) || item.name.includes(nNorm))) return true;
    return false;
  });
  return {
    hit: hits.length > 0,
    hits,
    summary: hits.length
      ? `⚠ 命中交易所重点监管/严重异动红线（卡片174）：${hits.map((h) => `${h.name || h.code}[${h.level === 'ban' ? '禁追买' : '严监控'}：${h.reason}]`).join('；')}`
      : '未命中本地重点监管异动红线',
  };
}

// ============================================================================
// 2. 全标签 / 跨市场关联链完整性核查（防 AI 樱桃采摘只讲看多故事）
// ============================================================================

function buildFullTagCrossCheck(researchPacket) {
  if (!researchPacket || !researchPacket.target) {
    return {
      tags: [],
      draggingSignals: [],
      regulatory: { hit: false, hits: [], summary: '未提供标的' },
      overseasDivergence: null,
      promptBlock: '',
    };
  }
  const target = researchPacket.target;
  const reg = checkRegulatoryRedline(target.code, target.name);
  const concepts = Array.isArray(researchPacket.concepts) ? researchPacket.concepts.slice(0, 10) : [];
  const benchmarks = Array.isArray(researchPacket.crossMarketBenchmarks) ? researchPacket.crossMarketBenchmarks : [];
  const snap = researchPacket.snapshot || null;

  const draggingSignals = [];
  if (reg.hit) draggingSignals.push(reg.summary);

  // 检查跨市场基准与本标的的背离/拖累信号
  const usBench = benchmarks.filter((b) => b.marketKind === 'US' && Number.isFinite(Number(b.pct)));
  const cnBench = benchmarks.filter((b) => b.marketKind === 'CN' && Number.isFinite(Number(b.pct)));
  const sox = benchmarks.find((b) => /SOX|费城半导体/i.test(`${b.name} ${b.code}`));
  const ndx = benchmarks.find((b) => /NDX|纳斯达克/i.test(`${b.name} ${b.code}`));

  if (sox && Number(sox.pct) <= -2.0) {
    draggingSignals.push(`海外半导体风向标费城半导体(SOX)走弱 ${Number(sox.pct).toFixed(2)}%，警惕映射拖累（卡片159/192）`);
  }
  if (ndx && Number(ndx.pct) <= -1.5) {
    draggingSignals.push(`纳斯达克指数走弱 ${Number(ndx.pct).toFixed(2)}%，成长估值承压`);
  }
  if (snap && Number.isFinite(Number(snap.ma5BiasPct)) && Number(snap.ma5BiasPct) >= 8) {
    draggingSignals.push(`现价 MA5 乖离率达 +${Number(snap.ma5BiasPct).toFixed(2)}%（超框架增订④ 8%红线，严禁追高）`);
  }
  if (snap && Number.isFinite(Number(snap.peTtm)) && Number(snap.peTtm) < 0) {
    draggingSignals.push(`PE(TTM) 为负值（${snap.peTtm}），当前处于亏损态，估值无盈利安全垫`);
  }
  if (Array.isArray(researchPacket.shareholders?.upcomingLockups) && researchPacket.shareholders.upcomingLockups.length > 0) {
    const soon = researchPacket.shareholders.upcomingLockups[0];
    draggingSignals.push(`存在限售股解禁压力：${soon.date || ''} ${soon.ratioPct ? `占比 ${soon.ratioPct}%` : ''}`);
  }

  let overseasDivergence = null;
  if (snap && Number.isFinite(Number(snap.pct)) && usBench.length > 0 && cnBench.length > 0) {
    const usAvg = usBench.reduce((s, b) => s + Number(b.pct), 0) / usBench.length;
    const cnAvg = cnBench.reduce((s, b) => s + Number(b.pct), 0) / cnBench.length;
    overseasDivergence = {
      usAvgPct: Number(usAvg.toFixed(2)),
      cnAvgPct: Number(cnAvg.toFixed(2)),
      stockPct: Number(Number(snap.pct).toFixed(2)),
      spreadVsUs: Number((Number(snap.pct) - usAvg).toFixed(2)),
    };
  }

  const lines = [
    `【全标签与风险拖累核查（防片面叙事纪律——AI 必须在空头论断/交易结构中逐一正面回应以下风险点，禁止隐瞒）】`,
    `- 监管异动红线（卡片174）：${reg.summary}`,
    `- 标的关联全部题材/概念标签（共 ${concepts.length} 个）：${concepts.length ? concepts.join('、') : '未披露'}`,
    `- 跨市场基准快照：${benchmarks.slice(0, 6).map((b) => `${b.name} ${b.pct != null ? (Number(b.pct) >= 0 ? '+' : '') + Number(b.pct).toFixed(2) + '%' : '-'}`).join('｜') || '无'}`,
    `- 机械识别的硬风险/拖后腿信号（共 ${draggingSignals.length} 项）：${draggingSignals.length ? draggingSignals.join('；') : '当前未检测到显著机械红线'}`,
  ];

  return {
    tags: concepts,
    draggingSignals,
    regulatory: reg,
    overseasDivergence,
    promptBlock: lines.join('\n'),
  };
}

// ============================================================================
// 3. 每日复盘 AI 产出数值对账门禁（Reconcile Daily Review）
// ============================================================================

function findMetricMatches(text, patterns) {
  const results = [];
  if (!text) return results;
  for (const pat of patterns) {
    const re = new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const val = Number(m[1]);
      if (Number.isFinite(val)) {
        results.push({
          fullMatch: m[0],
          rawNumStr: m[1],
          value: val,
          index: m.index,
        });
      }
    }
  }
  return results;
}

function reconcileDailyReviewDraft(form, packet) {
  const items = [];
  if (!form || !packet) {
    return { checkedCount: 0, driftCount: 0, passCount: 0, items };
  }

  const fieldsToScan = [
    { key: 'marketFacts', label: '三、指数与盘面事实' },
    { key: 'intradayStructure', label: '四、日内结构' },
    { key: 'macroNotes', label: '二、隔夜美股与宏观' },
    { key: 'scoreReason', label: '评分拆解' },
  ];

  // 1) 两市成交额核对（亿元 / 万亿元）
  const authAmtYi = Number(packet.marketSummary?.twoMarketAmtYi);
  if (Number.isFinite(authAmtYi) && authAmtYi > 0) {
    let foundAny = false;
    for (const f of fieldsToScan) {
      const text = String(form[f.key] || '');
      // 匹配 "两市成交... 1.85万亿" 或 "成交额... 18500亿"
      const mWan = findMetricMatches(text, [/(?:两市(?:成交(?:额)?|合计成交)|全市场成交(?:额)?)[^。\n，,；;]{0,16}?(\d+\.\d{1,3})\s*万亿/]);
      for (const hit of mWan) {
        foundAny = true;
        const aiYi = hit.value * 10000;
        const diffYi = Math.abs(aiYi - authAmtYi);
        const isDrift = diffYi > Math.max(150, authAmtYi * 0.015);
        const authWanStr = (authAmtYi / 10000).toFixed(2);
        items.push({
          id: `rc-amt-wan-${f.key}-${hit.index}`,
          field: f.key,
          fieldLabel: f.label,
          metricLabel: '两市总成交额',
          aiValue: `${hit.value}万亿`,
          authValue: `${authWanStr}万亿（${authAmtYi.toFixed(0)}亿）`,
          diffText: isDrift ? `偏差 ${diffYi.toFixed(0)} 亿元` : '核对一致',
          status: isDrift ? 'drift' : 'pass',
          severity: isDrift ? 'high' : 'ok',
          snippet: hit.fullMatch,
          replacement: hit.fullMatch.replace(hit.rawNumStr, authWanStr),
          autoFixable: isDrift,
        });
      }
      const mYi = findMetricMatches(text, [/(?:两市(?:成交(?:额)?|合计成交)|全市场成交(?:额)?)[^。\n，,；;]{0,16}?(\d{4,5}(?:\.\d+)?)\s*亿/]);
      for (const hit of mYi) {
        foundAny = true;
        const diffYi = Math.abs(hit.value - authAmtYi);
        const isDrift = diffYi > Math.max(150, authAmtYi * 0.015);
        const authStr = authAmtYi.toFixed(0);
        items.push({
          id: `rc-amt-yi-${f.key}-${hit.index}`,
          field: f.key,
          fieldLabel: f.label,
          metricLabel: '两市总成交额(亿)',
          aiValue: `${hit.value}亿`,
          authValue: `${authStr}亿`,
          diffText: isDrift ? `偏差 ${diffYi.toFixed(0)} 亿元` : '核对一致',
          status: isDrift ? 'drift' : 'pass',
          severity: isDrift ? 'high' : 'ok',
          snippet: hit.fullMatch,
          replacement: hit.fullMatch.replace(hit.rawNumStr, authStr),
          autoFixable: isDrift,
        });
      }
    }
    if (!foundAny) {
      items.push({
        id: 'rc-amt-missing',
        field: 'marketFacts',
        fieldLabel: '三、指数与盘面事实',
        metricLabel: '两市总成交额',
        aiValue: '正文未显式提及',
        authValue: `${authAmtYi.toFixed(0)}亿 (${(authAmtYi / 10000).toFixed(2)}万亿)`,
        diffText: '建议补写权威两市成交额',
        status: 'info',
        severity: 'low',
        snippet: '',
        replacement: '',
        autoFixable: false,
      });
    }
  }

  // 2) 各大核心指数涨跌幅核对
  const indices = Array.isArray(packet.indices) ? packet.indices : [];
  for (const idx of indices) {
    const authPct = Number(idx.dailyAuth?.pct ?? idx.intraday?.closePct);
    if (!Number.isFinite(authPct)) continue;
    const aliases = [idx.name];
    if (idx.name === '上证指数') aliases.push('沪指', '上证');
    if (idx.name === '深证成指') aliases.push('深成指');
    if (idx.name === '创业板指') aliases.push('创业板', '创指');
    if (idx.name === '科创50') aliases.push('科创50指');
    if (idx.name === '中证1000') aliases.push('中证1000指');

    const nameGroup = aliases.map(escapeRegExp).join('|');
    const re = new RegExp(`(?:${nameGroup})(?:指数)?[^。\n；;，,]{0,16}?([+-]?\\d+(?:\\.\\d+)?)%`, 'g');

    for (const f of fieldsToScan) {
      const text = String(form[f.key] || '');
      let m;
      while ((m = re.exec(text)) !== null) {
        // 判断文本中是否在数字前写了"跌"/"收跌"/"下挫"而省略负号
        let parsedVal = Number(m[1]);
        const prefixText = m[0].slice(0, m[0].lastIndexOf(m[1]));
        if (parsedVal > 0 && !m[1].startsWith('+') && /(?:跌|下挫|回落|收绿|走低)/.test(prefixText)) {
          parsedVal = -parsedVal;
        }
        const diff = Math.abs(parsedVal - authPct);
        const isDrift = diff > 0.12;
        const authSign = authPct >= 0 ? `+${authPct.toFixed(2)}` : authPct.toFixed(2);
        const signedReplace = m[1].startsWith('+') || m[1].startsWith('-') ? authSign : Math.abs(authPct).toFixed(2);
        items.push({
          id: `rc-idx-${idx.code}-${f.key}-${m.index}`,
          field: f.key,
          fieldLabel: f.label,
          metricLabel: `${idx.name}涨跌幅`,
          aiValue: `${parsedVal >= 0 ? '+' : ''}${parsedVal.toFixed(2)}%`,
          authValue: `${authSign}%`,
          diffText: isDrift ? `偏差 ${diff.toFixed(2)} 个百分点` : '核对一致',
          status: isDrift ? 'drift' : 'pass',
          severity: isDrift ? (diff >= 0.5 ? 'high' : 'medium') : 'ok',
          snippet: m[0],
          replacement: m[0].replace(`${m[1]}%`, `${signedReplace}%`),
          autoFixable: isDrift && (Math.sign(parsedVal) === Math.sign(authPct) || m[1].startsWith('+') || m[1].startsWith('-')),
        });
        break; // 每个字段对同一指数只核对首次主报数据
      }
    }
  }

  // 3) 涨停 / 跌停 / 炸板率 / 红盘率核对
  const pools = packet.limitPools;
  if (pools && pools.ok) {
    const checkInt = (metricLabel, authVal, regex, tol = 2, unit = '只') => {
      if (!Number.isFinite(Number(authVal))) return;
      const text = String(form.marketFacts || '');
      const m = text.match(regex);
      if (!m) return;
      const aiVal = Number(m[1]);
      const diff = Math.abs(aiVal - Number(authVal));
      const isDrift = diff > tol;
      items.push({
        id: `rc-pool-${metricLabel}`,
        field: 'marketFacts',
        fieldLabel: '三、指数与盘面事实',
        metricLabel,
        aiValue: `${aiVal}${unit}`,
        authValue: `${authVal}${unit}`,
        diffText: isDrift ? `偏差 ${diff.toFixed(1)}${unit}` : '核对一致',
        status: isDrift ? 'drift' : 'pass',
        severity: isDrift ? 'medium' : 'ok',
        snippet: m[0],
        replacement: m[0].replace(m[1], String(authVal)),
        autoFixable: isDrift,
      });
    };
    checkInt('涨停家数', pools.ztCount, /涨停(?:家数|数)?[^\d\n]{0,6}(\d{1,3})\s*(?:只|家)/, 2, '只');
    checkInt('跌停家数', pools.dtCount, /跌停(?:家数|数)?[^\d\n]{0,6}(\d{1,3})\s*(?:只|家)/, 2, '只');
    checkInt('炸板率', pools.burstRatePct, /炸板率[^\d\n]{0,6}(\d+(?:\.\d+)?)%/, 1.5, '%');
  }

  const redRate = Number(packet.marketSummary?.breadth?.redRatePct);
  if (Number.isFinite(redRate)) {
    const text = String(form.marketFacts || '');
    const m = text.match(/红盘率[^\d\n]{0,6}(\d+(?:\.\d+)?)%/);
    if (m) {
      const aiVal = Number(m[1]);
      const diff = Math.abs(aiVal - redRate);
      const isDrift = diff > 1.2;
      items.push({
        id: 'rc-red-rate',
        field: 'marketFacts',
        fieldLabel: '三、指数与盘面事实',
        metricLabel: '全市场红盘率',
        aiValue: `${aiVal}%`,
        authValue: `${redRate}%`,
        diffText: isDrift ? `偏差 ${diff.toFixed(1)} 个百分点` : '核对一致',
        status: isDrift ? 'drift' : 'pass',
        severity: isDrift ? 'medium' : 'ok',
        snippet: m[0],
        replacement: m[0].replace(m[1], String(redRate)),
        autoFixable: isDrift,
      });
    }
  }

  const driftCount = items.filter((i) => i.status === 'drift').length;
  const passCount = items.filter((i) => i.status === 'pass').length;
  return {
    checkedCount: items.length,
    driftCount,
    passCount,
    items,
  };
}

// ============================================================================
// 4. 标的研判 AI 产出数值对账门禁（Reconcile Stock Judgment）
// ============================================================================

function reconcileJudgmentDraft(form, researchPacket) {
  const items = [];
  const snap = researchPacket?.snapshot;
  if (!form || !snap || !snap.ok) {
    return { checkedCount: 0, driftCount: 0, passCount: 0, items };
  }

  const fieldsToScan = [
    { key: 'conclusion', label: '一句话结论' },
    { key: 'tradingStructure', label: '三、交易结构' },
    { key: 'bullArgs', label: '二、多头论断' },
    { key: 'bearArgs', label: '二、空头论断' },
    { key: 'industryPosition', label: '一、产业定位' },
  ];
  const combined = fieldsToScan.map((f) => ({ ...f, text: String(form[f.key] || '') }));

  const checkNum = (metricLabel, authVal, regex, tolPct, unit = '') => {
    const auth = Number(authVal);
    if (!Number.isFinite(auth) || auth === 0) return;
    for (const f of combined) {
      const m = f.text.match(regex);
      if (!m) continue;
      const aiVal = Number(m[1]);
      if (!Number.isFinite(aiVal)) continue;
      const relErr = Math.abs(aiVal - auth) / Math.max(Math.abs(auth), 0.01);
      const isDrift = relErr > tolPct;
      const authStr = Number(auth.toFixed(2)).toString();
      items.push({
        id: `rc-stk-${metricLabel}-${f.key}`,
        field: f.key,
        fieldLabel: f.label,
        metricLabel,
        aiValue: `${aiVal}${unit}`,
        authValue: `${authStr}${unit}`,
        diffText: isDrift ? `偏离实盘 ${(relErr * 100).toFixed(1)}%` : '核对一致',
        status: isDrift ? 'drift' : 'pass',
        severity: isDrift ? (relErr > 0.08 ? 'high' : 'medium') : 'ok',
        snippet: m[0],
        replacement: m[0].replace(m[1], authStr),
        autoFixable: isDrift,
      });
      break;
    }
  };

  checkNum('最新收盘/现价', snap.close ?? snap.price, /(?:现价|当前价|最新价|收盘价)[^\d\n]{0,8}(\d+(?:\.\d+)?)/, 0.025, '');
  checkNum('MA5 均线价', snap.ma5, /MA5(?:均线)?[^\d%\n]{0,6}(\d+(?:\.\d+)?)(?!%)/, 0.025, '');
  checkNum('MA20 均线价', snap.ma20, /MA20(?:均线)?[^\d%\n]{0,6}(\d+(?:\.\d+)?)(?!%)/, 0.025, '');
  if (Number.isFinite(Number(snap.ma5BiasPct))) {
    for (const f of combined) {
      const m = f.text.match(/MA5\s*乖离率?[^\d+\-\n]{0,6}([+-]?\d+(?:\.\d+)?)%/i);
      if (!m) continue;
      const aiVal = Number(m[1]);
      const auth = Number(snap.ma5BiasPct);
      const diff = Math.abs(aiVal - auth);
      const isDrift = diff > 0.8;
      const authStr = auth >= 0 ? `+${auth.toFixed(2)}` : auth.toFixed(2);
      items.push({
        id: `rc-stk-ma5bias-${f.key}`,
        field: f.key,
        fieldLabel: f.label,
        metricLabel: 'MA5 乖离率',
        aiValue: `${aiVal}%`,
        authValue: `${authStr}%`,
        diffText: isDrift ? `偏差 ${diff.toFixed(2)} 个百分点` : '核对一致',
        status: isDrift ? 'drift' : 'pass',
        severity: isDrift ? 'high' : 'ok',
        snippet: m[0],
        replacement: m[0].replace(m[1], authStr),
        autoFixable: isDrift,
      });
      break;
    }
  }
  if (Number.isFinite(Number(snap.peTtm)) && Number(snap.peTtm) > 0) {
    checkNum('PE(TTM)', snap.peTtm, /PE(?:\(TTM\)|-TTM|TTM)?[^\d\n]{0,6}(\d+(?:\.\d+)?)\s*(?:倍|x|X)?/, 0.08, '倍');
  }

  // 检查是否命中交易所重点监管红线但 AI 未提及
  const fullCheck = buildFullTagCrossCheck(researchPacket);
  if (fullCheck.regulatory.hit) {
    const allText = combined.map((c) => c.text).join('\n');
    const mentioned = /监管|异动|重点监控|174/.test(allText);
    items.push({
      id: 'rc-stk-regulatory',
      field: 'bearArgs',
      fieldLabel: '二、空头论断',
      metricLabel: '重点监管异动红线（卡片174）',
      aiValue: mentioned ? '已提示监管风险' : '⚠ 未在研判中提及',
      authValue: fullCheck.regulatory.summary,
      diffText: mentioned ? '核对一致' : '命中本地监管红线，必须写入空头/交易结构',
      status: mentioned ? 'pass' : 'drift',
      severity: mentioned ? 'ok' : 'high',
      snippet: '',
      replacement: '',
      autoFixable: false,
    });
  }

  const driftCount = items.filter((i) => i.status === 'drift').length;
  const passCount = items.filter((i) => i.status === 'pass').length;
  return {
    checkedCount: items.length,
    driftCount,
    passCount,
    items,
    fullTagCrossCheck: fullCheck,
  };
}

function applyReconcileFixes(form, items) {
  const next = { ...form };
  let applied = 0;
  for (const item of items || []) {
    if (!item || !item.autoFixable || !item.field || !item.snippet || !item.replacement) continue;
    const cur = String(next[item.field] || '');
    if (cur.includes(item.snippet)) {
      next[item.field] = cur.replace(item.snippet, item.replacement);
      applied += 1;
    }
  }
  return { form: next, applied };
}

module.exports = {
  loadRegulatoryWatchlist,
  saveRegulatoryWatchlist,
  checkRegulatoryRedline,
  buildFullTagCrossCheck,
  reconcileDailyReviewDraft,
  reconcileJudgmentDraft,
  applyReconcileFixes,
};
