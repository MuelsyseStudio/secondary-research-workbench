import React, { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  CheckCircle2,
  Compass,
  EyeOff,
  Flame,
  KeyRound,
  Layers,
  Loader2,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import { api } from '../api';
import { IS_OPEN_SOURCE_EDITION } from '../config/edition';
import { useI18n } from '../i18n';

export type UserRolePreset = 'wave_research' | 'short_term_a' | 'all_features';

export interface UserUiPreferences {
  onboarded: boolean;
  role: UserRolePreset;
  focusProMode: boolean;
}

const UI_PREFS_KEY = 'srw_ui_role_prefs_v1';

export function loadUserUiPrefs(): UserUiPreferences {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        return {
          onboarded: Boolean(p.onboarded),
          role: ['wave_research', 'short_term_a', 'all_features'].includes(p.role) ? p.role : 'wave_research',
          focusProMode: Boolean(p.focusProMode),
        };
      }
    }
  } catch {
    // ignore
  }
  return {
    onboarded: false,
    role: 'wave_research',
    focusProMode: false,
  };
}

export function saveUserUiPrefs(prefs: UserUiPreferences): void {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

interface RoleOnboardingModalProps {
  open: boolean;
  initialPrefs: UserUiPreferences;
  machineCode?: string;
  canDismiss?: boolean;
  onApply: (prefs: UserUiPreferences) => void;
  onQuickSetupDone?: (info: { addedStocks: number; aiConfigured: boolean; licenseActivated: boolean }) => void;
  onToast?: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
  onClose?: () => void;
}

const ROLE_CARDS: {
  id: UserRolePreset;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  highlights: string[];
}[] = [
  {
    id: 'wave_research',
    title: '波段投研与三库体系（推荐默认）',
    subtitle: '适合中线行业研究、方法论沉淀、日度复盘与标的假设追踪',
    icon: <BookOpen size={18} color="var(--navy)" />,
    highlights: [
      '默认进入投研模式驾驶舱，精简侧栏聚焦核心三库、全球盯盘、技术点位与账本归因',
      '内置结构化三库模板与统一复盘台账，随时可在侧栏恢复全部高级页签',
    ],
  },
  {
    id: 'short_term_a',
    title: 'A 股短线盯盘作战',
    subtitle: '适合盘中情绪周期跟踪、板块成分联动、连板梯队与异动监管核查',
    icon: <Flame size={18} color="var(--crimson)" />,
    highlights: [
      '默认进入短线全景看盘驾驶舱，左侧板块联动成分股，中栏分时+K线、右栏五档盘口',
      '复盘统一归口至「深度复盘与台账」，一键同步短线情绪温度与领涨主线题材',
    ],
  },
  {
    id: 'all_features',
    title: '全功能工作台（全部开启）',
    subtitle: '同时展示投研模式、短线作战中枢、情报进化与策略回测实验室',
    icon: <Layers size={18} color="var(--teal)" />,
    highlights: [
      '保留全部侧栏导航与多市场视角，自由在投研模式与短线模式之间一键热切',
      '适合需要全栈投研、复盘归因与 Python 策略回测的专业用户',
    ],
  },
];

const STARTER_TICKERS = [
  { secid: '1.600519', code: '600519', secuCode: '600519.SH', name: '贵州茅台', marketKind: 'CN' as const, currency: 'CNY' as const, group: 'A股核心', note: '消费蓝筹代表' },
  { secid: '0.300750', code: '300750', secuCode: '300750.SZ', name: '宁德时代', marketKind: 'CN' as const, currency: 'CNY' as const, group: 'A股核心', note: '新能源与创业板权重' },
  { secid: '1.601318', code: '601318', secuCode: '601318.SH', name: '中国平安', marketKind: 'CN' as const, currency: 'CNY' as const, group: 'A股核心', note: '大金融核心标杆' },
  { secid: '0.300308', code: '300308', secuCode: '300308.SZ', name: '中际旭创', marketKind: 'CN' as const, currency: 'CNY' as const, group: 'AI算力', note: 'AI 算力与光通信龙头' },
  { secid: '1.600036', code: '600036', secuCode: '600036.SH', name: '招商银行', marketKind: 'CN' as const, currency: 'CNY' as const, group: 'A股核心', note: '高股息银行标杆' },
];

export const RoleOnboardingModal: React.FC<RoleOnboardingModalProps> = ({
  open,
  initialPrefs,
  machineCode = '',
  canDismiss = true,
  onApply,
  onQuickSetupDone,
  onToast,
  onClose,
}) => {
  const { t } = useI18n();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [role, setRole] = useState<UserRolePreset>(initialPrefs.role || 'wave_research');
  const [focusProMode, setFocusProMode] = useState<boolean>(initialPrefs.focusProMode);
  const [selectedSecids, setSelectedSecids] = useState<string[]>(['1.600519', '0.300750', '0.300308']);
  const [aiProvider, setAiProvider] = useState<'deepseek' | 'qwen'>('deepseek');
  const [aiApiKey, setAiApiKey] = useState('');
  const [licenseKey, setLicenseKey] = useState('');
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const toggleTicker = (secid: string) => {
    setSelectedSecids((prev) => (prev.includes(secid) ? prev.filter((x) => x !== secid) : [...prev, secid]));
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    let addedStocks = 0;
    let aiConfigured = false;
    let licenseActivated = false;
    try {
      // 1. 导入所选初始自选标的（若已选择）
      const picks = STARTER_TICKERS.filter((item) => selectedSecids.includes(item.secid));
      for (const item of picks) {
        try {
          const res = await api.addWatchlistItem(item);
          if (!res?.alreadyExists) addedStocks++;
        } catch {
          // non-fatal
        }
      }

      // 2. 可选保存快捷 AI API Key（直连服务商，仅存本机）
      const trimmedKey = aiApiKey.trim();
      if (trimmedKey) {
        try {
          await api.saveAiConfig({
            provider: aiProvider,
            [aiProvider]: { apiKey: trimmedKey },
          });
          aiConfigured = true;
        } catch (err: any) {
          onToast?.(`AI 密钥保存未生效（可稍后在右上角 AI 按钮配置）：${err.message}`, 'warning');
        }
      }

      // 3. 可选激活离线授权码（若填写但验签失败，保留在弹窗内提示，不强行跳过）
      const trimmedLic = licenseKey.trim();
      setLicenseError(null);
      if (trimmedLic) {
        try {
          await api.activateLicense(trimmedLic);
          licenseActivated = true;
        } catch (err: any) {
          setLicenseError(err.message || '授权码验签未通过，请核对或清空跳过');
          setStep(3);
          return;
        }
      }

      onApply({
        onboarded: true,
        role,
        focusProMode,
      });
      // 先完成角色偏好应用，再通知快速初始化结果，避免 onApply 的默认页面覆盖自选股落地跳转
      onQuickSetupDone?.({ addedStocks, aiConfigured, licenseActivated });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkip = () => {
    // 跳过向导时不静默写入任何自选股、密钥或授权码，仅保存基础偏好并进入
    onApply({
      onboarded: true,
      role,
      focusProMode,
    });
  };

  return (
    <div className="modal-backdrop" style={{ zIndex: 2050 }} onClick={canDismiss ? onClose : undefined}>
      <div className="modal-box" style={{ maxWidth: 700, width: '94vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ background: 'var(--bg-soft)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Compass size={19} color="var(--navy)" />
            <div>
              <div style={{ fontWeight: 800, fontSize: 15.5 }}>
                {t(`快速上手向导（第 ${step} / 3 步）`, `Quick Setup Wizard (Step ${step} / 3)`)}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                {step === 1
                  ? t('选择主工作流，自动精简侧边栏并按你的习惯初始化界面', 'Choose your workflow to customize navigation')
                  : step === 2
                  ? t('勾选 3–5 只初始观察标的，进入工作台立即看到实时行情与 K 线', 'Pick starter tickers to see live quotes immediately')
                  : t('可选填大模型密钥或授权码（均可跳过，稍后随时配置）', 'Optionally configure AI key or license (both skippable)')}
              </div>
            </div>
          </div>
          {canDismiss && onClose && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              <X size={16} />
            </button>
          )}
        </div>

        {/* Step Indicator Bar */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 8,
            padding: '10px 18px 0',
          }}
        >
          {[
            { n: 1 as const, label: '1. 选择投研模式' },
            { n: 2 as const, label: '2. 勾选初始自选股' },
            { n: 3 as const, label: '3. AI 与授权（可选）' },
          ].map((item) => (
            <button
              key={item.n}
              type="button"
              onClick={() => setStep(item.n)}
              style={{
                border: 'none',
                borderRadius: 8,
                padding: '6px 10px',
                fontSize: 12,
                fontWeight: step === item.n ? 700 : 500,
                cursor: 'pointer',
                background: step === item.n ? 'var(--navy-soft)' : 'var(--bg-soft)',
                color: step === item.n ? 'var(--navy)' : 'var(--text-muted)',
                borderBottom: step === item.n ? '2px solid var(--navy)' : '2px solid transparent',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {step === 1 && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {ROLE_CARDS.map((card) => {
                  const selected = role === card.id;
                  return (
                    <button
                      key={card.id}
                      type="button"
                      onClick={() => setRole(card.id)}
                      style={{
                        textAlign: 'left',
                        cursor: 'pointer',
                        padding: '12px 14px',
                        borderRadius: 10,
                        border: selected ? '2px solid var(--navy)' : '1px solid var(--border)',
                        background: selected ? 'var(--navy-soft)' : 'var(--bg-elev)',
                        display: 'flex',
                        gap: 12,
                        alignItems: 'flex-start',
                        transition: 'border-color 0.14s ease, background 0.14s ease',
                      }}
                    >
                      <div style={{ marginTop: 2, flexShrink: 0 }}>{card.icon}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <strong style={{ fontSize: 13.5, color: 'var(--text)' }}>{card.title}</strong>
                          {selected && (
                            <span className="badge badge-navy" style={{ fontSize: 10.5 }}>
                              <CheckCircle2 size={11} /> 已选择
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{card.subtitle}</div>
                        <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>
                          {card.highlights.map((h, i) => (
                            <li key={i}>{h}</li>
                          ))}
                        </ul>
                      </div>
                    </button>
                  );
                })}
              </div>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '10px 13px',
                  borderRadius: 9,
                  background: 'var(--bg-soft)',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <EyeOff size={16} color="var(--navy)" />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 12.5 }}>开启「专注专业模式」（推荐机构 / 严肃投研场景）</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      自动关闭悬浮卡通挂件，保留简洁严肃的底部 AI 对话栏与全屏看板视野
                    </div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={focusProMode}
                  onChange={(e) => setFocusProMode(e.target.checked)}
                  style={{ width: 16, height: 16, flexShrink: 0 }}
                />
              </label>
            </>
          )}

          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700 }}>
                  <TrendingUp size={15} color="var(--navy)" />
                  <span>勾选初始观察标的（已选 {selectedSecids.length} 只，可随时增删）</span>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: 11.5 }}
                  onClick={() =>
                    setSelectedSecids(
                      selectedSecids.length === STARTER_TICKERS.length ? [] : STARTER_TICKERS.map((s) => s.secid)
                    )
                  }
                >
                  {selectedSecids.length === STARTER_TICKERS.length ? '全部取消' : '全选 5 只示例股'}
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                {STARTER_TICKERS.map((stk) => {
                  const checked = selectedSecids.includes(stk.secid);
                  return (
                    <button
                      key={stk.secid}
                      type="button"
                      onClick={() => toggleTicker(stk.secid)}
                      style={{
                        textAlign: 'left',
                        cursor: 'pointer',
                        padding: '10px 12px',
                        borderRadius: 9,
                        border: checked ? '1.5px solid var(--navy)' : '1px solid var(--border)',
                        background: checked ? 'var(--navy-soft)' : 'var(--bg-elev)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong style={{ fontSize: 13 }}>{stk.name}</strong>
                        <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {stk.code}
                        </span>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{stk.note}</div>
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                提示：进入工作台后可在「全球自选」页随时搜索添加任意 A 股、港美股或全球期货。
              </div>
            </div>
          )}

          {step === 3 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="panel panel-pad" style={{ background: 'var(--bg-soft)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
                  <Bot size={15} color="var(--navy)" />
                  <span>配置 AI 引擎 API Key（可选 · 支持跳过）</span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8 }}>
                  仅保存在本机硬盘，直连大模型官方接口，用于 AI 识图解盘、自动复盘与文献整理。
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <select
                    className="input"
                    style={{ width: 150 }}
                    value={aiProvider}
                    onChange={(e) => setAiProvider(e.target.value as 'deepseek' | 'qwen')}
                  >
                    <option value="deepseek">DeepSeek</option>
                    <option value="qwen">通义千问 (Qwen)</option>
                  </select>
                  <input
                    type="password"
                    className="input mono"
                    style={{ flex: 1, minWidth: 220, fontSize: 12 }}
                    placeholder="sk-...（暂不配置可直接留空跳过）"
                    value={aiApiKey}
                    onChange={(e) => setAiApiKey(e.target.value)}
                  />
                </div>
              </div>

              {!IS_OPEN_SOURCE_EDITION && (
              <div className="panel panel-pad" style={{ background: 'var(--bg-soft)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
                  <KeyRound size={15} color="var(--amber)" />
                  <span>输入离线授权码（可选 · 社区免费版可直接跳过）</span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8 }}>
                  激活指引：① 复制本机设备码 → ② 在购买渠道提交设备码获取授权码 → ③ 粘贴下方立即离线激活（免费版可直接留空跳过）。
                </div>
                {machineCode && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 9px', borderRadius: 7, background: 'var(--bg-elev)', border: '1px solid var(--border)', marginBottom: 8, fontSize: 11.5 }}>
                    <span>
                      本机设备码：<strong className="mono" style={{ color: 'var(--navy)' }}>{machineCode}</strong>
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                      onClick={() => {
                        navigator.clipboard?.writeText(machineCode).then(() => onToast?.('已复制 12 位设备码', 'success')).catch(() => {});
                      }}
                    >
                      复制设备码
                    </button>
                  </div>
                )}
                <input
                  className="input mono"
                  style={{ fontSize: 12 }}
                  placeholder="授权码示例：SRW2.xxxx...（暂不激活可直接留空）"
                  value={licenseKey}
                  onChange={(e) => {
                    setLicenseKey(e.target.value);
                    if (licenseError) setLicenseError(null);
                  }}
                />
                {licenseError && (
                  <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--crimson)', fontWeight: 600 }}>
                    {licenseError}
                  </div>
                )}
              </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <div>
            {step > 1 ? (
              <button type="button" className="btn btn-sm" onClick={() => setStep((s) => (s === 3 ? 2 : 1))}>
                <ArrowLeft size={13} /> 上一步
              </button>
            ) : canDismiss && onClose ? (
              <button type="button" className="btn btn-sm" onClick={onClose}>
                暂不更改
              </button>
            ) : (
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>可随时在设置中重新调整</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {step < 3 ? (
              <>
                <button type="button" className="btn btn-ghost btn-sm" disabled={submitting} onClick={handleSkip}>
                  跳过并直接进入
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setStep((s) => (s === 1 ? 2 : 3))}>
                  下一步 <ArrowRight size={13} />
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" disabled={submitting} onClick={handleConfirm}>
                {submitting ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
                <span>{submitting ? '正在初始化...' : '完成配置并进入工作台'}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
