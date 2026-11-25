'use strict';

/**
 * 二级投研受控词表、金融同义词字典、产业链主题映射与实体提取规则
 * - 100% 确定性规则初标（零幻觉），同时供 FTS5 索引与三路混合检索复用
 */

const TAXONOMY = {
  domains: [
    'macro',
    'asset_allocation',
    'industry_research',
    'valuation',
    'financial_forensics',
    'technical',
    'trend_trading',
    'short_term_sentiment',
    'quant',
    'derivatives',
    'behavioral',
    'risk_position',
    'policy_event',
  ],
  regimes: [
    'all',
    'bull_main_wave',
    'structural_rotation',
    'weak_choppy',
    'bear_liquidity_crunch',
    'sentiment_ice_point',
    'sentiment_climax',
    'supply_inflation_shock',
    'growth_slowdown',
  ],
  horizons: ['intraday', 'swing_days', 'tactical_weeks', 'cyclical_quarters', 'secular_years'],
  asset_classes: ['a_share', 'us_equity', 'hk_equity', 'rates_bond', 'fx', 'commodity', 'cross_asset'],
};

/**
 * 二级投研同义词组（双向展开，用于解决 FTS5 词法盲区与跨市场术语对齐）
 */
const SYNONYM_GROUPS = [
  ['光模块', '光互连', '光互联', 'optical', '1.6t', '800g', 'cpo', 'npo', 'dsp', 'serdes', '硅光', '光器件', '光芯片', '光纤'],
  ['hbm', '存储', 'dram', 'nand', '内存', 'essd', '闪存', '存储周期', '长鑫', 'cxmt', '长存', 'ymtc', '美光', '海力士'],
  ['asic', '定制芯片', 'tpu', 'trainium', 'mtia', '推理芯片', '推理算力', '去英伟达'],
  ['gpu', '英伟达', 'nvda', 'rubin', 'blackwell', 'gb300', 'nvl72', 'nvlink', '算力卡'],
  ['先进封装', 'cowos', 'copos', 'cowop', '玻璃基板', 'tgv', '混合键合', '逻辑折叠', '韬定律', 'pspi', 'muf', '球硅', 'abf', '载板'],
  ['探针卡', 'mems', '晶圆测试', 'cp测试', 'kgd', '强一股份', '精智达', 'formfactor'],
  ['半导体设备', 'wfe', '光刻', 'duv', 'euv', '刻蚀', '薄膜沉积', 'cmp', '量测', '国产替代'],
  ['功率半导体', '模拟芯片', 'mcu', 'sic', 'gan', 'igbt', '8寸晶圆', '成熟制程'],
  ['数据中心', 'idc', 'aidc', '电力瓶颈', 'ercot', 'btm', '自备电源', '固态变压器', 'sst', '电网', '燃气轮机', '储能'],
  ['资本开支', 'capex', '云厂商', 'hyperscaler', 'csp', '二阶导', '信用化', '信用利差', 'neocloud', 'fcf'],
  ['pcb', 'ccl', '覆铜板', '铜箔', 't-glass', 'e-glass', 'hvlp', '胜宏', '沪电', '东山精密'],
  ['情绪周期', '冰点', '高潮', '退潮', '混沌期', '连板', '高度板', '断板', '核按钮', '弱转强', '封板', '炸板', '打板'],
  ['龙头战法', '龙头', '龙一', '卡位', '身位', '换手板', '一字板', '反包', '地天板'],
  ['回撤', '风控', '止损', '仓位', '利润垫', '减亏', 'kelly', '凯利', '夏普', 'atr'],
  ['抱团', '抱团瓦解', '拥挤度', '流动性挤兑', '杀估值', '业绩证伪', '预期差'],
  ['利率', '美债', 'tips', 'erp', '风险溢价', 'dr001', '换锚', '逆回购', '流动性', '降息', '加息', 'fomc'],
  ['原油', '油价', '布伦特', 'brent', '天然气', 'ttf', '能源冲击', '地缘', '伊朗'],
  ['端侧ai', 'ai眼镜', '折叠屏', 'iphone', 'agent', 'cpu', '人形机器人', 'optimus', 'robotaxi', '灵巧手'],
  ['股债相关性', '跨资产', '再平衡', '美元', '日元', 'usdjpy', '人民币', '汇率', '黄金'],
];

