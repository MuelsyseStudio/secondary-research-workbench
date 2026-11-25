import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { CRYPTO_ENABLED, IS_COMMERCIAL_EDITION } from '../config/edition';
import type {
  AiProvider,
  AiSafeConfig,
  BotWatchFullState,
  SlimeBotActionCard,
  SlimeBotConfig,
  SlimeBotStateResponse,
  SlimeMascotItem,
  SlimeMiniTickerData,
} from '../types';

export const TOOL_LABELS: Record<string, string> = {
  search_knowledge: '🔍 检索三库',
  get_card_detail: '📖 读取卡片',
  get_market_board: '📈 实时行情看板',
  analyze_stock: '🎯 标的6流派点位',
  web_search_info: '🌐 联网搜资讯',
  get_trade_stats: '💼 交易账本统计',
  mutate_library: '✍️ 三库增删改',
  manage_watchlist: '⭐ 管理自选股',
  manage_watch_alert: '🔔 设定盯盘预警',
  manage_bot_schedule: '⏰ 设定定时任务',
  bot_watch_daemon: '🚨 主动盯盘预警',
  rollback_last_backup: '⏪ 快照回滚',
};

const ALL_FALLBACK_MASCOTS: SlimeMascotItem[] = [
  {
    id: 'slime_mochi',
    name: '手绘蓝史莱姆 · 波波',
    tag: '原创形象·默认',
    imageUrl: '/mascots/slime_mochi.png',
    defaultBotName: '波波',
    recommendedPersona: 'slime_tsundere',
    desc: '原创手绘扁圆蓝史莱姆团子，温和清晰。',
  },
  ...(!IS_COMMERCIAL_EDITION
    ? [
        {
          id: 'big_fat_fish',
          name: '蓝色大肥鱼',
          tag: '摸鱼反差萌',
          imageUrl: '/mascots/big_fat_fish.png',
          defaultBotName: '大肥鱼',
          recommendedPersona: 'fat_fish_chill',
          desc: '吃白饭的蓝色大肥鱼，理直气壮摸鱼护盘。',
        },
        {
          id: 'open_tux',
          name: '开源企鹅 · Tux研究猿',
          tag: '知名开源形象',
          imageUrl: '/mascots/open_tux.png',
          defaultBotName: 'Tux研究猿',
          recommendedPersona: 'cio_cold',
          desc: 'Linux 经典开源企鹅，金丝眼镜硬核看盘。',
        },
        {
          id: 'open_gopher',
          name: '开源蓝地鼠 · Gopher',
          tag: '知名开源形象',
          imageUrl: '/mascots/open_gopher.png',
          defaultBotName: '蓝地鼠',
          recommendedPersona: 'standup_ticker',
          desc: 'Go 语言经典开源蓝地鼠，端咖啡讲段子。',
        },
        {
          id: 'open_shiba',
          name: CRYPTO_ENABLED ? '招财柴犬 · Doge护盘官' : '招财柴犬 · 旺财护盘官',
          tag: '开源网络名梗',
          imageUrl: '/mascots/open_shiba.png',
          defaultBotName: '旺财柴',
          recommendedPersona: 'youzi_buddy',
          desc: '红围巾柴犬搭子，专治 FOMO 追高。',
        },
      ]
    : []),
];

export const FALLBACK_MASCOTS: SlimeMascotItem[] = ALL_FALLBACK_MASCOTS;

