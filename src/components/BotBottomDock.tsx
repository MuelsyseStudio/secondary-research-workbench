import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Maximize2,
  Minimize2,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import { MascotSprite, TOOL_LABELS, useSlimeBot } from '../contexts/SlimeBotContext';

interface BotBottomDockProps {
  compactDefault?: boolean;
  focusProMode?: boolean;
  slimeHidden?: boolean;
  onShowSlime?: () => void;
  onOpenFullscreenStock?: (secidOrQuery: string) => void;
}

const DOCK_QUICK_PROMPTS = [
  { label: '点评这只票', prompt: '结合技术面与三库方法论点评当前标的，给出支撑压力与风险点', attach: true },
  { label: '设为突破预警', prompt: '帮我为当前标的设一条关键压力位突破预警', attach: true },
  { label: '查方法论止损卡', prompt: '检索我方法论卡片库里关于止损、减仓和风控的核心卡片', attach: false },
];

export const BotBottomDock: React.FC<BotBottomDockProps> = ({
  compactDefault = false,
  focusProMode = false,
  slimeHidden = false,
  onShowSlime,
  onOpenFullscreenStock,
}) => {
  const {
    botState,
    inputText,
    setInputText,
    sending,
    dockDrawerOpen,
    setDockDrawerOpen,
    setMode,
    setDrawerTab,
    contextPill,
    dismissContextPill,
    sendMessage,
    approveAction,
    undoBackup,
  } = useSlimeBot();

  const [minimized, setMinimized] = useState(compactDefault);
  const [dockTab, setDockTab] = useState<'chat' | 'alerts' | 'schedules' | 'perm'>('chat');
  const endRef = useRef<HTMLDivElement | null>(null);
  const { watchState, saveConfig, deleteWatchAlertQuick } = useSlimeBot();

  const ALERT_COND_LABEL: Record<string, string> = {
    price_above: '价格突破 ≥',
    price_below: '价格跌破 ≤',
    pct_above: '盘中涨幅 ≥',
    pct_below: '盘中跌幅 ≤',
    vol_ratio_above: '量比放量 ≥',
  };

  useEffect(() => {
    if (dockDrawerOpen) {
      setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  }, [dockDrawerOpen, botState?.messages?.length, sending]);

  const cfg = botState?.config;
  const messages = botState?.messages || [];
  const permLevel = cfg?.permissionLevel ?? 2;
  const permShortLabel =
    permLevel === 0 ? '只读' : permLevel === 1 ? '行情' : permLevel === 2 ? '提案' : '自动';
  const permFullTitle =
    permLevel === 0
      ? '助手权限：只读分析（仅回答问题）'
      : permLevel === 1
      ? '助手权限：实时行情（可查行情与三库）'
      : permLevel === 2
      ? '助手权限：提案确认（写库前须您确认）'
      : '助手权限：自动写库（直接落盘并留快照）';
  const permClass =
    permLevel === 3
      ? 'badge-crimson'
      : permLevel === 2
      ? 'badge-navy'
      : permLevel === 1
      ? 'badge-emerald'
      : 'badge-muted';

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (inputText.trim() && !sending) {
        sendMessage(undefined, { openDockDrawer: true, attachContext: true });
      }
    }
  };

  if (minimized) {
    return (
      <div
        className="bot-bottom-dock bot-bottom-dock-mini"
        style={{
          height: 24,
          flexShrink: 0,
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          padding: '0 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 11,
          color: 'var(--text-muted)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Sparkles size={11} color="#0284c7" />
          <span>
            {cfg?.botName || '波波'} (L{permLevel}) 常驻对话栏已收起
            {contextPill ? ` · 上下文：${contextPill.label}` : ''}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ padding: '0 8px', height: 20, fontSize: 11 }}
          onClick={() => setMinimized(false)}
        >
          <ChevronUp size={12} /> 展开底部对话栏
        </button>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', flexShrink: 0, zIndex: 40 }}>
      {/* Upward Smooth Shared Chat Drawer */}
      {dockDrawerOpen && (
        <div
          style={{
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: '100%',
            marginBottom: 6,
            maxHeight: 'min(420px, 56vh)',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border-strong)',
            borderRadius: 12,
            boxShadow: '0 -10px 36px rgba(15, 23, 42, 0.24)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '7px 12px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg-soft)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, flexWrap: 'wrap' }}>
              {focusProMode ? (
                <Sparkles size={15} color="var(--navy)" />
              ) : (
                <MascotSprite
                  avatarId={cfg?.avatarId || 'slime_mochi'}
                  customAvatarDataUrl={cfg?.customAvatarDataUrl}
                  size={22}
                  thinking={sending}
                  showBadges={false}
                />
              )}
              <strong>{focusProMode ? 'AI 投研助手' : `${cfg?.botName || '波波'} · AI 助手`}</strong>
              <span className={`badge ${permClass}`} style={{ fontSize: 10, padding: '0 5px' }} title={permFullTitle}>
                {permShortLabel}
              </span>
              <div style={{ display: 'inline-flex', gap: 3, marginLeft: 4 }}>
                {(
                  [
                    ['chat', '对话'],
                    ['alerts', `预警(${watchState?.alertsStore?.alerts?.length || 0})`],
                    ['schedules', `定时(${watchState?.schedulesStore?.tasks?.length || 0})`],
                    ['perm', '权限'],
                  ] as const
                ).map(([k, lbl]) => (
                  <button
                    key={k}
                    type="button"
                    className={`btn btn-sm ${dockTab === k ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ fontSize: 11, padding: '1px 7px', height: 22 }}
                    onClick={() => setDockTab(k)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {!focusProMode && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: 11, padding: '2px 7px' }}
                  onClick={() => {
                    if (slimeHidden) onShowSlime?.();
                    setDockDrawerOpen(false);
                    setDrawerTab('chat');
                    setMode('chat');
                  }}
                  title="切换到悬浮大窗"
                >
                  <Maximize2 size={11} /> 悬浮窗
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ padding: '2px 6px' }}
                onClick={() => setDockDrawerOpen(false)}
              >
                <ChevronDown size={14} />
              </button>
            </div>
          </div>

          {dockTab === 'alerts' && (
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 140 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                已配置的盯盘价格/涨跌预警（可在聊天框直接说「帮我设 600519 突破 1600 预警」或在 K 线图右键添加）
              </div>
              {(watchState?.alertsStore?.alerts || []).length === 0 ? (
                <div style={{ padding: '18px 0', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
                  暂无盯盘预警规则。
                </div>
              ) : (
                (watchState?.alertsStore?.alerts || []).map((al: any) => (
                  <div
                    key={al.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '7px 10px',
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'var(--bg-soft)',
                      fontSize: 12,
                    }}
                  >
                    <div>
                      <strong>{al.name || al.code}</strong>{' '}
                      <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 11 }}>{al.code}</span>{' '}
                      <span className="badge badge-navy" style={{ fontSize: 10.5 }}>
                        {ALERT_COND_LABEL[al.condition] || al.condition} {al.threshold}
                      </span>
                      {al.note && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-muted)' }}>{al.note}</span>}
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ fontSize: 11, color: 'var(--crimson)', padding: '2px 7px' }}
                      onClick={() => deleteWatchAlertQuick(al.id)}
                    >
                      删除
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {dockTab === 'schedules' && (
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 140 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                AI 助手自定义定时播报任务（可在聊天框说「每天 08:30 帮我做盘前摘要」快速添加）
              </div>
              {(watchState?.schedulesStore?.tasks || []).length === 0 ? (
                <div style={{ padding: '18px 0', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
                  暂无定时任务。
                </div>
              ) : (
                (watchState?.schedulesStore?.tasks || []).map((tk: any) => (
                  <div
                    key={tk.id}
                    style={{
                      padding: '7px 10px',
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'var(--bg-soft)',
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>{tk.name}</strong>
                      <span className="badge badge-navy mono" style={{ fontSize: 10.5 }}>
                        {tk.timeHHMM} {tk.weekdaysOnly ? '工作日' : '每日'}
                      </span>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>{tk.prompt}</div>
                  </div>
                ))
              )}
            </div>
          )}

          {dockTab === 'perm' && (
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 140 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                调整 AI 助手操作权限（所有写入三库的变更均会生成可一键回滚的本地备份快照）：
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
                {[
                  { lv: 0, title: '只读分析', desc: '仅回答问题与检索本地三库，不拉行情不写库' },
                  { lv: 1, title: '实时行情', desc: '可查实时行情、点位诊断与三库检索（推荐默认）' },
                  { lv: 2, title: '提案确认（Pro）', desc: '写库前展示变更预览，经您点击批准后落盘' },
                  { lv: 3, title: '自动写库（Pro）', desc: '直接落盘写入并自动留存原子回滚快照' },
                ].map((opt) => (
                  <button
                    key={opt.lv}
                    type="button"
                    onClick={() => saveConfig({ permissionLevel: opt.lv as 0 | 1 | 2 | 3 }, `已切换助手权限为「${opt.title}」`)}
                    style={{
                      textAlign: 'left',
                      cursor: 'pointer',
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: permLevel === opt.lv ? '2px solid var(--navy)' : '1px solid var(--border)',
                      background: permLevel === opt.lv ? 'var(--navy-soft)' : 'var(--bg-card)',
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 12.5 }}>{opt.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {dockTab === 'chat' && (
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '10px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              minHeight: 140,
            }}
          >
            {messages.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: '24px 0' }}>
                直接提问三库卡片、让 {cfg?.botName || '波波'} 点评当前标的、设价格预警或增删卡片。
              </div>
            ) : (
              messages.slice(-16).map((m) => {
                const isUser = m.role === 'user';
                return (
                  <div
                    key={m.id}
                    style={{
                      alignSelf: isUser ? 'flex-end' : 'flex-start',
                      maxWidth: '86%',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    {!isUser && m.toolsUsed && m.toolsUsed.length > 0 && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {m.toolsUsed.map((tl, idx) => (
                          <span key={idx} className="badge badge-navy" style={{ fontSize: 10, padding: '1px 6px' }}>
                            {TOOL_LABELS[tl] || tl}
                          </span>
                        ))}
                      </div>
                    )}
                    <div
                      style={{
                        padding: '7px 11px',
                        borderRadius: isUser ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
                        background: isUser ? 'var(--navy)' : 'var(--bg-soft)',
                        color: isUser ? '#fff' : 'var(--text)',
                        fontSize: 12.5,
                        lineHeight: 1.55,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {m.content}
                    </div>
                    {!isUser && [...(m.proposedActions || []), ...(m.appliedActions || [])].length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {[...(m.proposedActions || []), ...(m.appliedActions || [])].map((act) => (
                          <div
                            key={act.id}
                            style={{
                              padding: '6px 9px',
                              borderRadius: 8,
                              border: '1px solid var(--border-strong)',
                              background: 'var(--bg-elev)',
                              fontSize: 11.5,
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: 8,
                            }}
                          >
                            <div>
                              <strong>{act.label}</strong>
                              {act.summary && <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{act.summary}</div>}
                            </div>
                            <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                              {act.status === 'pending' && (
                                <>
                                  <button
                                    type="button"
                                    className="btn btn-primary btn-sm"
                                    style={{ fontSize: 11 }}
                                    onClick={() => approveAction(m.id, act, false)}
                                  >
                                    <CheckCircle2 size={11} /> 批准执行
                                  </button>
                                  {act.kind === 'library_mutation' && (
                                    <button
                                      type="button"
                                      className="btn btn-sm"
                                      style={{ fontSize: 11 }}
                                      onClick={() => approveAction(m.id, act, true)}
                                    >
                                      Diff 核对
                                    </button>
                                  )}
                                </>
                              )}
                              {act.status === 'applied' && (
                                <span className="badge badge-emerald" style={{ fontSize: 10.5 }}>
                                  已执行
                                </span>
                              )}
                              {act.backupId && (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  style={{ fontSize: 11 }}
                                  onClick={() => undoBackup(act.backupId)}
                                >
                                  <RotateCcw size={11} /> 撤回
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
            {sending && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                <Loader2 size={13} className="spin" /> {cfg?.botName || '波波'} 正在调用三库/行情工具思考中...
              </div>
            )}
            <div ref={endRef} />
          </div>
          )}
        </div>
      )}

      {/* Persistent Compact Bottom Bar (44-46px) */}
      <div
        className="bot-bottom-dock"
        style={{
          minHeight: 45,
          padding: '5px 12px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {/* Left: Mini Mascot + Perm Badge + Dismissible Context Capsule */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setDockDrawerOpen((v) => !v)}
            title="点击展开/收起对话抽屉"
            style={{
              border: 'none',
              background: 'transparent',
              padding: 0,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            {focusProMode ? (
              <span
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  background: 'var(--navy-soft)',
                  color: 'var(--navy)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Sparkles size={14} />
              </span>
            ) : (
              <MascotSprite
                avatarId={cfg?.avatarId || 'slime_mochi'}
                customAvatarDataUrl={cfg?.customAvatarDataUrl}
                size={26}
                thinking={sending}
                showBadges={false}
              />
            )}
            <span className={`badge ${permClass}`} style={{ fontSize: 10, padding: '1px 5px' }} title={permFullTitle}>
              {permShortLabel}
            </span>
          </button>

          {contextPill && (
            <span
              className="badge badge-teal"
              style={{
                fontSize: 11,
                padding: '2px 7px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                maxWidth: 195,
              }}
            >
              <span
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: contextPill.secid && onOpenFullscreenStock ? 'pointer' : 'default' }}
                onClick={() => contextPill.secid && onOpenFullscreenStock?.(contextPill.secid)}
                title={`当前上下文：${contextPill.label}`}
              >
                上下文：{contextPill.label}
              </span>
              <button
                type="button"
                onClick={dismissContextPill}
                title="取消附带当前上下文"
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  padding: 0,
                  cursor: 'pointer',
                  display: 'inline-flex',
                }}
              >
                <X size={11} />
              </button>
            </span>
          )}
        </div>

        {/* Center: Input + Quick Command Chips */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="text"
            className="input"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              focusProMode
                ? '向 AI 投研助手提问…（Enter 发送 · 整理公开资料 / 设预警 / 查三库）'
                : `向 ${cfg?.botName || '波波'} 提问…（Enter 发送 · 点评个股 / 设预警 / 查三库）`
            }
            style={{
              flex: 1,
              height: 32,
              padding: '0 10px',
              fontSize: 12.5,
              lineHeight: '32px',
            }}
          />
          <div className="dock-quick-chips" style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            {DOCK_QUICK_PROMPTS.map((q) => (
              <button
                key={q.label}
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={sending}
                style={{ fontSize: 11, padding: '2px 7px', height: 26, border: '1px solid var(--border)' }}
                onClick={() => sendMessage(q.prompt, { openDockDrawer: true, attachContext: q.attach })}
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>

        {/* Right: Send + Drawer Toggle + Minimize Strip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={sending || !inputText.trim()}
            style={{ height: 30, padding: '0 10px', fontSize: 12 }}
            onClick={() => sendMessage(undefined, { openDockDrawer: true, attachContext: true })}
          >
            {sending ? <Loader2 size={13} className="spin" /> : <Send size={13} />}
            <span>发送</span>
          </button>
          <button
            type="button"
            className="btn btn-sm"
            style={{ height: 30, padding: '0 8px', fontSize: 11.5 }}
            onClick={() => setDockDrawerOpen((v) => !v)}
            title={dockDrawerOpen ? '收起对话抽屉' : '展开对话抽屉'}
          >
            {dockDrawerOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
            <span>{dockDrawerOpen ? '收起' : `记录(${messages.length})`}</span>
          </button>
          {slimeHidden && !focusProMode && onShowSlime && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ height: 30, padding: '0 7px', fontSize: 11 }}
              onClick={onShowSlime}
              title="恢复显示右下角悬浮挂件"
            >
              <Sparkles size={12} color="var(--navy)" />
              <span>挂件</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ height: 30, padding: '0 6px' }}
            onClick={() => {
              setDockDrawerOpen(false);
              setMinimized(true);
            }}
            title="最小化成底部细条（全屏盯盘不占纵向高度）"
          >
            <Minimize2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
};
