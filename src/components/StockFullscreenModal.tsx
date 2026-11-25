import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BellPlus,
  BookOpen,
  Calculator,
  Camera,
  ExternalLink,
  Flame,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { CRYPTO_ENABLED } from '../config/edition';
import type { EntityRef, KlineTimeframe, SecuritySearchItem } from '../types';
import { InteractiveKlineChart } from './InteractiveKlineChart';
import { IntradayVolumeChart } from './IntradayVolumeChart';
import { OrderBookPanel } from './OrderBookPanel';
import { TradePlanCardModal } from './TradePlanCardModal';
import { useSlimeBot } from '../contexts/SlimeBotContext';

interface StockFullscreenModalProps {
  queryOrSecid: string;
  standalone?: boolean;
  onClose: () => void;
  onChangeTarget: (nextQueryOrSecid: string, nextName?: string) => void;
  onTargetResolved?: (info: { secid: string; code: string; name: string }) => void;
  onOpenEntity?: (ref: EntityRef) => void;
  onQuickAnalyzeStock?: (queryLabel: string) => void;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

interface VisionChatItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  snapshotDataUrl?: string;
  visionMode?: 'multimodal' | 'quant_grounded_text';
  visionNotice?: string;
  providerLabel?: string;
  model?: string;
  latencyMs?: number;
  disclaimer?: string;
  createdAt: string;
}

/**
 * 将当前全屏图表视口内的所有 canvas（klinecharts 多层主/副图画布）合成为单张高清 PNG
 * 用于发给多模态大模型做实时「识图解盘」
 */
function captureChartStageSnapshot(stageEl: HTMLDivElement | null): string | null {
  if (!stageEl) return null;
  const canvases = Array.from(stageEl.querySelectorAll('canvas')).filter((c) => c.width > 0 && c.height > 0);
  if (canvases.length === 0) return null;
  const stageRect = stageEl.getBoundingClientRect();
  if (stageRect.width < 60 || stageRect.height < 60) return null;

  const maxW = 1280;
  const scale = Math.min(1.5, maxW / Math.max(1, stageRect.width));
  const outW = Math.round(stageRect.width * scale);
  const outH = Math.round(stageRect.height * scale);

  const off = document.createElement('canvas');
  off.width = outW;
  off.height = outH;
  const ctx = off.getContext('2d');
  if (!ctx) return null;

  const computedBg = window.getComputedStyle(stageEl).backgroundColor;
  ctx.fillStyle = computedBg && computedBg !== 'rgba(0, 0, 0, 0)' ? computedBg : '#0f172a';
  ctx.fillRect(0, 0, outW, outH);

  for (const cv of canvases) {
    try {
      const r = cv.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const dx = (r.left - stageRect.left) * scale;
      const dy = (r.top - stageRect.top) * scale;
      const dw = r.width * scale;
      const dh = r.height * scale;
      ctx.drawImage(cv, dx, dy, dw, dh);
    } catch {
      // ignore tainted or unready canvas layers
    }
  }
  try {
    return off.toDataURL('image/png');
  } catch {
    return null;
  }
}