/**
 * 常见核心标的实体词典（确定性精确识别，零幻觉）
 */
const KNOWN_TICKERS = [
  { code: '300308.SZ', name: '中际旭创', aliases: ['中际旭创', '旭创'] },
  { code: '300502.SZ', name: '新易盛', aliases: ['新易盛'] },
  { code: '300394.SZ', name: '天孚通信', aliases: ['天孚通信', '天孚'] },
  { code: '688498.SH', name: '源杰科技', aliases: ['源杰科技'] },
  { code: '688313.SH', name: '仕佳光子', aliases: ['仕佳光子'] },
  { code: '002281.SZ', name: '光迅科技', aliases: ['光迅科技'] },
  { code: '002463.SZ', name: '沪电股份', aliases: ['沪电股份', '沪电'] },
  { code: '300476.SZ', name: '胜宏科技', aliases: ['胜宏科技', '胜宏'] },
  { code: '002384.SZ', name: '东山精密', aliases: ['东山精密', '东山'] },
  { code: '600183.SH', name: '生益科技', aliases: ['生益科技'] },
  { code: '601138.SH', name: '工业富联', aliases: ['工业富联'] },
  { code: '002916.SZ', name: '深南电路', aliases: ['深南电路'] },
  { code: '688809.SH', name: '强一股份', aliases: ['强一股份', '强一'] },
  { code: '688627.SH', name: '精智达', aliases: ['精智达'] },
  { code: '688661.SH', name: '和林微纳', aliases: ['和林微纳'] },
  { code: '300054.SZ', name: '鼎龙股份', aliases: ['鼎龙股份'] },
  { code: '688019.SH', name: '安集科技', aliases: ['安集科技'] },
  { code: '300236.SZ', name: '上海新阳', aliases: ['上海新阳'] },
  { code: '688535.SH', name: '华海诚科', aliases: ['华海诚科'] },
  { code: '688300.SH', name: '联瑞新材', aliases: ['联瑞新材'] },
  { code: '688720.SH', name: '艾森股份', aliases: ['艾森股份'] },
  { code: '688035.SH', name: '德邦科技', aliases: ['德邦科技'] },
  { code: '300666.SZ', name: '江丰电子', aliases: ['江丰电子'] },
  { code: '002371.SZ', name: '北方华创', aliases: ['北方华创'] },
  { code: '688012.SH', name: '中微公司', aliases: ['中微公司', '中微'] },
  { code: '688072.SH', name: '拓荆科技', aliases: ['拓荆科技', '拓荆'] },
  { code: '688120.SH', name: '华海清科', aliases: ['华海清科'] },
  { code: '688082.SH', name: '盛美上海', aliases: ['盛美上海'] },
  { code: '688981.SH', name: '中芯国际', aliases: ['中芯国际', 'SMIC'] },
  { code: '688347.SH', name: '华虹公司', aliases: ['华虹公司', '华虹'] },
  { code: '688008.SH', name: '澜起科技', aliases: ['澜起科技', '澜起'] },
  { code: '688041.SH', name: '海光信息', aliases: ['海光信息', '海光'] },
  { code: '688521.SH', name: '芯原股份', aliases: ['芯原股份'] },
  { code: '603986.SH', name: '兆易创新', aliases: ['兆易创新'] },
  { code: '301308.SZ', name: '江波龙', aliases: ['江波龙'] },
  { code: '688525.SH', name: '佰维存储', aliases: ['佰维存储', '佰维'] },
  { code: '000725.SZ', name: '京东方A', aliases: ['京东方'] },
  { code: '603773.SH', name: '沃格光电', aliases: ['沃格光电'] },
  { code: '002475.SZ', name: '立讯精密', aliases: ['立讯精密'] },
  { code: '002600.SZ', name: '领益智造', aliases: ['领益智造'] },
  { code: '600519.SH', name: '贵州茅台', aliases: ['贵州茅台', '茅台'] },
  { code: '601398.SH', name: '工商银行', aliases: ['工商银行', '工行'] },
  { code: '600938.SH', name: '中国海油', aliases: ['中国海油', '海油'] },
  { code: '600026.SH', name: '中远海能', aliases: ['中远海能'] },
  { code: '601899.SH', name: '紫金矿业', aliases: ['紫金矿业'] },
  { code: '601689.SH', name: '拓普集团', aliases: ['拓普集团'] },
  { code: '002050.SZ', name: '三花智控', aliases: ['三花智控'] },
  { code: '002714.SZ', name: '牧原股份', aliases: ['牧原股份', '牧原'] },
  { code: 'NVDA.US', name: '英伟达', aliases: ['英伟达', 'NVDA', 'NVIDIA'] },
  { code: 'TSM.US', name: '台积电', aliases: ['台积电', 'TSMC'] },
  { code: 'AVGO.US', name: '博通', aliases: ['Broadcom', '博通', 'AVGO'] },
  { code: 'MU.US', name: '美光', aliases: ['Micron', '美光'] },
  { code: 'AMD.US', name: 'AMD', aliases: ['AMD'] },
  { code: 'INTC.US', name: '英特尔', aliases: ['英特尔', 'Intel', 'INTC'] },
  { code: 'ARM.US', name: 'Arm', aliases: ['Arm'] },
  { code: 'MRVL.US', name: 'Marvell', aliases: ['MRVL', 'Marvell'] },
  { code: 'CRDO.US', name: 'Credo', aliases: ['Credo', 'CRDO'] },
  { code: 'FORM.US', name: 'FormFactor', aliases: ['FormFactor'] },
  { code: 'AMAT.US', name: '应用材料', aliases: ['AMAT', '应用材料'] },
  { code: 'LRCX.US', name: '泛林', aliases: ['LRCX', '泛林'] },
  { code: 'KLAC.US', name: 'KLA', aliases: ['KLA', 'KLAC'] },
  { code: 'ORCL.US', name: 'Oracle', aliases: ['Oracle', 'ORCL'] },
  { code: 'AAPL.US', name: '苹果', aliases: ['苹果', 'Apple', 'AAPL'] },
  { code: 'MSFT.US', name: '微软', aliases: ['微软', 'Microsoft', 'MSFT'] },
  { code: 'AMZN.US', name: '亚马逊', aliases: ['亚马逊', 'AWS', 'Amazon'] },
  { code: 'META.US', name: 'Meta', aliases: ['Meta'] },
  { code: 'GOOG.US', name: '谷歌', aliases: ['谷歌', 'Google'] },
  { code: 'TSLA.US', name: '特斯拉', aliases: ['特斯拉', 'Tesla', 'TSLA'] },
  { code: 'DELL.US', name: '戴尔', aliases: ['戴尔', 'DELL'] },
  { code: 'LITE.US', name: 'Lumentum', aliases: ['Lumentum', 'LITE'] },
  { code: 'COHR.US', name: 'Coherent', aliases: ['Coherent', 'COHR'] },
];

