import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  Eye,
  KeyRound,
  PlugZap,
  Radio,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  Terminal,
  X,
  AlertCircle,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { CRYPTO_ENABLED, IS_CN_EDITION } from '../config/edition';
import type { DataSourceChannelId, DataSourceConfigResponse } from '../types';

interface DataSourceModalProps {
  open: boolean;
  initialChannel?: DataSourceChannelId;
  onClose: () => void;
  onUpdated?: (cfg: DataSourceConfigResponse) => void;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

const CHANNEL_TABS: { id: DataSourceChannelId; titleZh: string; titleEn: string; shortZh: string; shortEn: string; descZh: string; descEn: string }[] = [
  {
    id: 'cn_quotes',
    titleZh: '1. A股行情与盘口',
    titleEn: '1. CN Quotes & Order Book',
    shortZh: '行情 / L2盘口',
    shortEn: 'Quotes / L2',
    descZh: '实时报价、分时、多周期K线、免费五档盘口，及 L2 十档盘口 / 逐笔大单付费槽位',
    descEn: 'Real-time quotes, intraday, multi-timeframe K-lines, free 5-level book & paid L2/tick slots',
  },
  {
    id: 'cn_short_term',
    titleZh: '2. A股短线特色数据',
    titleEn: '2. CN Short-Term Signals',
    shortZh: '短线精灵 / 封单',
    shortEn: 'Sprite / Seal Flow',
    descZh: '短线精灵、竞价抢筹、涨停封单金额分时曲线、龙虎榜游资席位与筹码',
    descEn: 'Tape sprite alerts, opening auction, limit-up seal flow curves, Dragon-Tiger & chip distribution',
  },
  {
    id: 'news_feeds',
    titleZh: '3. 短线快讯与 Webhook',
    titleEn: '3. Live News & Webhook',
    shortZh: '电报 / Webhook',
    shortEn: 'News / Webhook',
    descZh: '7×24 合规快讯、自定义 JSON 轮询、外部研究简报槽位 + 本地 Webhook 实时推送',
    descEn: '24/7 compliant headlines, custom JSON polling, research digest slot & local Webhook push ingest',
  },
  {
    id: 'global_markets',
    titleZh: !IS_CN_EDITION && CRYPTO_ENABLED ? '4. 海外市场与加密' : '4. 海外股市与大宗期货',
    titleEn: !IS_CN_EDITION && CRYPTO_ENABLED ? '4. Global Markets & Crypto' : '4. Global Equities & Futures',
    shortZh: !IS_CN_EDITION && CRYPTO_ENABLED ? '美欧亚 / BTC' : '美欧亚 / 期货',
    shortEn: !IS_CN_EDITION && CRYPTO_ENABLED ? 'Global / Crypto' : 'Global / Futures',
    descZh:
      !IS_CN_EDITION && CRYPTO_ENABLED
        ? '美股/港股/台韩法英日德/全球期货与加密货币（Finnhub / Polygon / Binance 代理槽位）'
        : '美股/港股/台韩法英日德主流股市与全球大宗期货（Finnhub / Polygon / Alpha Vantage / 通用自定义 HTTP JSON 适配协议）',
    descEn:
      !IS_CN_EDITION && CRYPTO_ENABLED
        ? 'US/HK/APAC/EU equities, global futures & crypto (Finnhub / Polygon / custom JSON slots)'
        : 'US/HK/APAC/EU equities & global commodity futures (Finnhub / Polygon / Alpha Vantage / custom JSON)',
  },
];

const PRESET_I18N: Record<string, { labelEn: string; descEn: string }> = {
  'cn_quotes:default_eastmoney': {
    labelEn: 'Free Default (EastMoney + Tencent 5-Level Book)',
    descEn: 'Zero-key out of the box: real-time quotes, 1m intraday, multi-timeframe K-lines & 5-level order book. L2 10-level & tick slots stay ready for paid adapters.',
  },
  'cn_quotes:tushare_pro': {
    labelEn: 'Tushare Pro Token',
    descEn: 'Enter your Tushare Pro Token for official daily adjusted K-lines & quotes; uncovered intraday order books auto-fallback to public feeds.',
  },
  'cn_quotes:mairui_canghai': {
    labelEn: 'Mairui / Canghai / Aggregated HTTP Quotes',
    descEn: 'Supports URL placeholders {secid} / {code} / {symbol} / {token} for commercial HTTP quote providers.',
  },
  'cn_quotes:custom_gateway': {
    labelEn: 'iFinD / Choice / Custom Quant Gateway',
    descEn: 'Recommended for L2 10-level order books, large-order ticks & low-latency feeds: return standard JSON per contract docs with zero frontend code changes.',
  },
  'cn_short_term:default_eastmoney': {
    labelEn: 'Free Default (EastMoney Tape Sprite / Limit Pools / LHB)',
    descEn: 'Zero-key ready: tape sprite alerts, limit-up/down pools, streak ladder & Dragon-Tiger list. Seal-flow intraday curves reserve paid slots.',
  },
  'cn_short_term:custom_http': {
    labelEn: 'Custom High-Speed Short-Term Signals API',
    descEn: 'Configure JSON Path field mapping to light up limit-up seal-flow curves, opening auction radar & institutional seat feeds.',
  },
  'news_feeds:default_public': {
    labelEn: 'Default Demo & Local Webhook (POST /api/feeds/ingest)',
    descEn: 'Commercial builds disable unauthorized community scrapers and keep local POST /api/feeds/ingest & compliant RSS feeds active.',
  },
  'news_feeds:custom_json_poll': {
    labelEn: 'Custom JSON News Polling + Webhook',
    descEn: 'Periodically poll your compliant financial news, filing or research JSON endpoint with custom field mapping, merged with local Webhook ingest.',
  },
  'global_markets:default_eastmoney_global': {
    labelEn: 'Free Default (Global Equities & Commodity Futures)',
    descEn: 'Zero-key coverage for US/HK/TW/KR/EU/JP equities and global commodity futures macro tracking.',
  },
  'global_markets:finnhub': {
    labelEn: 'Finnhub API (US / Global Low-Latency Quotes)',
    descEn: 'Enter your Finnhub API Key for real-time US pre/regular-market quotes with automatic fallback.',
  },
  'global_markets:polygon': {
    labelEn: 'Polygon.io API (US Equities & Options)',
    descEn: 'Enter your Polygon.io API Key for aggregated US quotes and historical K-line bars.',
  },
  'global_markets:alpha_vantage': {
    labelEn: 'Alpha Vantage API',
    descEn: 'Enter your Alpha Vantage API Key for international market quotes and series.',
  },
  ...(!IS_CN_EDITION && CRYPTO_ENABLED
    ? {
        'global_markets:gateio_spot': {
          labelEn: 'Gate.io Public Spot (24/7 Direct)',
          descEn: 'Direct public spot market tickers and K-lines for 24/7 digital asset tracking.',
        },
        'global_markets:binance_proxy': {
          labelEn: 'Binance Spot / Custom Reverse Proxy',
          descEn: 'Connect to Binance REST API directly or via your own compliant reverse proxy.',
        },
        'global_markets:okx_proxy': {
          labelEn: 'OKX Spot / Custom Reverse Proxy',
          descEn: 'Connect to OKX public market endpoints directly or via your own proxy.',
        },
      }
    : {}),
  'global_markets:custom_global': {
    labelEn: 'Generic Custom HTTP JSON Gateway',
    descEn: 'Route global equities & futures through your own standard HTTP JSON adapter gateway.',
  },
};

const CONTRACT_TITLE_EN: Record<string, string> = {
  '通道1 · L2 十档盘口与逐笔 (orderbookPath)': 'Channel 1 · L2 10-Level Order Book & Ticks (orderbookPath)',
  '通道2 · 涨停封单金额分时曲线 (sealFlowPath)': 'Channel 2 · Limit-Up Seal Flow Curve (sealFlowPath)',
  '通道3 · 本地 Webhook 被动推送 (POST /api/feeds/ingest)': 'Channel 3 · Local Webhook Passive Ingest (POST /api/feeds/ingest)',
  '通道4 · 海外市场/自定义 JSON 网关': 'Channel 4 · Global Markets Custom JSON Gateway',
};

export const DataSourceModal: React.FC<DataSourceModalProps> = ({
  open,
  initialChannel = 'cn_quotes',
  onClose,
  onUpdated,
  onToast,
}) => {
  const { t } = useI18n();
  const [activeChannel, setActiveChannel] = useState<DataSourceChannelId>(initialChannel);
  const [config, setConfig] = useState<DataSourceConfigResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [dirtyChannels, setDirtyChannels] = useState<Set<DataSourceChannelId>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latencyMs?: number } | null>(null);
  const [showContracts, setShowContracts] = useState(false);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [sendingTestWebhook, setSendingTestWebhook] = useState(false);

