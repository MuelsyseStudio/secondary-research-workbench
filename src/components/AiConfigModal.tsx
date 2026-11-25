import React, { useEffect, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  KeyRound,
  PlugZap,
  RefreshCw,
  Save,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type { AiProvider, AiSafeConfig } from '../types';
import { isAiProviderReady } from './AiProviderPicker';

interface AiConfigModalProps {
  open: boolean;
  config: AiSafeConfig | null;
  onClose: () => void;
  onSaved: (cfg: AiSafeConfig) => void;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

type ApiProviderKey = 'deepseek' | 'qwen' | 'moonshot' | 'zhipu' | 'gemini' | 'openai' | 'custom';

interface ApiDraftState {
  apiKey: string;
  baseUrl: string;
  model: string;
  label?: string;
  enableGoogleSearch?: boolean;
}

const QUICK_RECOMMENDED_CARDS: {
  id: ApiProviderKey;
  titleZh: string;
  titleEn: string;
  subZh: string;
  subEn: string;
  consoleUrl: string;
  consoleLabel: string;
  guideTipZh: string;
  guideTipEn: string;
}[] = [
  {
    id: 'deepseek',
    titleZh: 'DeepSeek 官方 API（首选）',
    titleEn: 'DeepSeek Official API (Recommended)',
    subZh: '高性价比 · V3 快稳 / R1 深度推理',
    subEn: 'High value · V3 fast & R1 deep reasoning',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    consoleLabel: 'platform.deepseek.com/api_keys',
    guideTipZh: '点击右侧官方链接 → 创建 API Key → 粘贴到下方输入框 → 点击底部「保存并测试」即可启用',
    guideTipEn: 'Open console link → create an API key → paste below → click "Save & Test" to activate',
  },
  {
    id: 'qwen',
    titleZh: '通义千问 Qwen',
    titleEn: 'Alibaba Qwen (DashScope)',
    subZh: '阿里云百炼 · 国内直连稳定',
    subEn: 'Alibaba Model Studio · stable domestic access',
    consoleUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    consoleLabel: 'bailian.console.aliyun.com',
    guideTipZh: '打开阿里云百炼控制台 → 右上角「API-KEY」→ 创建密钥并粘贴到下方即可测试',
    guideTipEn: 'Open Alibaba Model Studio → "API-KEY" → create key and paste below to test',
  },
  {
    id: 'moonshot',
    titleZh: 'Kimi (Moonshot)',
    titleEn: 'Kimi (Moonshot AI)',
    subZh: '超长研报与公告文档解析强项',
    subEn: 'Long-context research report & filing analysis',
    consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
    consoleLabel: 'platform.moonshot.cn/console/api-keys',
    guideTipZh: '打开 Moonshot 控制台 → 「API Key 管理」→ 新建密钥并粘贴到下方即可测试',
    guideTipEn: 'Open Moonshot Console → "API Keys" → create key and paste below to test',
  },
];

const QUICK_PROVIDER_IDS: AiProvider[] = ['deepseek', 'qwen', 'moonshot'];
const ADVANCED_PROVIDER_IDS: AiProvider[] = ['zhipu', 'gemini', 'openai', 'custom', 'codex_cli', 'gemini_cli'];

const PROVIDER_CARDS: {
  id: AiProvider;
  titleZh: string;
  titleEn: string;
  subZh: string;
  subEn: string;
  kind: 'cli' | 'api';
}[] = [
  { id: 'deepseek', titleZh: 'DeepSeek API', titleEn: 'DeepSeek API', subZh: 'V3 / R1 深度推理', subEn: 'V3 / R1 Reasoning', kind: 'api' },
  { id: 'qwen', titleZh: '通义千问 Qwen', titleEn: 'Qwen (DashScope)', subZh: '阿里云百炼 DashScope', subEn: 'Alibaba Cloud API', kind: 'api' },
  { id: 'moonshot', titleZh: 'Kimi (Moonshot)', titleEn: 'Kimi (Moonshot)', subZh: '长上下文研报解析', subEn: 'Long-context PDFs', kind: 'api' },
  { id: 'zhipu', titleZh: '智谱 GLM', titleEn: 'Zhipu GLM', subZh: 'GLM-4-Plus / 4.5', subEn: 'GLM-4-Plus / 4.5', kind: 'api' },
  { id: 'gemini', titleZh: 'Google Gemini API', titleEn: 'Google Gemini API', subZh: '支持 Google 联网', subEn: 'Google Search grounding', kind: 'api' },
  { id: 'openai', titleZh: 'OpenAI / GPT API', titleEn: 'OpenAI / GPT API', subZh: 'GPT-4.1 / o3 / GPT-5', subEn: 'GPT-4.1 / o3 / GPT-5', kind: 'api' },
  { id: 'custom', titleZh: '自定义兼容接口', titleEn: 'Custom OpenAI-Compatible', subZh: '硅基流动 / OpenRouter / Ollama', subEn: 'SiliconFlow / OpenRouter / Ollama', kind: 'api' },
  { id: 'codex_cli', titleZh: '本机 Codex CLI', titleEn: 'Local Codex CLI', subZh: 'ChatGPT 官方套餐', subEn: 'ChatGPT CLI subscription', kind: 'cli' },
  { id: 'gemini_cli', titleZh: '本机 Gemini CLI', titleEn: 'Local Gemini CLI', subZh: 'Google 官方授权', subEn: 'Google CLI login', kind: 'cli' },
];

const MODEL_PRESETS: Record<ApiProviderKey, { labelZh: string; labelEn: string; model: string; baseUrl?: string }[]> = {
  deepseek: [
    { labelZh: 'DeepSeek-V3 (deepseek-chat · 推荐快稳)', labelEn: 'DeepSeek-V3 (deepseek-chat · Fast)', model: 'deepseek-chat' },
    { labelZh: 'DeepSeek-R1 (deepseek-reasoner · 深度推理)', labelEn: 'DeepSeek-R1 (deepseek-reasoner)', model: 'deepseek-reasoner' },
  ],
  qwen: [
    { labelZh: 'qwen-plus（推荐均衡）', labelEn: 'qwen-plus (Balanced)', model: 'qwen-plus' },
    { labelZh: 'qwen-max（旗舰）', labelEn: 'qwen-max (Flagship)', model: 'qwen-max' },
    { labelZh: 'qwq-plus（深度推理）', labelEn: 'qwq-plus (Reasoning)', model: 'qwq-plus' },
  ],
  moonshot: [
    { labelZh: 'kimi-k2-0711-preview（旗舰）', labelEn: 'kimi-k2-0711-preview (Flagship)', model: 'kimi-k2-0711-preview' },
    { labelZh: 'moonshot-v1-128k（超长文本）', labelEn: 'moonshot-v1-128k (128K)', model: 'moonshot-v1-128k' },
  ],
  zhipu: [
    { labelZh: 'glm-4-plus（推荐）', labelEn: 'glm-4-plus (Recommended)', model: 'glm-4-plus' },
    { labelZh: 'glm-4.5（新一代）', labelEn: 'glm-4.5 (Next-gen)', model: 'glm-4.5' },
  ],
  gemini: [
    { labelZh: 'gemini-2.5-pro（旗舰）', labelEn: 'gemini-2.5-pro (Flagship)', model: 'gemini-2.5-pro' },
    { labelZh: 'gemini-2.5-flash（高性价比）', labelEn: 'gemini-2.5-flash (Fast)', model: 'gemini-2.5-flash' },
  ],
  openai: [
    { labelZh: 'gpt-4.1', labelEn: 'gpt-4.1', model: 'gpt-4.1' },
    { labelZh: 'gpt-4o', labelEn: 'gpt-4o', model: 'gpt-4o' },
    { labelZh: 'o3', labelEn: 'o3', model: 'o3' },
  ],
  custom: [
    { labelZh: '硅基流动 DeepSeek-V3', labelEn: 'SiliconFlow DeepSeek-V3', model: 'deepseek-ai/DeepSeek-V3', baseUrl: 'https://api.siliconflow.cn/v1' },
    { labelZh: 'OpenRouter DeepSeek-V3', labelEn: 'OpenRouter DeepSeek-V3', model: 'deepseek/deepseek-chat-v3-0324', baseUrl: 'https://openrouter.ai/api/v1' },
    { labelZh: '火山方舟（豆包/DeepSeek）', labelEn: 'Volcengine Ark', model: 'ep-replace-endpoint-id', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    { labelZh: '本机 Ollama（免Key）', labelEn: 'Local Ollama (No Key)', model: 'qwen2.5:14b', baseUrl: 'http://127.0.0.1:11434/v1' },
  ],
};

const ENV_HINTS: Record<ApiProviderKey, { zh: string; en: string }> = {
  deepseek: { zh: '粘贴 sk-...（或设环境变量 DEEPSEEK_API_KEY）', en: 'Paste sk-... (or set DEEPSEEK_API_KEY)' },
  qwen: { zh: '粘贴 sk-...（或设环境变量 DASHSCOPE_API_KEY）', en: 'Paste sk-... (or set DASHSCOPE_API_KEY)' },
  moonshot: { zh: '粘贴 sk-...（或设环境变量 MOONSHOT_API_KEY）', en: 'Paste sk-... (or set MOONSHOT_API_KEY)' },
  zhipu: { zh: '粘贴智谱 API Key（或设 ZHIPU_API_KEY）', en: 'Paste Zhipu API Key (or set ZHIPU_API_KEY)' },
  gemini: { zh: '粘贴 AIza...（或设 GEMINI_API_KEY）', en: 'Paste AIza... (or set GEMINI_API_KEY)' },
  openai: { zh: '粘贴 sk-...（或设 OPENAI_API_KEY）', en: 'Paste sk-... (or set OPENAI_API_KEY)' },
  custom: { zh: '粘贴接口 Key（本机 Ollama 可留空）', en: 'Paste API key (leave empty for local Ollama)' },
};

export function resolveAiConfigWatchStocksPatch(params: {
  userWatchDraft: string | null;
  watchStocksConfigured?: boolean;
  configuredWatchStocks?: string[] | null;
}): { watchStocks?: string[] } {
  if (params.userWatchDraft !== null) {
    return {
      watchStocks: params.userWatchDraft
        .split(/[,，、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }
  if (params.watchStocksConfigured) {
    return {
      watchStocks: (params.configuredWatchStocks || []).map((s) => String(s).trim()).filter(Boolean),
    };
  }
  return {};
}

export const AiConfigModal: React.FC<AiConfigModalProps> = ({
  open,
  config,
  onClose,
  onSaved,
  onToast,
}) => {
  const { t } = useI18n();
  const [provider, setProvider] = useState<AiProvider>('deepseek');
  const [temperature, setTemperature] = useState('0.2');
  // 分离保存默认预览值与用户手动编辑草稿，防止异步自选预填晚返回时覆盖用户输入或显式清空
  const [defaultWatchPreview, setDefaultWatchPreview] = useState('');
  const [userWatchDraft, setUserWatchDraft] = useState<string | null>(null);
  const displayedWatchText = userWatchDraft !== null ? userWatchDraft : defaultWatchPreview;

  const [codexCmd, setCodexCmd] = useState('codex');
  const [codexModel, setCodexModel] = useState('');
  const [codexEffort, setCodexEffort] = useState('medium');

  const [geminiCliCmd, setGeminiCliCmd] = useState('gemini');
  const [geminiCliModel, setGeminiCliModel] = useState('');

  const [apiDrafts, setApiDrafts] = useState<Record<ApiProviderKey, ApiDraftState>>({
    deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    qwen: { apiKey: '', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    moonshot: { apiKey: '', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview' },
    zhipu: { apiKey: '', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
    gemini: { apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-pro', enableGoogleSearch: true },
    openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
    custom: { label: 'OpenAI-Compatible Gateway', apiKey: '', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  });

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [refreshingCli, setRefreshingCli] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    let alive = true;
    if (open && config) {
      const initialProvider: AiProvider = config.hasSavedConfig
        ? config.provider
        : QUICK_PROVIDER_IDS.includes(config.provider)
        ? config.provider
        : 'deepseek';
      setProvider(initialProvider);
      // 首次未配置时高级区默认折叠；已有用户保存的高级提供方默认保持折叠但清晰展示状态摘要，点击可展开编辑
      setShowAdvanced(false);
      setTemperature(String(config.temperature ?? 0.2));
      setUserWatchDraft(null);

      const savedWatch = (config.watchStocks || []).filter(Boolean);
      if (config.watchStocksConfigured) {
        // 严格尊重用户已保存配置（含显式清空 []）
        setDefaultWatchPreview(savedWatch.join(', '));
      } else {
        setDefaultWatchPreview('');
        api
          .getWatchlist()
          .then((res) => {
            if (!alive || !res?.configured || res?.isDemo) return;
            const codes = (res.items || [])
              .filter((it) => it && it.marketKind === 'CN')
              .map((it) => String(it.code || it.secid || '').replace(/^\d+\./, '').trim())
              .filter((code) => /^\d{6}$/.test(code))
              .slice(0, 10);
            if (codes.length > 0) setDefaultWatchPreview(codes.join(', '));
          })
          .catch(() => {});
      }

      setCodexCmd(config.codex_cli.command || 'codex');
      setCodexModel(config.codex_cli.model || '');
      setCodexEffort(config.codex_cli.reasoningEffort ?? 'medium');
      setGeminiCliCmd(config.gemini_cli.command || 'gemini');
      setGeminiCliModel(config.gemini_cli.model || '');
      setApiDrafts({
        deepseek: { apiKey: '', baseUrl: config.deepseek.baseUrl, model: config.deepseek.model },
        qwen: { apiKey: '', baseUrl: config.qwen.baseUrl, model: config.qwen.model },
        moonshot: { apiKey: '', baseUrl: config.moonshot.baseUrl, model: config.moonshot.model },
        zhipu: { apiKey: '', baseUrl: config.zhipu.baseUrl, model: config.zhipu.model },
        gemini: {
          apiKey: '',
          baseUrl: config.gemini.baseUrl,
          model: config.gemini.model,
          enableGoogleSearch: config.gemini.enableGoogleSearch,
        },
        openai: { apiKey: '', baseUrl: config.openai.baseUrl, model: config.openai.model },
        custom: {
          label: config.custom.label || 'OpenAI-Compatible Gateway',
          apiKey: '',
          baseUrl: config.custom.baseUrl,
          model: config.custom.model,
        },
      });
      setTestResult(null);
    }
    return () => {
      alive = false;
    };
  }, [open, config]);

  if (!open) return null;

  const updateApiDraft = (key: ApiProviderKey, patch: Partial<ApiDraftState>) => {
    setApiDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  const buildPatch = () => {
    const pack = (k: ApiProviderKey) => {
      const d = apiDrafts[k];
      return {
        ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}),
        baseUrl: d.baseUrl.trim(),
        model: d.model.trim(),
        ...(k === 'custom' ? { label: (d.label || '').trim() } : {}),
        ...(k === 'gemini' ? { enableGoogleSearch: Boolean(d.enableGoogleSearch) } : {}),
      };
    };

    const watchPatch = resolveAiConfigWatchStocksPatch({
      userWatchDraft,
      watchStocksConfigured: config?.watchStocksConfigured,
      configuredWatchStocks: config?.watchStocks,
    });

    return {
      provider,
      temperature: Number(temperature) || 0.2,
      ...watchPatch,
      codex_cli: {
        command: codexCmd.trim() || 'codex',
        model: codexModel.trim(),
        reasoningEffort: codexEffort.trim(),
      },
      gemini_cli: {
        command: geminiCliCmd.trim() || 'gemini',
        model: geminiCliModel.trim(),
      },
      deepseek: pack('deepseek'),
      qwen: pack('qwen'),
      moonshot: pack('moonshot'),
      zhipu: pack('zhipu'),
      gemini: pack('gemini'),
      openai: pack('openai'),
      custom: pack('custom'),
    };
  };

  const handleRefreshCli = async () => {
    setRefreshingCli(true);
    try {
      const res = await api.getAiConfig(true);
      onSaved(res.config);
      onToast(t('已重新探测本机 Codex / Gemini CLI 授权状态', 'Re-probed local Codex / Gemini CLI status'), 'info');
    } catch (err: any) {
      onToast(`${t('探测失败：', 'Probe failed: ')}${err.message}`, 'error');
    } finally {
      setRefreshingCli(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.saveAiConfig(buildPatch());
      onSaved(res.config);
      onToast(t('AI 引擎配置已保存至本机 ai-config.local.json', 'AI configuration saved locally'), 'success');
      onClose();
    } catch (err: any) {
      onToast(`${t('保存失败：', 'Save failed: ')}${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAndTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const saved = await api.saveAiConfig(buildPatch());
      onSaved(saved.config);
      const res = await api.testAiConnection(provider);
      setTestResult({
        ok: true,
        msg: t(
          `连通成功！引擎 ${res.provider} (${res.model})，耗时 ${(res.latencyMs / 1000).toFixed(1)}s`,
          `Connected! Provider ${res.provider} (${res.model}) in ${(res.latencyMs / 1000).toFixed(1)}s`
        ),
      });
    } catch (err: any) {
      setTestResult({ ok: false, msg: err.message });
    } finally {
      setTesting(false);
    }
  };

  const isQuickProvider = QUICK_PROVIDER_IDS.includes(provider);
  const isAdvancedProvider = ADVANCED_PROVIDER_IDS.includes(provider);
  const isApiProvider = provider !== 'codex_cli' && provider !== 'gemini_cli';
  const activeApiKey = isApiProvider ? (provider as ApiProviderKey) : null;
  const activeQuickCard = QUICK_RECOMMENDED_CARDS.find((c) => c.id === provider) || null;
  const activeProviderCard = PROVIDER_CARDS.find((c) => c.id === provider);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('AI 引擎中心', 'AI Engine Center')}
      onClick={onClose}
    >
      <div className="modal-box" style={{ maxWidth: 820 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Bot size={19} color="var(--navy)" />
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                {t('AI 引擎中心（30 秒极速配置）', 'AI Engine Center (30-Sec Quick Setup)')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t(
                  '仅存本机 · 统一驱动每日复盘、标的研判与文献/认知文档提纯（BYOAI）',
                  'Stored locally only · Powers daily reviews, thesis drafts & document ingestion (BYOAI)'
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

        <div className="modal-body">
          {/* 当前已保存高级提供方状态提示（当高级区折叠且用户当前选中的是高级/CLI提供方时展示） */}
          {!showAdvanced && isAdvancedProvider && activeProviderCard && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                padding: '9px 12px',
                marginBottom: 12,
                borderRadius: 8,
                background: 'var(--navy-soft)',
                border: '1px solid color-mix(in srgb, var(--navy) 25%, transparent)',
                fontSize: 12.5,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Terminal size={14} color="var(--navy)" />
                <span>
                  {t('当前激活高级引擎：', 'Active advanced engine: ')}
                  <strong>{t(activeProviderCard.titleZh, activeProviderCard.titleEn)}</strong>
                </span>
                <span className={`badge ${isAiProviderReady(config, provider) ? 'badge-emerald' : 'badge-amber'}`}>
                  {isAiProviderReady(config, provider) ? t('已就绪', 'Ready') : t('待配置', 'Setup needed')}
                </span>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setShowAdvanced(true)}>
                {t('展开高级参数', 'Edit Advanced')}
              </button>
            </div>
          )}

          {/* 新手 30 秒极速配置区 */}
          <div className="field-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label className="field-label" style={{ margin: 0 }}>
                <Sparkles size={13} color="var(--amber)" style={{ verticalAlign: -2, marginRight: 4 }} />
                {t(
                  '推荐 · 30 秒极速配置（选一个服务商 → 粘贴 API Key → 点底部「保存并测试」）',
                  'Quick Setup · Pick a provider → Paste API Key → Click "Save & Test"'
                )}
              </label>
            </div>
            <div className="grid-3" style={{ gap: 8 }}>
              {QUICK_RECOMMENDED_CARDS.map((card) => {
                const ready = isAiProviderReady(config, card.id);
                const selected = provider === card.id;
                return (
                  <button
                    key={card.id}
                    type="button"
                    className={`btn ${selected ? 'btn-primary' : ''}`}
                    style={{
                      justifyContent: 'space-between',
                      padding: '9px 10px',
                      textAlign: 'left',
                      height: 'auto',
                    }}
                    onClick={() => {
                      setProvider(card.id);
                      setTestResult(null);
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 700, fontSize: 12.5 }}>
                        <KeyRound size={13} />
                        {t(card.titleZh, card.titleEn)}
                      </span>
                      <span
                        style={{
                          fontSize: 10.5,
                          opacity: selected ? 0.88 : 0.68,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {t(card.subZh, card.subEn)}
                      </span>
                    </div>
                    <span
                      className={`badge ${ready ? 'badge-emerald' : 'badge-muted'}`}
                      style={{ fontSize: 10, padding: '1px 5px', flexShrink: 0 }}
                    >
                      {ready ? t('就绪', 'Ready') : t('未配Key', 'No Key')}
                    </span>
                  </button>
                );
              })}
            </div>

            {activeQuickCard && activeApiKey && (
              <div className="field-block" style={{ marginTop: 10, marginBottom: 0, background: 'var(--bg-soft)' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    flexWrap: 'wrap',
                    marginBottom: 8,
                    padding: '6px 10px',
                    borderRadius: 7,
                    background: 'var(--navy-soft)',
                    color: 'var(--navy)',
                    fontSize: 11.5,
                  }}
                >
                  <span>
                    <strong>{t('获取 Key 一步指引：', 'Quick Key Guide: ')}</strong>
                    {t(activeQuickCard.guideTipZh, activeQuickCard.guideTipEn)}
                  </span>
                  <a
                    href={activeQuickCard.consoleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-sm"
                    style={{ padding: '2px 8px', fontSize: 11, textDecoration: 'none', flexShrink: 0 }}
                  >
                    <ExternalLink size={11} />
                    <span>{t('前往官方申请 Key', 'Get API Key')}</span>
                  </a>
                </div>

                <div className="field-group" style={{ marginBottom: 0 }}>
                  <label className="field-label">
                    {t(activeQuickCard.titleZh, activeQuickCard.titleEn)} · API Key
                    {config?.[activeApiKey]?.hasApiKey && (
                      <span className="badge badge-emerald mono">
                        {t('已保存：', 'Saved: ')}
                        {config[activeApiKey].maskedKey}
                      </span>
                    )}
                  </label>
                  <input
                    type="password"
                    className="input mono"
                    placeholder={
                      config?.[activeApiKey]?.hasApiKey
                        ? t('留空保持当前已保存的 Key 不变', 'Leave blank to keep saved key')
                        : t(ENV_HINTS[activeApiKey].zh, ENV_HINTS[activeApiKey].en)
                    }
                    value={apiDrafts[activeApiKey].apiKey}
                    onChange={(e) => updateApiDraft(activeApiKey, { apiKey: e.target.value })}
                  />
                </div>
              </div>
            )}
          </div>

          {/* 开发者高级 / 更多模型与参数折叠区（首次使用者默认严格收起） */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showAdvanced ? 8 : 0 }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ padding: '4px 8px', fontSize: 12 }}
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                <Terminal size={12} />
                <span>
                  {showAdvanced
                    ? t('收起开发者高级配置（模型 / Base URL / CLI / 采样温度）', 'Hide Developer & Advanced Settings')
                    : t('展开开发者高级配置（Codex / Gemini / OpenAI / 智谱 / Ollama / 模型与网关）', 'Show Advanced Settings (CLI / OpenAI / Gemini / Ollama / Model & Base URL)')}
                </span>
              </button>
              {showAdvanced && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={handleRefreshCli} disabled={refreshingCli}>
                  <RefreshCw size={12} className={refreshingCli ? 'spin' : ''} />{' '}
                  {refreshingCli ? t('探测中...', 'Probing...') : t('重新探测本机 CLI', 'Re-probe Local CLIs')}
                </button>
              )}
            </div>

            {showAdvanced && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="grid-3" style={{ gap: 7 }}>
                  {PROVIDER_CARDS.filter((c) => ADVANCED_PROVIDER_IDS.includes(c.id)).map((card) => {
                    const ready = isAiProviderReady(config, card.id);
                    const selected = provider === card.id;
                    return (
                      <button
                        key={card.id}
                        type="button"
                        className={`btn ${selected ? 'btn-primary' : ''}`}
                        style={{
                          justifyContent: 'space-between',
                          padding: '8px 10px',
                          textAlign: 'left',
                          height: 'auto',
                        }}
                        onClick={() => {
                          setProvider(card.id);
                          setTestResult(null);
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 700, fontSize: 12.5 }}>
                            {card.kind === 'cli' ? <Terminal size={13} /> : <KeyRound size={13} />}
                            {t(card.titleZh, card.titleEn)}
                          </span>
                          <span
                            style={{
                              fontSize: 10.5,
                              opacity: selected ? 0.86 : 0.65,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t(card.subZh, card.subEn)}
                          </span>
                        </div>
                        <span
                          className={`badge ${ready ? 'badge-emerald' : 'badge-muted'}`}
                          style={{ fontSize: 10, padding: '1px 5px', flexShrink: 0 }}
                        >
                          {ready ? t('就绪', 'Ready') : card.kind === 'cli' ? t('未就绪', 'Offline') : t('未配Key', 'No Key')}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {provider === 'codex_cli' && (
                  <div className="field-block" style={{ background: 'var(--bg-soft)', marginBottom: 0 }}>
                    <div className="field-block-label" style={{ color: 'var(--navy)' }}>
                      <Terminal size={13} /> {t('本机 Codex CLI · ChatGPT 官方套餐直连', 'Local Codex CLI · ChatGPT Subscription')}
                    </div>
                    <div
                      style={{
                        padding: '8px 11px',
                        borderRadius: 7,
                        marginBottom: 11,
                        fontSize: 12.5,
                        background: config?.codex_cli.loggedIn ? 'var(--emerald-soft)' : 'var(--amber-soft)',
                        color: config?.codex_cli.loggedIn ? 'var(--emerald)' : 'var(--amber)',
                      }}
                    >
                      <strong>{t('本机检测状态：', 'Local Status: ')}</strong>
                      {config?.codex_cli.installed
                        ? `${config.codex_cli.version} · ${config.codex_cli.authStatus}`
                        : t(
                            '未检测到 codex 命令，请先安装 Codex CLI 并在终端执行 codex login 完成登录。',
                            'codex CLI not found. Install Codex CLI and run "codex login" in terminal.'
                          )}
                    </div>
                    <div className="grid-3">
                      <div className="field-group" style={{ marginBottom: 0 }}>
                        <label className="field-label">{t('CLI 命令名/路径', 'CLI Command / Path')}</label>
                        <input className="input mono" value={codexCmd} onChange={(e) => setCodexCmd(e.target.value)} />
                      </div>
                      <div className="field-group" style={{ marginBottom: 0 }}>
                        <label className="field-label">{t('指定模型（留空默认）', 'Model Override (optional)')}</label>
                        <input
                          className="input mono"
                          placeholder={t('留空沿用 ~/.codex/config.toml', 'Default from ~/.codex/config.toml')}
                          value={codexModel}
                          onChange={(e) => setCodexModel(e.target.value)}
                        />
                      </div>
                      <div className="field-group" style={{ marginBottom: 0 }}>
                        <label className="field-label">{t('推理深度', 'Reasoning Effort')}</label>
                        <select className="select" value={codexEffort} onChange={(e) => setCodexEffort(e.target.value)}>
                          <option value="">{t('默认（不覆盖配置）', 'Default')}</option>
                          <option value="low">{t('low（最快）', 'low (Fast)')}</option>
                          <option value="medium">{t('medium（推荐均衡）', 'medium (Balanced)')}</option>
                          <option value="high">{t('high（深度分析）', 'high (Deep)')}</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}

                {provider === 'gemini_cli' && (
                  <div className="field-block" style={{ background: 'var(--bg-soft)', marginBottom: 0 }}>
                    <div className="field-block-label" style={{ color: 'var(--teal)' }}>
                      <Terminal size={13} /> {t('本机 Gemini CLI · Google 官方授权', 'Local Gemini CLI · Google Auth')}
                    </div>
                    <div
                      style={{
                        padding: '8px 11px',
                        borderRadius: 7,
                        marginBottom: 11,
                        fontSize: 12.5,
                        background: config?.gemini_cli.installed ? 'var(--emerald-soft)' : 'var(--amber-soft)',
                        color: config?.gemini_cli.installed ? 'var(--emerald)' : 'var(--amber)',
                      }}
                    >
                      <strong>{t('本机检测状态：', 'Local Status: ')}</strong>
                      {config?.gemini_cli.installed
                        ? `${config.gemini_cli.version} · ${config.gemini_cli.authStatus}`
                        : t(
                            '当前未检测到 gemini 命令；安装 @google/gemini-cli 并登录后即可启用。',
                            'gemini CLI not detected. Install @google/gemini-cli and sign in.'
                          )}
                    </div>
                    <div className="grid-2">
                      <div className="field-group" style={{ marginBottom: 0 }}>
                        <label className="field-label">{t('CLI 命令名/路径', 'CLI Command / Path')}</label>
                        <input className="input mono" value={geminiCliCmd} onChange={(e) => setGeminiCliCmd(e.target.value)} />
                      </div>
                      <div className="field-group" style={{ marginBottom: 0 }}>
                        <label className="field-label">{t('指定模型（留空默认）', 'Model Override (optional)')}</label>
                        <input
                          className="input mono"
                          placeholder="e.g. gemini-2.5-pro"
                          value={geminiCliModel}
                          onChange={(e) => setGeminiCliModel(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {activeApiKey && (
                  <div className="field-block" style={{ background: 'var(--bg-soft)', marginBottom: 0 }}>
                    <div className="field-block-label" style={{ color: 'var(--navy)' }}>
                      <KeyRound size={13} />{' '}
                      {t(
                        `${activeProviderCard?.titleZh || activeApiKey} 高级参数配置`,
                        `${activeProviderCard?.titleEn || activeApiKey} Advanced Parameters`
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
                      <span style={{ fontSize: 11.5, color: 'var(--text-muted)', alignSelf: 'center', marginRight: 2 }}>
                        <Sparkles size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
                        {t('一键预设：', 'Presets: ')}
                      </span>
                      {MODEL_PRESETS[activeApiKey].map((preset) => (
                        <button
                          key={preset.model}
                          type="button"
                          className={`btn btn-sm ${apiDrafts[activeApiKey].model === preset.model ? 'btn-primary' : ''}`}
                          style={{ padding: '2px 8px', fontSize: 11.5 }}
                          onClick={() =>
                            updateApiDraft(activeApiKey, {
                              model: preset.model,
                              ...(preset.baseUrl ? { baseUrl: preset.baseUrl } : {}),
                            })
                          }
                        >
                          {t(preset.labelZh, preset.labelEn)}
                        </button>
                      ))}
                    </div>

                    {activeApiKey === 'custom' && (
                      <div className="field-group" style={{ marginBottom: 9 }}>
                        <label className="field-label">{t('自定义接口备注名', 'Custom Gateway Label')}</label>
                        <input
                          className="input"
                          value={apiDrafts.custom.label || ''}
                          onChange={(e) => updateApiDraft('custom', { label: e.target.value })}
                          placeholder={t('例：硅基流动 / OpenRouter / 本机 Ollama', 'e.g. OpenRouter / Local Ollama')}
                        />
                      </div>
                    )}

                    {!isQuickProvider && (
                      <div className="field-group" style={{ marginBottom: 9 }}>
                        <label className="field-label">
                          API Key
                          {config?.[activeApiKey]?.hasApiKey && (
                            <span className="badge badge-emerald mono">
                              {t('已保存：', 'Saved: ')}
                              {config[activeApiKey].maskedKey}
                            </span>
                          )}
                        </label>
                        <input
                          type="password"
                          className="input mono"
                          placeholder={
                            config?.[activeApiKey]?.hasApiKey
                              ? t('留空保持当前已保存的 Key 不变', 'Leave blank to keep saved key')
                              : t(ENV_HINTS[activeApiKey].zh, ENV_HINTS[activeApiKey].en)
                          }
                          value={apiDrafts[activeApiKey].apiKey}
                          onChange={(e) => updateApiDraft(activeApiKey, { apiKey: e.target.value })}
                        />
                      </div>
                    )}

                    <div className="grid-2">
                      <div className="field-group" style={{ marginBottom: activeApiKey === 'gemini' ? 8 : 0 }}>
                        <label className="field-label">{t('模型名称 (model)', 'Model Name')}</label>
                        <input
                          className="input mono"
                          value={apiDrafts[activeApiKey].model}
                          onChange={(e) => updateApiDraft(activeApiKey, { model: e.target.value })}
                        />
                      </div>
                      <div className="field-group" style={{ marginBottom: activeApiKey === 'gemini' ? 8 : 0 }}>
                        <label className="field-label">{t('Base URL（官方或自建网关）', 'Base URL (Official or Proxy)')}</label>
                        <input
                          className="input mono"
                          value={apiDrafts[activeApiKey].baseUrl}
                          onChange={(e) => updateApiDraft(activeApiKey, { baseUrl: e.target.value })}
                        />
                      </div>
                    </div>

                    {activeApiKey === 'gemini' && (
                      <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={Boolean(apiDrafts.gemini.enableGoogleSearch)}
                          onChange={(e) => updateApiDraft('gemini', { enableGoogleSearch: e.target.checked })}
                        />
                        {t('开启 Google Search 原生联网搜索', 'Enable Google Search grounding')}
                      </label>
                    )}
                  </div>
                )}

                <div className="grid-2">
                  <div className="field-group" style={{ marginBottom: 0 }}>
                    <label className="field-label">{t('采样温度（非推理模型生效，建议 0.2）', 'Sampling Temperature (recommended 0.2)')}</label>
                    <input
                      className="input mono"
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={temperature}
                      onChange={(e) => setTemperature(e.target.value)}
                    />
                  </div>
                  <div className="field-group" style={{ marginBottom: 0 }}>
                    <label className="field-label">
                      {t('日度复盘默认观察代码（可选，留空不强塞样本）', 'Daily Review Watch Tickers (optional, comma-separated)')}
                    </label>
                    <input
                      className="input mono"
                      value={displayedWatchText}
                      placeholder={t('留空默认按当前空间 A 股自选，或手动输入代码（逗号分隔）', 'Optional: defaults to active workspace CN watchlist')}
                      onChange={(e) => {
                        setUserWatchDraft(e.target.value);
                      }}
                    />
                    {config?.watchStocksLegacyPendingConfirm && (
                      <div
                        style={{
                          marginTop: 6,
                          padding: '6px 8px',
                          borderRadius: 6,
                          background: 'var(--amber-soft)',
                          border: '1px solid color-mix(in srgb, var(--amber) 35%, transparent)',
                          fontSize: 11.5,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 5,
                        }}
                      >
                        <span>
                          {t(
                            '检测到旧版自动保存的默认 6 股观察池，确认前已自动回退为当前空间自选：',
                            'Detected legacy auto-saved 6-stock defaults; falling back to active workspace watchlist until confirmed:'
                          )}
                        </span>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={async () => {
                              try {
                                const res = await api.saveAiConfig({ confirmLegacyWatchStocks: 'use_watchlist' });
                                onSaved(res.config);
                                setUserWatchDraft(null);
                                onToast(t('已确认：日度复盘默认沿用当前工作空间自选', 'Confirmed: use active workspace watchlist'), 'success');
                              } catch (err: any) {
                                api.getAiConfig().then((fresh) => { if (fresh?.config) onSaved(fresh.config); }).catch(() => {});
                                onToast(err.message || '确认失败', 'error');
                              }
                            }}
                          >
                            {t('沿用当前空间自选（推荐）', 'Use Workspace Watchlist')}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={async () => {
                              try {
                                const res = await api.saveAiConfig({ confirmLegacyWatchStocks: 'keep' });
                                onSaved(res.config);
                                setUserWatchDraft(null);
                                onToast(t('已确认保留旧版 6 只观察股作为自定义观察池', 'Confirmed: keep legacy 6 watch stocks'), 'success');
                              } catch (err: any) {
                                api.getAiConfig().then((fresh) => { if (fresh?.config) onSaved(fresh.config); }).catch(() => {});
                                onToast(err.message || '确认失败', 'error');
                              }
                            }}
                          >
                            {t('保留旧版 6 只观察股', 'Keep Legacy 6 Stocks')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {testResult && (
            <div
              className="field-block"
              style={{
                marginTop: 12,
                marginBottom: 0,
                background: testResult.ok ? 'var(--emerald-soft)' : 'var(--crimson-soft)',
                borderColor: testResult.ok ? 'var(--emerald)' : 'var(--crimson)',
                color: testResult.ok ? 'var(--emerald)' : 'var(--crimson)',
                fontSize: 12.5,
              }}
            >
              {testResult.ok && <CheckCircle2 size={14} style={{ verticalAlign: -2, marginRight: 6 }} />}
              {testResult.msg}
            </div>
          )}
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="btn btn-sm" onClick={handleSaveAndTest} disabled={testing || saving}>
            <PlugZap size={14} /> {testing ? t('正在连通测试...', 'Testing...') : t('保存并测试当前引擎', 'Save & Test Connection')}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-sm" onClick={onClose}>
              {t('取消', 'Cancel')}
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving || testing}>
              <Save size={14} /> {saving ? t('保存中...', 'Saving...') : t('保存配置', 'Save Settings')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
