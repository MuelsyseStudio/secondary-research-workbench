'use strict';

/**
 * P2-2：周度 / 月度聚合复盘 + AI 深度反思与方法论迭代提案 + 独立可分享 HTML 研报生成器
 */

const fs = require('node:fs');
const path = require('node:path');
const { invokeModel, parseJsonFromModelOutput } = require('./ai-provider.cjs');
const { loadSentimentChain } = require('./technical-engine.cjs');
const { loadVetoLedger } = require('./judgment-tracker.cjs');
const { computeTradeLedgerAnalytics } = require('./trade-ledger.cjs');
const { PATHS } = require('./parser.cjs');
const { DISCLAIMER_TEXT, EXECUTION_BOUNDARY_TEXT } = require('./edition.cjs');

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getDefaultDateRange(periodType = 'week') {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (periodType === 'month' ? 30 : 7));
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { startDate: fmt(start), endDate: fmt(end) };
}

async function buildPeriodicSummary(workspace, { periodType = 'week', startDate, endDate } = {}) {
  const def = getDefaultDateRange(periodType);
  const start = String(startDate || def.startDate).slice(0, 10);
  const end = String(endDate || def.endDate).slice(0, 10);

  const dailyInRange = (workspace.ledger.dailyReviews || [])
    .filter((d) => d.date >= start && d.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));

  const judgmentsInRange = (workspace.ledger.judgments || [])
    .filter((j) => !j.isLegacyRef && j.date >= start && j.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));

  const vetoInRange = (loadVetoLedger().items || []).filter((v) => v.date >= start && v.date <= end);
  const sentimentHistory = (loadSentimentChain().history || []).filter((h) => h.date >= start && h.date <= end);

  // 汇总锚点命中率与高频卡片提及
  let anchorTotal = 0;
  let anchorHit = 0;
  let anchorFail = 0;
  const cardMentions = new Map();
  const gapsAll = [];

  for (const d of dailyInRange) {
    for (const a of d.anchorChecks || []) {
      anchorTotal += 1;
      if (/^成立/.test(a.verdict || '')) anchorHit += 1;
      else if (/证伪/.test(a.verdict || '')) anchorFail += 1;
    }
    for (const cid of d.references?.methodIds || []) {
      cardMentions.set(cid, (cardMentions.get(cid) || 0) + 1);
    }
    for (const g of d.gaps || []) {
      gapsAll.push(`${d.date}: ${g}`);
    }
  }

  const dailyScores = dailyInRange.map((d) => d.score).filter((v) => Number.isFinite(v));
  const avgDailyScore = dailyScores.length ? round2(dailyScores.reduce((a, b) => a + b, 0) / dailyScores.length) : null;

  // 聚合交易账本区间内表现（不强制网络拉价，秒出结果）
  const tradeFull = await computeTradeLedgerAnalytics(workspace, { withMarketData: false });
  const tradesInRange = (tradeFull.trades || []).filter((t) => t.date >= start && t.date <= end);
  const closedInRange = tradesInRange.filter((t) => t.side === 'SELL' && t.realizedPnl != null);
  const periodRealizedPnl = round2(closedInRange.reduce((s, t) => s + (t.realizedPnl || 0), 0)) || 0;
  const periodWins = closedInRange.filter((t) => t.realizedPnl > 0).length;
  const periodWinRate = closedInRange.length ? round2((periodWins / closedInRange.length) * 100) : null;

  const cardTitleMap = new Map((workspace.methodology.cards || []).map((c) => [c.id, c.title]));
  const topCards = [...cardMentions.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id, count]) => ({ id, title: cardTitleMap.get(id) || `卡片${id}`, count }));

  return {
    ok: true,
    periodType,
    periodLabel: periodType === 'month' ? '月度聚合复盘' : '周度聚合复盘',
    startDate: start,
    endDate: end,
    stats: {
      dailyReviewCount: dailyInRange.length,
      avgDailyScore,
      minDailyScore: dailyScores.length ? Math.min(...dailyScores) : null,
      maxDailyScore: dailyScores.length ? Math.max(...dailyScores) : null,
      anchorTotal,
      anchorHit,
      anchorFail,
      anchorHitRatePct: anchorTotal ? round2((anchorHit / anchorTotal) * 100) : null,
      judgmentCount: judgmentsInRange.length,
      vetoCount: vetoInRange.length,
      tradeCount: tradesInRange.length,
      closedTradeCount: closedInRange.length,
      periodRealizedPnl,
      periodWinRate,
      openGapCount: gapsAll.length,
    },
    dailySeries: dailyInRange.map((d) => ({
      id: d.id,
      date: d.date,
      title: d.title,
      score: d.score,
      marketState: d.marketState,
      gapCount: (d.gaps || []).length,
    })),
    judgments: judgmentsInRange.map((j) => ({
      id: j.id,
      recordKey: j.recordKey,
      date: j.date,
      target: j.target,
      score: j.score,
      conclusion: j.conclusion,
    })),
    vetos: vetoInRange,
    sentimentHistory,
    topCards,
    tradeAttribution: {
      cardAttribution: tradeFull.cardAttribution.slice(0, 8),
      mistakeAttribution: tradeFull.mistakeAttribution,
    },
    gaps: gapsAll.slice(0, 12),
  };
}