  useEffect(() => {
    if (open) {
      setActiveChannel(initialChannel);
      setTestResult(null);
      setRevealedToken(null);
      setLoading(true);
      api
        .getDataSources()
        .then((res) => {
          setConfig(res);
          setDirtyChannels(new Set());
          setDraft({
            cn_quotes: { ...res.channels.cn_quotes, apiKey: '' },
            cn_short_term: { ...res.channels.cn_short_term, apiKey: '' },
            news_feeds: { ...res.channels.news_feeds, apiKey: '' },
            global_markets: { ...res.channels.global_markets, apiKey: '' },
          });
        })
        .catch((err: any) => onToast(err.message || t('加载数据源配置失败', 'Failed to load data source config'), 'error'))
        .finally(() => setLoading(false));
    }
  }, [open, initialChannel, onToast, t]);

  if (!open) return null;

  const chDraft = draft[activeChannel] || {};
  const presets = config?.presets?.[activeChannel] || [];
  const lastCheck = config?.lastChecks?.[activeChannel];

  const markDirty = (cid: DataSourceChannelId) => {
    setDirtyChannels((prev) => {
      if (prev.has(cid)) return prev;
      const next = new Set(prev);
      next.add(cid);
      return next;
    });
  };

  const updateField = (field: string, value: any) => {
    markDirty(activeChannel);
    setDraft((prev) => ({
      ...prev,
      [activeChannel]: { ...(prev[activeChannel] || {}), [field]: value },
    }));
  };

