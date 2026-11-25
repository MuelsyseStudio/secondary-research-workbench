'use strict';

/**
 * 二级投研 · 每日 A 股复盘可视化研报 HTML 生成引擎
 *
 * 特性：
 * 1. 100% 单文件离线自包含（零外链 CDN），发微信 / 飞书 / 邮件 / 浏览器打开即看，并内置 @media print 打印/导出 PDF 排版；
 * 2. 若本地存在对应交易日的真实 1 分钟数据包（market_packets/YYYY-MM-DD_intraday_packet.json），
 *    自动内嵌 7 大指数 + 观察股 1 分钟高精度 SVG 分时曲线、连板梯队阶梯图、≥3只板块集群横向柱状图与美股快照条；
 * 3. 若为历史早期无数据包日期，自动从 Markdown 正文智能提取成交额、涨跌广度、涨跌停、评分与市场状态，同样生成高可读性研报；
 * 4. 智能消解大段文字墙：将日内四段节奏（①竞价→②早盘→③午盘→④尾盘）、双线分治、行为金融四象限、14张高频卡矩阵、
 *    上期跟踪锚状态看板、次日跟踪锚清单与缺口登记分别结构化排版；
 * 5. 在工作台内嵌预览模式（embedded=true）下，点击任意「卡片XXX / 认知卡XXX」徽章可通过 postMessage 唤起工作台右侧预览抽屉。
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadArchivedMarketPacket } = require('./market-fetcher.cjs');
const { PATHS } = require('./app-paths.cjs');
const { DISCLAIMER_TEXT, EXECUTION_BOUNDARY_TEXT } = require('./edition.cjs');

function getExportHtmlDir() {
  return PATHS.exportHtmlDir;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtPct(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function pctClass(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return 'flat';
  const n = Number(v);
  if (n > 0) return 'up';
  if (n < 0) return 'down';
  return 'flat';
}

function fmtYi(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(3)} 万亿`;
  return `${n.toFixed(2)} 亿`;
}

/**
 * 富文本微排版：保留粗体、高亮「未获得（已记缺口）」、并将 卡片XXX / 认知卡XXX / 冲突XX 转为可点击语义徽章
 */
function formatRichInline(rawText) {
  let html = esc(rawText || '');

  // 加粗 **...**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // 标红/琥珀高亮 缺失与缺口提示
  html = html.replace(
    /(未获得（已记缺口）|未获得\(已记缺口\)|已记缺口|无根\/待研|待核)/g,
    '<span class="inline-gap">$1</span>'
  );

  // 认知卡 XXX / 认知 XXX
  html = html.replace(/(认知卡?\s?)(\d{3})\b/g, (m, prefix, id) => {
    return `<button type="button" class="chip chip-cog" data-kind="cognition" data-id="${id}">${prefix}${id}</button>`;
  });

  // 方法论 卡片 XXX / 卡 XXX（避免误命中 3 位普通数字，仅匹配显式“卡片/卡”前缀）
  html = html.replace(/(卡片\s?|卡)(\d{3})\b/g, (m, prefix, id) => {
    return `<button type="button" class="chip chip-method" data-kind="methodology" data-id="${id}">${prefix}${id}</button>`;
  });

  // 冲突 X
  html = html.replace(/(冲突\s?)(\d{1,2})\b/g, (m, prefix, id) => {
    return `<button type="button" class="chip chip-conflict" data-kind="conflict" data-id="${id}">${prefix}${id}</button>`;
  });

  return html;
}

/**
 * 通用 Markdown 片段转整洁 HTML（支持无序/有序列表、表格、小标题、以及长段落智能分句）
 */
function renderCleanMarkdown(mdText) {
  if (!mdText || !mdText.trim()) return '<p class="muted">（无记录）</p>';
  const cleaned = mdText
    .replace(/^[一二三四五六七八九十]+、[^｜\n]{1,20}[｜|]\s*/gm, '')
    .trim();

  const lines = cleaned.split(/\r?\n/);
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }

    // Markdown 表格
    if (line.startsWith('|') && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      const headers = line.slice(1, -1).split('|').map((s) => s.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i].trim().slice(1, -1).split('|').map((s) => s.trim()));
        i++;
      }
      blocks.push(
        `<div class="tbl-wrap"><table class="rpt-table"><thead><tr>${headers
          .map((h) => `<th>${formatRichInline(h)}</th>`)
          .join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${formatRichInline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`
      );
      continue;
    }

    // 子标题 ####
    if (/^####\s+/.test(line)) {
      blocks.push(`<h4 class="sub-h4">${formatRichInline(line.replace(/^####\s+/, ''))}</h4>`);
      i++;
      continue;
    }

    // 列表项
    if (/^[-*•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*•]\s+/, ''));
        i++;
      }
      blocks.push(
        `<ul class="rpt-list">${items.map((it) => `<li>${formatRichInline(it)}</li>`).join('')}</ul>`
      );
      continue;
    }

    // 普通段落：若单段超过 260 字且含多句，按关键锚点或句号适当分段，防止文字墙
    if (line.length > 260) {
      const parts = splitDenseParagraph(line);
      if (parts.length > 1) {
        blocks.push(
          `<ul class="rpt-list rpt-list-soft">${parts.map((p) => `<li>${formatRichInline(p)}</li>`).join('')}</ul>`
        );
      } else {
        blocks.push(`<p class="rpt-p">${formatRichInline(line)}</p>`);
      }
    } else {
      blocks.push(`<p class="rpt-p">${formatRichInline(line)}</p>`);
    }
    i++;
  }

  return blocks.join('\n');
}