export const StockFullscreenModal: React.FC<StockFullscreenModalProps> = ({
  queryOrSecid,
  standalone = false,
  onClose,
  onChangeTarget,
  onTargetResolved,
  onOpenEntity,
  onQuickAnalyzeStock,
  onToast,
}) => {
  const { t, pctColor, formatPrice, formatPct, marketBadgeLabel, currencySymbol } = useI18n();
  const { watchState, addPriceAlertQuick, deleteWatchAlertQuick, setContextPill } = useSlimeBot();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const chartStageRef = useRef<HTMLDivElement | null>(null);
  const onTargetResolvedRef = useRef(onTargetResolved);
  onTargetResolvedRef.current = onTargetResolved;

  const [timeframe, setTimeframe] = useState<KlineTimeframe>('day');
  const [chartTab, setChartTab] = useState<'kline' | 'intraday'>('kline');
  // 默认纯净铺满全屏 K 线，右侧情报/盘口/三库/AI识图抽屉按需一键展开
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  const [rightTab, setRightTab] = useState<'ai_vision' | 'book' | 'tech' | 'anomaly' | 'library' | 'alert'>('book');
  const [isNativeFs, setIsNativeFs] = useState(false);
  const [showPlanCard, setShowPlanCard] = useState(false);

  // 原地 AI 实时识图解盘状态
  const [visionMessages, setVisionMessages] = useState<VisionChatItem[]>([]);
  const [visionQuestion, setVisionQuestion] = useState('');
  const [visionLoading, setVisionLoading] = useState(false);
  const [visionSnapshot, setVisionSnapshot] = useState<string | null>(null);
  const [visionError, setVisionError] = useState<string | null>(null);
  const visionSeqRef = useRef(0);

  const [dossier, setDossier] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Top global search + Eastmoney hot ranks dropdown
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<SecuritySearchItem[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hotRanks, setHotRanks] = useState<any[]>([]);

  // Quick Bot watch alert form
  const [alertCond, setAlertCond] = useState<'price_above' | 'price_below' | 'pct_above' | 'pct_below' | 'vol_ratio_above'>('price_above');
  const [alertThreshold, setAlertThreshold] = useState('');
  const [alertNote, setAlertNote] = useState('');
  const [alertWebhook, setAlertWebhook] = useState(false);
  const [savingAlert, setSavingAlert] = useState(false);

  const mountedRef = useRef(true);
  const loadSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadSeqRef.current += 1;
    };
  }, []);

  const loadDossier = useCallback(
    async (q: string, tf: KlineTimeframe) => {
      const reqSeq = ++loadSeqRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.getStockFullscreenDossier(q, tf);
        if (!mountedRef.current || reqSeq !== loadSeqRef.current) return;
        setDossier(res);
        if (res?.target?.secid) {
          setContextPill({
            label: `${res.target.name} ${res.target.code}`,
            secid: res.target.secid,
            code: res.target.code,
            name: res.target.name,
            price: res?.technical?.indicators?.price ?? null,
          });
          onTargetResolvedRef.current?.({
            secid: res.target.secid,
            code: res.target.code || res.target.secid.replace(/^\d+\./, ''),
            name: res.target.name || '',
          });
        }
        if (res?.technical?.indicators?.price != null) {
          const px = Number(res.technical.indicators.price);
          setAlertThreshold(String(Number((px * 1.03).toFixed(px >= 100 ? 2 : 3))));
        }
      } catch (err: any) {
        if (!mountedRef.current || reqSeq !== loadSeqRef.current) return;
        setError(err.message || '加载标的详情失败');
      } finally {
        if (mountedRef.current && reqSeq === loadSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [setContextPill]
  );

  useEffect(() => {
    loadDossier(queryOrSecid, timeframe);
  }, [queryOrSecid, timeframe, loadDossier]);

  // 切换标的时重置本标的的 AI 识图会话，避免串票
  useEffect(() => {
    visionSeqRef.current += 1;
    setVisionMessages([]);
    setVisionSnapshot(null);
    setVisionError(null);
    setVisionLoading(false);
  }, [queryOrSecid]);

  const runLiveChartVision = useCallback(
    async (promptOverride?: string, recapture = true) => {
      const targetSecid = dossier?.target?.secid || queryOrSecid;
      if (!targetSecid) return;
      const reqSeq = ++visionSeqRef.current;
      const question = String(promptOverride ?? visionQuestion).trim();
      const snap = recapture ? captureChartStageSnapshot(chartStageRef.current) : visionSnapshot;
      if (snap) setVisionSnapshot(snap);

      const userLabel =
        question ||
        t(
          `请识图解读当前 ${dossier?.target?.name || targetSecid} (${chartTab === 'intraday' ? '分时' : timeframe}) 的形态、量价与关键支撑压力位`,
          `Analyze current ${dossier?.target?.name || targetSecid} chart structure & levels`
        );

      const historyForApi = visionMessages.slice(-6).map((m) => ({ role: m.role, content: m.content }));
      setVisionMessages((prev) => [
        ...prev,
        {
          id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          role: 'user',
          content: userLabel,
          snapshotDataUrl: snap || undefined,
          createdAt: new Date().toLocaleTimeString(),
        },
      ]);
      if (promptOverride === undefined) setVisionQuestion('');
      setVisionLoading(true);
      setVisionError(null);
      try {
        const res = await api.analyzeChartVision({
          secid: targetSecid,
          query: queryOrSecid,
          timeframe,
          chartTab,
          imageBase64: snap || undefined,
          imageMimeType: 'image/png',
          userQuestion: userLabel,
          history: historyForApi,
        });
        if (!mountedRef.current || reqSeq !== visionSeqRef.current) return;
        setVisionMessages((prev) => [
          ...prev,
          {
            id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            role: 'assistant',
            content: res.answerMarkdown,
            visionMode: res.visionMode,
            visionNotice: res.visionNotice,
            providerLabel: res.providerLabel,
            model: res.model,
            latencyMs: res.latencyMs,
            disclaimer: res.disclaimer,
            createdAt: new Date().toLocaleTimeString(),
          },
        ]);
      } catch (err: any) {
        if (!mountedRef.current || reqSeq !== visionSeqRef.current) return;
        const msg = err?.message || 'AI 识图解盘调用失败，请检查右上角「AI 引擎」配置';
        setVisionError(msg);
        onToast(msg, 'error');
      } finally {
        if (mountedRef.current && reqSeq === visionSeqRef.current) {
          setVisionLoading(false);
        }
      }
    },
    [chartTab, dossier?.target?.name, dossier?.target?.secid, onToast, queryOrSecid, t, timeframe, visionMessages, visionQuestion, visionSnapshot]
  );

  const handleOpenInPlaceAiVision = useCallback(() => {
    setRightTab('ai_vision');
    setRightDrawerOpen(true);
    // 若尚无本标的解盘记录，先截取当前画面（等抽屉布局动画前立刻抓纯净宽屏画布！）并自动触发首次识图
    if (visionMessages.length === 0 && !visionLoading) {
      const snap = captureChartStageSnapshot(chartStageRef.current);
      if (snap) setVisionSnapshot(snap);
      window.setTimeout(() => {
        runLiveChartVision(
          '请结合当前图表截图与实时量价数据，解读最新 K 线形态与趋势结构、量价动能、关键支撑/压力与防守位，以及风险信号。',
          !snap
        );
      }, 60);
    }
  }, [runLiveChartVision, visionLoading, visionMessages.length]);

  useEffect(() => {
    api.getHotRankBoard(12).then((r) => setHotRanks(r.items || [])).catch(() => {});
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsNativeFs(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showPlanCard) {
          setShowPlanCard(false);
          return;
        }
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
          return;
        }
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, showPlanCard]);

  useEffect(() => {
    const q = searchQ.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api.searchSecurities(q).then((r) => setSearchResults(r.items || [])).catch(() => {});
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQ]);

  const toggleNativeFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await (rootRef.current || document.documentElement).requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      onToast('当前窗口环境不支持系统原生全屏，已处于窗口全屏铺满模式');
    }
  };

  const handleAddToWatchlist = async () => {
    if (!dossier?.target) return;
    try {
      const target = dossier.target;
      const res = await api.addWatchlistItem(
        {
          secid: target.secid,
          code: target.code,
          secuCode: target.secuCode,
          name: target.name,
          marketKind: target.marketKind,
          currency: target.currency,
          group:
            CRYPTO_ENABLED && target.marketKind === 'CRYPTO'
              ? '加密货币 24/7'
              : target.marketKind === 'FUT'
              ? '全球期货'
              : `${marketBadgeLabel(target.marketKind)}自选`,
          note: '',
        },
        false
      );
      if (res.alreadyExists) {
        onToast(t(`${target.name} 已在自选列表中`, `${target.name} is already in watchlist`), 'info');
      } else {
        onToast(t(`已将 ${target.name} (${target.secuCode}) 加入自选看板`, `Added ${target.name} to watchlist`), 'success');
      }
    } catch (err: any) {
      onToast(err.message || '加入自选失败', 'error');
    }
  };

  const handleCreateBotAlert = async () => {
    if (!dossier?.target) return;
    const val = Number(alertThreshold);
    if (!Number.isFinite(val)) {
      onToast(t('请输入合法的触发数值', 'Please enter a valid threshold number'), 'warning');
      return;
    }
    setSavingAlert(true);
    try {
      await api.mutateBotWatchAlert({
        secid: dossier.target.secid,
        code: dossier.target.code,
        secuCode: dossier.target.secuCode,
        name: dossier.target.name,
        marketKind: dossier.target.marketKind,
        currency: dossier.target.currency,
        condition: alertCond,
        threshold: val,
        note: alertNote,
        notifyWebhook: alertWebhook,
      });
      onToast(t(`已为 ${dossier.target.name} 设定 Bot 盯盘预警！触发时将主动推送给你`, `Bot watch alert saved for ${dossier.target.name}!`), 'success');
      setAlertNote('');
    } catch (err: any) {
      onToast(err.message || '保存预警失败', 'error');
    } finally {
      setSavingAlert(false);
    }
  };

  const tech = dossier?.technical;
  const target = dossier?.target;
  const ind = tech?.indicators;
  const anomaly = dossier?.anomaly;
  const links = dossier?.threeLibraryLinks;

  return (
    <div
      ref={rootRef}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 1450,
        background: 'var(--bg)',
        color: 'var(--text)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Slim 44px Edge-to-Edge Fullscreen Command Bar */}
      <div
        style={{
          minHeight: 44,
          flexShrink: 0,
          padding: '5px 12px',
          background: 'var(--bg-elev)',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        {/* Global Ticker Search + Hot Rank Dropdown */}
        <div style={{ position: 'relative', width: 224, flexShrink: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              border: '1px solid var(--border-strong)',
              borderRadius: 7,
              padding: '3px 8px',
              background: 'var(--bg-soft)',
            }}
          >
            <Search size={13} color="var(--text-muted)" />
            <input
              value={searchQ}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setTimeout(() => setSearchOpen(false), 180)}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchQ.trim()) {
                  onChangeTarget(searchQ.trim());
                  setSearchOpen(false);
                }
              }}
              placeholder={
                CRYPTO_ENABLED
                  ? t('快切标的（代码/名称/期货/BTC）...', 'Switch ticker...')
                  : t('快切标的（A股/美港欧亚/期货）...', 'Switch ticker...')
              }
              style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 12, width: '100%', color: 'var(--text)' }}
            />
          </div>
          {searchOpen && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                width: 340,
                marginTop: 4,
                background: 'var(--bg-elev)',
                border: '1px solid var(--border-strong)',
                borderRadius: 9,
                boxShadow: 'var(--shadow-lg)',
                maxHeight: 360,
                overflowY: 'auto',
                zIndex: 40,
                padding: 8,
              }}
            >
              {searchQ.trim() ? (
                searchResults.length > 0 ? (
                  searchResults.map((s) => (
                    <button
                      key={s.secid}
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ width: '100%', justifyContent: 'space-between', marginBottom: 2 }}
                      onMouseDown={() => {
                        onChangeTarget(s.secid, s.name);
                        setSearchQ('');
                        setSearchOpen(false);
                      }}
                    >
                      <span>
                        <strong>{s.name}</strong> <span className="mono" style={{ opacity: 0.7 }}>{s.secuCode}</span>
                      </span>
                      <span className="badge badge-navy" style={{ fontSize: 10 }}>{marketBadgeLabel(s.marketKind)}</span>
                    </button>
                  ))
                ) : (
                  <div style={{ padding: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                    {t('按回车直接尝试解析：', 'Press Enter to resolve: ')}{searchQ}
                  </div>
                )
              ) : (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Flame size={12} color="var(--crimson)" /> {t('实时人气热股（点击直达全屏 K 线）', 'Hot Stocks')}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                    {hotRanks.slice(0, 10).map((h) => (
                      <button
                        key={h.secid}
                        type="button"
                        className="btn btn-sm"
                        style={{ justifyContent: 'space-between', padding: '4px 7px' }}
                        onMouseDown={() => {
                          onChangeTarget(h.secid, h.name);
                          setSearchOpen(false);
                        }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <b style={{ color: 'var(--amber)', marginRight: 4 }}>{h.rank}</b>{h.name}
                        </span>
                        <span className="mono num" style={{ color: pctColor(h.pct), fontWeight: 700, fontSize: 11 }}>{formatPct(h.pct)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Live Quote Strip */}
        {target && ind && (
          <div className="num" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
            <span className="badge badge-navy" style={{ fontSize: 10.5 }}>{marketBadgeLabel(target.marketKind)}</span>
            <strong style={{ fontSize: 15, color: 'var(--text)' }}>{target.name}</strong>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{target.secuCode}</span>
            <span className="mono" style={{ fontSize: 16.5, fontWeight: 800, color: pctColor(ind.pct) }}>
              {formatPrice(ind.price, target.currency)}
            </span>
            <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: pctColor(ind.pct) }}>
              {formatPct(ind.pct)}
            </span>
            <span className="badge badge-muted" style={{ fontSize: 10.5 }}>{ind.trendRegime}</span>
            {anomaly && anomaly.riskLevel !== 'safe' && (
              <span className="badge badge-crimson" style={{ fontSize: 10.5 }}>
                <ShieldAlert size={11} /> {anomaly.statusText}
              </span>
            )}
          </div>
        )}

        {/* Chart Mode Switch + Right Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <div className="seg-tabs" style={{ padding: 2 }}>
            <button
              type="button"
              className={`seg-tab ${chartTab === 'kline' ? 'active' : ''}`}
              style={{ padding: '3px 9px', fontSize: 11.5 }}
              onClick={() => setChartTab('kline')}
            >
              <TrendingUp size={12} /> {t('全屏 K 线', 'K-Line')}
            </button>
            <button
              type="button"
              className={`seg-tab ${chartTab === 'intraday' ? 'active' : ''}`}
              style={{ padding: '3px 9px', fontSize: 11.5 }}
              onClick={() => setChartTab('intraday')}
            >
              <Activity size={12} /> {t('全屏分时', 'Intraday')}
            </button>
          </div>

          {target?.marketKind === 'CN' && (
            <button type="button" className="btn btn-sm" onClick={() => setShowPlanCard(true)} title="A股仓位与硬止损交易计划卡">
              <Calculator size={12} /> {t('计划卡', 'Plan')}
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={handleAddToWatchlist}>
            <Plus size={12} /> {t('加自选', 'Watch')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setRightTab('alert');
              setRightDrawerOpen(true);
            }}
          >
            <BellPlus size={12} /> {t('预警', 'Alert')}
          </button>
          {target && (
            <button
              type="button"
              className={`btn btn-sm ${rightDrawerOpen && rightTab === 'ai_vision' ? 'btn-teal' : 'btn-primary'}`}
              onClick={handleOpenInPlaceAiVision}
              title={t('原地截屏实时识图解读当前走势（不离开全屏 K 线，内部可随时转入台账深度研判）', 'In-page AI live chart vision analysis')}
            >
              <Sparkles size={12} /> {t('AI 识图解盘', 'AI Vision')}
            </button>
          )}
          <button
            type="button"
            className={`btn btn-sm ${rightDrawerOpen ? 'btn-teal' : ''}`}
            onClick={() => setRightDrawerOpen((v) => !v)}
            title={rightDrawerOpen ? '收起右侧盘口/点位/三库侧栏，还原 100% 纯净 K 线' : '展开盘口、6流派点位、异动与三库关联侧栏'}
          >
            {rightDrawerOpen ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
            <span>{rightDrawerOpen ? t('纯净全屏', 'Pure Chart') : t('盘口/三库', 'Details')}</span>
          </button>
          {!standalone && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                const sec = target?.secid || queryOrSecid;
                const url = `${window.location.origin}/?standalone=stock&secid=${encodeURIComponent(sec)}`;
                window.open(url, `srw_stock_${sec.replace(/[^a-zA-Z0-9]/g, '_')}`, 'width=1340,height=860,noopener');
                onToast(t('已在新窗口弹出独立全屏研股页，可直接拖至副屏盯盘', 'Popped out fullscreen chart to a new window'));
              }}
              title={t('新窗口独立弹出（适配双屏 / 多屏交易员）', 'Pop out into a standalone multi-monitor window')}
            >
              <ExternalLink size={13} />
              <span>{t('新窗口', 'Pop-Out')}</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={toggleNativeFullscreen}
            title={isNativeFs ? '退出浏览器原生全屏' : '进入浏览器原生全屏 (F11)'}
          >
            {isNativeFs ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => loadDossier(queryOrSecid, timeframe)} title="刷新数据">
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
          </button>
          {standalone ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                window.location.href = '/';
              }}
              title="返回完整工作台主界面"
            >
              {t('返回工作台', 'Back to Desk')}
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-danger" onClick={onClose} title="ESC 退出全屏">
              <X size={13} /> {t('退出', 'ESC')}
            </button>
          )}
        </div>
      </div>

      {/* Main Edge-to-Edge Fullscreen Chart Stage */}
      {loading && !dossier ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-muted)' }}>
          <Loader2 size={20} className="spin" /> {t('正在全屏加载 K 线画布与技术点位...', 'Loading fullscreen K-line canvas...')}
        </div>
      ) : error ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <AlertTriangle size={28} color="var(--crimson)" />
          <div style={{ color: 'var(--crimson)', fontWeight: 600 }}>{error}</div>
          <button type="button" className="btn btn-sm" onClick={() => loadDossier(queryOrSecid, timeframe)}>
            {t('重试', 'Retry')}
          </button>
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: rightDrawerOpen ? `minmax(0, 1fr) ${rightTab === 'ai_vision' ? '432px' : '356px'}` : 'minmax(0, 1fr)',
            overflow: 'hidden',
          }}
        >
          {/* Full-Viewport Chart Canvas (NO centered popup, NO cramped cards underneath) */}
          <div
            ref={chartStageRef}
            style={{
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              background: 'var(--bg-elev)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              padding: '6px 10px 4px',
            }}
          >
            {chartTab === 'kline' && tech?.klines?.length ? (
              <InteractiveKlineChart
                secid={target?.secid}
                title={`${target?.name} (${target?.secuCode})`}
                klines={tech.klines}
                timeframe={timeframe}
                onChangeTimeframe={(tf) => setTimeframe(tf)}
                loadingTimeframe={loading}
                currencySymbol={currencySymbol(target?.currency)}
                resistances={tech.levels?.resistances}
                supports={tech.levels?.supports}
                poc={tech.levels?.volumeProfile?.poc}
                volumeProfileBins={tech.levels?.volumeProfile?.bins}
                turtleStop2N={tech.levels?.turtleStop2N}
                trendlines={tech.trendlines}
                tradeMarkers={tech.tradeMarkers}
                initialDrawings={tech.drawings}
                initialDrawingAlerts={tech.drawingAlerts}
                botPriceAlerts={(watchState?.alertsStore?.alerts || [])
                  .filter((a) => a.secid === target?.secid && (a.condition === 'price_above' || a.condition === 'price_below') && a.enabled)
                  .map((a) => ({ id: a.id, price: a.threshold, condition: a.condition as 'price_above' | 'price_below', note: a.note }))}
                onAddBotPriceAlert={(price, cond) =>
                  target?.secid && addPriceAlertQuick({ secid: target.secid, name: target.name, price, condition: cond })
                }
                onDeleteBotPriceAlert={(id) => deleteWatchAlertQuick(id)}
                onToast={onToast}
                fillHeight
                hideFullscreenBtn
              />
            ) : (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                {dossier?.intraday?.available ? (
                  <IntradayVolumeChart
                    intraday={dossier.intraday}
                    preClose={dossier.intraday?.preClose}
                    pct={ind?.pct}
                    currencySymbol={currencySymbol(target?.currency)}
                    fillHeight
                    interactive
                  />
                ) : (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    {t('当前市场休市或该海外品种暂无分时流，可切换「全屏 K 线」并查看 15m / 1m 分钟结构。', 'Intraday stream unavailable; switch to K-Line 15m/1m view.')}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Collapsible Right Intelligence Drawer (Only visible when user requests Details) */}
          {rightDrawerOpen && (
            <div
              style={{
                borderLeft: '1px solid var(--border)',
                background: 'var(--bg-sidebar)',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                overflow: 'hidden',
              }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', borderBottom: '1px solid var(--border)', padding: 5, gap: 3 }}>
                {[
                  { id: 'ai_vision', label: t('AI识图', 'Vision') },
                  { id: 'book', label: t('盘口', 'Book') },
                  { id: 'tech', label: t('点位', 'Levels') },
                  { id: 'anomaly', label: t('异动', 'Anom') },
                  { id: 'library', label: t('三库', '3-Libs') },
                  { id: 'alert', label: t('预警', 'Alert') },
                ].map((tb) => (
                  <button
                    key={tb.id}
                    type="button"
                    className={`btn btn-sm ${rightTab === tb.id ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ fontSize: 11, padding: '4px 2px', justifyContent: 'center' }}
                    onClick={() => setRightTab(tb.id as any)}
                  >
                    {tb.label}
                  </button>
                ))}
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: rightTab === 'book' ? 6 : 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {rightTab === 'ai_vision' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 9, flex: 1, minHeight: 0 }}>
                    {/* 顶部操作条：重新截屏识图 + 可选转入台账正式研判 */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={visionLoading}
                        onClick={() => runLiveChartVision('请重新截取当前画面，解读最新走势形态、量价信号与关键支撑压力位。', true)}
                      >
                        {visionLoading ? <Loader2 size={12} className="spin" /> : <Camera size={12} />}
                        {t('实时截屏识图', 'Capture & Analyze')}
                      </button>
                      {onQuickAnalyzeStock && target && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{ fontSize: 11 }}
                          onClick={() => {
                            onClose();
                            onQuickAnalyzeStock(`${target.name} (${target.secuCode})`);
                          }}
                          title="转入「深度复盘与台账」发起完整联网研判并建档"
                        >
                          {t('转入台账深度研判', 'Full Ledger Report')} <ArrowUpRight size={11} />
                        </button>
                      )}
                    </div>

                    {/* 当前截屏预览 */}
                    {visionSnapshot && (
                      <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)', background: 'var(--bg-soft)' }}>
                        <img
                          src={visionSnapshot}
                          alt="实时K线截屏"
                          style={{ width: '100%', maxHeight: 132, objectFit: 'cover', display: 'block' }}
                        />
                        <div style={{ padding: '4px 8px', fontSize: 10.5, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                          <span>已捕获实时画布 ({chartTab === 'intraday' ? '分时' : timeframe})</span>
                          <span>切换周期或画线后可点上方重拍</span>
                        </div>
                      </div>
                    )}

                    {/* 4 枚快捷追问芯片 */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {[
                        '当前 K 线形态与量价强弱？',
                        '关键支撑/压力与 2N 防守位？',
                        '有无顶底背离或高危见顶信号？',
                        '结合三库研判/异动红线复核',
                      ].map((chip) => (
                        <button
                          key={chip}
                          type="button"
                          className="btn btn-sm"
                          disabled={visionLoading}
                          style={{ fontSize: 10.5, padding: '3px 7px', height: 'auto' }}
                          onClick={() => runLiveChartVision(chip, true)}
                        >
                          {chip}
                        </button>
                      ))}
                    </div>

                    {/* 对话解读消息流 */}
                    <div style={{ flex: 1, minHeight: 180, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {visionMessages.length === 0 && !visionLoading && (
                        <div className="panel" style={{ padding: 12, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                          <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--text)' }}>
                            原地实时识图解盘（不离开全屏 K 线）
                          </div>
                          <div>
                            点击「实时截屏识图」或下方快捷问题，系统会自动捕获左侧当前 K 线画布（含均线、6流派点位、筹码峰、趋势线、自定义画线与策略 B/S 点），结合最近 60 根真实量价数据实时解读。
                          </div>
                        </div>
                      )}

                      {visionMessages.map((msg) => (
                        <div
                          key={msg.id}
                          style={{
                            padding: '9px 10px',
                            borderRadius: 8,
                            border: '1px solid var(--border)',
                            background: msg.role === 'user' ? 'var(--navy-soft)' : 'var(--bg-elev)',
                            fontSize: 12,
                            lineHeight: 1.62,
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, fontSize: 10.5, color: 'var(--text-muted)' }}>
                            <strong style={{ color: msg.role === 'user' ? 'var(--navy)' : 'var(--teal)' }}>
                              {msg.role === 'user' ? '我的提问' : `AI 识图解盘 · ${msg.providerLabel || ''}`}
                            </strong>
                            <span>
                              {msg.createdAt}
                              {msg.latencyMs ? ` · ${(msg.latencyMs / 1000).toFixed(1)}s` : ''}
                            </span>
                          </div>
                          {msg.visionNotice && (
                            <div
                              style={{
                                fontSize: 10.5,
                                padding: '4px 7px',
                                borderRadius: 5,
                                marginBottom: 6,
                                background: msg.visionMode === 'multimodal' ? 'var(--teal-soft)' : 'var(--bg-soft)',
                                color: msg.visionMode === 'multimodal' ? 'var(--teal)' : 'var(--text-secondary)',
                              }}
                            >
                              {msg.visionMode === 'multimodal' ? '👁️ ' : '📊 '}
                              {msg.visionNotice}
                            </div>
                          )}
                          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text)' }}>
                            {msg.content}
                          </div>
                          {msg.disclaimer && (
                            <div style={{ marginTop: 6, paddingTop: 5, borderTop: '1px dashed var(--border)', fontSize: 10, color: 'var(--text-muted)' }}>
                              {msg.disclaimer}
                            </div>
                          )}
                        </div>
                      ))}

                      {visionLoading && (
                        <div className="panel" style={{ padding: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                          <Loader2 size={14} className="spin" />
                          <span>正在截屏识图并交叉核对实时量价与 6 流派点位...</span>
                        </div>
                      )}

                      {visionError && !visionLoading && (
                        <div style={{ padding: 8, borderRadius: 6, background: 'var(--crimson-soft)', color: 'var(--crimson)', fontSize: 11.5 }}>
                          {visionError}
                        </div>
                      )}
                    </div>

                    {/* 底部自由追问输入 */}
                    <div style={{ display: 'flex', gap: 6, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                      <input
                        className="input"
                        style={{ flex: 1, height: 32, fontSize: 12 }}
                        placeholder="针对当前走势继续追问（回车发送，自动带图）..."
                        value={visionQuestion}
                        disabled={visionLoading}
                        onChange={(e) => setVisionQuestion(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey && visionQuestion.trim()) {
                            e.preventDefault();
                            runLiveChartVision();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={visionLoading || !visionQuestion.trim()}
                        onClick={() => runLiveChartVision()}
                      >
                        <Send size={12} />
                      </button>
                    </div>
                  </div>
                )}

                {rightTab === 'book' && target?.secid && (
                  <OrderBookPanel secid={target.secid} stockName={target.name} />
                )}

                {rightTab === 'tech' && tech && (
                  <>
                    {(tech.triggeredAlerts || []).length > 0 && (
                      <div style={{ padding: 10, borderRadius: 8, background: 'var(--crimson-soft)', border: '1px solid color-mix(in srgb, var(--crimson) 35%, transparent)' }}>
                        <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--crimson)', marginBottom: 4 }}>
                          已触发技术高点 / 破位预警 ({tech.triggeredAlerts.length})
                        </div>
                        {tech.triggeredAlerts.map((a: any, i: number) => (
                          <div key={i} style={{ fontSize: 11.5, marginBottom: 4, lineHeight: 1.45 }}>
                            <b>{a.ruleName}</b>：{a.actionAdvice}
                          </div>
                        ))}
                      </div>
                    )}

                    <div>
                      <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6, color: 'var(--crimson)' }}>
                        {t('上方压力位 R1–R3', 'Resistance Levels R1–R3')}
                      </div>
                      {(tech.levels?.resistances || []).slice(0, 4).map((lv: any) => (
                        <div key={lv.code} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 8px', borderRadius: 6, background: 'var(--bg-soft)', marginBottom: 4, fontSize: 11.5 }}>
                          <span><b>{lv.code}</b> {lv.primaryLabel}</span>
                          <span className="mono num" style={{ fontWeight: 700 }}>
                            {formatPrice(lv.price, target?.currency)} ({lv.distPct > 0 ? '+' : ''}{lv.distPct}%)
                          </span>
                        </div>
                      ))}
                    </div>

                    <div>
                      <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6, color: 'var(--emerald)' }}>
                        {t('下方支撑位 S1–S3', 'Support Levels S1–S3')}
                      </div>
                      {(tech.levels?.supports || []).slice(0, 4).map((lv: any) => (
                        <div key={lv.code} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 8px', borderRadius: 6, background: 'var(--bg-soft)', marginBottom: 4, fontSize: 11.5 }}>
                          <span><b>{lv.code}</b> {lv.primaryLabel}</span>
                          <span className="mono num" style={{ fontWeight: 700 }}>
                            {formatPrice(lv.price, target?.currency)} ({lv.distPct}%)
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {rightTab === 'anomaly' && (
                  <>
                    {anomaly ? (
                      <div className="panel" style={{ padding: 10 }}>
                        <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>
                          {t('交易所严重异动偏离测算（卡片174）', 'Exchange Severe Anomaly Meter')}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 8 }}>
                          {anomaly.board} · {t('对照基准', 'Benchmark')}: {anomaly.benchName}
                        </div>
                        <div style={{ marginBottom: 8 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
                            <span>10日偏离 (+100%红线)</span>
                            <b className="mono" style={{ color: anomaly.dev10dPct >= 85 ? 'var(--crimson)' : 'var(--text)' }}>
                              {anomaly.dev10dPct}% (余 {anomaly.gapTo100Pct}%)
                            </b>
                          </div>
                          <div style={{ height: 6, borderRadius: 4, background: 'var(--bg-soft)', overflow: 'hidden', marginTop: 3 }}>
                            <div style={{ width: `${Math.min(100, Math.max(2, anomaly.progress10Pct))}%`, height: '100%', background: anomaly.dev10dPct >= 85 ? 'var(--crimson)' : 'var(--amber)' }} />
                          </div>
                        </div>
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
                            <span>30日偏离 (+200%红线)</span>
                            <b className="mono">{anomaly.dev30dPct}% (余 {anomaly.gapTo200Pct}%)</b>
                          </div>
                          <div style={{ height: 6, borderRadius: 4, background: 'var(--bg-soft)', overflow: 'hidden', marginTop: 3 }}>
                            <div style={{ width: `${Math.min(100, Math.max(2, anomaly.progress30Pct))}%`, height: '100%', background: anomaly.dev30dPct >= 170 ? 'var(--crimson)' : 'var(--navy)' }} />
                          </div>
                        </div>
                        <div style={{ marginTop: 8, fontSize: 11.5, fontWeight: 600, color: anomaly.riskLevel === 'triggered' ? 'var(--crimson)' : 'var(--text-secondary)' }}>
                          {anomaly.statusText}
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>
                        {CRYPTO_ENABLED
                          ? t('非 A 股全球标的，不受沪深交易所 10日/30日严重异动停牌限制。', 'Not subject to A-share severe anomaly rules.')
                          : t('非 A 股全球股市或大宗期货，不受沪深交易所 10日/30日严重异动停牌限制。', 'Not subject to A-share severe anomaly rules.')}
                      </div>
                    )}

                    <div>
                      <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>
                        {t('近期异动 / 监管 / 风险提示公告', 'Recent Anomaly & Risk Filings')}
                      </div>
                      {(dossier?.announcements || []).length > 0 ? (
                        dossier.announcements.map((a: any, idx: number) => (
                          <div key={idx} style={{ padding: '6px 8px', borderRadius: 6, background: 'var(--bg-soft)', marginBottom: 5, fontSize: 11.5 }}>
                            <div style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>{a.date}</div>
                            <a href={a.url || '#'} target="_blank" rel="noreferrer" style={{ color: 'var(--navy)', fontWeight: 600 }}>
                              {a.title}
                            </a>
                          </div>
                        ))
                      ) : (
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          {t('近期无异常波动或停牌核查公告。', 'No recent anomaly filings.')}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {rightTab === 'library' && (
                  <>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
                        <BookOpen size={13} color="var(--navy)" /> {t('关联台账研判假设', 'Linked Research Judgments')} ({links?.judgments?.length || 0})
                      </div>
                      {(links?.judgments || []).length > 0 ? (
                        links.judgments.map((j: any) => (
                          <div
                            key={j.id}
                            className="panel"
                            style={{ padding: 8, marginBottom: 6, cursor: 'pointer' }}
                            onClick={() => {
                              if (onOpenEntity) {
                                onClose();
                                onOpenEntity({ kind: 'judgment', id: j.id });
                              }
                            }}
                          >
                            <div style={{ fontWeight: 700, fontSize: 12 }}>{j.title}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{j.date} · {j.direction} · {j.status}</div>
                            {j.invalidation && (
                              <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 4 }}>
                                {t('失效条件', 'Invalidation')}: {j.invalidation}
                              </div>
                            )}
                          </div>
                        ))
                      ) : (
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          {t('台账中暂无该标的研判记录，可点上方「AI 研判」一键建档。', 'No linked judgment yet.')}
                        </div>
                      )}
                    </div>

                    <div>
                      <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>
                        {t('关联行业前沿认知卡', 'Linked Industry Cognition')} ({links?.cognitionCards?.length || 0})
                      </div>
                      {(links?.cognitionCards || []).map((c: any) => (
                        <div
                          key={c.id}
                          className="panel"
                          style={{ padding: 8, marginBottom: 6, cursor: 'pointer' }}
                          onClick={() => {
                            if (onOpenEntity) {
                              onClose();
                              onOpenEntity({ kind: 'cognition', id: c.id });
                            }
                          }}
                        >
                          <div style={{ fontWeight: 700, fontSize: 11.5 }}>[{c.id}] {c.title}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 3 }}>{c.facts}</div>
                        </div>
                      ))}
                    </div>

                    {links?.tradeHistory && (
                      <div className="panel" style={{ padding: 8, background: 'var(--bg-soft)' }}>
                        <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4 }}>
                          {t('我的交易账本记录', 'My Trade Ledger History')}
                        </div>
                        {links.tradeHistory.openPosition && (
                          <div style={{ fontSize: 11.5, marginBottom: 4 }}>
                            {t('当前持仓', 'Open Pos')}: <b>{links.tradeHistory.openPosition.shares}</b> · {t('成本', 'Cost')} {links.tradeHistory.openPosition.avgCost}
                          </div>
                        )}
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {t('历史成交笔数', 'Recorded trades')}: {links.tradeHistory.recentTrades?.length || 0}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {rightTab === 'alert' && (
                  <div className="panel" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 9 }}>
                    <div style={{ fontWeight: 700, fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <BellPlus size={14} color="var(--navy)" /> {t('让 Bot 帮我盯住这只标的', 'Set Bot Watch Alert')}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      {t('触发后 Bot 会立即弹出提醒气泡、写入聊天流并同步到 Windows 桌面宠物。', 'Bot pushes instant alerts when triggered.')}
                    </div>
                    <div>
                      <label className="field-label">{t('触发条件', 'Condition')}</label>
                      <select className="select" value={alertCond} onChange={(e) => setAlertCond(e.target.value as any)}>
                        <option value="price_above">{t('价格突破上限 ≥', 'Price >= Target')}</option>
                        <option value="price_below">{t('价格跌破下限 ≤', 'Price <= Target')}</option>
                        <option value="pct_above">{t('盘中涨幅达到 ≥ (%)', 'Intraday Change >= %')}</option>
                        <option value="pct_below">{t('盘中跌幅触及 ≤ (%)', 'Intraday Change <= %')}</option>
                        <option value="vol_ratio_above">{t('盘中量比放大 ≥ (倍)', 'Volume Ratio >= x')}</option>
                      </select>
                    </div>
                    <div>
                      <label className="field-label">{t('目标阈值', 'Threshold')}</label>
                      <input
                        className="input mono"
                        type="number"
                        step="any"
                        value={alertThreshold}
                        onChange={(e) => setAlertThreshold(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="field-label">{t('提醒备注（如止损/突破买点）', 'Note')}</label>
                      <input
                        className="input"
                        value={alertNote}
                        onChange={(e) => setAlertNote(e.target.value)}
                        placeholder={t('例如：突破前高减仓 / 跌破MA20止损', 'e.g. Breakout / Stop-loss')}
                      />
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, cursor: 'pointer' }}>
                      <input type="checkbox" checked={alertWebhook} onChange={(e) => setAlertWebhook(e.target.checked)} />
                      <span>{t('同时推送到 Webhook', 'Also forward to Webhook')}</span>
                    </label>
                    <button type="button" className="btn btn-primary" disabled={savingAlert} onClick={handleCreateBotAlert}>
                      {savingAlert ? <Loader2 size={14} className="spin" /> : <BellPlus size={14} />}
                      {t('保存并交给 Bot 实时盯盘', 'Save Bot Watch')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Ultra-slim 26px Bottom Telemetry Strip (Preserves max vertical K-line canvas space) */}
      {ind && (
        <div
          className="mono num"
          style={{
            height: 26,
            flexShrink: 0,
            padding: '0 12px',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-sidebar)',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            fontSize: 11,
            color: 'var(--text-secondary)',
            overflowX: 'auto',
            whiteSpace: 'nowrap',
          }}
        >
          <span>MA5/20: <b style={{ color: 'var(--text)' }}>{ind.ma5 ?? '-'} / {ind.ma20 ?? '-'}</b></span>
          {ind.ma5BiasPct != null && (
            <span>MA5乖离: <b style={{ color: Math.abs(ind.ma5BiasPct) >= 8 ? 'var(--crimson)' : 'var(--text)' }}>{ind.ma5BiasPct > 0 ? '+' : ''}{ind.ma5BiasPct}%</b></span>
          )}
          <span>RSI(6/14): <b style={{ color: 'var(--text)' }}>{ind.rsi6 ?? '-'} / {ind.rsi14 ?? '-'}</b></span>
          <span>MACD柱: <b style={{ color: 'var(--text)' }}>{ind.macdHist ?? '-'}</b></span>
          <span>5日/20日: <b style={{ color: pctColor(ind.ret5dPct) }}>{formatPct(ind.ret5dPct)}</b> / <b style={{ color: pctColor(ind.ret20dPct) }}>{formatPct(ind.ret20dPct)}</b></span>
          <span>5日量比: <b style={{ color: 'var(--text)' }}>{ind.volRatio5d != null ? `${ind.volRatio5d}x` : '--'}</b></span>
          <span>ATR(14): <b style={{ color: 'var(--text)' }}>{ind.atrPct != null ? `${ind.atrPct}%` : '--'}</b></span>
          {tech?.levels?.rewardRiskRatio != null && (
            <span>R1/S1盈亏比: <b style={{ color: 'var(--teal)' }}>{tech.levels.rewardRiskRatio}:1</b></span>
          )}
          {tech?.levels?.volumeProfile?.poc != null && (
            <span>POC筹码峰: <b style={{ color: 'var(--navy)' }}>{formatPrice(tech.levels.volumeProfile.poc, target?.currency)}</b></span>
          )}
          {tech?.levels?.turtleStop2N != null && (
            <span>2N止损: <b style={{ color: 'var(--amber)' }}>{formatPrice(tech.levels.turtleStop2N, target?.currency)}</b></span>
          )}
        </div>
      )}

      {target && (
        <TradePlanCardModal
          open={showPlanCard}
          seed={{
            code: target.code || target.secuCode,
            name: target.name,
            entryPrice: ind?.price != null ? Number(ind.price.toFixed(2)) : '',
            stopLossPrice:
              tech?.levels?.turtleStop2N && ind?.price && tech.levels.turtleStop2N < ind.price
                ? Number(tech.levels.turtleStop2N.toFixed(2))
                : ind?.price
                ? Number((ind.price * 0.95).toFixed(2))
                : '',
            targetPrice: tech?.levels?.resistances?.[0]?.price ? Number(tech.levels.resistances[0].price.toFixed(2)) : '',
          }}
          onClose={() => setShowPlanCard(false)}
          onToast={onToast}
        />
      )}
    </div>
  );
};
