import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Bell,
  BellPlus,
  CheckCircle2,
  Clock,
  EyeOff,
  ImagePlus,
  Loader2,
  Maximize2,
  MonitorUp,
  Palette,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  Shield,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { CRYPTO_ENABLED } from '../config/edition';
import type {
  AiSafeConfig,
  SlimeBotConfig,
  SlimeMascotItem,
} from '../types';
import { AiProviderPicker } from './AiProviderPicker';
import { FALLBACK_MASCOTS, MascotSprite, TOOL_LABELS, useSlimeBot } from '../contexts/SlimeBotContext';

interface SlimeBotWidgetProps {
  aiConfig: AiSafeConfig | null;
  compactEdge?: boolean;
  onHideToDock?: () => void;
  onOpenAiSettings: () => void;
  onOpenFullscreenStock?: (secidOrQuery: string) => void;
  onToast: (msg: string) => void;
}

const QUICK_PROMPTS = [
  '讲个大A幽默段子',
  '变身行情看板',
  '看看今天自选盘面和情绪',
  '查下我方法论库里关于乖离和止损的卡片',
  '查下我交易账本最近的胜率和坏习惯成本',
];

/**
 * 上传自定义宠物贴纸时，浏览器本地自动做四边洪水填充去白底并缩放到 220x220 透明 PNG
 */
function processCustomMascotUpload(rawDataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = 220;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Canvas 不可用'));
      const ratio = Math.min(size / img.width, size / img.height);
      const dw = Math.round(img.width * ratio);
      const dh = Math.round(img.height * ratio);
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(img, Math.round((size - dw) / 2), Math.round((size - dh) / 2), dw, dh);

      const imgData = ctx.getImageData(0, 0, size, size);
      const d = imgData.data;
      // 如果四角偏纯白，则从外缘洪水去白底（保留角色内部高光/白围裙）
      const isCornerNearWhite = (x: number, y: number) => {
        const i = (y * size + x) * 4;
        return d[i + 3] > 200 && d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235;
      };
      if (isCornerNearWhite(1, 1) && isCornerNearWhite(size - 2, 1)) {
        const visited = new Uint8Array(size * size);
        const queue: number[] = [];
        const enqueue = (x: number, y: number) => {
          const p = y * size + x;
          if (visited[p]) return;
          const i = p * 4;
          if (d[i + 3] > 0 && d[i] > 224 && d[i + 1] > 224 && d[i + 2] > 224) {
            visited[p] = 1;
            queue.push(p);
          }
        };
        for (let x = 0; x < size; x++) {
          enqueue(x, 0);
          enqueue(x, size - 1);
        }
        for (let y = 0; y < size; y++) {
          enqueue(0, y);
          enqueue(size - 1, y);
        }
        let head = 0;
        while (head < queue.length) {
          const cur = queue[head++];
          d[cur * 4 + 3] = 0;
          const cx = cur % size;
          const cy = Math.floor(cur / size);
          if (cx > 0) enqueue(cx - 1, cy);
          if (cx < size - 1) enqueue(cx + 1, cy);
          if (cy > 0) enqueue(cx, cy - 1);
          if (cy < size - 1) enqueue(cx, cy + 1);
        }
        ctx.putImageData(imgData, 0, 0);
      }
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('自定义形象图片读取失败'));
    img.src = rawDataUrl;
  });
}