function splitDenseParagraph(text) {
  // 优先按 ①②③④ 分段
  if (/[①②③④⑤]/.test(text) && (text.match(/[①②③④⑤⑥⑦⑧⑨⑩]/g) || []).length >= 2) {
    const segs = text.split(/(?=[①②③④⑤⑥⑦⑧⑨⑩])/).map((s) => s.trim()).filter(Boolean);
    if (segs.length >= 2) return segs;
  }
  // 否则按句号合并成每段 ~140 字的易读微段
  const sentences = text.split(/(?<=。)/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length <= 2) return [text];
  const out = [];
  let buf = '';
  for (const s of sentences) {
    if (buf.length + s.length > 170 && buf) {
      out.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * 服务端生成高精 1 分钟分时 SVG（纯矢量零依赖，含昨收虚线、黄色均价线、涨跌渐变面积、最高/最低点标记）
 */
function buildIntradaySvg(points, { width = 280, height = 74, highTime, lowTime, mini = false } = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    return `<div class="svg-empty">无分钟序列</div>`;
  }
  const vals = points.flatMap((pt) => [Number(pt.p), Number(pt.a)]).filter(Number.isFinite);
  vals.push(0);
  const rawMin = Math.min(...vals);
  const rawMax = Math.max(...vals);
  const span = Math.max(0.25, rawMax - rawMin);
  const minV = rawMin - span * 0.14;
  const maxV = rawMax + span * 0.14;

  const padX = mini ? 3 : 5;
  const padY = mini ? 4 : 7;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const toX = (idx) => padX + (idx / Math.max(1, points.length - 1)) * innerW;
  const toY = (v) => padY + innerH - ((v - minV) / (maxV - minV)) * innerH;

  const lastPct = Number(points[points.length - 1]?.p || 0);
  const isUp = lastPct >= 0;
  const strokeColor = isUp ? '#d92d20' : '#15803d';
  const fillColor = isUp ? 'rgba(217, 45, 32, 0.12)' : 'rgba(21, 128, 61, 0.12)';
  const zeroY = toY(0);

  const pricePts = points.map((pt, i) => `${toX(i).toFixed(1)},${toY(pt.p).toFixed(1)}`).join(' ');
  const avgPts = points.map((pt, i) => `${toX(i).toFixed(1)},${toY(pt.a).toFixed(1)}`).join(' ');
  const areaPath = `M ${toX(0).toFixed(1)},${zeroY.toFixed(1)} L ${points
    .map((pt, i) => `${toX(i).toFixed(1)},${toY(pt.p).toFixed(1)}`)
    .join(' L ')} L ${toX(points.length - 1).toFixed(1)},${zeroY.toFixed(1)} Z`;

  let hiDot = '';
  let loDot = '';
  if (!mini) {
    const hiIdx = highTime
      ? points.findIndex((p) => p.t >= highTime)
      : points.reduce((best, p, i) => (p.p > points[best].p ? i : best), 0);
    const loIdx = lowTime
      ? points.findIndex((p) => p.t >= lowTime)
      : points.reduce((best, p, i) => (p.p < points[best].p ? i : best), 0);
    if (hiIdx >= 0) {
      hiDot = `<circle cx="${toX(hiIdx).toFixed(1)}" cy="${toY(points[hiIdx].p).toFixed(1)}" r="2.8" fill="#d92d20" stroke="#fff" stroke-width="1"/>`;
    }
    if (loIdx >= 0) {
      loDot = `<circle cx="${toX(loIdx).toFixed(1)}" cy="${toY(points[loIdx].p).toFixed(1)}" r="2.8" fill="#15803d" stroke="#fff" stroke-width="1"/>`;
    }
  }

  return `<svg viewBox="0 0 ${width} ${height}" class="spark-svg${mini ? ' spark-mini' : ''}" preserveAspectRatio="none">
    <line x1="${padX}" y1="${zeroY.toFixed(1)}" x2="${width - padX}" y2="${zeroY.toFixed(1)}" stroke="currentColor" stroke-opacity="0.24" stroke-dasharray="3 3" stroke-width="1"/>
    ${!mini ? `<line x1="${(width / 2).toFixed(1)}" y1="${padY}" x2="${(width / 2).toFixed(1)}" y2="${height - padY}" stroke="currentColor" stroke-opacity="0.09" stroke-width="1"/>` : ''}
    <path d="${areaPath}" fill="${fillColor}"/>
    <polyline fill="none" stroke="#d97706" stroke-width="${mini ? 1 : 1.15}" stroke-opacity="0.82" points="${avgPts}"/>
    <polyline fill="none" stroke="${strokeColor}" stroke-width="${mini ? 1.5 : 1.8}" stroke-linejoin="round" points="${pricePts}"/>
    ${hiDot}${loDot}
  </svg>`;
}

/**
 * 圆形评分仪表盘 SVG
 */
function buildScoreGaugeSvg(score) {
  const num = Number.isFinite(Number(score)) ? Math.max(0, Math.min(10, Number(score))) : null;
  const r = 38;
  const circ = 2 * Math.PI * r;
  const pct = num !== null ? num / 10 : 0;
  const dash = (pct * circ).toFixed(1);
  const color =
    num === null ? '#64748b' : num >= 6.5 ? '#15803d' : num >= 5.0 ? '#d97706' : '#dc2626';
  const gradeLabel =
    num === null ? '未评分' : num >= 7.0 ? '偏强修复' : num >= 6.0 ? '结构偏多' : num >= 5.0 ? '震荡分化' : num >= 4.0 ? '弱势防守' : '冰点风险';

  return `<div class="score-gauge">
    <svg viewBox="0 0 96 96" width="94" height="94">
      <circle cx="48" cy="48" r="${r}" fill="none" stroke="var(--border)" stroke-width="7.5"/>
      <circle cx="48" cy="48" r="${r}" fill="none" stroke="${color}" stroke-width="7.5"
        stroke-linecap="round" stroke-dasharray="${dash} ${circ.toFixed(1)}"
        transform="rotate(-90 48 48)"/>
      <text x="48" y="47" text-anchor="middle" class="gauge-num" fill="var(--text)">${num !== null ? num.toFixed(1) : '—'}</text>
      <text x="48" y="63" text-anchor="middle" class="gauge-sub" fill="var(--muted)">/ 10 分</text>
    </svg>
    <div class="gauge-tag" style="color:${color};border-color:${color}44;background:${color}14">${gradeLabel}</div>
  </div>`;
}

/**
 * 解析“市场状态”字符串（投机=...；趋势成长=...；防御/上游=...）为三联卡片
 */
function parseMarketStateCards(marketState) {
  if (!marketState || !marketState.trim()) return [];
  const parts = marketState
    .split(/[；;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const cards = [];
  for (const p of parts) {
    const m = p.match(/^([^=：:]{2,12})[=：:]\s*(.+)$/);
    if (m) {
      const label = m[1].trim();
      const tone = /投机|短线/.test(label)
        ? 'amber'
        : /成长|趋势|价值/.test(label)
        ? 'navy'
        : 'teal';
      cards.push({ label, text: m[2].trim(), tone });
    } else if (cards.length > 0) {
      cards[cards.length - 1].text += `；${p}`;
    } else {
      cards.push({ label: '市场状态', text: p, tone: 'navy' });
    }
  }
  return cards;
}

/**
 * 从无 packet 的历史 Markdown 正文提取基础 KPI，让历史旧复盘也能呈现核心指标条
 */
function extractFallbackKpis(rawText) {
  const txt = String(rawText || '');
  const amtMatch =
    txt.match(/(?:沪深两市|沪深|两市)?成交(?:额)?[^0-9\n]{0,12}([0-9]+(?:\.[0-9]+)?)\s*(万亿|亿元|亿)/) ||
    txt.match(/([0-9]+(?:\.[0-9]+)?)\s*万亿/);
  let twoMarketAmtStr = '—';
  if (amtMatch) {
    const v = Number(amtMatch[1]);
    const unit = amtMatch[2] || '万亿';
    twoMarketAmtStr = unit.includes('万') ? `${v} 万亿` : v >= 10000 ? `${(v / 10000).toFixed(3)} 万亿` : `${v} 亿`;
  }

  const volDeltaMatch = txt.match(/(放量|缩量)[^0-9\n]{0,8}([0-9]+(?:\.[0-9]+)?)\s*(亿|%|pct)/);
  const volSub = volDeltaMatch ? `较前日 ${volDeltaMatch[1]} ${volDeltaMatch[2]}${volDeltaMatch[3]}` : '以台账原文为准';

  const redMatch = txt.match(/红盘率[^0-9\n]{0,8}([0-9]+(?:\.[0-9]+)?)%/);
  const upDownMatch = txt.match(/(\d{3,4})\s*涨[^\d]{1,6}(\d{3,4})\s*跌/) || txt.match(/涨\s*(\d{3,4})[^\d]{1,6}跌\s*(\d{3,4})/);
  const up = upDownMatch ? Number(upDownMatch[1]) : null;
  const down = upDownMatch ? Number(upDownMatch[2]) : null;
  const redRatePct = redMatch
    ? Number(redMatch[1])
    : up !== null && down !== null && up + down > 0
    ? Number(((up / (up + down)) * 100).toFixed(1))
    : null;

  const ztMatch = txt.match(/(?:非ST)?涨停\s*(\d{1,3})/) || txt.match(/(\d{1,3})\s*(?:只|家)?涨停/);
  const dtMatch = txt.match(/(?:非ST)?跌停\s*(\d{1,3})/) || txt.match(/(\d{1,3})\s*(?:只|家)?跌停/);
  const zbMatch = txt.match(/炸板\s*(\d{1,3})/) || txt.match(/(\d{1,3})\s*(?:只|家)?炸板/);
  const sealMatch = txt.match(/封板率\s*([0-9]+(?:\.[0-9]+)?)%/);
  const boardMatch = txt.match(/(?:最高连板(?:高度)?|高度(?:重建至|降至|回升至|维持)?)\s*(\d{1,2})\s*板/) || txt.match(/双(\d)板/);

  return {
    twoMarketAmtStr,
    volSub,
    redRatePct,
    up,
    down,
    ztCount: ztMatch ? Number(ztMatch[1]) : null,
    dtCount: dtMatch ? Number(dtMatch[1]) : null,
    zbCount: zbMatch ? Number(zbMatch[1]) : null,
    sealRatePct: sealMatch ? Number(sealMatch[1]) : null,
    maxBoard: boardMatch ? Number(boardMatch[1]) : null,
  };
}

/**
 * 智能解析“日内结构”文本 → 4 阶段时间轴（竞价/早盘/午盘/尾盘）+ 个股分时卡片
 */
function renderIntradayTimelineSection(content) {
  if (!content || !content.trim()) return '';
  const cleaned = content.replace(/^四、日内结构[｜|]\s*/, '').trim();

  // 检查是否可按 ① ② ③ ④ 拆出四段节奏
  const hasStages = /[①②③④]/.test(cleaned) && /(竞价|开盘)/.test(cleaned) && /(早盘|午盘|尾盘)/.test(cleaned);
  if (!hasStages) {
    return renderCleanMarkdown(cleaned);
  }

  // 把“逐股分时”或“七指数最大10分钟”从第四段里拆出
  let mainFlow = cleaned;
  let stockIntraday = '';
  let tenMinSummary = '';

  const stockIdx = mainFlow.indexOf('逐股分时：');
  if (stockIdx !== -1) {
    stockIntraday = mainFlow.slice(stockIdx + 5).trim();
    mainFlow = mainFlow.slice(0, stockIdx).trim();
  }
  const tenIdx = mainFlow.indexOf('七指数最大10分钟');
  if (tenIdx !== -1) {
    tenMinSummary = mainFlow.slice(tenIdx).trim();
    mainFlow = mainFlow.slice(0, tenIdx).trim();
  }

  const stageMatches = mainFlow.split(/(?=[①②③④])/).map((s) => s.trim()).filter(Boolean);
  const stageMeta = [
    { key: '09:15–09:30', label: '竞价与开盘', tone: 'navy' },
    { key: '09:30–11:30', label: '早盘博弈', tone: 'amber' },
    { key: '13:00–14:30', label: '午盘主浪', tone: 'crimson' },
    { key: '14:30–15:00', label: '尾盘定调', tone: 'teal' },
  ];

  const timelineHtml = `<div class="timeline-grid">${stageMatches
    .map((seg, idx) => {
      const m = seg.match(/^[①②③④]\s*([^：:]{2,10})[：:]\s*([\s\S]+)$/);
      const title = m ? m[1].trim() : stageMeta[idx]?.label || `阶段 ${idx + 1}`;
      const body = m ? m[2].trim() : seg.replace(/^[①②③④]\s*/, '');
      const timeTag = stageMeta[idx]?.key || '';
      const tone = stageMeta[idx]?.tone || 'navy';
      return `<div class="stage-card stage-${tone}">
        <div class="stage-head">
          <span class="stage-num">${idx + 1}</span>
          <span class="stage-title">${esc(title)}</span>
          ${timeTag ? `<span class="stage-time mono">${timeTag}</span>` : ''}
        </div>
        <div class="stage-body">${formatRichInline(body)}</div>
      </div>`;
    })
    .join('')}</div>`;

  const extraBlocks = [];
  if (tenMinSummary) {
    const items = tenMinSummary
      .replace(/^七指数最大10分钟[^：:]*[：:]\s*/, '')
      .split(/[；;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    extraBlocks.push(
      `<div class="mini-callout"><div class="mini-callout-title">七指数 10 分钟最大脉冲 & 收盘位置</div><div class="chip-grid">${items
        .map((it) => `<div class="kv-pill">${formatRichInline(it)}</div>`)
        .join('')}</div></div>`
    );
  }
  if (stockIntraday) {
    const items = stockIntraday
      .split(/[；;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    extraBlocks.push(
      `<div class="mini-callout"><div class="mini-callout-title">核心观察股与龙头逐股分时拆解</div><div class="stock-note-grid">${items
        .map((it) => `<div class="stock-note-item">${formatRichInline(it)}</div>`)
        .join('')}</div></div>`
    );
  }

  return timelineHtml + extraBlocks.join('');
}

/**
 * 智能解析“双线拆分” → 投机高标线 vs 价值成长线（+ 防御/纪律）双栏对照
 */
function renderDualLineSection(content) {
  if (!content || !content.trim()) return '';
  const cleaned = content.replace(/^五、[^｜\n]{1,14}[｜|]\s*/, '').trim();

  const valIdx = cleaned.search(/价值成长|趋势成长/);
  const defIdx = cleaned.search(/防御样本|防御\/上游|双线仓位框架/);
  if (valIdx > 15) {
    const specText = cleaned.slice(0, valIdx).trim();
    const valEnd = defIdx > valIdx ? defIdx : cleaned.length;
    const valText = cleaned.slice(valIdx, valEnd).trim();
    const tailText = defIdx > valIdx ? cleaned.slice(defIdx).trim() : '';

    return `<div class="dual-grid">
      <div class="dual-col dual-amber">
        <div class="dual-head">⚡ 投机高标线（短线情绪与梯队）</div>
        <div class="dual-body">${formatRichInline(specText)}</div>
      </div>
      <div class="dual-col dual-navy">
        <div class="dual-head">📈 价值成长线（产业逻辑与核心权重大票）</div>
        <div class="dual-body">${formatRichInline(valText)}</div>
      </div>
    </div>${
      tailText
        ? `<div class="mini-callout" style="margin-top:12px"><div class="mini-callout-title">🛡️ 防御对照 & 双线独立仓位纪律</div><div class="rpt-p" style="margin:0">${formatRichInline(tailText)}</div></div>`
        : ''
    }`;
  }

  return renderCleanMarkdown(cleaned);
}

/**
 * 智能解析“行为金融检视” → 四象限偏差卡片网格
 */
function renderBehavioralSection(content) {
  if (!content || !content.trim()) return '';
  const cleaned = content.replace(/^九、行为金融检视[｜|]\s*/, '').trim();

  // 支持按 Markdown 列表项 `- **xxx**：...` 或按关键词切分
  const items = [];
  const bulletMatches = [...cleaned.matchAll(/^[-*]\s*\*\*([^*：:]+)[：:]?\*\*[：:]?\s*(.+)$/gm)];
  if (bulletMatches.length >= 2) {
    for (const m of bulletMatches) {
      items.push({ title: m[1].trim(), body: m[2].trim() });
    }
  } else {
    const segs = cleaned
      .split(/(?=(?:锚定效应|近因效应|处置效应|叙事拥挤|传闻驱动|幸存者偏差|损失厌恶|从众效应)[^：:\n]{0,14}[：:])/g)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const seg of segs) {
      const m = seg.match(/^([^：:\n]{2,18})[：:]\s*([\s\S]+)$/);
      if (m) items.push({ title: m[1].trim(), body: m[2].trim() });
    }
  }

  if (items.length >= 2) {
    return `<div class="behav-grid">${items
      .map(
        (it) => `<div class="behav-card">
          <div class="behav-title">${esc(it.title)}</div>
          <div class="behav-body">${formatRichInline(it.body)}</div>
        </div>`
      )
      .join('')}</div>`;
  }
  return renderCleanMarkdown(cleaned);
}

/**
 * 渲染上期跟踪锚核对看板（带顶部统计条 + 彩色裁定徽章）
 */
function renderAnchorChecksSection(anchorChecks, fallbackContent) {
  if (!anchorChecks || anchorChecks.length === 0) {
    return renderCleanMarkdown(fallbackContent || '- 本期无上期预设跟踪锚需核对。');
  }
  const counts = { pass: 0, partial: 0, fail: 0, missing: 0 };
  const classify = (v) => {
    const s = String(v || '');
    if (/部分/.test(s)) return 'partial';
    if (/证伪|失败/.test(s)) return 'fail';
    if (/成立|兑现|命中/.test(s)) return 'pass';
    return 'missing';
  };
  for (const r of anchorChecks) counts[classify(r.verdict)]++;

  const badgeHtml = (v) => {
    const cls = classify(v);
    const labelMap = { pass: 'v-pass', partial: 'v-partial', fail: 'v-fail', missing: 'v-missing' };
    return `<span class="verdict-pill ${labelMap[cls]}">${esc(v || '未判定')}</span>`;
  };

  return `
    <div class="verdict-summary">
      <span class="verdict-pill v-pass">✓ 成立 ${counts.pass}</span>
      <span class="verdict-pill v-partial">◐ 部分成立 ${counts.partial}</span>
      <span class="verdict-pill v-fail">✗ 证伪 ${counts.fail}</span>
      <span class="verdict-pill v-missing">○ 未获得/不判定 ${counts.missing}</span>
    </div>
    <div class="tbl-wrap">
      <table class="rpt-table anchor-table">
        <thead>
          <tr><th style="width:19%">跟踪锚</th><th style="width:27%">上期预设</th><th style="width:40%">当日事实证据</th><th style="width:14%">裁定</th></tr>
        </thead>
        <tbody>
          ${anchorChecks
            .map(
              (r) => `<tr>
                <td class="strong-cell">${formatRichInline(r.anchor)}</td>
                <td class="muted-cell">${formatRichInline(r.preset)}</td>
                <td>${formatRichInline(r.evidence)}</td>
                <td style="text-align:center">${badgeHtml(r.verdict)}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

/**
 * 渲染高频方法论卡可信度矩阵（网格卡片，清晰扫读 14 张卡）
 */
function renderCredibilityMatrix(entries, fallbackContent) {
  if (!entries || entries.length === 0) {
    return renderCleanMarkdown(fallbackContent || '- 本日无高频方法论卡调整。');
  }
  return `<div class="cred-grid">${entries
    .map((e) => {
      const st = String(e.statusText || '');
      const tone = /\+0\./.test(st) ? 'cred-up' : /-0\./.test(st) ? 'cred-down' : 'cred-hold';
      return `<div class="cred-card ${tone}">
        <div class="cred-head">
          <button type="button" class="chip chip-method" data-kind="methodology" data-id="${esc(e.cardId)}">卡片 ${esc(e.cardId)}</button>
          <span class="cred-delta ${tone}">${esc(st)}</span>
        </div>
        <div class="cred-detail">${formatRichInline(e.detail)}</div>
      </div>`;
    })
    .join('')}</div>`;
}

/**
 * 渲染数据底座可视化板块（7 大指数 1m 分时 SVG 网格 + 连板梯队 + ≥3只板块集群柱状图 + 观察股分时表）
 */
function renderMarketPacketVisuals(packet) {
  if (!packet) return '';

  // 1. 7 大指数分时卡片网格
  const indexCardsHtml = (packet.indices || [])
    .map((idx) => {
      const pct = idx.dailyAuth?.pct;
      const cls = pctClass(pct);
      const intra = idx.intraday || {};
      const svg = buildIntradaySvg(intra.sparkline, {
        width: 280,
        height: 68,
        highTime: intra.dayHigh?.time,
        lowTime: intra.dayLow?.time,
      });
      const closePos = Number.isFinite(intra.closePosPct) ? intra.closePosPct : null;
      return `<div class="idx-card">
        <div class="idx-top">
          <div>
            <div class="idx-name">${esc(idx.name)}</div>
            <div class="idx-code mono">${esc(idx.code)}</div>
          </div>
          <div class="idx-quote ${cls}">
            <div class="idx-close mono">${idx.dailyAuth?.close ?? '—'}</div>
            <div class="idx-pct mono">${fmtPct(pct)}</div>
          </div>
        </div>
        ${svg}
        <div class="idx-meta mono">
          <span>高 ${intra.dayHigh?.price ?? idx.dailyAuth?.high ?? '—'} @${intra.dayHigh?.time || '—'}</span>
          <span>低 ${intra.dayLow?.price ?? idx.dailyAuth?.low ?? '—'} @${intra.dayLow?.time || '—'}</span>
        </div>
        <div class="idx-foot">
          ${
            intra.maxUp10m
              ? `<span class="pulse-tag pulse-up">▲ ${intra.maxUp10m.fromTime}→${intra.maxUp10m.toTime} ${fmtPct(intra.maxUp10m.deltaPct)}</span>`
              : ''
          }
          ${closePos !== null ? `<span class="pos-tag mono">收盘位 ${closePos}%</span>` : ''}
        </div>
      </div>`;
    })
    .join('');

  // 2. 连板梯队阶梯图
  const lp = packet.limitPools || {};
  const ladderHtml =
    lp.ok && Array.isArray(lp.boardLadder) && lp.boardLadder.length > 0
      ? (() => {
          const maxB = lp.maxBoard || Math.max(...lp.boardLadder.map((b) => b.board));
          const byB = new Map(lp.boardLadder.map((b) => [b.board, b]));
          const rows = [];
          for (let b = maxB; b >= 2; b--) {
            const grp = byB.get(b);
            if (!grp) {
              rows.push(`<div class="ladder-row ladder-gap">
                <div class="ladder-badge gap">${b}板</div>
                <div class="ladder-stocks"><span class="gap-text">⚠️ ${b}板断层空缺</span></div>
              </div>`);
            } else {
              rows.push(`<div class="ladder-row">
                <div class="ladder-badge">${b}板 <span>(${grp.count})</span></div>
                <div class="ladder-stocks">${grp.stocks
                  .map(
                    (s) => `<span class="stock-pill">
                      <strong>${esc(s.name)}</strong>
                      <span class="sp-meta">${esc(s.industry)} · ${esc(s.boardStyle)} · ${esc(s.firstSealTime?.slice(0, 5) || '')}</span>
                    </span>`
                  )
                  .join('')}</div>
              </div>`);
            }
          }
          return rows.join('');
        })()
      : '<div class="muted">暂无连板梯队数据</div>';

  // 3. ≥3 只板块集群横向柱状图
  const clusters = lp.ok && Array.isArray(lp.clustersGe3) ? lp.clustersGe3 : [];
  const maxClusterCount = clusters.length > 0 ? Math.max(...clusters.map((c) => c.count)) : 1;
  const clusterBarsHtml =
    clusters.length > 0
      ? `<div class="cluster-bars">${clusters
          .map((c) => {
            const w = Math.max(10, Math.round((c.count / maxClusterCount) * 100));
            return `<div class="cbar-row">
              <div class="cbar-label">
                <span class="cbar-name">${esc(c.industry)}</span>
                <span class="cbar-max">${c.maxBoard}板</span>
              </div>
              <div class="cbar-track">
                <div class="cbar-fill" style="width:${w}%"></div>
              </div>
              <div class="cbar-val mono">${c.count}只</div>
              <div class="cbar-samples">${esc((c.sampleStocks || []).slice(0, 3).join('、'))}</div>
            </div>`;
          })
          .join('')}</div>`
      : '<div class="muted">暂无 ≥3 只板块集群</div>';

  // 4. 跌停 & 炸板摘要条
  const dtList = (lp.dtStocks || []).map((s) => `${s.name}(${s.industry})`).join('、');
  const zbList = (lp.zbSample || [])
    .slice(0, 6)
    .map((s) => `${s.name}(${fmtPct(s.pct)},炸${s.openCount}次)`)
    .join('、');

  // 5. 观察股与龙头分时表（含内嵌 mini 1m sparkline）
  const watchRowsHtml = (packet.watchStocks || [])
    .map((s) => {
      const cls = pctClass(s.dailyAuth?.pct);
      const miniSvg = buildIntradaySvg(s.intraday?.sparkline, { width: 112, height: 30, mini: true });
      return `<tr>
        <td><strong>${esc(s.name)}</strong> <span class="mono muted">${esc(s.code)}</span></td>
        <td><span class="role-tag">${esc(s.role)}</span></td>
        <td class="mono num-r">${s.dailyAuth?.close ?? '—'}</td>
        <td class="mono num-r ${cls}"><strong>${fmtPct(s.dailyAuth?.pct)}</strong></td>
        <td style="width:120px;padding:4px 8px">${miniSvg}</td>
        <td class="mono num-r">${s.dailyAuth?.amountYi != null ? `${s.dailyAuth.amountYi}亿` : '—'}</td>
        <td class="mono num-r">${s.dailyAuth?.turnoverPct != null ? `${s.dailyAuth.turnoverPct}%` : '—'}</td>
        <td class="mono">${s.intraday?.dayHigh?.time || '—'} / ${s.intraday?.dayLow?.time || '—'}</td>
        <td class="mono num-r">${s.intraday?.closePosPct != null ? `${s.intraday.closePosPct}%` : '—'}</td>
      </tr>`;
    })
    .join('');

  // 6. 美股快照条
  const usStrip =
    packet.usOvernight?.ok && packet.usOvernight.items?.length > 0
      ? `<div class="us-strip">
          <div class="us-label">🌐 腾讯美股快照（美东 ${esc(packet.usOvernight.items[0]?.tradeTimeET || '')}，请按时间戳核对先后关系）</div>
          <div class="us-items">${packet.usOvernight.items
            .map(
              (u) => `<span class="us-pill ${pctClass(u.pct)}">
                <strong>${esc(u.name)}</strong> <span class="mono">${u.close}</span> <span class="mono">${fmtPct(u.pct)}</span>
              </span>`
            )
            .join('')}</div>
        </div>`
      : '';

  return `
    <section id="sec-charts" class="rpt-section">
      <div class="sec-head">
        <h2><span class="sec-bar"></span>核心指数 1 分钟分时图谱（真实 ${packet.totalIntradayBars} 条 1m K 线）</h2>
        <span class="sec-sub mono">权威日K(腾讯) + 东财 241 条正式交易分时 · 虚线=昨收 · 金线=均价线</span>
      </div>
      <div class="idx-grid">${indexCardsHtml}</div>
      ${usStrip}
    </section>

    <section id="sec-sentiment" class="rpt-section">
      <div class="sec-head">
        <h2><span class="sec-bar bar-amber"></span>情绪连板梯队 × 板块集群穷举（框架增订③）</h2>
        <span class="sec-sub">涨停 ${lp.ztCount ?? '—'} · 跌停 ${lp.dtCount ?? '—'} · 炸板 ${lp.zbCount ?? '—'} · 封板率 ${lp.sealRatePct ?? '—'}%</span>
      </div>
      <div class="sent-grid">
        <div class="sub-panel">
          <div class="sub-panel-title">连板空间梯队（最高 ${lp.maxBoard ?? '—'} 板 · 连板 ${lp.lianbanCount ?? '—'} 只）</div>
          ${ladderHtml}
          ${
            dtList || zbList
              ? `<div class="alert-strip">
                  ${dtList ? `<div><strong class="down">跌停池：</strong>${esc(dtList)}</div>` : ''}
                  ${zbList ? `<div><strong class="amber-txt">炸板样本：</strong>${esc(zbList)}</div>` : ''}
                </div>`
              : ''
          }
        </div>
        <div class="sub-panel">
          <div class="sub-panel-title">≥3 只涨停行业集群（共 ${clusters.length} 个分支）</div>
          ${clusterBarsHtml}
        </div>
      </div>

      ${
        watchRowsHtml
          ? `<div class="sub-panel" style="margin-top:14px">
              <div class="sub-panel-title">核心观察股 & 连板龙头 · 权威日K与 1 分钟分时结构</div>
              <div class="tbl-wrap">
                <table class="rpt-table">
                  <thead>
                    <tr>
                      <th>标的</th><th>池位角色</th><th class="num-r">收盘</th><th class="num-r">涨跌幅</th>
                      <th>1m 分时曲线</th><th class="num-r">成交额</th><th class="num-r">换手率</th><th>日高/日低时点</th><th class="num-r">收盘位</th>
                    </tr>
                  </thead>
                  <tbody>${watchRowsHtml}</tbody>
                </table>
              </div>
            </div>`
          : ''
      }
    </section>`;
}

/**
 * 构建完整独立的 HTML 文档（支持归档复盘 dailyReview 和未写盘草稿 draft 两种来源）
 */
function buildDailyReportHtml({
  date,
  headline,
  score,
  scoreReason,
  marketState,
  dataSource,
  evidenceCutoff,
  sections, // [{ key, title, content }]
  anchorChecks,
  credibilityEntries,
  nextAnchors,
  gaps,
  pendingOptNote,
  rawMarkdown,
  packet,
  ledgerVersion,
  isDraft = false,
  embedded = false,
  initialTheme = 'light',
}) {
  const effectivePacket = packet || loadArchivedMarketPacket(date);
  const fallbackKpis = !effectivePacket ? extractFallbackKpis(rawMarkdown || '') : null;

  // 1. 组装 KPI 4 卡片
  const twoMarketAmt = effectivePacket?.marketSummary?.twoMarketAmtYi != null
    ? fmtYi(effectivePacket.marketSummary.twoMarketAmtYi)
    : fallbackKpis?.twoMarketAmtStr || '—';
  const volDeltaStr =
    effectivePacket?.marketSummary?.volDeltaYi != null
      ? `较前日 ${effectivePacket.marketSummary.volDeltaYi > 0 ? '放量 +' : '缩量 '}${effectivePacket.marketSummary.volDeltaYi} 亿 (${fmtPct(effectivePacket.marketSummary.volDeltaPct)})`
      : fallbackKpis?.volSub || '—';
  const volDeltaCls = pctClass(effectivePacket?.marketSummary?.volDeltaYi);

  const breadth = effectivePacket?.marketSummary?.breadth;
  const redRate = breadth?.ok ? breadth.redRatePct : fallbackKpis?.redRatePct ?? null;
  const upCnt = breadth?.ok ? breadth.up : fallbackKpis?.up ?? null;
  const downCnt = breadth?.ok ? breadth.down : fallbackKpis?.down ?? null;
  const flatCnt = breadth?.ok ? breadth.flat : null;
  const totalBreadth = (upCnt || 0) + (downCnt || 0) + (flatCnt || 0);
  const upWidth = totalBreadth > 0 ? Math.round(((upCnt || 0) / totalBreadth) * 100) : redRate ?? 50;
  const downWidth = totalBreadth > 0 ? Math.round(((downCnt || 0) / totalBreadth) * 100) : 100 - upWidth;

  const lp = effectivePacket?.limitPools;
  const ztCnt = lp?.ok ? lp.ztCount : fallbackKpis?.ztCount;
  const dtCnt = lp?.ok ? lp.dtCount : fallbackKpis?.dtCount;
  const zbCnt = lp?.ok ? lp.zbCount : fallbackKpis?.zbCount;
  const sealRate = lp?.ok ? lp.sealRatePct : fallbackKpis?.sealRatePct;
  const maxBoard = lp?.ok ? lp.maxBoard : fallbackKpis?.maxBoard;
  const lianbanCnt = lp?.ok ? lp.lianbanCount : null;

  // 2. 市场状态三联卡
  const stateCards = parseMarketStateCards(marketState);

  // 3. 分节定位与差异化可视化渲染
  const findSec = (re) => sections.find((s) => re.test(s.title));
  const renderedTitles = new Set();

  const macroSec = findSec(/宏观|隔夜美股/);
  const factsSec = findSec(/指数与盘面|盘面事实/);
  const intraSec = findSec(/日内结构/);
  const dualSec = findSec(/主跌段拆分|双线拆分|双线标的池/);
  const anchorSec = findSec(/跟踪锚|衔接核对/);
  const credSec = findSec(/卡片可信度/);
  const failSec = findSec(/方法论失效|应用错误/);
  const behavSec = findSec(/行为金融/);
  const scoreSec = findSec(/评分与下一交易日|大盘整体评分|复盘总结/);

  [macroSec, factsSec, intraSec, dualSec, anchorSec, credSec, failSec, behavSec, scoreSec]
    .filter(Boolean)
    .forEach((s) => renderedTitles.add(s.title));

  // 未命中的附加历史小节（如早期的【模块 A】【模块 B】【勘误】【板块集群穷举】【选股】）原样保留渲染
  const extraSections = sections.filter((s) => !renderedTitles.has(s.title) && !/前置检查/.test(s.title));

  // 方法论失效 vs 应用错误双卡拆解
  let failHtml = '';
  if (failSec) {
    const mf = failSec.content.match(/方法论失效\*{0,2}[：:]\s*([^\n]+)/);
    const ae = failSec.content.match(/应用错误\*{0,2}[：:]\s*([^\n]+)/);
    if (mf || ae) {
      failHtml = `<div class="dual-grid">
        <div class="dual-col dual-crimson">
          <div class="dual-head">🔍 方法论失效评估</div>
          <div class="dual-body">${formatRichInline(mf ? mf[1] : '无')}</div>
        </div>
        <div class="dual-col dual-navy">
          <div class="dual-head">🧭 应用错误与口径校正</div>
          <div class="dual-body">${formatRichInline(ae ? ae[1] : '无新增')}</div>
        </div>
      </div>`;
    } else {
      failHtml = renderCleanMarkdown(failSec.content);
    }
  }

  // 次日跟踪锚编号卡片清单
  const nextAnchorsList = Array.isArray(nextAnchors)
    ? nextAnchors
    : String(nextAnchors || '')
        .split(/(?=[①②③④⑤⑥⑦⑧⑨⑩])|\r?\n/)
        .map((s) => s.replace(/[；;]\s*$/, '').trim())
        .filter(Boolean);

  const gapsList = Array.isArray(gaps)
    ? gaps
    : String(gaps || '')
        .split(/(?=[①②③④⑤⑥⑦⑧⑨⑩⑪⑫])|(?<=。)\s*/)
        .map((s) => s.trim())
        .filter(Boolean);

  // 评分加扣分说明
  const scoreNoteText =
    scoreReason ||
    (scoreSec?.content.match(/盘面评分[^。]*。\s*([^\n]+)/)?.[1] ||
      scoreSec?.content.match(/评分[^\n]*\n([\s\S]+)/)?.[1]?.split('\n')[0] ||
      '');

  const docTitle = `${date} A股每日复盘研报 · ${headline}`;

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${initialTheme === 'dark' ? 'dark' : 'light'}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(docTitle)}</title>
<style>
  :root {
    --bg: #f6f4ee;
    --surface: #ffffff;
    --surface-soft: #f1efe7;
    --text: #15202b;
    --text-2: #3b4a5a;
    --muted: #667587;
    --border: #e4e0d5;
    --border-strong: #cfc9ba;
    --navy: #14365d;
    --navy-soft: #eaf1f9;
    --teal: #0f766e;
    --teal-soft: #e4f5f2;
    --amber: #b45309;
    --amber-soft: #fef3c7;
    --crimson: #c81e1e;
    --crimson-soft: #fee2e2;
    --emerald: #15803d;
    --emerald-soft: #dcfce7;
    --up: #d92d20;
    --down: #15803d;
    --shadow: 0 2px 10px rgba(20, 38, 60, 0.05);
    --radius: 12px;
    --font-sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif;
    --font-serif: "Songti SC", "Noto Serif SC", Georgia, serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  [data-theme="dark"] {
    --bg: #0c1118;
    --surface: #131b26;
    --surface-soft: #1a2433;
    --text: #e7eef6;
    --text-2: #b8c6d8;
    --muted: #7f91a8;
    --border: #243144;
    --border-strong: #354761;
    --navy: #78b3f5;
    --navy-soft: rgba(59, 130, 246, 0.14);
    --teal: #2dd4bf;
    --teal-soft: rgba(45, 212, 191, 0.14);
    --amber: #f59e0b;
    --amber-soft: rgba(245, 158, 11, 0.14);
    --crimson: #f87171;
    --crimson-soft: rgba(248, 113, 113, 0.15);
    --emerald: #4ade80;
    --emerald-soft: rgba(74, 222, 128, 0.14);
    --up: #f87171;
    --down: #4ade80;
    --shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 14.5px;
    line-height: 1.72;
    -webkit-font-smoothing: antialiased;
  }
  .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .up { color: var(--up); }
  .down { color: var(--down); }
  .flat, .muted { color: var(--muted); }
  .amber-txt { color: var(--amber); }

  /* Sticky Utility Bar */
  .util-bar {
    position: sticky; top: 0; z-index: 50;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border);
    padding: 9px 20px;
    display: ${embedded ? 'flex' : 'flex'};
    align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  }
  .util-nav { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .util-brand { font-weight: 800; font-size: 13px; color: var(--navy); margin-right: 6px; letter-spacing: 0.02em; }
  .nav-pill {
    font-size: 12px; color: var(--text-2); text-decoration: none;
    padding: 3px 9px; border-radius: 99px; border: 1px solid transparent;
  }
  .nav-pill:hover { background: var(--surface-soft); border-color: var(--border); color: var(--text); }
  .util-actions { display: flex; gap: 6px; }
  .u-btn {
    border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
    border-radius: 7px; padding: 4px 10px; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .u-btn:hover { background: var(--surface-soft); }
  .u-btn-primary { background: var(--navy); color: #fff; border-color: var(--navy); }
  [data-theme="dark"] .u-btn-primary { background: #2563eb; border-color: #2563eb; }

  /* Main Container */
  .page { max-width: 1080px; margin: 0 auto; padding: ${embedded ? '18px 20px 44px' : '26px 22px 64px'}; }

  /* Hero Masthead */
  .hero {
    background: var(--surface);
    border: 1px solid var(--border);
    border-top: 4px solid var(--navy);
    border-radius: var(--radius);
    padding: 24px 26px 22px;
    box-shadow: var(--shadow);
    margin-bottom: 18px;
  }
  .hero-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; flex-wrap: wrap; }
  .hero-main { flex: 1; min-width: 280px; }
  .hero-kicker { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
  .k-badge {
    font-size: 11.5px; font-weight: 700; padding: 2px 8px; border-radius: 5px;
    background: var(--navy-soft); color: var(--navy);
  }
  .k-date { background: var(--amber-soft); color: var(--amber); }
  .k-draft { background: var(--crimson-soft); color: var(--crimson); }
  .k-muted { background: var(--surface-soft); color: var(--muted); font-weight: 600; }
  .hero h1 {
    margin: 0 0 10px; font-size: 22px; line-height: 1.38; font-weight: 800; color: var(--text);
    letter-spacing: -0.01em;
  }
  .hero-source { font-size: 12px; color: var(--muted); line-height: 1.55; }

  .score-gauge { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; }
  .gauge-num { font-size: 23px; font-weight: 800; font-family: var(--font-mono); }
  .gauge-sub { font-size: 10.5px; font-weight: 600; }
  .gauge-tag { margin-top: 4px; font-size: 11.5px; font-weight: 700; padding: 2px 10px; border-radius: 99px; border: 1px solid; }

  .state-trio {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px;
    margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border);
  }
  .state-card {
    padding: 10px 13px; border-radius: 9px; background: var(--surface-soft);
    border-left: 3.5px solid var(--navy); font-size: 13px; line-height: 1.55;
  }
  .state-card.tone-amber { border-left-color: var(--amber); }
  .state-card.tone-teal { border-left-color: var(--teal); }
  .state-label { font-size: 11.5px; font-weight: 800; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 3px; }

  /* KPI Strip */
  .kpi-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
  .kpi-box {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px 16px; box-shadow: var(--shadow);
  }
  .kpi-lbl { font-size: 12px; color: var(--muted); font-weight: 600; }
  .kpi-val { font-size: 23px; font-weight: 800; margin: 3px 0 4px; line-height: 1.2; letter-spacing: -0.02em; }
  .kpi-sub { font-size: 12px; color: var(--text-2); }
  .breadth-bar {
    display: flex; height: 6px; border-radius: 99px; overflow: hidden;
    background: var(--surface-soft); margin: 6px 0 4px;
  }
  .bb-up { background: var(--up); }
  .bb-flat { background: #94a3b8; }
  .bb-down { background: var(--down); }

  /* Sections */
  .rpt-section {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 20px 22px; margin-bottom: 16px; box-shadow: var(--shadow);
    break-inside: avoid-page;
  }
  .sec-head {
    display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--border);
  }
  .sec-head h2 { margin: 0; font-size: 16px; font-weight: 800; display: flex; align-items: center; gap: 9px; color: var(--text); }
  .sec-bar { width: 4px; height: 17px; border-radius: 3px; background: var(--navy); display: inline-block; }
  .bar-amber { background: var(--amber); }
  .bar-teal { background: var(--teal); }
  .bar-crimson { background: var(--crimson); }
  .sec-sub { font-size: 12px; color: var(--muted); }

  /* Index 1m Sparkline Cards */
  .idx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(225px, 1fr)); gap: 11px; }
  .idx-card {
    border: 1px solid var(--border); border-radius: 10px; padding: 11px 13px;
    background: color-mix(in srgb, var(--surface-soft) 40%, var(--surface));
  }
  .idx-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px; }
  .idx-name { font-weight: 700; font-size: 13.5px; }
  .idx-code { font-size: 11px; color: var(--muted); }
  .idx-quote { text-align: right; line-height: 1.25; }
  .idx-close { font-weight: 800; font-size: 14px; }
  .idx-pct { font-weight: 700; font-size: 12.5px; }
  .spark-svg { width: 100%; height: 64px; display: block; color: var(--muted); }
  .spark-mini { width: 110px; height: 28px; }
  .svg-empty { height: 50px; display: flex; align-items: center; justify-content: center; font-size: 11.5px; color: var(--muted); }
  .idx-meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-top: 6px; }
  .idx-foot { display: flex; justify-content: space-between; align-items: center; gap: 4px; margin-top: 5px; flex-wrap: wrap; }
  .pulse-tag { font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 4px; }
  .pulse-up { background: var(--crimson-soft); color: var(--up); }
  .pos-tag { font-size: 10.5px; color: var(--muted); margin-left: auto; }

  /* US Strip */
  .us-strip {
    margin-top: 14px; padding: 10px 13px; border-radius: 9px;
    background: var(--surface-soft); border: 1px solid var(--border);
  }
  .us-label { font-size: 11.5px; font-weight: 700; color: var(--muted); margin-bottom: 7px; }
  .us-items { display: flex; gap: 7px; flex-wrap: wrap; }
  .us-pill {
    font-size: 12px; padding: 3px 9px; border-radius: 6px;
    background: var(--surface); border: 1px solid var(--border);
  }

  /* Sentiment & Clusters */
  .sent-grid { display: grid; grid-template-columns: 1fr 1.15fr; gap: 14px; }
  .sub-panel { border: 1px solid var(--border); border-radius: 10px; padding: 13px 15px; background: color-mix(in srgb, var(--surface-soft) 30%, var(--surface)); }
  .sub-panel-title { font-size: 13px; font-weight: 800; color: var(--navy); margin-bottom: 10px; }

  .ladder-row { display: flex; gap: 10px; align-items: flex-start; padding: 7px 0; border-bottom: 1px dashed var(--border); }
  .ladder-row:last-child { border-bottom: none; }
  .ladder-badge {
    min-width: 66px; text-align: center; font-size: 12px; font-weight: 800;
    padding: 3px 7px; border-radius: 6px; background: var(--crimson-soft); color: var(--up); flex-shrink: 0;
  }
  .ladder-badge span { font-weight: 600; opacity: 0.85; }
  .ladder-badge.gap { background: var(--amber-soft); color: var(--amber); }
  .ladder-stocks { display: flex; gap: 6px; flex-wrap: wrap; }
  .stock-pill {
    font-size: 12px; padding: 3px 8px; border-radius: 6px;
    background: var(--surface); border: 1px solid var(--border); display: inline-flex; gap: 5px; align-items: baseline;
  }
  .sp-meta { font-size: 11px; color: var(--muted); }
  .gap-text { font-size: 12px; color: var(--amber); font-weight: 600; }
  .alert-strip {
    margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--border);
    font-size: 12px; display: flex; flex-direction: column; gap: 4px; color: var(--text-2);
  }

  /* Cluster Horizontal Bars */
  .cluster-bars { display: flex; flex-direction: column; gap: 7px; }
  .cbar-row {
    display: grid; grid-template-columns: 118px 1fr 44px minmax(110px, 0.9fr);
    gap: 8px; align-items: center; font-size: 12px;
  }
  .cbar-label { display: flex; align-items: center; justify-content: space-between; gap: 4px; min-width: 0; }
  .cbar-name { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cbar-max { font-size: 10.5px; color: var(--amber); background: var(--amber-soft); padding: 0 5px; border-radius: 4px; font-weight: 700; flex-shrink: 0; }
  .cbar-track { height: 9px; background: var(--surface-soft); border-radius: 99px; overflow: hidden; }
  .cbar-fill { height: 100%; border-radius: 99px; background: linear-gradient(90deg, var(--navy) 0%, var(--teal) 100%); }
  .cbar-val { font-weight: 700; text-align: right; color: var(--text); }
  .cbar-samples { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Timeline 4 Stages */
  .timeline-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .stage-card {
    border: 1px solid var(--border); border-left: 4px solid var(--navy);
    border-radius: 9px; padding: 12px 14px; background: var(--surface);
  }
  .stage-amber { border-left-color: var(--amber); }
  .stage-crimson { border-left-color: var(--crimson); }
  .stage-teal { border-left-color: var(--teal); }
  .stage-head { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
  .stage-num {
    width: 20px; height: 20px; border-radius: 50%; background: var(--navy-soft); color: var(--navy);
    font-size: 11.5px; font-weight: 800; display: inline-flex; align-items: center; justify-content: center;
  }
  .stage-title { font-weight: 800; font-size: 13.5px; }
  .stage-time { margin-left: auto; font-size: 11px; color: var(--muted); }
  .stage-body { font-size: 13.5px; color: var(--text-2); line-height: 1.7; }

  .mini-callout {
    margin-top: 12px; padding: 12px 14px; border-radius: 9px;
    background: var(--surface-soft); border: 1px solid var(--border);
  }
  .mini-callout-title { font-size: 12px; font-weight: 800; color: var(--navy); margin-bottom: 8px; }
  .chip-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 6px; }
  .kv-pill { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 5px 9px; font-size: 12.5px; }
  .stock-note-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 7px; }
  .stock-note-item { background: var(--surface); border: 1px solid var(--border); border-radius: 7px; padding: 7px 10px; font-size: 12.5px; line-height: 1.55; }

  /* Dual Line & Behavioral Grids */
  .dual-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .dual-col { border: 1px solid var(--border); border-top: 3.5px solid var(--navy); border-radius: 9px; padding: 13px 15px; background: var(--surface-soft); }
  .dual-amber { border-top-color: var(--amber); }
  .dual-crimson { border-top-color: var(--crimson); }
  .dual-head { font-weight: 800; font-size: 13.5px; margin-bottom: 7px; color: var(--text); }
  .dual-body { font-size: 13.5px; color: var(--text-2); line-height: 1.72; }

  .behav-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .behav-card { border: 1px solid var(--border); border-radius: 9px; padding: 11px 14px; background: color-mix(in srgb, var(--surface-soft) 50%, var(--surface)); }
  .behav-title { font-weight: 800; font-size: 13px; color: var(--navy); margin-bottom: 4px; }
  .behav-body { font-size: 13px; color: var(--text-2); line-height: 1.65; }

  /* Tables */
  .tbl-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 9px; }
  .rpt-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .rpt-table th {
    text-align: left; font-size: 11.5px; font-weight: 700; color: var(--muted);
    padding: 8px 10px; background: var(--surface-soft); border-bottom: 1px solid var(--border-strong);
    white-space: nowrap;
  }
  .rpt-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; line-height: 1.55; }
  .rpt-table tr:last-child td { border-bottom: none; }
  .num-r { text-align: right; }
  .strong-cell { font-weight: 700; color: var(--text); }
  .muted-cell { color: var(--muted); font-size: 12.5px; }
  .role-tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--navy-soft); color: var(--navy); font-weight: 600; white-space: nowrap; }

  /* Verdict Pills */
  .verdict-summary { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
  .verdict-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: 99px; font-size: 11.5px; font-weight: 700; white-space: nowrap; }
  .v-pass { background: var(--emerald-soft); color: var(--emerald); }
  .v-partial { background: var(--amber-soft); color: var(--amber); }
  .v-fail { background: var(--crimson-soft); color: var(--crimson); }
  .v-missing { background: var(--surface-soft); color: var(--muted); }

  /* Credibility Matrix */
  .cred-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
  .cred-card { border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px; background: var(--surface); }
  .cred-card.cred-up { border-left: 3.5px solid var(--emerald); }
  .cred-card.cred-down { border-left: 3.5px solid var(--crimson); }
  .cred-card.cred-hold { border-left: 3.5px solid var(--border-strong); }
  .cred-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 4px; }
  .cred-delta { font-size: 11.5px; font-weight: 700; padding: 1px 7px; border-radius: 5px; font-family: var(--font-mono); }
  .cred-delta.cred-up { background: var(--emerald-soft); color: var(--emerald); }
  .cred-delta.cred-down { background: var(--crimson-soft); color: var(--crimson); }
  .cred-delta.cred-hold { background: var(--surface-soft); color: var(--muted); }
  .cred-detail { font-size: 12.5px; color: var(--text-2); line-height: 1.55; }

  /* Next Anchors Checklist & Gaps */
  .anchor-cards { display: flex; flex-direction: column; gap: 8px; }
  .next-card {
    display: flex; gap: 11px; align-items: flex-start;
    padding: 10px 13px; border-radius: 9px; border: 1px solid var(--border);
    background: color-mix(in srgb, var(--navy-soft) 28%, var(--surface));
  }
  .next-idx {
    width: 24px; height: 24px; border-radius: 6px; background: var(--navy); color: #fff;
    font-size: 12px; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px;
  }
  .gap-box {
    border: 1px dashed var(--amber); background: color-mix(in srgb, var(--amber-soft) 45%, var(--surface));
    border-radius: 10px; padding: 14px 16px; margin-top: 14px;
  }
  .gap-title { font-size: 13px; font-weight: 800; color: var(--amber); margin-bottom: 6px; }
  .gap-list { margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--text-2); display: flex; flex-direction: column; gap: 4px; }

  /* Prose & Semantic Chips */
  .rpt-p { margin: 0 0 10px; color: var(--text-2); }
  .rpt-p:last-child { margin-bottom: 0; }
  .rpt-list { margin: 0 0 8px; padding-left: 19px; color: var(--text-2); display: flex; flex-direction: column; gap: 6px; }
  .rpt-list-soft li { padding-bottom: 4px; border-bottom: 1px dashed color-mix(in srgb, var(--border) 65%, transparent); }
  .rpt-list-soft li:last-child { border-bottom: none; padding-bottom: 0; }
  .sub-h4 { margin: 12px 0 6px; font-size: 14px; color: var(--navy); }
  .inline-gap {
    display: inline-block; padding: 0 5px; border-radius: 4px; font-size: 0.9em; font-weight: 700;
    background: var(--amber-soft); color: var(--amber);
  }
  .chip {
    display: inline-flex; align-items: center; padding: 0 5px; margin: 0 1px;
    border-radius: 4px; font-size: 12px; font-weight: 700; font-family: var(--font-mono);
    border: 1px solid transparent; cursor: ${embedded ? 'pointer' : 'default'}; vertical-align: baseline;
  }
  .chip-method { background: var(--navy-soft); color: var(--navy); border-color: color-mix(in srgb, var(--navy) 22%, transparent); }
  .chip-cog { background: var(--teal-soft); color: var(--teal); border-color: color-mix(in srgb, var(--teal) 22%, transparent); }
  .chip-conflict { background: var(--crimson-soft); color: var(--crimson); border-color: color-mix(in srgb, var(--crimson) 22%, transparent); }

  .rpt-footer {
    text-align: center; font-size: 12px; color: var(--muted); padding: 14px 8px 0;
    border-top: 1px solid var(--border); margin-top: 18px;
  }

  @media (max-width: 820px) {
    .kpi-strip, .state-trio, .sent-grid, .timeline-grid, .dual-grid, .behav-grid, .cred-grid {
      grid-template-columns: 1fr;
    }
    .cbar-row { grid-template-columns: 100px 1fr 40px; }
    .cbar-samples { display: none; }
  }
  @media print {
    body { background: #fff !important; color: #111 !important; font-size: 12px; }
    .util-bar { display: none !important; }
    .page { max-width: 100%; padding: 0; }
    .hero, .kpi-box, .rpt-section { box-shadow: none !important; break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="util-bar">
    <div class="util-nav">
      <span class="util-brand">二级投研 · 每日复盘</span>
      <a class="nav-pill" href="#sec-top">总览</a>
      ${effectivePacket ? '<a class="nav-pill" href="#sec-charts">1m分时图谱</a><a class="nav-pill" href="#sec-sentiment">梯队聚类</a>' : ''}
      ${macroSec ? '<a class="nav-pill" href="#sec-macro">宏观外围</a>' : ''}
      ${intraSec ? '<a class="nav-pill" href="#sec-intraday">日内节奏</a>' : ''}
      ${dualSec ? '<a class="nav-pill" href="#sec-dualline">双线分治</a>' : ''}
      <a class="nav-pill" href="#sec-anchors">锚点核对</a>
      <a class="nav-pill" href="#sec-cred">高频卡矩阵</a>
      ${behavSec ? '<a class="nav-pill" href="#sec-behav">行为金融</a>' : ''}
      <a class="nav-pill" href="#sec-next">次日观察</a>
    </div>
    <div class="util-actions" style="${embedded ? 'display:none' : ''}">
      <button type="button" class="u-btn" id="themeBtn" onclick="toggleTheme()">切换深色</button>
      <button type="button" class="u-btn u-btn-primary" onclick="window.print()">打印 / 存 PDF</button>
    </div>
  </div>

  <main class="page" id="sec-top">
    <!-- Hero Executive Masthead -->
    <header class="hero">
      <div class="hero-top">
        <div class="hero-main">
          <div class="hero-kicker">
            <span class="k-badge k-date mono">${esc(date)}</span>
            <span class="k-badge">A股每日复盘研报</span>
            ${isDraft ? '<span class="k-badge k-draft">草稿预览（尚未落库）</span>' : `<span class="k-badge k-muted mono">台账 ${esc(ledgerVersion || 'v3')}</span>`}
            ${effectivePacket ? `<span class="k-badge k-muted mono">真实 1m K线 ${effectivePacket.totalIntradayBars} 条</span>` : ''}
          </div>
          <h1>${esc(headline)}</h1>
          <div class="hero-source">
            ${dataSource ? `<strong>数据口径：</strong>${esc(dataSource)}` : ''}
            ${evidenceCutoff ? `<span class="mono"> · 证据冻结 ${esc(evidenceCutoff)}</span>` : ''}
          </div>
        </div>
        ${buildScoreGaugeSvg(score)}
      </div>

      ${
        stateCards.length > 0
          ? `<div class="state-trio">${stateCards
              .map(
                (sc) => `<div class="state-card tone-${sc.tone}">
                  <div class="state-label">${esc(sc.label)}</div>
                  <div>${formatRichInline(sc.text)}</div>
                </div>`
              )
              .join('')}</div>`
          : ''
      }
    </header>

    <!-- 4-Card KPI Telemetry Strip -->
    <section class="kpi-strip">
      <div class="kpi-box">
        <div class="kpi-lbl">沪深两市总成交</div>
        <div class="kpi-val mono">${esc(twoMarketAmt)}</div>
        <div class="kpi-sub mono ${volDeltaCls}">${esc(volDeltaStr)}</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-lbl">全市场广度与红盘率</div>
        <div class="kpi-val mono ${redRate != null ? (redRate >= 50 ? 'up' : 'down') : ''}">${redRate != null ? `${redRate}%` : '—'}</div>
        <div class="breadth-bar">
          <div class="bb-up" style="width:${upWidth}%"></div>
          <div class="bb-flat" style="width:${Math.max(0, 100 - upWidth - downWidth)}%"></div>
          <div class="bb-down" style="width:${downWidth}%"></div>
        </div>
        <div class="kpi-sub mono">${upCnt != null && downCnt != null ? `涨 ${upCnt} / 跌 ${downCnt}${flatCnt != null ? ` / 平 ${flatCnt}` : ''}` : '详见盘面事实'}</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-lbl">非ST 涨停 / 跌停 / 炸板</div>
        <div class="kpi-val mono">
          <span class="up">${ztCnt ?? '—'}</span>
          <span class="muted" style="font-size:15px"> / </span>
          <span class="down">${dtCnt ?? '—'}</span>
          <span class="muted" style="font-size:15px"> / </span>
          <span>${zbCnt ?? '—'}</span>
        </div>
        <div class="kpi-sub mono">封板率 ${sealRate != null ? `${sealRate}%` : '—'}</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-lbl">最高连板高度与梯队</div>
        <div class="kpi-val mono">${maxBoard != null ? `${maxBoard} 板` : '—'}</div>
        <div class="kpi-sub mono">${lianbanCnt != null ? `连板股共 ${lianbanCnt} 只` : '详见连板梯队拆解'}</div>
      </div>
    </section>

    <!-- 真实分钟数据图表区（存在 packet 时全自动生成） -->
    ${renderMarketPacketVisuals(effectivePacket)}

    <!-- 宏观与隔夜外围 -->
    ${
      macroSec
        ? `<section id="sec-macro" class="rpt-section">
            <div class="sec-head">
              <h2><span class="sec-bar"></span>${esc(macroSec.title)}</h2>
              <span class="sec-sub">框架增订① · 宏观必查与外围时序边界</span>
            </div>
            ${renderCleanMarkdown(macroSec.content)}
          </section>`
        : ''
    }

    <!-- 指数与盘面事实详述 -->
    ${
      factsSec
        ? `<section id="sec-facts" class="rpt-section">
            <div class="sec-head">
              <h2><span class="sec-bar bar-teal"></span>${esc(factsSec.title)}</h2>
              <span class="sec-sub">全口径核验事实记录</span>
            </div>
            ${renderCleanMarkdown(factsSec.content)}
          </section>`
        : ''
    }

    <!-- 日内四段节奏时间轴 -->
    ${
      intraSec
        ? `<section id="sec-intraday" class="rpt-section">
            <div class="sec-head">
              <h2><span class="sec-bar bar-crimson"></span>${esc(intraSec.title)}</h2>
              <span class="sec-sub">竞价 → 早盘 → 午盘 → 尾盘 · 精确分钟转折</span>
            </div>
            ${renderIntradayTimelineSection(intraSec.content)}
          </section>`
        : ''
    }

    <!-- 双线分治对照栏 -->
    ${
      dualSec
        ? `<section id="sec-dualline" class="rpt-section">
            <div class="sec-head">
              <h2><span class="sec-bar bar-amber"></span>${esc(dualSec.title)}</h2>
              <span class="sec-sub">投机高标池 vs 价值成长池 · 独立止损不混管</span>
            </div>
            ${renderDualLineSection(dualSec.content)}
          </section>`
        : ''
    }

    <!-- 其他历史专属模块（如老格式模块A/B/勘误/选股池） -->
    ${extraSections
      .map(
        (s) => `<section class="rpt-section">
          <div class="sec-head">
            <h2><span class="sec-bar"></span>${esc(s.title)}</h2>
          </div>
          ${renderCleanMarkdown(s.content)}
        </section>`
      )
      .join('')}

    <!-- 上期跟踪锚核对看板 -->
    <section id="sec-anchors" class="rpt-section">
      <div class="sec-head">
        <h2><span class="sec-bar bar-teal"></span>上期跟踪锚逐条核对</h2>
        <span class="sec-sub">事前预设 vs 当日硬证据 · 杜绝事后诸葛亮</span>
      </div>
      ${renderAnchorChecksSection(anchorChecks, anchorSec?.content)}
    </section>

    <!-- 高频方法论卡可信度矩阵 -->
    <section id="sec-cred" class="rpt-section">
      <div class="sec-head">
        <h2><span class="sec-bar"></span>高频方法论卡可信度校准矩阵（${(credibilityEntries || []).length} 张）</h2>
        <span class="sec-sub">三处一致 · 防通胀与封存纪律</span>
      </div>
      ${renderCredibilityMatrix(credibilityEntries, credSec?.content)}
    </section>

    <!-- 方法论失效 vs 应用错误 -->
    ${
      failSec
        ? `<section id="sec-audit" class="rpt-section">
            <div class="sec-head">
              <h2><span class="sec-bar bar-crimson"></span>${esc(failSec.title)}</h2>
              <span class="sec-sub">区分框架缺陷与执行口径偏差</span>
            </div>
            ${failHtml}
          </section>`
        : ''
    }

    <!-- 行为金融检视 -->
    ${
      behavSec
        ? `<section id="sec-behav" class="rpt-section">
            <div class="sec-head">
              <h2><span class="sec-bar bar-amber"></span>${esc(behavSec.title)}</h2>
              <span class="sec-sub">常设模块 · 识别市场与自身认知偏差</span>
            </div>
            ${renderBehavioralSection(behavSec.content)}
          </section>`
        : ''
    }

    <!-- 评分依据 + 次日跟踪锚清单 + 缺口透明登记 -->
    <section id="sec-next" class="rpt-section">
      <div class="sec-head">
        <h2><span class="sec-bar bar-teal"></span>综合评分依据与次日跟踪锚</h2>
        <span class="sec-sub">仅供研究，不构成投资建议</span>
      </div>
      ${
        scoreNoteText
          ? `<div class="mini-callout" style="margin-top:0;margin-bottom:14px">
              <div class="mini-callout-title">📊 评分构成（${score ?? '—'} / 10 · 框架增订⑥校准）</div>
              <div class="rpt-p" style="margin:0">${formatRichInline(scoreNoteText)}</div>
            </div>`
          : ''
      }
      ${
        nextAnchorsList.length > 0
          ? `<div class="anchor-cards">${nextAnchorsList
              .map(
                (a, idx) => `<div class="next-card">
                  <span class="next-idx">${idx + 1}</span>
                  <div>${formatRichInline(a.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, ''))}</div>
                </div>`
              )
              .join('')}</div>`
          : '<p class="muted">（无次日跟踪锚记录）</p>'
      }

      ${
        gapsList.length > 0
          ? `<div class="gap-box">
              <div class="gap-title">⚠️ 数据缺口透明登记（缺失项严格保留为未获得，严禁编造）</div>
              <ul class="gap-list">${gapsList.map((g) => `<li>${formatRichInline(g)}</li>`).join('')}</ul>
            </div>`
          : ''
      }

      ${
        pendingOptNote
          ? `<div style="margin-top:10px;font-size:12px;color:var(--muted)"><strong>待拍板优化建议：</strong>${formatRichInline(pendingOptNote)}</div>`
          : ''
      }
    </section>

    <footer class="rpt-footer">
      <div>二级投研 · 三库闭环研究工作台生成 · 交易日 ${esc(date)} · 离线单文件 HTML 可直接分享与打印 PDF</div>
      <div style="margin-top:6px;font-size:11.5px;opacity:0.88;line-height:1.6">
        <strong>合规免责水印：</strong>${esc(DISCLAIMER_TEXT)} ${esc(EXECUTION_BOUNDARY_TEXT)}
      </div>
    </footer>
  </main>

<script>
  function toggleTheme() {
    var el = document.documentElement;
    var next = el.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    el.setAttribute('data-theme', next);
    var btn = document.getElementById('themeBtn');
    if (btn) btn.textContent = next === 'dark' ? '切换浅色' : '切换深色';
  }
  (function syncBtn() {
    var btn = document.getElementById('themeBtn');
    if (btn) btn.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '切换浅色' : '切换深色';
  })();
  ${
    embedded
      ? `document.addEventListener('click', function(e) {
          var chip = e.target.closest && e.target.closest('.chip[data-kind]');
          if (chip && window.parent && window.parent !== window) {
            window.parent.postMessage({
              type: 'srw-open-entity',
              kind: chip.getAttribute('data-kind'),
              id: chip.getAttribute('data-id')
            }, '*');
          }
        });`
      : ''
  }
</script>
</body>
</html>`;
}

/**
 * 入口 1：从已入库的 DailyReviewEntry 生成可视化 HTML
 */
function renderArchivedDailyReviewHtml(dailyReview, workspace, options = {}) {
  const preSec = (dailyReview.subsections || []).find((s) => /前置检查/.test(s.title));
  const dataSourceMatch = preSec?.content?.match(/数据来源与口径[：:]\s*([^\n]+)/);
  const cutoffMatch = preSec?.content?.match(/证据冻结时点[：:]\s*([^\n]+)/);

  return buildDailyReportHtml({
    date: dailyReview.date,
    headline: dailyReview.title,
    score: dailyReview.score,
    scoreReason: '',
    marketState: dailyReview.marketState,
    dataSource: dataSourceMatch ? dataSourceMatch[1].trim() : '',
    evidenceCutoff: cutoffMatch ? cutoffMatch[1].trim() : '',
    sections: dailyReview.subsections || [],
    anchorChecks: dailyReview.anchorChecks || [],
    credibilityEntries: dailyReview.credibilityEntries || [],
    nextAnchors: dailyReview.nextAnchors || [],
    gaps: dailyReview.gaps || [],
    pendingOptNote: dailyReview.pendingOptNote || '',
    rawMarkdown: dailyReview.rawMarkdown || '',
    packet: options.packet || null,
    ledgerVersion: workspace?.ledger?.meta?.version || '',
    isDraft: false,
    embedded: Boolean(options.embedded),
    initialTheme: options.theme || 'light',
  });
}

/**
 * 入口 2：从正在起草/刚由 AI 填好的每日复盘表单 + 实时 1m 数据包生成 HTML
 */
function renderDraftDailyReviewHtml(form, packet, workspace, options = {}) {
  const sections = [
    { title: '二、隔夜美股与宏观事件（框架增订①）', content: form.macroNotes || '' },
    { title: '三、指数与盘面事实', content: form.marketFacts || '' },
    { title: '四、日内结构（框架增订②）', content: form.intradayStructure || '' },
    { title: '五、主跌段拆分：投机高标 vs 价值成长', content: form.dualLineSplit || '' },
    {
      title: '八、方法论失效 vs 应用错误',
      content: `- **方法论失效**：${form.methodFailure || '无'}\n- **应用错误**：${form.applicationError || '无新增'}`,
    },
    { title: '九、行为金融检视（常设模块）', content: form.behavioralReview || '' },
  ];

  const credEntries = (form.credibilityAdjustments || [])
    .filter((x) => x.cardId)
    .map((adj) => {
      const card = workspace?.methodology?.cards?.find((c) => c.id === adj.cardId);
      const oldScore = card?.credibilityScore ?? 0.5;
      const delta = Number(adj.delta || 0);
      const newScore = Math.max(0, Math.min(1, Number((oldScore + delta).toFixed(2))));
      const statusText =
        delta > 0 ? `${oldScore}→${newScore}，+${delta}` : delta < 0 ? `${oldScore}→${newScore}，${delta}` : `${oldScore}维持`;
      return { cardId: adj.cardId, statusText, detail: adj.reason || '按框架记录' };
    });

  return buildDailyReportHtml({
    date: form.date || packet?.actualTradeDate || '当日',
    headline: form.headline || `${form.date || ''} 每日 A 股复盘草稿`,
    score: form.score !== '' ? Number(form.score) : null,
    scoreReason: form.scoreReason || '',
    marketState: form.marketState || '',
    dataSource: form.dataSource || '',
    evidenceCutoff: form.evidenceCutoff || packet?.fetchedAt || '',
    sections,
    anchorChecks: form.anchorChecks || [],
    credibilityEntries: credEntries,
    nextAnchors: form.nextAnchors || '',
    gaps: form.gaps || '',
    pendingOptNote: '①-⑧维持待拍板，未拍板规则不自动执行。',
    rawMarkdown: `${form.macroNotes || ''}\n${form.marketFacts || ''}\n${form.intradayStructure || ''}`,
    packet: packet || null,
    ledgerVersion: workspace?.ledger?.meta?.version || '',
    isDraft: true,
    embedded: Boolean(options.embedded),
    initialTheme: options.theme || 'light',
  });
}

/**
 * 将生成的独立分享版 HTML 保存到本地目录 复盘简报HTML/
 */
function saveReportHtmlToDisk(date, html, suffix = '') {
  const dir = getExportHtmlDir();
  fs.mkdirSync(dir, { recursive: true });
  const safeDate = String(date || 'report').replace(/[^0-9A-Za-z_-]/g, '');
  const safeSuffix = suffix ? `_${String(suffix).replace(/[^0-9A-Za-z_\u4e00-\u9fa5-]/g, '')}` : '';
  const fileName = `${safeDate}_A股复盘研报${safeSuffix}.html`;
  const fullPath = path.join(dir, fileName);
  fs.writeFileSync(fullPath, html, 'utf8');
  return { fileName, fullPath, dir, sizeBytes: Buffer.byteLength(html, 'utf8') };
}

module.exports = {
  get EXPORT_HTML_DIR() {
    return getExportHtmlDir();
  },
  renderArchivedDailyReviewHtml,
  renderDraftDailyReviewHtml,
  saveReportHtmlToDisk,
};