  const updateNestedField = (group: 'jsonPaths' | 'fieldMap', field: string, value: string) => {
    markDirty(activeChannel);
    setDraft((prev) => ({
      ...prev,
      [activeChannel]: {
        ...(prev[activeChannel] || {}),
        [group]: { ...((prev[activeChannel] || {})[group] || {}), [field]: value },
      },
    }));
  };

  const applyPreset = (presetId: string) => {
    const p = presets.find((x) => x.id === presetId);
    if (!p) return;
    markDirty(activeChannel);
    setDraft((prev) => ({
      ...prev,
      [activeChannel]: {
        ...(prev[activeChannel] || {}),
        preset: p.id,
        mode: p.mode,
        label: p.label,
        ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
        ...(p.quotePath !== undefined ? { quotePath: p.quotePath } : {}),
        ...(p.orderbookPath !== undefined ? { orderbookPath: p.orderbookPath } : {}),
        ...(p.tickPath !== undefined ? { tickPath: p.tickPath } : {}),
        ...(p.intradayPath !== undefined ? { intradayPath: p.intradayPath } : {}),
        ...(p.klinePath !== undefined ? { klinePath: p.klinePath } : {}),
        ...(p.spritePath !== undefined ? { spritePath: p.spritePath } : {}),
        ...(p.auctionPath !== undefined ? { auctionPath: p.auctionPath } : {}),
        ...(p.sealFlowPath !== undefined ? { sealFlowPath: p.sealFlowPath } : {}),
        ...(p.lhbPath !== undefined ? { lhbPath: p.lhbPath } : {}),
        ...(p.chipPath !== undefined ? { chipPath: p.chipPath } : {}),
        ...(p.pollUrl !== undefined ? { pollUrl: p.pollUrl } : {}),
        ...(p.communityUrl !== undefined ? { communityUrl: p.communityUrl } : {}),
        ...(CRYPTO_ENABLED && p.cryptoExchange !== undefined ? { cryptoExchange: p.cryptoExchange } : {}),
        ...(p.authHeaderName !== undefined ? { authHeaderName: p.authHeaderName } : {}),
        ...(p.authHeaderPrefix !== undefined ? { authHeaderPrefix: p.authHeaderPrefix } : {}),
      },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const targetIds: DataSourceChannelId[] =
        dirtyChannels.size > 0 ? Array.from(dirtyChannels) : [activeChannel];
      const channelsPatch: Record<string, any> = {};
      for (const cid of targetIds) {
        if (draft[cid]) channelsPatch[cid] = draft[cid];
      }
      const saved = await api.saveDataSources({ channels: channelsPatch });
      setConfig(saved);
      setDirtyChannels(new Set());
      setDraft({
        cn_quotes: { ...saved.channels.cn_quotes, apiKey: '' },
        cn_short_term: { ...saved.channels.cn_short_term, apiKey: '' },
        news_feeds: { ...saved.channels.news_feeds, apiKey: '' },
        global_markets: { ...saved.channels.global_markets, apiKey: '' },
      });
      onUpdated?.(saved);
      onToast(
        t(
          '数据源配置已保存至本地 data-sources.local.json（仅更新已修改通道，打包自动排除）',
          'Data source config saved locally to data-sources.local.json (modified channels only; excluded from builds)'
        ),
        'success'
      );
    } catch (err: any) {
      onToast(err.message || t('保存数据源配置失败', 'Failed to save data source config'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleResetChannel = async () => {
    setSaving(true);
    try {
      const saved = await api.saveDataSources({ resetChannel: activeChannel });
      setConfig(saved);
      setDraft((prev) => ({
        ...prev,
        [activeChannel]: { ...saved.channels[activeChannel], apiKey: '' },
      }));
      onUpdated?.(saved);
      setTestResult(null);
      onToast(t('已恢复该通道为免费默认公开源', 'Channel reset to free default public feed'), 'info');
    } catch (err: any) {
      onToast(err.message || t('恢复默认失败', 'Failed to reset channel'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testDataSourceChannel(activeChannel, chDraft);
      setTestResult({ ok: res.ok, message: res.message, latencyMs: res.latencyMs });
      const fresh = await api.getDataSources().catch(() => null);
      if (fresh) {
        setConfig(fresh);
        onUpdated?.(fresh);
      }
    } catch (err: any) {
      setTestResult({ ok: false, message: err.message || t('测试请求失败', 'Connection test failed') });
    } finally {
      setTesting(false);
    }
  };

  const handleRevealToken = async () => {
    try {
      const res = await api.revealFeedWebhookToken();
      setRevealedToken(res.token);
    } catch (err: any) {
      onToast(err.message || t('读取 Token 失败', 'Failed to reveal token'), 'error');
    }
  };

  const handleCopyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast(t(`已复制${label}`, `Copied ${label}`), 'success');
    } catch {
      onToast(t('复制失败，请手动选中复制', 'Copy failed — please copy manually'), 'error');
    }
  };

  const handleSendTestWebhook = async () => {
    setSendingTestWebhook(true);
    try {
      const res = await api.sendTestWebhookFeed();
      onToast(
        t(
          `测试电报已注入短线信息流（当前已缓存 ${res.totalStored} 条 Webhook 消息）`,
          `Test headline pushed to feed (${res.totalStored} cached Webhook messages)`
        ),
        'success'
      );
    } catch (err: any) {
      onToast(err.message || t('推送测试电报失败', 'Failed to send test webhook'), 'error');
    } finally {
      setSendingTestWebhook(false);
    }
  };

  const caps = config?.capabilities;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('可插拔数据源与接口管理', 'Pluggable Data Sources & Feed Adapters')}
      style={{ zIndex: 1080 }}
      onClick={onClose}
    >
      <div
        className="modal-card"
        style={{ width: 'min(960px, 95vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Database size={19} color="var(--navy)" />
            <div>
              <h3 style={{ margin: 0, fontSize: 15.5, fontWeight: 800 }}>
                {t('可插拔数据源与接口管理（4 通道适配层）', 'Pluggable Data Source Manager (4-Channel Adapter)')}
              </h3>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                {t(
                  '免费公开源开箱即用 · 高阶 L2 / 逐笔 / 封单分时 / 付费电报可填入 Key 或自建网关零改代码点亮 · 缺失字段绝不造假',
                  'Public feeds ready out-of-the-box · Plug in custom/paid L2, tick & news gateways with zero code changes · Missing fields stay null'
                )}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={t('关闭弹窗', 'Close dialog')}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {loading && !config ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
            {t('正在加载数据源路由配置...', 'Loading data source router config...')}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '235px minmax(0, 1fr)', flex: 1, minHeight: 0, overflow: 'hidden' }}>
            {/* Left Channel Rail */}
            <div
              style={{
                borderRight: '1px solid var(--border)',
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                overflowY: 'auto',
                background: 'var(--bg-subtle)',
              }}
            >
              {CHANNEL_TABS.map((tab) => {
                const isActive = activeChannel === tab.id;
                const ch = draft[tab.id] || config?.channels?.[tab.id];
                const chk = config?.lastChecks?.[tab.id];
                const isCustom = ch?.mode === 'custom';
                const dotColor = chk ? (chk.ok ? '#10b981' : '#ef4444') : isCustom ? '#f59e0b' : '#22c55e';
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setActiveChannel(tab.id);
                      setTestResult(null);
                    }}
                    style={{
                      textAlign: 'left',
                      padding: '10px 10px',
                      borderRadius: 9,
                      border: `1px solid ${isActive ? 'var(--navy)' : 'var(--border)'}`,
                      background: isActive ? 'var(--bg-elev)' : 'transparent',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>{t(tab.titleZh, tab.titleEn)}</span>
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: dotColor,
                          flexShrink: 0,
                          boxShadow: `0 0 0 3px ${dotColor}26`,
                        }}
                        title={chk ? chk.message : isCustom ? t('自定义源', 'Custom Feed') : t('免费默认源', 'Default Public Feed')}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className={`badge ${isCustom ? 'badge-gold' : 'badge-emerald'}`} style={{ fontSize: 10, padding: '1px 5px' }}>
                        {isCustom ? t('自定义主源', 'Custom Primary') : t('免费默认', 'Free Default')}
                      </span>
                      {chk?.latencyMs != null && (
                        <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {chk.latencyMs}ms
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}

              {/* Capability Matrix Summary */}
              {caps && (
                <div
                  style={{
                    marginTop: 'auto',
                    padding: 10,
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-elev)',
                    fontSize: 11,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 5,
                  }}
                >
                  <div style={{ fontWeight: 700, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <ShieldCheck size={13} color="var(--emerald)" /> {t('当前高阶槽位状态', 'Adapter Slot Status')}
                  </div>
                  {[
                    {
                      k: t('五档盘口', '5-Level Book'),
                      ok: true,
                      txt: caps.orderbook5Level.tier === 'custom' ? t('自定义', 'Custom') : t('免费实时', 'Free Live'),
                    },
                    {
                      k: t('L2 十档盘口', 'L2 10-Level'),
                      ok: caps.l2Orderbook10.available,
                      txt: caps.l2Orderbook10.available ? t('已点亮', 'Active') : t('待接付费源', 'Paid Slot'),
                    },
                    {
                      k: t('L2 逐笔大单', 'L2 Tick Flow'),
                      ok: caps.l2TickByTick.available,
                      txt: caps.l2TickByTick.available ? t('已点亮', 'Active') : t('待接付费源', 'Paid Slot'),
                    },
                    {
                      k: t('封单分时曲线', 'Seal Curve'),
                      ok: caps.sealFlowIntraday.available,
                      txt: caps.sealFlowIntraday.available ? t('已点亮', 'Active') : t('待接付费源', 'Paid Slot'),
                    },
                    {
                      k: t('Webhook 推流', 'Webhook Ingest'),
                      ok: caps.communityDeepPost.hasWebhook,
                      txt: caps.communityDeepPost.hasWebhook ? t('就绪', 'Ready') : t('已关闭', 'Disabled'),
                    },
                  ].map((item) => (
                    <div key={item.k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: 'var(--text-muted)' }}>{item.k}</span>
                      <span style={{ fontWeight: 700, color: item.ok ? 'var(--emerald)' : '#d97706' }}>{item.txt}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Right Config Form */}
            <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <h4 style={{ margin: 0, fontSize: 14.5 }}>
                    {(() => {
                      const activeTabDef = CHANNEL_TABS.find((x) => x.id === activeChannel);
                      return activeTabDef ? t(activeTabDef.titleZh, activeTabDef.titleEn) : activeChannel;
                    })()}
                  </h4>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className={`btn btn-sm ${chDraft.mode === 'default' ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => updateField('mode', 'default')}
                    >
                      {t('免费默认源', 'Free Default')}
                    </button>
                    <button
                      type="button"
                      className={`btn btn-sm ${chDraft.mode === 'custom' ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => {
                        updateField('mode', 'custom');
                        if (chDraft.preset?.startsWith('default_')) {
                          const firstCustom = presets.find((p) => p.mode === 'custom');
                          if (firstCustom) applyPreset(firstCustom.id);
                        }
                      }}
                    >
                      {t('自定义 / 付费主源', 'Custom / Paid Primary')}
                    </button>
                  </div>
                </div>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                  {(() => {
                    const activeTabDef = CHANNEL_TABS.find((x) => x.id === activeChannel);
                    return activeTabDef ? t(activeTabDef.descZh, activeTabDef.descEn) : '';
                  })()}
                </p>
              </div>

              {/* Preset Selector */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 }}>
                {presets.map((p) => {
                  const selected = chDraft.preset === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => applyPreset(p.id)}
                      style={{
                        textAlign: 'left',
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: `1px solid ${selected ? 'var(--navy)' : 'var(--border)'}`,
                        background: selected ? 'rgba(24,49,83,0.08)' : 'var(--bg-subtle)',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
                        {t(p.label, PRESET_I18N[`${activeChannel}:${p.id}`]?.labelEn || p.label)}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.35 }}>
                        {t(p.desc, PRESET_I18N[`${activeChannel}:${p.id}`]?.descEn || p.desc)}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Channel-specific Custom Form */}
              {chDraft.mode === 'custom' && (
                <div
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    {activeChannel !== 'news_feeds' ? (
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5 }}>
                        <span style={{ fontWeight: 700 }}>{t('主源 Base URL', 'Primary Base URL')}</span>
                        <input
                          className="input mono"
                          value={chDraft.baseUrl || ''}
                          onChange={(e) => updateField('baseUrl', e.target.value)}
                          placeholder={t('例如 http://127.0.0.1:8899 或 https://api.tushare.pro', 'e.g. http://127.0.0.1:8899 or https://api.provider.com')}
                        />
                      </label>
                    ) : (
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5 }}>
                        <span style={{ fontWeight: 700 }}>{t('主动轮询 JSON Feed URL', 'Active Poll JSON Feed URL')}</span>
                        <input
                          className="input mono"
                          value={chDraft.pollUrl || ''}
                          onChange={(e) => updateField('pollUrl', e.target.value)}
                          placeholder={t('例如 http://127.0.0.1:8899/api/news/live', 'e.g. http://127.0.0.1:8899/api/news/live')}
                        />
                      </label>
                    )}

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5 }}>
                      <span style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
                        <KeyRound size={12} /> API Key / Token
                        {chDraft.hasApiKey && (
                          <span className="badge badge-emerald" style={{ fontSize: 10 }}>
                            {t('已存', 'Saved')} {chDraft.maskedApiKey}
                          </span>
                        )}
                      </span>
                      <input
                        className="input mono"
                        type="password"
                        value={chDraft.apiKey || ''}
                        onChange={(e) => updateField('apiKey', e.target.value)}
                        placeholder={
                          chDraft.hasApiKey
                            ? t('留空保持当前 Key，输入新值则覆盖', 'Leave blank to keep saved key')
                            : t('输入付费源 API Key 或 Token', 'Enter provider API key or token')
                        }
                      />
                    </label>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 110px', gap: 10 }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5 }}>
                      <span>{t('鉴权 Header 名（可留空）', 'Auth Header Name (optional)')}</span>
                      <input
                        className="input mono"
                        value={chDraft.authHeaderName || ''}
                        onChange={(e) => updateField('authHeaderName', e.target.value)}
                        placeholder="Authorization / X-API-Key"
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5 }}>
                      <span>{t('Header 前缀（如 Bearer ）', 'Header Prefix (e.g. Bearer )')}</span>
                      <input
                        className="input mono"
                        value={chDraft.authHeaderPrefix ?? ''}
                        onChange={(e) => updateField('authHeaderPrefix', e.target.value)}
                        placeholder="Bearer "
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5 }}>
                      <span>{t('超时 (ms)', 'Timeout (ms)')}</span>
                      <input
                        className="input mono"
                        type="number"
                        value={chDraft.timeoutMs || 6500}
                        onChange={(e) => updateField('timeoutMs', Number(e.target.value))}
                      />
                    </label>
                  </div>

                  {/* Channel 1 specific paths */}
                  {activeChannel === 'cn_quotes' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      {[
                        ['orderbookPath', t('十档/五档盘口路径 (支持 {secid}/{code}/{token})', 'Order Book Path (supports {secid}/{code}/{token})')],
                        ['tickPath', t('L2 逐笔大单路径', 'L2 Tick / Large Orders Path')],
                        ['quotePath', t('实时快照报价路径', 'Real-Time Snapshot Quote Path')],
                        ['intradayPath', t('实时分时路径 (points 数组)', 'Intraday Series Path (points array)')],
                        ['klinePath', t('多周期 K 线路径 (支持 {tf})', 'Multi-Timeframe K-Line Path ({tf})')],
                        ['wsUrl', t('可选 WebSocket 推流地址 (wss://...)', 'Optional WebSocket Stream URL (wss://...)')],
                      ].map(([k, label]) => (
                        <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
                          <span style={{ color: 'var(--text-muted)' }}>{label}</span>
                          <input
                            className="input mono"
                            style={{ fontSize: 11.5 }}
                            value={chDraft[k] || ''}
                            onChange={(e) => updateField(k, e.target.value)}
                          />
                        </label>
                      ))}
                    </div>
                  )}

                  {/* Channel 2 specific paths */}
                  {activeChannel === 'cn_short_term' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      {[
                        ['spritePath', t('短线精灵路径', 'Tape Sprite Path')],
                        ['sealFlowPath', t('涨停封单金额分时路径 ({secid})', 'Limit-Up Seal Flow Path ({secid})')],
                        ['auctionPath', t('竞价抢筹路径', 'Opening Auction Path')],
                        ['lhbPath', t('龙虎榜席位路径', 'Dragon-Tiger Seat Path')],
                        ['chipPath', t('筹码分布与获利盘路径 ({secid})', 'Chip Distribution Path ({secid})')],
                      ].map(([k, label]) => (
                        <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
                          <span style={{ color: 'var(--text-muted)' }}>{label}</span>
                          <input
                            className="input mono"
                            style={{ fontSize: 11.5 }}
                            value={chDraft[k] || ''}
                            onChange={(e) => updateField(k, e.target.value)}
                          />
                        </label>
                      ))}
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
                        <span style={{ color: 'var(--text-muted)' }}>{t('JSON Path · 短线精灵数组', 'JSON Path · Tape Sprite Array')}</span>
                        <input
                          className="input mono"
                          style={{ fontSize: 11.5 }}
                          value={chDraft.jsonPaths?.spriteItems || 'items'}
                          onChange={(e) => updateNestedField('jsonPaths', 'spriteItems', e.target.value)}
                        />
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
                        <span style={{ color: 'var(--text-muted)' }}>{t('JSON Path · 封单分时序列', 'JSON Path · Seal Flow Series')}</span>
                        <input
                          className="input mono"
                          style={{ fontSize: 11.5 }}
                          value={chDraft.jsonPaths?.sealSeries || 'series'}
                          onChange={(e) => updateNestedField('jsonPaths', 'sealSeries', e.target.value)}
                        />
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
                        <span style={{ color: 'var(--text-muted)' }}>{t('JSON Path · 竞价/龙虎榜数组', 'JSON Path · Auction / LHB Array')}</span>
                        <input
                          className="input mono"
                          style={{ fontSize: 11.5 }}
                          value={chDraft.jsonPaths?.lhbItems || 'items'}
                          onChange={(e) => updateNestedField('jsonPaths', 'lhbItems', e.target.value)}
                        />
                      </label>
                    </div>
                  )}

                  {/* Channel 3 custom mapping */}
                  {activeChannel === 'news_feeds' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
                        <span style={{ color: 'var(--text-muted)' }}>
                          {t('外部研究简报 / 深度快讯接口 URL（可选：合规转发网关）', 'External Research Digest / News Feed URL (optional gateway)')}
                        </span>
                        <input
                          className="input mono"
                          style={{ fontSize: 11.5 }}
                          value={chDraft.communityUrl || ''}
                          onChange={(e) => updateField('communityUrl', e.target.value)}
                          placeholder="http://127.0.0.1:8899/api/community/posts"
                        />
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
                        <span style={{ color: 'var(--text-muted)' }}>{t('主动轮询间隔 (秒，10–300)', 'Poll Interval (sec, 10–300)')}</span>
                        <input
                          type="number"
                          min={10}
                          max={300}
                          className="input mono"
                          style={{ fontSize: 11.5 }}
                          value={chDraft.pollIntervalSec || 30}
                          onChange={(e) => updateField('pollIntervalSec', Number(e.target.value))}
                        />
                      </label>
                      {[
                        ['itemsPath', t('列表 JSON Path', 'Items JSON Path')],
                        ['titleField', t('标题字段', 'Title Field')],
                        ['timeField', t('时间字段', 'Time Field')],
                        ['sourceField', t('来源字段', 'Source Field')],
                        ['urlField', t('链接字段', 'URL Field')],
                        ['importantField', t('重要标记字段', 'Important Flag Field')],
                      ].map(([k, label]) => (
                        <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
                          <span style={{ color: 'var(--text-muted)' }}>{label}</span>
                          <input
                            className="input mono"
                            style={{ fontSize: 11.5 }}
                            value={chDraft.fieldMap?.[k] || ''}
                            onChange={(e) => updateNestedField('fieldMap', k, e.target.value)}
                          />
                        </label>
                      ))}
                    </div>
                  )}

                  {/* Channel 4 specific */}
                  {activeChannel === 'global_markets' && (
                    <div style={{ display: 'grid', gridTemplateColumns: !IS_CN_EDITION && CRYPTO_ENABLED ? '1fr 1fr' : '1fr', gap: 8 }}>
                      {!IS_CN_EDITION && CRYPTO_ENABLED && (
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
                          <span style={{ color: 'var(--text-muted)' }}>{t('加密交易所通道', 'Crypto Exchange Adapter')}</span>
                          <select
                            className="input"
                            value={chDraft.cryptoExchange || 'gateio'}
                            onChange={(e) => {
                              const ex = e.target.value;
                              setDraft((prev) => {
                                const cur = prev[activeChannel] || {};
                                const next: Record<string, any> = { ...cur, cryptoExchange: ex };
                                const matchedPreset = presets.find((p) => p.id === `${ex}_proxy` || p.id === `${ex}_spot`);
                                if (matchedPreset?.baseUrl && cur.baseUrl && cur.baseUrl !== matchedPreset.baseUrl) {
                                  next.baseUrl = matchedPreset.baseUrl;
                                }
                                return { ...prev, [activeChannel]: next };
                              });
                            }}
                          >
                            <option value="gateio">{t('Gate.io 公开现货（默认直连）', 'Gate.io Public Spot (Direct)')}</option>
                            <option value="binance">{t('Binance（需可直连或自建反代）', 'Binance (Direct or Custom Proxy)')}</option>
                            <option value="okx">{t('OKX（需可直连或自建反代）', 'OKX (Direct or Custom Proxy)')}</option>
                            <option value="custom">{t('自定义 REST 网关', 'Custom REST Gateway')}</option>
                          </select>
                        </label>
                      )}
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
                        <span style={{ color: 'var(--text-muted)' }}>
                          {t('自定义代理或通用 HTTP JSON 网关地址（可选）', 'Custom Proxy or Generic HTTP JSON Gateway URL (optional)')}
                        </span>
                        <input
                          className="input mono"
                          style={{ fontSize: 11.5 }}
                          value={chDraft.proxyUrl || ''}
                          onChange={(e) => updateField('proxyUrl', e.target.value)}
                          placeholder="https://your-gateway.example.com"
                        />
                      </label>
                    </div>
                  )}

                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={chDraft.fallbackOnError !== false}
                      onChange={(e) => updateField('fallbackOnError', e.target.checked)}
                    />
                    <span>
                      {t(
                        '自定义主源超时或报错时，自动无缝回退到免费公开源（强烈建议开启）',
                        'Automatically fall back to public feeds if custom primary times out or errors (recommended)'
                      )}
                    </span>
                  </label>
                </div>
              )}