export const MascotSprite: React.FC<{
  avatarId?: string;
  customAvatarDataUrl?: string;
  size?: number;
  mood?: string;
  thinking?: boolean;
  showBadges?: boolean;
}> = ({
  avatarId = 'slime_mochi',
  customAvatarDataUrl,
  size = 80,
  mood = 'happy',
  thinking = false,
  showBadges = true,
}) => {
  const isAlert = mood === 'alert' || mood === 'puffy';
  const src =
    avatarId === 'custom' && customAvatarDataUrl
      ? customAvatarDataUrl
      : `/mascots/${avatarId || 'slime_mochi'}.png`;

  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <img
        src={src}
        alt="投研伙伴形象"
        draggable={false}
        className={thinking ? 'slime-thinking' : 'slime-breathe'}
        style={{
          width: size,
          height: size,
          objectFit: 'contain',
          display: 'block',
          filter: isAlert
            ? 'drop-shadow(0 6px 14px rgba(239, 68, 68, 0.34))'
            : 'drop-shadow(0 6px 12px rgba(56, 189, 248, 0.25))',
        }}
      />
      {showBadges && thinking && (
        <span
          style={{
            position: 'absolute',
            top: 0,
            right: -2,
            background: '#ffffff',
            border: '1.5px solid #38bdf8',
            color: '#0284c7',
            borderRadius: 999,
            padding: '0px 5px',
            fontSize: 10,
            fontWeight: 800,
            boxShadow: '0 2px 8px rgba(15,23,42,0.14)',
          }}
        >
          ...
        </span>
      )}
      {showBadges && isAlert && !thinking && (
        <span
          style={{
            position: 'absolute',
            top: 2,
            right: 2,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: '#ef4444',
            color: '#ffffff',
            border: '2px solid #ffffff',
            fontSize: 11,
            fontWeight: 900,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 8px rgba(239,68,68,0.45)',
          }}
        >
          !
        </span>
      )}
    </div>
  );
};

export interface BotContextPill {
  label: string;
  secid?: string;
  code?: string;
  name?: string;
  price?: number | null;
}

interface SlimeBotContextValue {
  mode: 'slime' | 'ticker' | 'chat';
  setMode: React.Dispatch<React.SetStateAction<'slime' | 'ticker' | 'chat'>>;
  drawerTab: 'chat' | 'alerts' | 'schedules' | 'settings';
  setDrawerTab: React.Dispatch<React.SetStateAction<'chat' | 'alerts' | 'schedules' | 'settings'>>;
  dockDrawerOpen: boolean;
  setDockDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  botState: SlimeBotStateResponse | null;
  setBotState: React.Dispatch<React.SetStateAction<SlimeBotStateResponse | null>>;
  ticker: SlimeMiniTickerData | null;
  tickerLoading: boolean;
  watchState: BotWatchFullState | null;
  setWatchState: React.Dispatch<React.SetStateAction<BotWatchFullState | null>>;
  inputText: string;
  setInputText: React.Dispatch<React.SetStateAction<string>>;
  sending: boolean;
  provider: AiProvider;
  setProvider: React.Dispatch<React.SetStateAction<AiProvider>>;
  contextPill: BotContextPill | null;
  setContextPill: (pill: BotContextPill | null) => void;
  dismissedContextKey: string;
  dismissContextPill: () => void;
  loadState: () => Promise<void>;
  refreshTicker: (force?: boolean) => Promise<void>;
  refreshWatchState: () => Promise<void>;
  saveConfig: (patch: Partial<SlimeBotConfig>, msg?: string) => Promise<void>;
  sendMessage: (textOverride?: string, opts?: { openDockDrawer?: boolean; openFloatingChat?: boolean; attachContext?: boolean }) => Promise<void>;
  approveAction: (messageId: string, act: SlimeBotActionCard, viaDiffModal?: boolean) => Promise<void>;
  undoBackup: (backupId?: string | null) => Promise<void>;
  clearHistory: () => Promise<void>;
  launchDesktopPet: () => Promise<void>;
  addPriceAlertQuick: (params: { secid: string; name: string; price: number; condition?: 'price_above' | 'price_below'; note?: string }) => Promise<void>;
  deleteWatchAlertQuick: (id: string) => Promise<void>;
}

const SlimeBotContext = createContext<SlimeBotContextValue | null>(null);

