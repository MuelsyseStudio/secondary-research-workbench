'use strict';

/**
 * 工作台个性化品牌中心（左上角图标、标题、副标题定制 + AI 风格统一化重绘）
 * - 持久化在 stateFile('brand-profile.local.json')，隔离在用户本地数据目录，打包便携版时自动剥离。
 * - 内置 8 款与暖羊皮纸 / 深蓝机构研报 UI 完美统一的预制徽标，支持自定义文字印章、上传图片风格融合与 AI 矢量重绘。
 */

const fs = require('node:fs');
const { stateFile } = require('./app-paths.cjs');
const { invokeModel } = require('./ai-provider.cjs');

const BRAND_ICON_PRESETS = [
  { id: 'seal_yan', name: '古典印章「研」', tag: '经典默认', desc: '深海藏青鎏金双框，典雅投研印章' },
  { id: 'bull_crest', name: '机构金牛徽章', tag: '华尔街风', desc: '鎏金公牛剪影，硬核二级投研质感' },
  { id: 'kline_peak', name: 'K 线山峰徽标', tag: '量化趋势', desc: '红绿阳阴 K 线构筑的趋势峰峦' },
  { id: 'alpha_compass', name: 'Alpha 星盘罗盘', tag: '宏观择时', desc: '藏青与鎏金罗盘指针，锚定主线方向' },
  { id: 'slime_seal', name: '粉彩蓝史莱姆徽', tag: '软萌陪伴', desc: '手绘粉彩天蓝小团子圆徽' },
  { id: 'whale_seal', name: '大肥鱼鲸尾徽', tag: '松弛投研', desc: '深海蓝鲸鱼尾波浪印记' },
  { id: 'scroll_tri', name: '三库卷轴金纹', tag: '知识复利', desc: '三层书卷叠加，象征方法论/认知/台账闭环' },
  { id: 'monogram', name: '自定义文字印章', tag: '自由定制', desc: '任意 1-2 个汉字或字母 + 5 种金融配色' },
];

const MONOGRAM_TONES = [
  { id: 'navy', name: '机构藏青', bg: '#183153', fg: '#f8f5ee', border: '#c89b3c' },
  { id: 'crimson', name: '朱砂印泥', bg: '#b8322c', fg: '#fff8f2', border: '#e6b877' },
  { id: 'emerald', name: '翡翠金融', bg: '#166549', fg: '#f2fbf7', border: '#9ad5bc' },
  { id: 'amber', name: '鎏金琥珀', bg: '#9a6518', fg: '#fffaf0', border: '#f0cf85' },
  { id: 'sky', name: '冰川浅蓝', bg: '#0369a1', fg: '#f0f9ff', border: '#7dd3fc' },
];

const DEFAULT_BRAND_PROFILE = {
  title: '二级投研工作台',
  subtitle: '三库闭环 · 日常维护与复盘',
  iconMode: 'preset', // 'preset' | 'monogram' | 'custom_image' | 'ai_svg'
  presetId: 'seal_yan',
  monogramText: '研',
  monogramTone: 'navy',
  customImageDataUrl: '',
  customImageStyle: 'workbench_harmonize', // 'workbench_harmonize' | 'ink_seal' | 'clean_cutout' | 'original'
  aiSvgMarkup: '',
  updatedAt: null,
};

function brandFilePath() {
  return stateFile('brand-profile.local.json');
}

function sanitizeSvgMarkup(raw) {
  let s = String(raw || '').trim();
  const match = s.match(/<svg[\s\S]*?<\/svg>/i);
  if (!match) return '';
  s = match[0];
  // 严格安全清洗：剥离 script / foreignObject / on* 事件 / javascript:
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/javascript\s*:/gi, '');
  if (!/viewBox=/i.test(s)) {
    s = s.replace(/<svg\b/i, '<svg viewBox="0 0 64 64"');
  }
  return s.slice(0, 12000);
}