async function runPeriodicAiSynthesis(workspace, summary, providerOverride) {
  const systemPrompt = `你是二级投研客观复盘整理助手。请基于给定的周期聚合数据（${summary.periodLabel} ${summary.startDate} ~ ${summary.endDate}），输出一份深刻、坦诚、直指核心规律的周期总结 JSON（严禁空话套话，所有结论必须锚定给定数字或卡号；严格遵守去荐股化红线：严禁输出买卖评级、目标价或具体荐股操作建议，仅作公开信息与个人复盘统计整理、逻辑假设核验与风险暴露提示）：
{
  "headline": "一句话周期定性标题",
  "marketRegimeReview": "本周期市场情绪演变、主线轮动与评分轨迹总结（分点）",
  "researchAndExecutionReview": "标的研判、否决纪律与交易账本执行复盘（含胜率、做T与行为错因分析）",
  "topLessons": ["核心教训/正反馈 1", "核心教训 2", "核心教训 3"],
  "cardEvolutionProposals": [{"cardId":"3位卡号","action":"强化/修订/观察","reason":"具体建议依据"}],
  "nextPeriodFocus": ["下一周期核心跟踪主线与风险边界 1", "2", "3"]
}`;

  const userPrompt = `请综合以下【${summary.periodLabel}】真实聚合事实包生成周期深度反思 JSON：\n\n${JSON.stringify(summary, null, 2)}`;

  const res = await invokeModel({
    providerOverride,
    systemPrompt,
    userPrompt,
    expectJson: true,
    timeoutMs: 180000,
  });
  const parsed = parseJsonFromModelOutput(res.rawText);
  return {
    ok: true,
    provider: res.provider,
    model: res.model,
    latencyMs: res.latencyMs,
    report: {
      headline: String(parsed.headline || `${summary.startDate} ~ ${summary.endDate} ${summary.periodLabel}`).trim(),
      marketRegimeReview: String(parsed.marketRegimeReview || '').trim(),
      researchAndExecutionReview: String(parsed.researchAndExecutionReview || '').trim(),
      topLessons: Array.isArray(parsed.topLessons) ? parsed.topLessons.map(String) : [],
      cardEvolutionProposals: Array.isArray(parsed.cardEvolutionProposals) ? parsed.cardEvolutionProposals : [],
      nextPeriodFocus: Array.isArray(parsed.nextPeriodFocus) ? parsed.nextPeriodFocus.map(String) : [],
    },
  };
}