/**
 * 首批 8 大核心产业链/宏观主题活视图定义
 */
const INITIAL_TOPICS = [
  {
    id: 'T:ai-optical',
    slug: 'ai-optical',
    title: 'AI 算力 · 光互连、1.6T 可插拔与 CPO/NPO 演进',
    chain_prefix: 'ai.optical',
    matchPatterns: [/光互连|光互联|光模块|1\.6T|800G|CPO|NPO|光器件|光芯片|光纤|DSP|SerDes|Credo|MRVL|scale-up|MMC连接器|铜退光进/i],
  },
  {
    id: 'T:ai-chips-server',
    slug: 'ai-chips-server',
    title: 'AI 算力 · GPU vs ASIC、服务器与 PCB/散热链',
    chain_prefix: 'ai.compute',
    matchPatterns: [/ASIC|TPU|Trainium|MTIA|Rubin|Blackwell|NVLink|AI服务器|白牌|PCB|CCL|覆铜板|E-glass|T-Glass|MLCC|金刚石散热|CPU重估|昇腾|Peerium/i],
  },
  {
    id: 'T:memory-hbm',
    slug: 'memory-hbm',
    title: '存储超级周期 · HBM、DRAM/NAND 与 eSSD/HDD',
    chain_prefix: 'semi.memory',
    matchPatterns: [/HBM|DRAM|NAND|存储|eSSD|HDD|CXMT|长鑫|YMTC|长存|澜起|CXL|持续学习/i],
  },
  {
    id: 'T:ai-capex-credit',
    slug: 'ai-capex-credit',
    title: '云厂商资本开支脉冲、AI 变现与信用融资链',
    chain_prefix: 'ai.capex_credit',
    matchPatterns: [/hyperscaler|capex|资本开支|信用化|信用利差|Anthropic|OpenAI|Oracle|OCI|neocloud|表外担保|残值担保|ROIC|ARR|融资压力|AI宏观-市场错位/i],
  },
  {
    id: 'T:semi-mfg-pkg',
    slug: 'semi-mfg-pkg',
    title: '半导体制造、设备材料、先进封装与国产替代',
    chain_prefix: 'semi.mfg_pkg',
    matchPatterns: [/WFE|光刻|DUV|台积电|晶圆|先进封装|CoWoS|ABF|载板|BT基板|CoWoP|CoPoS|玻璃基板|探针卡|模拟\/功率|功率半导体|成熟逻辑|国产化率|国产设备|材料替代|韬.*定律|逻辑折叠|英特尔.*封装|MicroLED/i],
  },
  {
    id: 'T:dc-power-policy',
    slug: 'dc-power-policy',
    title: '北美数据中心管线、电力瓶颈与算力出口政策',
    chain_prefix: 'infra.power_policy',
    matchPatterns: [/数据中心管线|电力瓶颈|能耗爆发|BTM|自备电源|ERCOT|搁浅|禁令|电网投资|电网升级|储能|固态变压器|SST|BIS|远程算力|海外建站|FCC|算力出口|合规NV卡/i],
  },
  {
    id: 'T:global-macro-assets',
    slug: 'global-macro-assets',
    title: '全球宏观利率、跨资产配置、中国资金与政策窗口',
    chain_prefix: 'macro.global_cn',
    matchPatterns: [/美债|ERP|TIPS|FOMC|亚洲FMS|中金FICC|央行|货币政策|换锚|金融街论坛|外资|内地资金|新兴市场|伊朗|油价|能源定价|精炼铜|中美缓和|周期品|加息/i],
  },
  {
    id: 'T:edge-ai-robotics',
    slug: 'edge-ai-robotics',
    title: '端侧 AI、Agent 应用、人形机器人与医药前沿',
    chain_prefix: 'ai.edge_apps',
    matchPatterns: [/端侧AI|AI眼镜|折叠iPhone|Agent|Muse|DeepSeek|Kimi|MAU|智谱|Robotaxi|Optimus|机器人|SpaceX|医药|CXO|猪周期/i],
  },
];