function loadBrandProfile() {
  try {
    if (fs.existsSync(brandFilePath())) {
      const raw = JSON.parse(fs.readFileSync(brandFilePath(), 'utf8'));
      return {
        ...DEFAULT_BRAND_PROFILE,
        ...(raw || {}),
      };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_BRAND_PROFILE };
}

function saveBrandProfile(patch) {
  const cur = loadBrandProfile();
  const next = {
    ...cur,
    ...(patch || {}),
    updatedAt: new Date().toISOString(),
  };
  next.title = String(next.title || '二级投研工作台').trim().slice(0, 24) || '二级投研工作台';
  next.subtitle = String(next.subtitle || '').trim().slice(0, 36);
  next.monogramText = String(next.monogramText || '研').trim().slice(0, 2) || '研';
  if (next.customImageDataUrl && next.customImageDataUrl.length > 1500000) {
    throw new Error('自定义图标数据过大，请上传小于 1MB 的图片或使用自动压缩');
  }
  if (next.aiSvgMarkup) {
    next.aiSvgMarkup = sanitizeSvgMarkup(next.aiSvgMarkup);
  }
  fs.writeFileSync(brandFilePath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return getBrandState();
}

function resetBrandProfile() {
  if (fs.existsSync(brandFilePath())) fs.unlinkSync(brandFilePath());
  return getBrandState();
}

function getBrandState() {
  return {
    ok: true,
    profile: loadBrandProfile(),
    presets: BRAND_ICON_PRESETS,
    monogramTones: MONOGRAM_TONES,
  };
}

/**
 * AI 风格一致性图标生成/重构：
 * 将用户上传的图片（多模态识别）或创意描述，重构为与工作台「暖羊皮纸 / 机构藏青 #183153 / 鎏金 #c89b3c / 粉彩天蓝 #38bdf8」
 * 视觉体系 100% 协调的极简 64x64 矢量 SVG 应用图标！
 */
async function stylizeBrandIconWithAi({ imageBase64, imageMimeType, promptHint, title, stylePreset = 'editorial_navy', providerOverride }) {
  const styleDescMap = {
    editorial_navy: '机构研报藏青鎏金风：圆角方形深海藏青底(#183153)、细腻鎏金描边(#c89b3c)与象牙白(#faf7f0)极简几何/徽章图形',
    pastel_cute: '日系粉彩手绘萌系风：柔和浅天蓝(#e0f2fe)或奶油白底(#faf7f0)、粉彩天蓝(#38bdf8)与柔珊瑚粉(#fb7185)圆润可爱卡通徽标',
    crimson_seal: '复古朱砂印章风：古典朱砂红底(#b8322c)、暖金内框(#f0cf85)与米白极简纹样',
    minimal_mono: '极简现代金融线条风：暖白底(#faf7f0)、深墨蓝(#183153)2.5px精致单色几何图标配一抹鎏金(#c89b3c)点缀',
  };
  const chosenStyle = styleDescMap[stylePreset] || styleDescMap.editorial_navy;

  const systemPrompt = `你是顶级品牌与 App 图标设计师，专门为「暖羊皮纸 + 机构藏青 + 鎏金」视觉风格的桌面投研工作台设计 64x64 左上角正方形圆角应用图标。
请严格输出一段干净、独立、可直接渲染的 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">...</svg> 代码：
1. 必须包含外层圆角矩形背景 <rect x="2" y="2" width="60" height="60" rx="14" .../>，保证贴在浅色/深色侧边栏上都边缘利落、风格高度统一；
2. 严禁使用外部图片链接、严禁使用 <script> 或事件属性；
3. 图形控制在 6-18 个清晰优雅的矢量路径/基本图形，在 36x36px 小尺寸下依然一眼辨识、构图居中饱满、细节精致不凌乱；
4. 仅输出纯 SVG 代码，不要输出任何额外解释文字。`;

  const userPrompt = `请为工作台「${title || '二级投研工作台'}」设计/重构一款与工作台 UI 高度一致的左上角品牌图标。
目标风格：${chosenStyle}
${imageBase64 ? '参考用户上传的图片主体元素，提炼其最核心的特征轮廓与神韵，并用上述工作台统一色板重绘为高级感矢量徽标。' : ''}
用户补充创意说明：${promptHint || '结合金融投研与个人专属感，精致耐看'}
请直接输出 <svg viewBox="0 0 64 64">...</svg>：`;

  const modelRes = await invokeModel({
    providerOverride,
    systemPrompt,
    userPrompt,
    imageBase64: imageBase64 || undefined,
    imageMimeType: imageMimeType || undefined,
    expectJson: false,
    timeoutMs: 90000,
  });

  const cleanSvg = sanitizeSvgMarkup(modelRes.rawText);
  if (!cleanSvg) {
    throw new Error('AI 未返回有效 SVG 图标代码，请换一句更具体的图标描述或切换支持绘图的模型重试');
  }

  return {
    ok: true,
    svgMarkup: cleanSvg,
    provider: modelRes.provider,
    model: modelRes.model,
  };
}

module.exports = {
  BRAND_ICON_PRESETS,
  MONOGRAM_TONES,
  getBrandState,
  saveBrandProfile,
  resetBrandProfile,
  stylizeBrandIconWithAi,
};