export const SlimeBotProvider: React.FC<{
  aiConfig: AiSafeConfig | null;
  workspaceEpoch?: number;
  onRequestMutation: (action: string, payload: Record<string, unknown>, onSuccess?: () => void) => void;
  onLibraryChanged: () => Promise<void>;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
  children: React.ReactNode;
}> = ({ aiConfig, workspaceEpoch = 0, onRequestMutation, onLibraryChanged, onToast, children }) => {
  const [mode, setMode] = useState<'slime' | 'ticker' | 'chat'>('slime');
  const [drawerTab, setDrawerTab] = useState<'chat' | 'alerts' | 'schedules' | 'settings'>('chat');
  const [dockDrawerOpen, setDockDrawerOpen] = useState(false);
  const [botState, setBotState] = useState<SlimeBotStateResponse | null>(null);
  const [ticker, setTicker] = useState<SlimeMiniTickerData | null>(null);
  const [tickerLoading, setTickerLoading] = useState(false);
  const [watchState, setWatchState] = useState<BotWatchFullState | null>(null);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [provider, setProvider] = useState<AiProvider>(aiConfig?.provider || 'codex_cli');
  const [rawContextPill, setRawContextPill] = useState<BotContextPill | null>(null);
  const [dismissedContextKey, setDismissedContextKey] = useState('');

  useEffect(() => {
    if (aiConfig?.provider) setProvider(aiConfig.provider);
  }, [aiConfig?.provider]);

  // 切换工作空间时同步清空 Bot 当前标的上下文，避免将旧空间个股带入新空间
  useEffect(() => {
    setRawContextPill(null);
    setDismissedContextKey('');
  }, [workspaceEpoch]);

  const setContextPill = useCallback((pill: BotContextPill | null) => {
    setRawContextPill(pill);
    if (pill) {
      const nextKey = pill.secid || pill.label;
      setDismissedContextKey((prev) => (prev === nextKey ? '' : prev));
    }
  }, []);

  const dismissContextPill = useCallback(() => {
    if (rawContextPill) {
      setDismissedContextKey(rawContextPill.secid || rawContextPill.label);
    }
  }, [rawContextPill]);

  const contextPill =
    rawContextPill && (rawContextPill.secid || rawContextPill.label) !== dismissedContextKey
      ? rawContextPill
      : null;

  const loadState = useCallback(async () => {
    try {
      const st = await api.getBotState();
      setBotState(st);
    } catch {
      // non-fatal
    }
  }, []);

  const refreshTicker = useCallback(async (force = false) => {
    setTickerLoading(true);
    try {
      const t = await api.getBotTicker(force);
      setTicker(t);
    } catch {
      // non-fatal
    } finally {
      setTickerLoading(false);
    }
  }, []);

  const refreshWatchState = useCallback(async () => {
    try {
      const ws = await api.getBotWatchState();
      setWatchState(ws);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    loadState();
    refreshTicker(false);
    refreshWatchState();
    const poll = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      refreshWatchState();
    }, 25000);
    return () => clearInterval(poll);
  }, [loadState, refreshTicker, refreshWatchState]);

  useEffect(() => {
    if (mode !== 'ticker') return;
    refreshTicker(false);
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      refreshTicker(true);
    }, 20000);
    return () => clearInterval(id);
  }, [mode, refreshTicker]);

  const saveConfig = useCallback(
    async (patch: Partial<SlimeBotConfig>, msg?: string) => {
      try {
        const next = await api.saveBotConfig(patch);
        setBotState(next);
        if (msg) onToast(msg);
      } catch (err: any) {
        onToast(`保存形象与设置失败：${err.message}`);
      }
    },
    [onToast]
  );

  const sendMessage = useCallback(
    async (
      textOverride?: string,
      opts?: { openDockDrawer?: boolean; openFloatingChat?: boolean; attachContext?: boolean }
    ) => {
      const raw = (textOverride ?? inputText).trim();
      if (!raw || sending) return;
      const payloadText =
        opts?.attachContext && contextPill && !raw.includes(contextPill.name || contextPill.code || '___')
          ? `[当前查看标的：${contextPill.label}${contextPill.price != null ? `，现价 ${contextPill.price}` : ''}] ${raw}`
          : raw;

      setInputText('');
      if (opts?.openDockDrawer) setDockDrawerOpen(true);
      if (opts?.openFloatingChat) {
        setDrawerTab('chat');
        setMode('chat');
      }
      setSending(true);
      try {
        const res = await api.sendBotChat(payloadText, provider);
        setBotState(res.state);
        if (res.ticker) setTicker(res.ticker);
        if (res.libraryChanged) {
          await onLibraryChanged();
          onToast(`${res.state.config.botName} 已在自动写库权限下完成写入并自动留好原子备份`);
        }
        if (res.message.uiAction === 'show_ticker') {
          setMode('ticker');
          refreshTicker(true);
        } else if (res.message.uiAction === 'show_slime') {
          setMode('slime');
        }
        refreshWatchState();
      } catch (err: any) {
        onToast(`回复失败：${err.message}`);
      } finally {
        setSending(false);
      }
    },
    [inputText, sending, contextPill, provider, onLibraryChanged, onToast, refreshTicker, refreshWatchState]
  );

  const approveAction = useCallback(
    async (messageId: string, act: SlimeBotActionCard, viaDiffModal = false) => {
      if (viaDiffModal && act.kind === 'library_mutation' && act.action) {
        onRequestMutation(act.action, act.payload, async () => {
          await loadState();
        });
        return;
      }
      try {
        const res = await api.approveBotAction(messageId, act.id);
        setBotState(res.state);
        if (res.libraryChanged) {
          await onLibraryChanged();
        }
        onToast(`已执行：${act.label}`);
      } catch (err: any) {
        onToast(`执行失败：${err.message}`);
      }
    },
    [onRequestMutation, loadState, onLibraryChanged, onToast]
  );

  const undoBackup = useCallback(
    async (backupId?: string | null) => {
      try {
        const res = await api.undoBotBackup(backupId || undefined);
        setBotState(res.state);
        await onLibraryChanged();
        onToast(`已撤回操作，三库已恢复至快照 ${res.restoredFrom}`);
      } catch (err: any) {
        onToast(`撤回失败：${err.message}`);
      }
    },
    [onLibraryChanged, onToast]
  );

  const clearHistory = useCallback(async () => {
    try {
      const next = await api.clearBotHistory();
      setBotState(next);
      onToast('已清空会话历史');
    } catch (err: any) {
      onToast(err.message);
    }
  }, [onToast]);

  const launchDesktopPet = useCallback(async () => {
    try {
      await api.launchDesktopSlimePet();
      onToast('已召唤 Windows 桌面真·悬浮透明伙伴！（同步你当前选中的形象，双击可变成行情看板）');
    } catch (err: any) {
      onToast(err.message);
    }
  }, [onToast]);

  const addPriceAlertQuick = useCallback(
    async (params: {
      secid: string;
      name: string;
      price: number;
      condition?: 'price_above' | 'price_below';
      note?: string;
    }) => {
      try {
        const ws = await api.mutateBotWatchAlert({
          query: params.secid,
          secid: params.secid,
          stockName: params.name,
          condition: params.condition || 'price_above',
          threshold: Number(params.price.toFixed(2)),
          note: params.note || `图表快捷价格预警 (${params.price.toFixed(2)})`,
        });
        setWatchState(ws);
        onToast(`已为 ${params.name} 设定 Bot 价格预警：${params.condition === 'price_below' ? '跌破' : '突破'} ${params.price.toFixed(2)}`);
      } catch (err: any) {
        onToast(`设定价格预警失败：${err.message}`);
      }
    },
    [onToast]
  );

  const deleteWatchAlertQuick = useCallback(
    async (id: string) => {
      try {
        const ws = await api.mutateBotWatchAlert({ action: 'delete', id });
        setWatchState(ws);
        onToast('已移除图表价格预警线');
      } catch (err: any) {
        onToast(err.message);
      }
    },
    [onToast]
  );

  const contextValue = useMemo<SlimeBotContextValue>(
    () => ({
      mode,
      setMode,
      drawerTab,
      setDrawerTab,
      dockDrawerOpen,
      setDockDrawerOpen,
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
      contextPill,
      setContextPill,
      dismissedContextKey,
      dismissContextPill,
      loadState,
      refreshTicker,
      refreshWatchState,
      saveConfig,
      sendMessage,
      approveAction,
      undoBackup,
      clearHistory,
      launchDesktopPet,
      addPriceAlertQuick,
      deleteWatchAlertQuick,
    }),
    [
      mode,
      drawerTab,
      dockDrawerOpen,
      botState,
      ticker,
      tickerLoading,
      watchState,
      inputText,
      sending,
      provider,
      contextPill,
      dismissedContextKey,
      dismissContextPill,
      loadState,
      refreshTicker,
      refreshWatchState,
      saveConfig,
      sendMessage,
      approveAction,
      undoBackup,
      clearHistory,
      launchDesktopPet,
      addPriceAlertQuick,
      deleteWatchAlertQuick,
    ]
  );

  return <SlimeBotContext.Provider value={contextValue}>{children}</SlimeBotContext.Provider>;
};

export function useSlimeBot(): SlimeBotContextValue {
  const ctx = useContext(SlimeBotContext);
  if (!ctx) throw new Error('useSlimeBot must be used within SlimeBotProvider');
  return ctx;
}