function renderPeriodicReviewHtml(summary, aiReport = null, { theme = 'light' } = {}) {
  const isDark = theme === 'dark';
  const bg = isDark ? '#14171d' : '#f7f4ee';
  const cardBg = isDark ? '#1d222b' : '#ffffff';
  const text = isDark ? '#e6e8ec' : '#1b2430';
  const muted = isDark ? '#98a2b3' : '#5e6a7a';
  const border = isDark ? '#2d3442' : '#e5dfd3';
  const accent = '#9a3412';

  // 生成极简 SVG 评分曲线
  const pts = (summary.dailySeries || []).filter((d) => Number.isFinite(d.score));
  let svgCurve = '<div style="color:' + muted + ';font-size:13px">本区间内暂无带评分的日度复盘记录</div>';
  if (pts.length >= 2) {
    const W = 680;
    const H = 150;
    const pad = 26;
    const step = (W - pad * 2) / (pts.length - 1);
    const yOf = (s) => pad + ((10 - Math.max(1, Math.min(10, s))) / 9) * (H - pad * 2);
    const poly = pts.map((p, i) => `${(pad + i * step).toFixed(1)},${yOf(p.score).toFixed(1)}`).join(' ');
    svgCurve = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-height:170px;display:block">
      <line x1="${pad}" y1="${yOf(5)}" x2="${W - pad}" y2="${yOf(5)}" stroke="${border}" stroke-dasharray="4 4" />
      <polyline fill="none" stroke="${accent}" stroke-width="2.5" points="${poly}" />
      ${pts
        .map(
          (p, i) => `<g>
            <circle cx="${(pad + i * step).toFixed(1)}" cy="${yOf(p.score).toFixed(1)}" r="4" fill="${accent}" />
            <text x="${(pad + i * step).toFixed(1)}" y="${(yOf(p.score) - 8).toFixed(1)}" text-anchor="middle" font-size="11" fill="${text}">${p.score}</text>
            <text x="${(pad + i * step).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="${muted}">${escapeHtml(p.date.slice(5))}</text>
          </g>`
        )
        .join('')}
    </svg>`;
  }

  const st = summary.stats;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(aiReport?.headline || summary.periodLabel)} (${escapeHtml(summary.startDate)} ~ ${escapeHtml(summary.endDate)})</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 28px 18px 48px; background: ${bg}; color: ${text}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.65; }
    .wrap { max-width: 920px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
    .hero { background: ${cardBg}; border: 1px solid ${border}; border-top: 4px solid ${accent}; border-radius: 12px; padding: 24px 26px; }
    .hero h1 { margin: 6px 0 8px; font-size: 23px; }
    .meta { font-size: 12.5px; color: ${muted}; }
    .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .kpi { background: ${cardBg}; border: 1px solid ${border}; border-radius: 10px; padding: 14px 16px; }
    .kpi-label { font-size: 12px; color: ${muted}; }
    .kpi-val { font-size: 22px; font-weight: 800; margin-top: 4px; }
    .card { background: ${cardBg}; border: 1px solid ${border}; border-radius: 10px; padding: 18px 22px; }
    .card h2 { margin: 0 0 12px; font-size: 16px; border-left: 3.5px solid ${accent}; padding-left: 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid ${border}; }
    th { color: ${muted}; font-weight: 600; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; background: rgba(154,52,18,0.12); color: ${accent}; margin: 0 6px 6px 0; }
    .pre { white-space: pre-wrap; font-size: 13.8px; }
    @media (max-width: 720px) { .kpis { grid-template-columns: repeat(2, 1fr); } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div class="meta">二级投研 · 三库工作台 · ${escapeHtml(summary.periodLabel)}</div>
      <h1>${escapeHtml(aiReport?.headline || `${summary.startDate} 至 ${summary.endDate} ${summary.periodLabel}`)}</h1>
      <div class="meta">统计区间：${escapeHtml(summary.startDate)} ~ ${escapeHtml(summary.endDate)} ｜ 收录日度复盘 ${st.dailyReviewCount} 篇 · 标的研判 ${st.judgmentCount} 份 · 否决观察 ${st.vetoCount} 条</div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="kpi-label">区间日度复盘均分</div><div class="kpi-val">${st.avgDailyScore ?? '-'} <span style="font-size:12px;color:${muted}">(${st.minDailyScore ?? '-'}~${st.maxDailyScore ?? '-'})</span></div></div>
      <div class="kpi"><div class="kpi-label">跟踪锚成立命中率</div><div class="kpi-val">${st.anchorHitRatePct != null ? st.anchorHitRatePct + '%' : '-'} <span style="font-size:12px;color:${muted}">(${st.anchorHit}/${st.anchorTotal})</span></div></div>
      <div class="kpi"><div class="kpi-label">区间实盘已实现盈亏</div><div class="kpi-val" style="color:${st.periodRealizedPnl >= 0 ? '#dc2626' : '#16a34a'}">${st.periodRealizedPnl >= 0 ? '+' : ''}${st.periodRealizedPnl}</div></div>
      <div class="kpi"><div class="kpi-label">平仓胜率 / 否决记录</div><div class="kpi-val">${st.periodWinRate != null ? st.periodWinRate + '%' : '-'} <span style="font-size:12px;color:${muted}">/ ${st.vetoCount}否决</span></div></div>
    </div>

    <div class="card">
      <h2>区间市场评分演化轨迹</h2>
      ${svgCurve}
    </div>

    ${
      aiReport
        ? `<div class="card">
            <h2>一、周期市场节奏与情绪复盘</h2>
            <div class="pre">${escapeHtml(aiReport.marketRegimeReview)}</div>
          </div>
          <div class="card">
            <h2>二、研究、否决与交易执行归因</h2>
            <div class="pre">${escapeHtml(aiReport.researchAndExecutionReview)}</div>
          </div>
          <div class="card">
            <h2>三、核心教训与下周期作战红线</h2>
            <ul>${(aiReport.topLessons || []).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
            <div style="margin-top:10px;font-weight:700;font-size:13.5px">下一周期核心抓手：</div>
            <ul>${(aiReport.nextPeriodFocus || []).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
          </div>`
        : ''
    }

    <div class="card">
      <h2>高频调用方法论卡片（本周期）</h2>
      <div>${(summary.topCards || []).map((c) => `<span class="pill">卡${escapeHtml(c.id)} ${escapeHtml(c.title)} ×${c.count}</span>`).join('') || '暂无'}</div>
    </div>

    <div class="card">
      <h2>本周期日度复盘清单</h2>
      <table>
        <thead><tr><th>日期</th><th>评分</th><th>标题</th><th>双线状态</th></tr></thead>
        <tbody>
          ${(summary.dailySeries || [])
            .map(
              (d) => `<tr><td>${escapeHtml(d.date)}</td><td><strong>${d.score ?? '-'}</strong></td><td>${escapeHtml(d.title)}</td><td>${escapeHtml(d.marketState)}</td></tr>`
            )
            .join('') || '<tr><td colspan="4">区间内暂无日度复盘</td></tr>'}
        </tbody>
      </table>
    </div>

    <footer style="margin-top:8px;padding:14px 18px;border:1px solid ${border};border-radius:10px;background:${cardBg};font-size:11.5px;color:${muted};line-height:1.65">
      <div><strong>合规免责水印：</strong>${escapeHtml(DISCLAIMER_TEXT)}</div>
      <div style="margin-top:4px">${escapeHtml(EXECUTION_BOUNDARY_TEXT)}</div>
    </footer>
  </div>
</body>
</html>`;
}

function savePeriodicHtmlToDisk(summary, html) {
  const dir = PATHS.periodicHtmlDir;
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${summary.startDate}_至_${summary.endDate}_${summary.periodLabel}.html`;
  const fullPath = path.join(dir, fileName);
  fs.writeFileSync(fullPath, html, 'utf8');
  return { fileName, fullPath, dir, sizeBytes: Buffer.byteLength(html, 'utf8') };
}

module.exports = {
  buildPeriodicSummary,
  runPeriodicAiSynthesis,
  renderPeriodicReviewHtml,
  savePeriodicHtmlToDisk,
};