/**
 * 确定性提取文本中的已知股票实体（A股6位代码 + 词典匹配）
 */
function extractEntities(text) {
  const s = String(text || '');
  const found = new Map();

  for (const item of KNOWN_TICKERS) {
    for (const alias of item.aliases) {
      let matched = false;
      if (/^[A-Za-z0-9.\-]+$/.test(alias)) {
        const re = new RegExp(`(?<![A-Za-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`);
        matched = re.test(s);
      } else {
        matched = s.includes(alias);
      }
      if (matched) {
        if (!found.has(item.code)) {
          found.set(item.code, { code: item.code, name: item.name, role: 'mentioned' });
        }
        break;
      }
    }
  }

  // 额外抓取显式 6 位 A 股代码（如 688809.SH / 300308）
  for (const m of s.matchAll(/(?<![0-9])([036]\d{5})(?:\.(SH|SZ|BJ))?(?![0-9])/g)) {
    const raw6 = m[1];
    const suf = m[2] || (raw6.startsWith('6') ? 'SH' : 'SZ');
    const code = `${raw6}.${suf}`;
    if (!found.has(code)) {
      found.set(code, { code, name: raw6, role: 'mentioned' });
    }
  }

  return [...found.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * 确定性映射方法论卡片原章节与标题到多维正交标签
 */
function inferMethodTaxonomy(card) {
  const sec = String(card.sectionTitle || '');
  const amendText = (card.fields?.amendments || card.amendments || []).map((a) => a.content).join(' ');
  const text = `${card.title || ''} ${card.system || ''} ${card.fields?.coreThesis || card.coreThesis || ''} ${card.fields?.applicableConditions || card.applicableConditions || ''} ${amendText.slice(0, 600)}`;
  const domains = new Set();
  const regimes = new Set();
  const horizons = new Set();
  const assetClasses = new Set();

  if (/宏观|利率|货币|债务|时钟|外汇/.test(sec + ' ' + card.system)) domains.add('macro');
  if (/资产配置|再平衡|跨资产|海外配置/.test(sec + ' ' + text)) domains.add('asset_allocation');
  if (/产业研究|半导体|产业链|基本面/.test(sec + ' ' + card.system)) domains.add('industry_research');
  if (/估值|价值投资|PE|PB|DCF|业绩定价|预期差/.test(sec + ' ' + card.system + ' ' + card.title)) domains.add('valuation');
  if (/财报|排雷|舞弊/.test(text)) domains.add('financial_forensics');
  if (/技术分析|蜡烛图|波浪|缠论|量价|威科夫|MACD|筹码|趋势线/.test(sec + ' ' + card.system + ' ' + text)) domains.add('technical');
  if (/趋势|突破|海龟|波段/.test(sec + ' ' + card.system)) domains.add('trend_trading');
  if (/短线|情绪|龙头|连板|打板|竞价|冰点|异动|监管套利|核按|乖离/.test(sec + ' ' + text)) {
    domains.add('short_term_sentiment');
  }
  if (/量化|回测|过拟合|协整|统计套利/.test(sec + ' ' + card.system)) domains.add('quant');
  if (/衍生品|期权|波动率|Call|Put|期货/.test(sec + ' ' + text)) domains.add('derivatives');
  if (/行为金融|心理|乌合之众|预期|偏误|克制|FOMO|处置效应/.test(sec + ' ' + text)) domains.add('behavioral');
  if (/仓位|风控|止损|回撤|Kelly|凯利|纠错|套利|减亏|ATR/.test(text)) domains.add('risk_position');
  if (/政策|事件驱动|选举|论坛|地缘|监管/.test(sec + ' ' + text)) domains.add('policy_event');
  if (domains.size === 0) domains.add('industry_research');

  // Regimes
  if (/冰点|弱市|退潮|熊市|阴跌|恐慌|崩盘/.test(text)) regimes.add('weak_choppy');
  if (/冰点/.test(text)) regimes.add('sentiment_ice_point');
  if (/高潮|泡沫|抱团见顶|拥挤|赶顶|瓦解/.test(text)) regimes.add('sentiment_climax');
  if (/流动性挤兑|Beta下行|杀估值/.test(text)) regimes.add('bear_liquidity_crunch');
  if (/主升|全面进攻|牛市/.test(text)) regimes.add('bull_main_wave');
  if (/轮动|震荡|混沌|切换|结构性/.test(text)) regimes.add('structural_rotation');
  if (/供给冲击|通胀|能源|滞胀/.test(text)) regimes.add('supply_inflation_shock');
  if (regimes.size === 0) regimes.add('all');

  // Horizons
  if (/日内|竞价|分时|盘口|打板|半路|一进二|隔夜/.test(text)) horizons.add('intraday');
  if (/短线|连板|断板|弱转强|龙头|3-5|次日|情绪周期/.test(text)) horizons.add('swing_days');
  if (/波段|月度|周度|主线|抱团|右侧|事件/.test(text)) horizons.add('tactical_weeks');
  if (/周期|季度|景气|财报|产能|库存|Capex/.test(text)) horizons.add('cyclical_quarters');
  if (/长期|护城河|DCF|债务周期|资产配置|十年|复利/.test(text)) horizons.add('secular_years');
  if (horizons.size === 0) horizons.add('tactical_weeks');

  // Asset classes
  if (/A股|涨停|跌停|连板|沪深|中证|游资|龙虎榜|两融|中国|A 股/.test(text)) assetClasses.add('a_share');
  if (/美股|标普|SPX|纳指|费半|SOX|英伟达|美国|高盛/.test(text)) assetClasses.add('us_equity');
  if (/债|利率|国债|TIPS|信用利差|DR001/.test(text)) assetClasses.add('rates_bond');
  if (/美元|日元|人民币|外汇|汇率|FX/.test(text)) assetClasses.add('fx');
  if (/原油|商品|油价|黄金|铜|能源|期货/.test(text)) assetClasses.add('commodity');
  if (assetClasses.size >= 2) assetClasses.add('cross_asset');
  if (assetClasses.size === 0) assetClasses.add('a_share');

  // Card kind: framework vs rule
  const isRule =
    (card.reviewLogsCount || 0) > 0 ||
    /纪律|SOP|买点|止损|仓位|打板|低吸|半路|套利|风控|切回|触发|四条件|三条件|两日确认|阈值|偏离|逃生|纠错|红线/.test(
      `${card.title || ''} ${card.system || ''}`
    );

  return {
    card_kind: card.isRevoked ? 'tombstone' : isRule ? 'rule' : 'framework',
    domains: [...domains].sort(),
    regimes: [...regimes].sort(),
    horizons: [...horizons].sort(),
    asset_classes: [...assetClasses].sort(),
  };
}

/**
 * 确定性映射认知卡到主题活视图与产业链节点
 */
function inferCognitionTopicsAndNodes(card) {
  const isSingleTopicBatch =
    /^第[一二三四五六七八九十]+编/.test(String(card.batchTitle || '')) &&
    !/批次/.test(String(card.batchTitle || ''));
  const primaryText = `${card.title || ''} ${card.categoryTag || ''} ${isSingleTopicBatch ? card.batchTitle : ''}`;
  const fallbackText = `${card.facts || ''} ${card.industryImplications || ''}`.slice(0, 500);
  const topics = [];
  const chainNodes = new Set();

  for (const t of INITIAL_TOPICS) {
    if (t.matchPatterns.some((re) => re.test(primaryText))) {
      topics.push(t.id);
      chainNodes.add(t.chain_prefix);
    }
  }
  if (topics.length === 0) {
    for (const t of INITIAL_TOPICS) {
      if (t.matchPatterns.some((re) => re.test(fallbackText))) {
        topics.push(t.id);
        chainNodes.add(t.chain_prefix);
      }
    }
  }

  const nodeText = primaryText;
  if (/光模块|光互连|光互联|1\.6T|800G|CPO|NPO|光纤|光器件/.test(nodeText)) chainNodes.add('ai.optical.transceiver');
  if (/ASIC|TPU|Trainium|MTIA/.test(nodeText)) chainNodes.add('ai.compute.asic');
  if (/GPU|英伟达|Rubin|Blackwell|NVLink/.test(nodeText)) chainNodes.add('ai.compute.gpu');
  if (/HBM|DRAM|NAND|存储|HDD|eSSD/.test(nodeText)) chainNodes.add('semi.memory.hbm');
  if (/探针卡|MEMS/.test(nodeText)) chainNodes.add('semi.test.probe_card');
  if (/先进封装|CoWoS|玻璃基板|CoPoS|CoWoP|PSPI|MUF|ABF|载板/.test(nodeText)) chainNodes.add('semi.pkg.advanced');
  if (/WFE|光刻|DUV|刻蚀|设备/.test(nodeText)) chainNodes.add('semi.equip.wfe');
  if (/功率|模拟|MCU|SiC|GaN/.test(nodeText)) chainNodes.add('semi.analog_power');
  if (/PCB|CCL|铜箔|覆铜板|E-glass|T-Glass/.test(nodeText)) chainNodes.add('ai.hardware.pcb_ccl');
  if (/电力|ERCOT|BTM|电网|储能|SST|数据中心管线|搁浅|禁令/.test(nodeText)) chainNodes.add('infra.power.us_grid');
  if (/BIS|出口|禁令|税收|关税|FCC|监管/.test(nodeText)) chainNodes.add('policy.export_regulation');
  if (/信用利差|信用化|信用债|表外担保|ROIC|capex|资本开支/i.test(nodeText)) chainNodes.add('ai.capex.credit');
  if (/美债|TIPS|ERP|FOMC|利率|换锚|央行|FICC/.test(nodeText)) chainNodes.add('macro.rates_liquidity');
  if (/油价|原油|伊朗|天然气|铜/.test(nodeText)) chainNodes.add('macro.commodities');
  if (/端侧|眼镜|折叠|Agent|机器人|Optimus|Robotaxi/.test(nodeText)) chainNodes.add('ai.edge_robotics');

  if (topics.length === 0) topics.push('T:global-macro-assets');
  if (chainNodes.size === 0) chainNodes.add('general.industry');

  let claimType = 'mixed_fact_forecast';
  if (/日历|会议催化|前瞻情景矩阵|事件窗/.test(card.title || '')) {
    claimType = 'event_calendar';
  } else if (/预测|展望|目标|2027|2028|2029|2030|TAM|指引|情景/.test(`${card.title || ''} ${card.facts || ''}`)) {
    claimType = /实证|财报|公告|新闻稿|出口|出货|已生效|预售/.test(`${card.title || ''} ${card.evidenceLevelRaw || ''}`)
      ? 'mixed_fact_forecast'
      : 'forecast';
  } else if (card.evidenceGrades && card.evidenceGrades.includes('A')) {
    claimType = 'fact';
  }

  return {
    claim_type: claimType,
    topics: [...new Set(topics)].slice(0, 2),
    chain_nodes: [...chainNodes].sort(),
  };
}

/**
 * 构建投研双字 + 专词 FTS5 索引词串（零插件支持中文高精度 BM25）
 */
const DICT_TERMS = [...new Set(SYNONYM_GROUPS.flat().map((x) => x.toLowerCase()))].sort((a, b) => b.length - a.length);
const SYNONYM_MAP = new Map();
for (const group of SYNONYM_GROUPS) {
  const lowerGroup = group.map((x) => x.toLowerCase());
  for (const term of lowerGroup) {
    if (!SYNONYM_MAP.has(term)) SYNONYM_MAP.set(term, new Set());
    for (const peer of lowerGroup) {
      if (peer !== term) SYNONYM_MAP.get(term).add(peer);
    }
  }
}

function tokenizeForFts(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return '';
  const out = [];

  // 1. 英文/数字/代码词元
  for (const m of s.matchAll(/[a-z0-9][a-z0-9._\-]{1,}/g)) {
    const tok = m[0].replace(/[^a-z0-9]/g, '');
    if (tok.length >= 2) out.push(tok);
  }

  // 2. 投研专词命中（保留完整词元提升短语权重）
  for (const term of DICT_TERMS) {
    if (/[\u4e00-\u9fa5]/.test(term) && s.includes(term)) {
      out.push(term);
    }
  }

  // 3. 中文 2-gram 滑窗（兜底未登录词）
  const zhRuns = s.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const run of zhRuns) {
    if (run.length <= 4) out.push(run);
    for (let i = 0; i < run.length - 1; i++) {
      out.push(run.slice(i, i + 2));
    }
  }

  return out.join(' ');
}

function expandQuerySynonyms(queryText) {
  const q = String(queryText || '').toLowerCase();
  const matchedTerms = [];
  const expandedPeers = [];
  for (const term of DICT_TERMS) {
    if (q.includes(term)) {
      matchedTerms.push(term);
      const peers = SYNONYM_MAP.get(term);
      if (peers) {
        for (const p of peers) expandedPeers.push(p);
      }
    }
  }
  return {
    matchedTerms: [...new Set(matchedTerms)],
    expandedPeers: [...new Set(expandedPeers)].slice(0, 18),
  };
}

module.exports = {
  TAXONOMY,
  SYNONYM_GROUPS,
  KNOWN_TICKERS,
  INITIAL_TOPICS,
  extractEntities,
  inferMethodTaxonomy,
  inferCognitionTopicsAndNodes,
  tokenizeForFts,
  expandQuerySynonyms,
};
