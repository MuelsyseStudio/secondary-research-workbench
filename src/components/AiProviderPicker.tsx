import React from 'react';
import { Settings2 } from 'lucide-react';
import { useI18n } from '../i18n';
import type { AiProvider, AiSafeConfig } from '../types';

export const AI_PROVIDER_OPTIONS: {
  id: AiProvider;
  label: string;
  labelEn: string;
  shortLabel: string;
  shortLabelEn: string;
  group: 'cli' | 'cn' | 'intl';
}[] = [
  { id: 'codex_cli', label: '本机 Codex CLI（ChatGPT 官方套餐）', labelEn: 'Local Codex CLI (ChatGPT Plan)', shortLabel: 'CODEX 套餐', shortLabelEn: 'CODEX CLI', group: 'cli' },
  { id: 'gemini_cli', label: '本机 Gemini CLI（Google 官方授权）', labelEn: 'Local Gemini CLI (Google Auth)', shortLabel: 'GEMINI CLI', shortLabelEn: 'GEMINI CLI', group: 'cli' },
  { id: 'deepseek', label: 'DeepSeek API（V3 / R1）', labelEn: 'DeepSeek API (V3 / R1)', shortLabel: 'DEEPSEEK', shortLabelEn: 'DEEPSEEK', group: 'cn' },
  { id: 'qwen', label: '阿里通义千问 Qwen API', labelEn: 'Alibaba Qwen API', shortLabel: 'QWEN', shortLabelEn: 'QWEN', group: 'cn' },
  { id: 'moonshot', label: 'Kimi / Moonshot API', labelEn: 'Kimi / Moonshot API', shortLabel: 'KIMI', shortLabelEn: 'KIMI', group: 'cn' },
  { id: 'zhipu', label: '智谱 GLM API', labelEn: 'Zhipu GLM API', shortLabel: 'GLM', shortLabelEn: 'GLM', group: 'cn' },
  { id: 'gemini', label: 'Google Gemini API', labelEn: 'Google Gemini API', shortLabel: 'GEMINI', shortLabelEn: 'GEMINI', group: 'intl' },
  { id: 'openai', label: 'OpenAI / GPT API', labelEn: 'OpenAI / GPT API', shortLabel: 'GPT API', shortLabelEn: 'GPT API', group: 'intl' },
  { id: 'custom', label: '自定义 OpenAI 兼容接口（硅基流动/OpenRouter/豆包/Ollama）', labelEn: 'Custom OpenAI-Compatible API (OpenRouter / Ollama)', shortLabel: 'CUSTOM API', shortLabelEn: 'CUSTOM API', group: 'intl' },
];

export function isAiProviderReady(config: AiSafeConfig | null, provider: AiProvider): boolean {
  if (!config) return false;
  if (provider === 'codex_cli') return config.codex_cli.loggedIn;
  if (provider === 'gemini_cli') return config.gemini_cli.installed;
  if (provider === 'custom') {
    const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(config.custom.baseUrl || '');
    return config.custom.hasApiKey || isLocal;
  }
  return Boolean(config[provider]?.hasApiKey);
}

export function getAiProviderBadgeText(config: AiSafeConfig | null, provider?: AiProvider, lang: 'zh' | 'en' = 'zh'): string {
  const p = provider || config?.provider || 'deepseek';
  const opt = AI_PROVIDER_OPTIONS.find((x) => x.id === p);
  if (!opt) return p.toUpperCase();
  return lang === 'en' ? opt.shortLabelEn : opt.shortLabel;
}

export function getAiProviderModelLabel(config: AiSafeConfig | null, provider: AiProvider, lang: 'zh' | 'en' = 'zh'): string {
  if (!config) return provider;
  if (provider === 'codex_cli') return `Codex CLI (${config.codex_cli.model || (lang === 'en' ? 'plan default' : '官方套餐默认')})`;
  if (provider === 'gemini_cli') return `Gemini CLI (${config.gemini_cli.model || (lang === 'en' ? 'default' : '官方默认')})`;
  const opt = AI_PROVIDER_OPTIONS.find((x) => x.id === provider);
  const model = config[provider]?.model || '';
  const badge = opt ? (lang === 'en' ? opt.shortLabelEn : opt.shortLabel) : provider;
  return `${badge}${model ? ` · ${model}` : ''}`;
}

interface AiProviderPickerProps {
  value: AiProvider;
  config: AiSafeConfig | null;
  onChange: (provider: AiProvider) => void;
  onOpenSettings: () => void;
}

export const AiProviderPicker: React.FC<AiProviderPickerProps> = ({
  value,
  config,
  onChange,
  onOpenSettings,
}) => {
  const { lang, t } = useI18n();
  const ready = isAiProviderReady(config, value);
  const modelInfo = getAiProviderModelLabel(config, value, lang);

  const renderOpt = (opt: (typeof AI_PROVIDER_OPTIONS)[number]) => {
    const ok = isAiProviderReady(config, opt.id);
    const model =
      opt.id === 'codex_cli'
        ? config?.codex_cli.model || t('套餐默认', 'default')
        : opt.id === 'gemini_cli'
        ? config?.gemini_cli.model || t('默认', 'default')
        : config?.[opt.id]?.model || '';
    return (
      <option key={opt.id} value={opt.id}>
        {ok ? '✓ ' : '○ '}
        {lang === 'en' ? opt.labelEn : opt.label}
        {model ? ` [${model}]` : ''}
      </option>
    );
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <select
        className="select"
        style={{ width: 'auto', minWidth: 215, maxWidth: 300, padding: '5px 9px', fontSize: 12.5, fontWeight: 600 }}
        value={value}
        onChange={(e) => onChange(e.target.value as AiProvider)}
        title={t('切换当前执行的 AI 推理引擎', 'Switch active AI inference provider')}
      >
        <optgroup label={t('本机官方套餐 CLI（免 API Key）', 'Local CLI (No API Key)')}>
          {AI_PROVIDER_OPTIONS.filter((x) => x.group === 'cli').map(renderOpt)}
        </optgroup>
        <optgroup label={t('国内主流大模型 API', 'CN Model APIs')}>
          {AI_PROVIDER_OPTIONS.filter((x) => x.group === 'cn').map(renderOpt)}
        </optgroup>
        <optgroup label={t('海外与自定义 OpenAI 兼容 API', 'Global & Custom OpenAI-Compatible APIs')}>
          {AI_PROVIDER_OPTIONS.filter((x) => x.group === 'intl').map(renderOpt)}
        </optgroup>
      </select>
      <button type="button" className="btn btn-sm" onClick={onOpenSettings} title={modelInfo}>
        <Settings2 size={13} />
        <span className={`badge ${ready ? 'badge-emerald' : 'badge-amber'}`} style={{ padding: '0 5px', fontSize: 10.5 }}>
          {ready ? t('就绪', 'Ready') : t('去配置', 'Setup')}
        </span>
      </button>
    </div>
  );
};