              {/* Local Webhook Ingest Card (always shown on news_feeds tab) */}
              {activeChannel === 'news_feeds' && config && (
                <div
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    border: '1px solid rgba(14, 165, 233, 0.35)',
                    background: 'rgba(14, 165, 233, 0.06)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Radio size={14} color="#0284c7" />{' '}
                      {t(
                        '被动推送入口：本地 Webhook Ingest（零改代码对接任何付费电报机器人）',
                        'Passive Push Endpoint: Local Webhook Ingest (Connect any news bot with zero code changes)'
                      )}
                    </strong>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={chDraft.webhookEnabled !== false}
                        onChange={(e) => updateField('webhookEnabled', e.target.checked)}
                      />
                      {t('启用接收', 'Enable Ingest')}
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <code className="mono" style={{ fontSize: 11.5, padding: '4px 8px', borderRadius: 6, background: 'var(--bg-elev)', border: '1px solid var(--border)' }}>
                      POST {config.webhookUrl}
                    </code>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleCopyText(config.webhookUrl, ' Webhook URL')}
                    >
                      <Copy size={12} /> {t('复制地址', 'Copy URL')}
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 11.5 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Bearer Token:</span>
                    <code className="mono" style={{ padding: '3px 7px', borderRadius: 6, background: 'var(--bg-elev)', border: '1px solid var(--border)' }}>
                      {revealedToken || chDraft.maskedWebhookToken || '****'}
                    </code>
                    {!revealedToken ? (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={handleRevealToken}>
                        <Eye size={12} /> {t('查看明文', 'Reveal Token')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleCopyText(revealedToken, ' Webhook Token')}
                      >
                        <Copy size={12} /> {t('复制 Token', 'Copy Token')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={sendingTestWebhook}
                      onClick={handleSendTestWebhook}
                    >
                      <Send size={12} />{' '}
                      {sendingTestWebhook ? t('推送中...', 'Sending...') : t('模拟推送一条测试电报', 'Send Test Webhook')}
                    </button>
                  </div>
                </div>
              )}

              {/* Legacy Incompatible Config Reconfigure Notice */}
              {chDraft.migrationNotice && (
                <div
                  style={{
                    padding: '9px 12px',
                    borderRadius: 8,
                    border: '1px solid rgba(245,158,11,0.45)',
                    background: 'rgba(245,158,11,0.09)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                  }}
                >
                  <AlertCircle size={15} color="#d97706" />
                  <span style={{ flex: 1 }}>{chDraft.migrationNotice}</span>
                </div>
              )}

              {/* Test Result & Last Check */}
              {(testResult || lastCheck) && (
                <div
                  style={{
                    padding: '9px 12px',
                    borderRadius: 8,
                    border: `1px solid ${(testResult ? testResult.ok : lastCheck?.ok) ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)'}`,
                    background: (testResult ? testResult.ok : lastCheck?.ok) ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                  }}
                >
                  {(testResult ? testResult.ok : lastCheck?.ok) ? (
                    <CheckCircle2 size={15} color="#10b981" />
                  ) : (
                    <AlertCircle size={15} color="#ef4444" />
                  )}
                  <span style={{ flex: 1 }}>
                    {testResult ? testResult.message : `${t('上次检测：', 'Last check: ')}${lastCheck?.message}`}
                  </span>
                </div>
              )}

              {/* Action Row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn btn-sm" disabled={testing} onClick={handleTest}>
                    {testing ? <RefreshCw size={13} className="spin" /> : <PlugZap size={13} />}
                    {testing ? t('实测连通中...', 'Testing...') : t('一键测试连接', 'Test Connection')}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={handleResetChannel}>
                    <RotateCcw size={13} /> {t('恢复免费默认', 'Reset to Default')}
                  </button>
                </div>
                <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={handleSave}>
                  <Save size={13} />{' '}
                  {saving
                    ? t('保存中...', 'Saving...')
                    : dirtyChannels.size > 1
                    ? t(`保存已修改的 ${dirtyChannels.size} 个通道`, `Save ${dirtyChannels.size} Modified Channels`)
                    : t('保存当前通道配置', 'Save Channel Config')}
                </button>
              </div>

              {/* Collapsible Standard JSON Interface Contract Docs */}
              <div style={{ border: '1px solid var(--border)', borderRadius: 9, overflow: 'hidden' }}>
                <button
                  type="button"
                  onClick={() => setShowContracts((v) => !v)}
                  style={{
                    width: '100%',
                    padding: '9px 12px',
                    background: 'var(--bg-subtle)',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    color: 'var(--text)',
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Terminal size={13} />{' '}
                    {t(
                      '标准 JSON 接口契约与 cURL 接入文档（照格式转发即可零改前端代码）',
                      'Standard JSON Adapter Contracts & cURL Examples'
                    )}
                  </span>
                  {showContracts ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
                {showContracts && (
                  <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-elev)' }}>
                    {(config?.contracts || []).map((c, idx) => (
                      <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <strong style={{ fontSize: 12 }}>{t(c.title, CONTRACT_TITLE_EN[c.title] || c.title)}</strong>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: 11 }}
                            onClick={() => handleCopyText(c.curl, t(' cURL 示例', 'cURL sample'))}
                          >
                            <Copy size={11} /> {t('复制 cURL', 'Copy cURL')}
                          </button>
                        </div>
                        <pre
                          className="mono"
                          style={{
                            margin: 0,
                            padding: 8,
                            borderRadius: 6,
                            background: 'var(--bg-subtle)',
                            fontSize: 11,
                            overflowX: 'auto',
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {c.curl}
                        </pre>
                        <pre
                          className="mono"
                          style={{
                            margin: '6px 0 0',
                            padding: 8,
                            borderRadius: 6,
                            background: 'var(--bg-subtle)',
                            fontSize: 11,
                            overflowX: 'auto',
                            color: 'var(--text-muted)',
                          }}
                        >
                          {c.responseSample}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