export const SlimeBotWidget: React.FC<SlimeBotWidgetProps> = ({
  aiConfig,
  compactEdge = false,
  onHideToDock,
  onOpenAiSettings,
  onOpenFullscreenStock,
  onToast,
}) => {
  const { t } = useI18n();
  const {
    mode,
    setMode,
    drawerTab,
    setDrawerTab,
    dockDrawerOpen,
    botState,
    setBotState,
    ticker,
    tickerLoading,
    watchState,
    setWatchState,
    inputText,
    setInputText,
    sending,
    provider,
    setProvider,
    loadState,
    refreshTicker,
    saveConfig: ctxSaveConfig,
    sendMessage,
    approveAction: handleApproveAction,
    undoBackup: handleUndoBackup,
    launchDesktopPet: handleLaunchDesktopPet,
  } = useSlimeBot();

  const [dismissedAlertId, setDismissedAlertId] = useState<string>('');
  const [newAlertQuery, setNewAlertQuery] = useState('');
  const [newAlertCond, setNewAlertCond] = useState<'price_above' | 'price_below' | 'pct_above' | 'pct_below' | 'vol_ratio_above'>('price_above');
  const [newAlertThreshold, setNewAlertThreshold] = useState('');
  const [newAlertNote, setNewAlertNote] = useState('');
  const [newSchedName, setNewSchedName] = useState('');
  const [newSchedTime, setNewSchedTime] = useState('08:30');
  const [newSchedPrompt, setNewSchedPrompt] = useState('');
  const [runningSchedId, setRunningSchedId] = useState<string | null>(null);
  const [evaluatingAlerts, setEvaluatingAlerts] = useState(false);

  const showSettings = drawerTab === 'settings';
  const setShowSettings = (v: boolean | ((prev: boolean) => boolean)) => {
    setDrawerTab((cur) => {
      const next = typeof v === 'function' ? v(cur === 'settings') : v;
      return next ? 'settings' : 'chat';
    });
  };
  const [syncPersonaOnMascot, setSyncPersonaOnMascot] = useState(true);
  const [hoveringSlime, setHoveringSlime] = useState(false);

  const [draftName, setDraftName] = useState('波波');
  const [draftCustomPrompt, setDraftCustomPrompt] = useState('');
  const customPetFileRef = useRef<HTMLInputElement | null>(null);

  // 右下角避开底部 45px 常驻 Bot 对话栏
  const [pos, setPos] = useState({ right: 24, bottom: 58 });
  const dragRef = useRef<{
    dragging: boolean;
    moved: boolean;
    startX: number;
    startY: number;
    startRight: number;
    startBottom: number;
  }>({
    dragging: false,
    moved: false,
    startX: 0,
    startY: 0,
    startRight: 24,
    startBottom: 58,
  });

  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (botState?.config) {
      setDraftName(botState.config.botName || '波波');
      setDraftCustomPrompt(botState.config.customPrompt || '');
    }
  }, [botState?.config?.botName, botState?.config?.customPrompt]);

  useEffect(() => {
    if (mode === 'chat') {
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);
    }
  }, [mode, botState?.messages.length, sending]);

  const handleSlimePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button[data-no-drag="1"]')) return;
    dragRef.current = {
      dragging: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      startRight: pos.right,
      startBottom: pos.bottom,
    };
    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current.dragging) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragRef.current.moved = true;
      const nextRight = Math.max(12, Math.min(window.innerWidth - 110, dragRef.current.startRight - dx));
      const nextBottom = Math.max(52, Math.min(window.innerHeight - 125, dragRef.current.startBottom - dy));
      setPos({ right: nextRight, bottom: nextBottom });
    };
    const onUp = () => {
      dragRef.current.dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleSaveConfig = async (patch: Partial<SlimeBotConfig>, msg?: string) => {
    await ctxSaveConfig(patch, msg);
  };

  const handleSelectMascot = (item: SlimeMascotItem) => {
    const patch: Partial<SlimeBotConfig> = { avatarId: item.id };
    if (syncPersonaOnMascot) {
      patch.botName = item.defaultBotName;
      patch.personaId = item.recommendedPersona;
    }
    handleSaveConfig(
      patch,
      syncPersonaOnMascot
        ? `已切换形象为「${item.name}」并同步专属人设！`
        : `已切换形象为「${item.name}」（保留当前人设）`
    );
  };

  const handleCustomPetUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      onToast('请上传 4MB 以内的形象图片');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const cleanPng = await processCustomMascotUpload(String(reader.result || ''));
        await handleSaveConfig(
          { avatarId: 'custom', customAvatarDataUrl: cleanPng },
          '自定义宠物形象已上传并自动去白底生效！'
        );
      } catch (err: any) {
        onToast(err.message);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSend = async (textOverride?: string) => {
    await sendMessage(textOverride, { openFloatingChat: false, attachContext: false });
  };

  const cfg = botState?.config;
  const mascots = botState?.mascotCatalog?.length ? botState.mascotCatalog : FALLBACK_MASCOTS;
  const lastBotMsg = [...(botState?.messages || [])].reverse().find((m) => m.role === 'assistant');
  const liveMood = sending ? 'thinking' : lastBotMsg?.mood || ticker?.mood || 'happy';
  const permBadgeColor =
    cfg?.permissionLevel === 3
      ? 'badge-crimson'
      : cfg?.permissionLevel === 2
      ? 'badge-navy'
      : cfg?.permissionLevel === 1
      ? 'badge-emerald'
      : 'badge-muted';

  const unreadCount = watchState?.notifications?.unreadCount || 0;
  const latestUnread = watchState?.notifications?.latestUnread || null;
  const showProactiveBubble = Boolean(!compactEdge && latestUnread && latestUnread.id !== dismissedAlertId);

  const handleAddWatchAlert = async () => {
    if (!newAlertQuery.trim() || !newAlertThreshold.trim()) {
      onToast(t('请填写标的名称/代码和触发数值', 'Enter symbol and threshold'));
      return;
    }
    try {
      const ws = await api.mutateBotWatchAlert({
        query: newAlertQuery.trim(),
        condition: newAlertCond,
        threshold: Number(newAlertThreshold),
        note: newAlertNote.trim(),
      });
      setWatchState(ws);
      setNewAlertQuery('');
      setNewAlertThreshold('');
      setNewAlertNote('');
      onToast(t('已新增 Bot 盯盘预警！后台每 45 秒自动巡检触发推送', 'Bot watch alert added!'));
    } catch (err: any) {
      onToast(err.message);
    }
  };

  const handleAddSchedule = async (tpl?: { name: string; timeHHMM: string; prompt: string; taskType?: string }) => {
    const name = tpl ? tpl.name : newSchedName.trim();
    const timeHHMM = tpl ? tpl.timeHHMM : newSchedTime.trim();
    const prompt = tpl ? tpl.prompt : newSchedPrompt.trim();
    if (!name || !prompt) {
      onToast(t('请填写任务名称和定时指令', 'Enter task name and instruction'));
      return;
    }
    try {
      const ws = await api.mutateBotSchedule({
        name,
        timeHHMM,
        prompt,
        taskType: tpl?.taskType || 'custom_prompt',
        weekdaysOnly: true,
        enabled: true,
      });
      setWatchState(ws);
      if (!tpl) {
        setNewSchedName('');
        setNewSchedPrompt('');
      }
      onToast(t(`已添加定时任务「${name}」(${timeHHMM})`, `Scheduled task "${name}" (${timeHHMM}) added`));
    } catch (err: any) {
      onToast(err.message);
    }
  };

  // 当底部常驻对话抽屉展开时，临时隐身右下角悬浮宠，彻底消除任何遮挡重叠
  if (dockDrawerOpen && mode === 'slime') {
    return null;
  }

  // =========================================================================
  // 形态 1：右下角手绘卡通悬浮伙伴（史莱姆 / 大肥鱼 / Tux企鹅 / 蓝地鼠 / 招财柴）
  // =========================================================================
  if (mode === 'slime') {
    return (
      <div
        onPointerDown={handleSlimePointerDown}
        onMouseEnter={() => setHoveringSlime(true)}
        onMouseLeave={() => setHoveringSlime(false)}
        style={{
          position: 'fixed',
          right: pos.right,
          bottom: pos.bottom,
          zIndex: 920,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          userSelect: 'none',
          cursor: 'grab',
        }}
      >
        {/* Bot 主动触发预警 / 定时播报悬浮气泡 */}
        {showProactiveBubble && latestUnread && (
          <div
            data-no-drag="1"
            style={{
              marginBottom: 6,
              width: 270,
              padding: '8px 10px',
              borderRadius: 12,
              background: 'var(--bg-card)',
              border: latestUnread.severity === 'high' ? '1.5px solid #dc2626' : '1.5px solid #0284c7',
              boxShadow: '0 10px 28px rgba(15,23,42,0.18)',
              fontSize: 11.5,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4, marginBottom: 3 }}>
              <strong style={{ color: latestUnread.severity === 'high' ? '#dc2626' : '#0284c7', fontSize: 11.5 }}>
                🔔 {latestUnread.title}
              </strong>
              <button
                type="button"
                data-no-drag="1"
                className="btn btn-ghost btn-sm"
                style={{ padding: 2, height: 'auto' }}
                onClick={async () => {
                  setDismissedAlertId(latestUnread.id);
                  const ws = await api.markBotNotificationsRead([latestUnread.id]).catch(() => null);
                  if (ws) setWatchState(ws);
                }}
              >
                <X size={12} />
              </button>
            </div>
            <div style={{ color: 'var(--text-secondary)', lineHeight: 1.4, marginBottom: 6 }}>{latestUnread.body.slice(0, 120)}</div>
            <div style={{ display: 'flex', gap: 5 }}>
              {latestUnread.secid && onOpenFullscreenStock && (
                <button
                  type="button"
                  data-no-drag="1"
                  className="btn btn-primary btn-sm"
                  style={{ fontSize: 10.5, padding: '2px 7px' }}
                  onClick={() => onOpenFullscreenStock(latestUnread.secid!)}
                >
                  <Maximize2 size={10} /> {t('全屏看盘', 'Fullscreen')}
                </button>
              )}
              <button
                type="button"
                data-no-drag="1"
                className="btn btn-sm"
                style={{ fontSize: 10.5, padding: '2px 7px' }}
                onClick={async () => {
                  setDismissedAlertId(latestUnread.id);
                  const ws = await api.markBotNotificationsRead().catch(() => null);
                  if (ws) setWatchState(ws);
                  setDrawerTab('alerts');
                  setMode('chat');
                }}
              >
                {t('查看全部预警', 'All Alerts')}
              </button>
            </div>
          </div>
        )}

        {hoveringSlime && (
          <div
            style={{
              marginBottom: 4,
              display: 'flex',
              gap: 4,
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 999,
              padding: '4px 8px',
              boxShadow: '0 8px 24px rgba(15, 23, 42, 0.14)',
              whiteSpace: 'nowrap',
            }}
          >
            <button
              type="button"
              data-no-drag="1"
              className="btn btn-ghost btn-sm"
              style={{ padding: '2px 7px', fontSize: 11, height: 'auto' }}
              onClick={() => setMode('ticker')}
              title={t('变身迷你实时行情看板', 'Morph into Mini Ticker')}
            >
              <Activity size={12} color="var(--crimson)" /> {t('变看板', 'Ticker')}
            </button>
            <button
              type="button"
              data-no-drag="1"
              className="btn btn-ghost btn-sm"
              style={{ padding: '2px 7px', fontSize: 11, height: 'auto' }}
              onClick={() => {
                setDrawerTab('alerts');
                setMode('chat');
              }}
              title={t('管理盯盘预警与定时任务', 'Manage Watch Alerts & Schedules')}
            >
              <Bell size={12} color="#d97706" /> {t('预警/定时', 'Alerts')}
            </button>
            <button
              type="button"
              data-no-drag="1"
              className="btn btn-ghost btn-sm"
              style={{ padding: '2px 7px', fontSize: 11, height: 'auto' }}
              onClick={() => {
                setDrawerTab('settings');
                setMode('chat');
              }}
              title={t('切换史莱姆 / 大肥鱼 / 开源形象与人设', 'Switch Mascot & Persona')}
            >
              <Palette size={12} color="#0284c7" /> {t('换形象', 'Mascot')}
            </button>
            {botState?.hasDesktopPet && (
              <button
                type="button"
                data-no-drag="1"
                className="btn btn-ghost btn-sm"
                style={{ padding: '2px 7px', fontSize: 11, height: 'auto' }}
                onClick={handleLaunchDesktopPet}
                title={t('召唤可悬浮在 Windows 桌面最上层的独立透明挂件', 'Launch Windows Desktop Pet')}
              >
                <MonitorUp size={12} color="var(--navy)" /> {t('桌面悬浮', 'Desktop')}
              </button>
            )}
            {onHideToDock && (
              <button
                type="button"
                data-no-drag="1"
                className="btn btn-ghost btn-sm"
                style={{ padding: '2px 7px', fontSize: 11, height: 'auto' }}
                onClick={onHideToDock}
                title={t('隐藏悬浮挂件并收纳至底部栏（彻底不遮挡内容）', 'Hide floating pet into bottom dock')}
              >
                <EyeOff size={12} color="var(--text-muted)" /> {t('贴边隐藏', 'Hide')}
              </button>
            )}
          </div>
        )}

        <div
          onClick={() => {
            if (!dragRef.current.moved) {
              setDrawerTab('chat');
              setMode('chat');
            }
          }}
          onDoubleClick={() => setMode('ticker')}
          title={`单击和 ${cfg?.botName || '波波'} 对话 · 双击变身迷你行情看板 · 拖拽移动`}
          style={{ cursor: 'pointer', position: 'relative' }}
        >
          {unreadCount > 0 && (
            <span
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                zIndex: 5,
                minWidth: 19,
                height: 19,
                borderRadius: 999,
                background: '#dc2626',
                color: '#fff',
                fontSize: 10.5,
                fontWeight: 800,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 4px',
                boxShadow: '0 2px 6px rgba(220,38,38,0.45)',
              }}
            >
              {unreadCount}
            </span>
          )}
          <MascotSprite
            avatarId={cfg?.avatarId || 'slime_mochi'}
            customAvatarDataUrl={cfg?.customAvatarDataUrl}
            size={compactEdge ? 52 : 80}
            mood={unreadCount > 0 ? 'alert' : liveMood}
            thinking={sending}
          />
        </div>

        <div
          style={{
            marginTop: -4,
            padding: '2px 9px',
            borderRadius: 999,
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            boxShadow: '0 3px 10px rgba(15,23,42,0.10)',
            fontSize: 10.5,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span>{cfg?.botName || '波波'}</span>
          <span style={{ color: '#0284c7' }}>
            {(cfg?.permissionLevel ?? 2) === 0
              ? '只读'
              : (cfg?.permissionLevel ?? 2) === 1
              ? '行情'
              : (cfg?.permissionLevel ?? 2) === 2
              ? '提案'
              : '自动'}
          </span>
        </div>
      </div>
    );
  }

  // =========================================================================
  // 形态 2：变身「迷你实时行情悬浮看板」
  // =========================================================================
  if (mode === 'ticker') {
    return (
      <div
        className="panel"
        style={{
          position: 'fixed',
          right: Math.min(pos.right, 28),
          bottom: Math.min(pos.bottom, 28),
          width: 356,
          zIndex: 930,
          boxShadow: '0 16px 40px rgba(15, 23, 42, 0.22)',
          border: '1.5px solid #38bdf8',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '8px 12px',
            background: 'linear-gradient(135deg, rgba(14,165,233,0.15), rgba(24,49,83,0.08))',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <MascotSprite
              avatarId={cfg?.avatarId || 'slime_mochi'}
              customAvatarDataUrl={cfg?.customAvatarDataUrl}
              size={34}
              mood={ticker?.mood || 'happy'}
              showBadges={false}
            />
            <div>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>{cfg?.botName || '波波'} · 迷你行情看板</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                {ticker?.sentiment
                  ? `情绪：${ticker.sentiment.node}${ticker.sentiment.score != null ? ` ${ticker.sentiment.score}分` : ''}（上限${ticker.sentiment.maxPositionPct}%）`
                  : '实时同步自选 A/美/港股'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ padding: 4 }}
              onClick={() => refreshTicker(true)}
              title="刷新实时行情"
            >
              <RefreshCw size={13} className={tickerLoading ? 'spin' : ''} />
            </button>
            <button
              type="button"
              className="btn btn-sm"
              style={{ padding: '2px 7px', fontSize: 11, height: 'auto' }}
              onClick={() => setMode('chat')}
            >
              对话
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ padding: '2px 7px', fontSize: 11, height: 'auto' }}
              onClick={() => setMode('slime')}
              title="变回卡通形象"
            >
              变回团子
            </button>
          </div>
        </div>

        <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ticker?.benchmarks && ticker.benchmarks.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 5 }}>
              {ticker.benchmarks.slice(0, 6).map((b) => {
                const up = (b.pct ?? 0) >= 0;
                return (
                  <div
                    key={b.code}
                    style={{
                      padding: '4px 6px',
                      borderRadius: 6,
                      background: 'var(--bg-subtle)',
                      fontSize: 11,
                    }}
                  >
                    <div style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {b.name}
                    </div>
                    <div className="mono" style={{ fontWeight: 700, color: up ? 'var(--crimson)' : 'var(--emerald)' }}>
                      {b.pct !== null ? `${up ? '+' : ''}${b.pct.toFixed(2)}%` : '-'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 230, overflowY: 'auto' }}>
            {(ticker?.stocks || []).map((s) => {
              const up = (s.pct ?? 0) >= 0;
              return (
                <div
                  key={s.secid}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '4px 7px',
                    borderRadius: 6,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center', minWidth: 0 }}>
                    <span className="badge badge-muted" style={{ fontSize: 9.5, padding: '0 4px' }}>
                      {s.marketKind === 'US' ? '美' : s.marketKind === 'HK' ? '港' : 'A'}
                    </span>
                    <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</strong>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                      {s.code}
                    </span>
                  </div>
                  <div className="mono" style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                    <span>{s.price !== null ? s.price.toFixed(2) : '-'}</span>
                    <span
                      style={{
                        minWidth: 56,
                        textAlign: 'right',
                        fontWeight: 700,
                        color: up ? 'var(--crimson)' : 'var(--emerald)',
                      }}
                    >
                      {s.pct !== null ? `${up ? '+' : ''}${s.pct.toFixed(2)}%` : '-'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // 形态 3：展开对话 + 形象选择画廊 / 权限滑块 / 人设工坊
  // =========================================================================
  return (
    <div
      className="panel"
      style={{
        position: 'fixed',
        right: 20,
        bottom: 20,
        width: 458,
        height: 640,
        maxHeight: 'calc(100vh - 36px)',
        maxWidth: 'calc(100vw - 32px)',
        zIndex: 940,
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 20px 54px rgba(15, 23, 42, 0.25)',
        border: '1.5px solid #38bdf8',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '10px 12px',
          background: 'linear-gradient(135deg, rgba(14,165,233,0.15), rgba(24,49,83,0.08))',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <MascotSprite
            avatarId={cfg?.avatarId || 'slime_mochi'}
            customAvatarDataUrl={cfg?.customAvatarDataUrl}
            size={44}
            mood={liveMood}
            thinking={sending}
            showBadges={false}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 13.5 }}>{cfg?.botName || '波波'}</strong>
              <span className={`badge ${permBadgeColor}`} style={{ fontSize: 10, padding: '0 5px' }}>
                L{cfg?.permissionLevel ?? 2}
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              共享三库 · 形象与人设自由切 · 可变身行情看板
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-sm"
            style={{ padding: '3px 7px', fontSize: 11, height: 'auto' }}
            onClick={() => setMode('ticker')}
            title="变身迷你行情看板"
          >
            <Activity size={12} color="var(--crimson)" /> 变看板
          </button>
          {botState?.hasDesktopPet && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ padding: 5 }}
              onClick={handleLaunchDesktopPet}
              title="召唤 Windows 桌面真·悬浮透明伙伴"
            >
              <MonitorUp size={14} color="var(--navy)" />
            </button>
          )}
          <button
            type="button"
            className={`btn btn-sm ${showSettings ? 'btn-primary' : 'btn-ghost'}`}
            style={{ padding: 5 }}
            onClick={() => setShowSettings((v) => !v)}
            title="切换形象、人设与权限档位"
          >
            <Settings2 size={14} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ padding: 5 }}
            onClick={async () => {
              const st = await api.clearBotHistory();
              setBotState(st);
              onToast('已清空对话记录');
            }}
            title="清空对话记录"
          >
            <Trash2 size={13} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ padding: 5 }}
            onClick={() => setMode('slime')}
            title="收起为悬浮伙伴"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Drawer Sub-Tabs: 对话 / 盯盘预警 / 定时任务 / 形象与权限 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
        {[
          { id: 'chat', label: t('对话助手', 'Chat') },
          { id: 'alerts', label: `${t('盯盘预警', 'Alerts')}${unreadCount > 0 ? ` (${unreadCount})` : ''}` },
          { id: 'schedules', label: `${t('定时任务', 'Schedules')} (${watchState?.schedulesStore.tasks.length || 0})` },
          { id: 'settings', label: t('形象/权限', 'Settings') },
        ].map((tb) => (
          <button
            key={tb.id}
            type="button"
            className={`btn btn-sm ${drawerTab === tb.id ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: 11, padding: '4px 4px', justifyContent: 'center' }}
            onClick={() => setDrawerTab(tb.id as any)}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {/* Tab: Bot Watch Alerts (盯盘预警 + 工作台技术预警转发) */}
      {drawerTab === 'alerts' ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Global Toggle: 转发工作台技术预警 */}
          <div style={{ padding: 9, borderRadius: 8, background: 'var(--bg-subtle)', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: 12 }}><Bell size={13} color="#d97706" /> {t('Bot 后台自动盯盘与推送', 'Bot Auto-Watch Push')}</strong>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={evaluatingAlerts}
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={async () => {
                  setEvaluatingAlerts(true);
                  try {
                    const r = await api.evaluateBotWatchAlertsNow(false);
                    setWatchState(r.watchState);
                    loadState();
                    onToast(t(`巡检完毕：新触发 ${r.triggered.length} 条预警`, `Checked: ${r.triggered.length} triggered`));
                  } finally {
                    setEvaluatingAlerts(false);
                  }
                }}
              >
                <RefreshCw size={11} className={evaluatingAlerts ? 'spin' : ''} /> {t('立即巡检', 'Check Now')}
              </button>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={watchState?.alertsStore.forwardTechnicalRules !== false}
                onChange={async (e) => {
                  const ws = await api.saveBotWatchSettings({ forwardTechnicalRules: e.target.checked });
                  setWatchState(ws);
                }}
              />
              <span>{t('自动转发工作台高危「技术预警规则」触发结果到 Bot 弹窗', 'Auto-forward Workbench High-Severity Technical Alerts to Bot')}</span>
            </label>
          </div>

          {/* Quick Add Watch Alert */}
          <div className="card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ fontWeight: 700, fontSize: 12 }}>
              <BellPlus size={13} color="#0284c7" />{' '}
              {CRYPTO_ENABLED
                ? t('新建个股 / 期货 / BTC 盯盘预警', 'Add Global Stock / Futures / BTC Alert')
                : t('新建个股 / 全球股 / 期货盯盘预警', 'Add Global Stock / Futures Alert')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <input
                className="input"
                style={{ fontSize: 11.5 }}
                value={newAlertQuery}
                onChange={(e) => setNewAlertQuery(e.target.value)}
                placeholder={
                  CRYPTO_ENABLED
                    ? t('标的如 中际旭创 / 2330.TW / BTC', 'Symbol e.g. NVDA / BTC / 300308')
                    : t('标的如 中际旭创 / 2330.TW / COMEX黄金', 'Symbol e.g. NVDA / 2330.TW / 300308')
                }
              />
              <select
                className="input"
                style={{ fontSize: 11.5 }}
                value={newAlertCond}
                onChange={(e) => setNewAlertCond(e.target.value as any)}
              >
                <option value="price_above">{t('价格突破 ≥', 'Price >=')}</option>
                <option value="price_below">{t('价格跌破 ≤', 'Price <=')}</option>
                <option value="pct_above">{t('涨幅达 ≥%', 'Pct >= %')}</option>
                <option value="pct_below">{t('跌幅达 ≤%', 'Pct <= %')}</option>
                <option value="vol_ratio_above">{t('量比 ≥x', 'VolRatio >=')}</option>
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr auto', gap: 6 }}>
              <input
                className="input mono"
                type="number"
                step="any"
                style={{ fontSize: 11.5 }}
                value={newAlertThreshold}
                onChange={(e) => setNewAlertThreshold(e.target.value)}
                placeholder={t('目标阈值', 'Value')}
              />
              <input
                className="input"
                style={{ fontSize: 11.5 }}
                value={newAlertNote}
                onChange={(e) => setNewAlertNote(e.target.value)}
                placeholder={t('备注（如止损/突破）', 'Note')}
              />
              <button type="button" className="btn btn-primary btn-sm" onClick={handleAddWatchAlert}>
                <Plus size={12} /> {t('添加', 'Add')}
              </button>
            </div>
          </div>

          {/* Active Watch Alerts List */}
          <div>
            <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 5 }}>
              {t('已设定的盯盘预警', 'Active Watch Alerts')} ({watchState?.alertsStore.alerts.length || 0})
            </div>
            {(watchState?.alertsStore.alerts || []).length === 0 ? (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', padding: 8 }}>
                {CRYPTO_ENABLED
                  ? t('暂无自定义预警。你也可以直接在聊天里说：“帮我盯着 BTC 跌破 58000 提醒我”！', 'No alerts yet. You can also ask Bot directly in chat!')
                  : t('暂无自定义预警。你也可以直接在聊天里说：“帮我盯着中际旭创跌破 140 提醒我”！', 'No alerts yet. You can also ask Bot directly in chat!')}
              </div>
            ) : (
              (watchState?.alertsStore.alerts || []).map((al) => (
                <div key={al.id} style={{ padding: '7px 9px', borderRadius: 7, border: '1px solid var(--border)', marginBottom: 5, fontSize: 11.5, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, cursor: 'pointer' }} onClick={() => onOpenFullscreenStock?.(al.secid)}>
                      {al.name} <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{al.secuCode}</span>
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
                      {al.condition} <b className="mono">{al.threshold}</b> {al.lastValue != null ? `(${t('现', 'Now')} ${al.lastValue})` : ''} {al.note ? `· ${al.note}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      type="button"
                      className={`btn btn-sm ${al.enabled ? 'btn-primary' : ''}`}
                      style={{ fontSize: 10, padding: '2px 6px' }}
                      onClick={async () => setWatchState(await api.mutateBotWatchAlert({ action: 'toggle', id: al.id }))}
                    >
                      {al.enabled ? t('盯盘中', 'On') : t('已暂停', 'Off')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ padding: 3 }}
                      onClick={async () => setWatchState(await api.mutateBotWatchAlert({ action: 'delete', id: al.id }))}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Push Notification History */}
          {(watchState?.notifications?.recent || []).length > 0 && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                <strong style={{ fontSize: 12 }}>{t('近期触发推送记录', 'Recent Push Alerts')}</strong>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: 10.5 }}
                    onClick={async () => setWatchState(await api.markBotNotificationsRead())}
                  >
                    {t('全部标已读', 'Mark all read')}
                  </button>
                )}
              </div>
              {(watchState?.notifications?.recent || []).slice(0, 8).map((n) => (
                <div key={n.id} style={{ padding: '6px 8px', borderRadius: 6, background: n.read ? 'var(--bg-subtle)' : 'rgba(220,38,38,0.08)', marginBottom: 4, fontSize: 11 }}>
                  <div style={{ fontWeight: 700 }}>{n.title}</div>
                  <div style={{ color: 'var(--text-secondary)', marginTop: 1 }}>{n.body}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : drawerTab === 'schedules' ? (
        /* Tab: Bot Custom Scheduled Tasks (取代死板 6 时段专家广场，完全自定义！) */
        <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', padding: 8, borderRadius: 8, background: 'var(--bg-subtle)' }}>
            <Clock size={12} style={{ verticalAlign: -2 }} /> {t('给你的专属伙伴设定任意时间点的定时任务（到点自动按你选定的人设播报并弹窗推送，支持一键套用短线模板）', 'Schedule custom timed tasks for your Bot with proactive push reports.')}
          </div>

          {/* 4 One-Click Templates */}
          <div>
            <div style={{ fontWeight: 700, fontSize: 11.5, marginBottom: 5 }}>{t('快捷模板一键添加：', 'Quick Templates:')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
              {(watchState?.scheduleTemplates || []).map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  className="btn btn-sm"
                  style={{ height: 'auto', padding: '5px 7px', flexDirection: 'column', alignItems: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }}
                  onClick={() => handleAddSchedule(tpl)}
                >
                  <span style={{ fontWeight: 700, fontSize: 11 }}>⏰ {tpl.timeHHMM} {t(tpl.name, tpl.nameEn)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Custom Schedule Creator */}
          <div className="card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontWeight: 700, fontSize: 12 }}>{t('自定义新定时任务', 'Create Custom Schedule')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 96px', gap: 6 }}>
              <input className="input" style={{ fontSize: 11.5 }} value={newSchedName} onChange={(e) => setNewSchedName(e.target.value)} placeholder={t('任务名称（如：尾盘偷袭扫描）', 'Task name')} />
              <input className="input mono" type="time" style={{ fontSize: 11.5 }} value={newSchedTime} onChange={(e) => setNewSchedTime(e.target.value)} />
            </div>
            <textarea
              className="input"
              rows={2}
              style={{ fontSize: 11.5 }}
              value={newSchedPrompt}
              onChange={(e) => setNewSchedPrompt(e.target.value)}
              placeholder={t('到点要让 Bot 执行的指令（如：查台积电与自选光模块强弱，提醒有无破位风险）', 'Instruction for Bot to run at scheduled time...')}
            />
            <button type="button" className="btn btn-primary btn-sm" onClick={() => handleAddSchedule()}>
              <Plus size={12} /> {t('保存定时任务', 'Save Schedule')}
            </button>
          </div>

          {/* Existing Schedules */}
          <div>
            <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 5 }}>
              {t('我的 Bot 定时任务', 'My Bot Schedules')} ({watchState?.schedulesStore.tasks.length || 0})
            </div>
            {(watchState?.schedulesStore.tasks || []).map((tk) => (
              <div key={tk.id} className="card" style={{ padding: 8, marginBottom: 6, fontSize: 11.5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                  <strong>⏰ {tk.timeHHMM} · {tk.name}</strong>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ fontSize: 10, padding: '2px 6px' }}
                      disabled={runningSchedId === tk.id}
                      onClick={async () => {
                        setRunningSchedId(tk.id);
                        try {
                          const r = await api.runBotScheduleNow(tk.id);
                          setWatchState(r.watchState);
                          await loadState();
                          onToast(t(`已立即执行「${tk.name}」并推送播报`, `Executed "${tk.name}"`));
                        } catch (err: any) {
                          onToast(err.message);
                        } finally {
                          setRunningSchedId(null);
                        }
                      }}
                    >
                      {runningSchedId === tk.id ? <Loader2 size={10} className="spin" /> : <Play size={10} />} {t('试跑', 'Run')}
                    </button>
                    <button
                      type="button"
                      className={`btn btn-sm ${tk.enabled ? 'btn-primary' : ''}`}
                      style={{ fontSize: 10, padding: '2px 6px' }}
                      onClick={async () => setWatchState(await api.mutateBotSchedule({ action: 'toggle', id: tk.id }))}
                    >
                      {tk.enabled ? t('开启', 'On') : t('暂停', 'Off')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ padding: 3 }}
                      onClick={async () => setWatchState(await api.mutateBotSchedule({ action: 'delete', id: tk.id }))}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>{tk.prompt}</div>
                {tk.lastSummary && (
                  <div style={{ fontSize: 10.5, color: 'var(--navy)', marginTop: 4, padding: '4px 6px', borderRadius: 5, background: 'var(--bg-subtle)' }}>
                    {t('上次播报', 'Last')}: {tk.lastSummary}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : showSettings && botState && cfg ? (
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: 12, display: 'flex', flexDirection: 'column', gap: 13 }}>
          {/* 1. Mascot Gallery */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontWeight: 700, fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 5 }}>
                <Palette size={14} color="#0284c7" />
                <span>选择卡通形象（同步网页与 Windows 桌面悬浮）</span>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={syncPersonaOnMascot}
                  onChange={(e) => setSyncPersonaOnMascot(e.target.checked)}
                />
                <span>同步切专属人设</span>
              </label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 7 }}>
              {mascots.map((m) => {
                const selected = (cfg.avatarId || 'slime_mochi') === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className="btn"
                    style={{
                      height: 'auto',
                      padding: '7px 6px',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 4,
                      border: selected ? '2px solid #0284c7' : '1px solid var(--border)',
                      background: selected ? 'rgba(56, 189, 248, 0.12)' : 'var(--bg-card)',
                    }}
                    onClick={() => handleSelectMascot(m)}
                    title={m.desc}
                  >
                    <img
                      src={m.imageUrl}
                      alt={m.name}
                      style={{ width: 54, height: 54, objectFit: 'contain', display: 'block' }}
                    />
                    <div style={{ fontWeight: 700, fontSize: 11.5, textAlign: 'center', lineHeight: 1.25 }}>
                      {m.name.split('·')[0].trim()}
                    </div>
                    <span className="badge badge-muted" style={{ fontSize: 9.5, padding: '0 4px' }}>
                      {m.tag}
                    </span>
                  </button>
                );
              })}

              {/* Upload Custom Pet Card */}
              <button
                type="button"
                className="btn"
                style={{
                  height: 'auto',
                  padding: '7px 6px',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 5,
                  border: cfg.avatarId === 'custom' ? '2px solid #0284c7' : '1px dashed var(--border-strong)',
                  background: cfg.avatarId === 'custom' ? 'rgba(56, 189, 248, 0.12)' : 'var(--bg-subtle)',
                }}
                onClick={() => customPetFileRef.current?.click()}
              >
                {cfg.avatarId === 'custom' && cfg.customAvatarDataUrl ? (
                  <img
                    src={cfg.customAvatarDataUrl}
                    alt="自定义"
                    style={{ width: 54, height: 54, objectFit: 'contain', display: 'block' }}
                  />
                ) : (
                  <div style={{ width: 54, height: 54, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <ImagePlus size={24} color="var(--text-muted)" />
                  </div>
                )}
                <div style={{ fontWeight: 700, fontSize: 11.5 }}>上传自定义形象</div>
                <span className="badge badge-muted" style={{ fontSize: 9.5, padding: '0 4px' }}>
                  自动去白底
                </span>
              </button>
              <input
                ref={customPetFileRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleCustomPetUpload}
              />
            </div>
          </div>

          {/* 2. Permission Levels */}
          <div>
            <div style={{ fontWeight: 700, fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
              <Shield size={14} color="var(--navy)" />
              <span>Bot 权限档位（实时生效，随时可调）</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {botState.permissionLevels.map((pl) => {
                const active = cfg.permissionLevel === pl.level;
                return (
                  <button
                    key={pl.level}
                    type="button"
                    className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                    style={{
                      justifyContent: 'flex-start',
                      textAlign: 'left',
                      height: 'auto',
                      padding: '6px 9px',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 1,
                      whiteSpace: 'normal',
                      width: '100%',
                    }}
                    onClick={() =>
                      handleSaveConfig({ permissionLevel: pl.level as 0 | 1 | 2 | 3 }, `已切换权限为：${pl.label}`)
                    }
                  >
                    <span style={{ fontWeight: 700, fontSize: 11.5 }}>{pl.label}</span>
                    <span style={{ fontSize: 10.5, opacity: active ? 0.9 : 0.72, fontWeight: 400 }}>{pl.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. Persona Workshop */}
          <div>
            <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>人设工坊（可任意混搭形象与性格）</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6, marginBottom: 8 }}>
              {botState.personaPresets.map((p) => {
                const active = cfg.personaId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                    style={{
                      height: 'auto',
                      padding: '6px 8px',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      textAlign: 'left',
                      gap: 2,
                      whiteSpace: 'normal',
                      width: '100%',
                    }}
                    onClick={() => handleSaveConfig({ personaId: p.id }, `人设已切换为「${p.name}」`)}
                  >
                    <span style={{ fontWeight: 700, fontSize: 11.5 }}>{p.name}</span>
                    <span style={{ fontSize: 10, opacity: active ? 0.88 : 0.68, fontWeight: 400, lineHeight: 1.35 }}>
                      {p.tagline}
                    </span>
                  </button>
                );
              })}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '120px minmax(0, 1fr)', gap: 8, marginBottom: 8 }}>
              <div>
                <label className="field-label">伙伴昵称</label>
                <input
                  className="input"
                  style={{ fontSize: 12 }}
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label">补充/自定义人设指令</label>
                <input
                  className="input"
                  style={{ fontSize: 12 }}
                  placeholder="例如：称呼我为老板，多讲大肥鱼摆烂梗..."
                  value={draftCustomPrompt}
                  onChange={(e) => setDraftCustomPrompt(e.target.value)}
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <AiProviderPicker value={provider} config={aiConfig} onChange={setProvider} onOpenSettings={onOpenAiSettings} />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  handleSaveConfig({ botName: draftName, customPrompt: draftCustomPrompt }, '形象与人设配置已保存');
                  setShowSettings(false);
                }}
              >
                完成并返回聊天
              </button>
            </div>
          </div>

          {botState.hasDesktopPet && (
            <div style={{ padding: 9, borderRadius: 8, background: 'var(--bg-subtle)', border: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                <strong>Windows 桌面悬浮挂件</strong>：同步显示你选中的卡通形象，双击变身桌面行情看板！
              </div>
              <button type="button" className="btn btn-sm btn-primary" style={{ flexShrink: 0 }} onClick={handleLaunchDesktopPet}>
                <MonitorUp size={13} /> 召唤桌面悬浮
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Chat Thread */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(botState?.messages || []).map((m) => {
              const isUser = m.role === 'user';
              return (
                <div
                  key={m.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: isUser ? 'flex-end' : 'flex-start',
                    gap: 5,
                  }}
                >
                  {!isUser && m.toolsUsed && m.toolsUsed.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {m.toolsUsed.map((t) => (
                        <span key={t} className="badge badge-muted" style={{ fontSize: 10, padding: '1px 6px' }}>
                          {TOOL_LABELS[t] || t}
                        </span>
                      ))}
                    </div>
                  )}

                  <div
                    style={{
                      maxWidth: '88%',
                      padding: '8px 11px',
                      borderRadius: isUser ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                      background: isUser ? 'var(--navy)' : 'var(--bg-subtle)',
                      color: isUser ? '#ffffff' : 'var(--text-primary)',
                      border: isUser ? 'none' : '1px solid var(--border)',
                      fontSize: 12.5,
                      lineHeight: 1.55,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {m.content}
                  </div>

                  {(m.proposedActions || []).map((act) => (
                    <div
                      key={act.id}
                      style={{
                        width: '92%',
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: act.status === 'applied' ? '1px solid var(--emerald)' : '1.5px solid #38bdf8',
                        background: 'var(--bg-card)',
                        fontSize: 12,
                      }}
                    >
                      <div style={{ fontWeight: 700, marginBottom: 3 }}>
                        {act.status === 'applied' ? '✅ 已执行：' : '📋 待确认提案变更：'}
                        {act.label}
                      </div>
                      {act.summary && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 6 }}>{act.summary}</div>}
                      {act.status === 'pending' ? (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            style={{ fontSize: 11 }}
                            onClick={() => handleApproveAction(m.id, act, false)}
                          >
                            <CheckCircle2 size={12} /> 批准并执行
                          </button>
                          {act.kind === 'library_mutation' && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              style={{ fontSize: 11 }}
                              onClick={() => handleApproveAction(m.id, act, true)}
                            >
                              预览完整 Diff
                            </button>
                          )}
                        </div>
                      ) : (
                        act.backupId && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: 11, padding: '2px 6px' }}
                            onClick={() => handleUndoBackup(act.backupId)}
                          >
                            <RotateCcw size={11} /> 撤回本次修改
                          </button>
                        )
                      )}
                    </div>
                  ))}

                  {(m.appliedActions || []).map((act) => (
                    <div
                      key={act.id}
                      style={{
                        width: '92%',
                        padding: '7px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--emerald)',
                        background: 'var(--emerald-soft)',
                        fontSize: 11.5,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <div>
                        <strong>⚡ 已自动落盘执行：</strong>
                        <span>{act.summary || act.label}</span>
                      </div>
                      {act.backupId && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{ fontSize: 10.5, padding: '2px 7px', flexShrink: 0 }}
                          onClick={() => handleUndoBackup(act.backupId)}
                        >
                          <RotateCcw size={11} /> 撤回
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}

            {sending && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                <Loader2 size={14} className="spin" color="#0284c7" />
                <span>{cfg?.botName || '波波'} 正在思考 / 调用工具...</span>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div style={{ padding: '8px 10px', borderTop: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
            <div style={{ display: 'flex', gap: 5, overflowX: 'auto', paddingBottom: 7 }}>
              {QUICK_PROMPTS.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="btn btn-sm"
                  style={{ fontSize: 11, padding: '2px 8px', height: 'auto', whiteSpace: 'nowrap', flexShrink: 0 }}
                  disabled={sending}
                  onClick={() => handleSend(q)}
                >
                  <Sparkles size={10} color="#0284c7" /> {q}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input"
                style={{ flex: 1, fontSize: 12.5 }}
                placeholder={`跟 ${cfg?.botName || '波波'} 聊点什么：查卡、搜行情、增删改库、讲段子...`}
                value={inputText}
                disabled={sending}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={sending || !inputText.trim()}
                onClick={() => handleSend()}
              >
                <Send size={14} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
