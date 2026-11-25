import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Award,
  BookOpen,
  Calculator,
  Calendar,
  Camera,
  CheckCircle2,
  Crosshair,
  FileSpreadsheet,
  Flame,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Sliders,
  Sparkles,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type {
  AiProvider,
  AiSafeConfig,
  EntityRef,
  ExecutionSlotStateResponse,
  TradeLedgerAnalytics,
  TradeRecord,
  WorkspaceData,
} from '../types';
import { AiProviderPicker, isAiProviderReady } from '../components/AiProviderPicker';
import { TradePlanCardModal } from '../components/TradePlanCardModal';
import { ExecutionSlotModal } from '../components/ExecutionSlotModal';

interface TradeLedgerPageProps {
  workspace: WorkspaceData;
  aiConfig: AiSafeConfig | null;
  onOpenEntity: (ref: EntityRef) => void;
  onOpenTechnical: (secidOrQuery: string) => void;
  onOpenAiSettings: () => void;
  onToast: (msg: string) => void;
}

function pnlColor(v: number | null | undefined) {
  if (v == null || v === 0) return 'var(--text-secondary)';
  return v > 0 ? '#dc2626' : '#16a34a';
}

function fmtMoney(v: number | null | undefined, currency = 'CNY') {
  if (v == null) return '--';
  const sym = currency === 'USD' ? '$' : currency === 'HKD' ? 'HK$' : '¥';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}${sym}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const TradeLedgerPage: React.FC<TradeLedgerPageProps> = ({
  workspace,
  aiConfig,
  onOpenEntity,
  onOpenTechnical,
  onOpenAiSettings,
  onToast,
}) => {
  const { t } = useI18n();
  const [data, setData] = useState<TradeLedgerAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // 录单/导入模式弹窗
  const [modalMode, setModalMode] = useState<'none' | 'manual' | 'csv' | 'ai' | 'settings'>('none');
  const [showPlanCard, setShowPlanCard] = useState(false);
  const [showExecSlot, setShowExecSlot] = useState(false);
  const [execSlotState, setExecSlotState] = useState<ExecutionSlotStateResponse | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<AiProvider>(aiConfig?.provider || 'codex_cli');
  const imgInputRef = useRef<HTMLInputElement>(null);

  // 手动快录表单
  const [form, setForm] = useState({
    accountType: 'real' as 'real' | 'sim',
    date: new Date().toISOString().slice(0, 10),
    time: '10:05',
    code: '',
    name: '',
    marketKind: 'CN' as 'CN' | 'US' | 'HK',
    side: 'BUY' as 'BUY' | 'SELL',
    price: '',
    quantity: '',
    stopLossPrice: '',
    targetPrice: '',
    cardIds: '',
    themes: '',
    emotionTag: '按计划执行',
    planScore: '8',
    note: '',
  });
  const [saving, setSaving] = useState(false);

  // CSV 导入 & AI 截图导入状态
  const [csvText, setCsvText] = useState('');
  const [aiRawText, setAiRawText] = useState('');
  const [aiImageDataUrl, setAiImageDataUrl] = useState('');
  const [aiImageMime, setAiImageMime] = useState('image/png');
  const [parsingImport, setParsingImport] = useState(false);
  const [stagedTrades, setStagedTrades] = useState<TradeRecord[]>([]);

  // 账户设置表单
  const [settingsForm, setSettingsForm] = useState({
    accountCapital: '500000',
    commissionRate: '0.00025',
    maxSinglePct: '25',
    maxThemePct: '45',
  });

  // 月份日历筛选（默认当前年月）
  const [calMonth, setCalMonth] = useState(() => new Date().toISOString().slice(0, 7));

  useEffect(() => {
    if (aiConfig?.provider) setSelectedProvider(aiConfig.provider);
  }, [aiConfig?.provider]);

  useEffect(() => {
    api
      .getExecutionSlot()
      .then((res) => setExecSlotState(res))
      .catch(() => null);
  }, []);

  const loadAnalytics = useCallback(
    async (force = false) => {
      if (force) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await api.getTradeAnalytics(force);
        setData(res);
        setSettingsForm({
          accountCapital: String(res.settings.accountCapital),
          commissionRate: String(res.settings.commissionRate),
          maxSinglePct: String(res.settings.maxSinglePct),
          maxThemePct: String(res.settings.maxThemePct),
        });
      } catch (err: any) {
        onToast(`加载交易账本失败：${err.message}`);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [onToast]
  );

  useEffect(() => {
    loadAnalytics(false);
  }, [loadAnalytics]);

  const handleManualSubmit = async () => {
    if (!form.code.trim() || !Number(form.price) || !Number(form.quantity)) {
      onToast('请完整填写标的代码、成交价格和数量');
      return;
    }
    setSaving(true);
    try {
      await api.addTrades([
        {
          accountType: form.accountType,
          date: form.date,
          time: form.time,
          code: form.code.trim(),
          name: form.name.trim() || form.code.trim(),
          marketKind: form.marketKind,
          side: form.side,
          price: Number(form.price),
          quantity: Number(form.quantity),
          stopLossPrice: form.stopLossPrice ? Number(form.stopLossPrice) : null,
          targetPrice: form.targetPrice ? Number(form.targetPrice) : null,
          cardIds: form.cardIds
            .split(/[,，/\s]+/)
            .map((x) => x.trim())
            .filter(Boolean),
          themes: form.themes
            .split(/[,，/\s]+/)
            .map((x) => x.trim())
            .filter(Boolean),
          emotionTag: form.emotionTag,
          planScore: Number(form.planScore) || 8,
          note: form.note,
        },
      ]);
      onToast(`已录入 ${form.side === 'BUY' ? '买入' : '卖出'} ${form.name || form.code}，已自动重算 FIFO 盈亏、B/S 图表点位与归因矩阵！`);
      setModalMode('none');
      setForm((p) => ({ ...p, code: '', name: '', price: '', quantity: '', stopLossPrice: '', targetPrice: '', note: '' }));
      await loadAnalytics(false);
    } catch (err: any) {
      onToast(`录入失败：${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleParseCsv = async () => {
    setParsingImport(true);
    try {
      const res = await api.parseBrokerCsv(csvText);
      setStagedTrades(res.trades || []);
      onToast(`成功解析 ${res.trades.length} 条成交记录${res.errors.length ? `（跳过 ${res.errors.length} 行）` : ''}，请确认后批量入账`);
    } catch (err: any) {
      onToast(`CSV 解析失败：${err.message}`);
    } finally {
      setParsingImport(false);
    }
  };

  const handlePickImage = (file: File | undefined) => {
    if (!file) return;
    setAiImageMime(file.type || 'image/png');
    const reader = new FileReader();
    reader.onload = () => setAiImageDataUrl(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  const handleParseAi = async () => {
    if (!isAiProviderReady(aiConfig, selectedProvider)) {
      onToast('所选 AI 引擎尚未就绪，请先配置。');
      onOpenAiSettings();
      return;
    }
    setParsingImport(true);
    try {
      const res = await api.parseTradesWithAi({
        text: aiRawText,
        imageBase64: aiImageDataUrl,
        imageMimeType: aiImageMime,
        provider: selectedProvider,
      });
      setStagedTrades(res.trades || []);
      onToast(`AI（${res.model}）成功提取 ${res.trades.length} 条成交记录，请核对后入账！`);
    } catch (err: any) {
      onToast(`AI 识别交割单失败：${err.message}`);
    } finally {
      setParsingImport(false);
    }
  };

  const handleCommitStaged = async () => {
    if (!stagedTrades.length) return;
    setSaving(true);
    try {
      const res = await api.addTrades(stagedTrades);
      if (res.auditRecorded === false) {
        onToast(
          t(
            `已批量入账 ${stagedTrades.length} 条成交记录，但审计日志写入失败：${res.auditError || '磁盘写入受阻'}`,
            `Imported ${stagedTrades.length} trades, but audit trail write failed: ${res.auditError || 'disk error'}`
          )
        );
      } else {
        onToast(t(`已批量入账 ${stagedTrades.length} 条成交记录！`, `Imported ${stagedTrades.length} trades.`));
      }
      setStagedTrades([]);
      setCsvText('');
      setAiRawText('');
      setAiImageDataUrl('');
      setModalMode('none');
      await loadAnalytics(false);
    } catch (err: any) {
      onToast(`${t('入账失败：', 'Import failed: ')}${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const [pendingDeleteTradeId, setPendingDeleteTradeId] = useState<string | null>(null);

  const handleDeleteTrade = (id: string) => {
    setPendingDeleteTradeId(id);
  };

  const executeDeleteTrade = async () => {
    if (!pendingDeleteTradeId) return;
    const id = pendingDeleteTradeId;
    setPendingDeleteTradeId(null);
    try {
      const res = await api.deleteTrade(id);
      if (res.auditRecorded === false) {
        onToast(t(`已删除交易记录，但审计日志写入失败：${res.auditError || '磁盘受阻'}`, `Trade deleted, but audit log write failed: ${res.auditError || 'disk error'}`));
      } else {
        onToast(t('已删除交易记录并重算持仓与归因', 'Trade deleted and portfolio recalculated'));
      }
      await loadAnalytics(false);
    } catch (err: any) {
      onToast(`${t('删除失败：', 'Delete failed: ')}${err.message}`);
    }
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const res = await api.updateTradeSettings({
        accountCapital: Number(settingsForm.accountCapital) || 500000,
        commissionRate: Number(settingsForm.commissionRate) || 0.00025,
        maxSinglePct: Number(settingsForm.maxSinglePct) || 25,
        maxThemePct: Number(settingsForm.maxThemePct) || 45,
      });
      if (res.auditRecorded === false) {
        onToast(t(`已更新账户配置，但审计日志写入失败：${res.auditError || '磁盘受阻'}`, `Settings saved, but audit log write failed: ${res.auditError || 'disk error'}`));
      } else {
        onToast(t('已更新账户资金基准与风控集中度红线', 'Account risk settings updated'));
      }
      setModalMode('none');
      await loadAnalytics(false);
    } catch (err: any) {
      onToast(`${t('保存设置失败：', 'Failed to save settings: ')}${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // 构建月度 PnL 日历网格
  const calendarCells = useMemo(() => {
    const [yStr, mStr] = calMonth.split('-');
    const year = Number(yStr);
    const monthIdx = Number(mStr) - 1;
    if (!year || monthIdx < 0) return [];
    const firstDay = new Date(year, monthIdx, 1);
    const startPad = firstDay.getDay(); // 0=Sun
    const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
    const pnlByDate = new Map((data?.pnlCalendar || []).map((c) => [c.date, c]));
    const cells: { day: number | null; dateStr?: string; rec?: TradeLedgerAnalytics['pnlCalendar'][number] }[] = [];
    for (let i = 0; i < startPad; i++) cells.push({ day: null });
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ day: d, dateStr: ds, rec: pnlByDate.get(ds) });
    }
    return cells;
  }, [calMonth, data?.pnlCalendar]);

  const filteredTrades = useMemo(() => {
    const list = data?.trades || [];
    if (!selectedDay) return list;
    return list.filter((t) => t.date === selectedDay);
  }, [data?.trades, selectedDay]);

  if (loading && !data) {
    return (
      <div className="scroll-page" style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>
        <Loader2 size={22} className="spin" /> 正在加载交易账本、FIFO 持仓与方法论归因矩阵...
      </div>
    );
  }

  const kpi = data?.kpi;

  return (
    <div className="scroll-page" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 头部工具条 */}
      <div
        className="panel panel-pad"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          background: 'linear-gradient(120deg, var(--bg-elev) 0%, var(--emerald-soft) 100%)',
        }}
      >
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 7 }}>
            <Wallet size={18} color="var(--emerald)" />
            {t('实盘 / 模拟交易账本与交割单归因中心', 'Live & Sim Trade Ledger & Playbook Attribution')}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
            {t(
              'FIFO 精确盈亏 · 日内做T自动配对 · B/S点位直绘K线 · 卖后T+5/T+20卖飞/逃顶审计 · 方法论卡片实战胜率 & 坏习惯亏钱榜',
              'FIFO Realized P&L · Intraday Pairing · K-Line B/S Markers · Post-Exit Audit · Card Win-Rate & Mistake Cost'
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setModalMode('manual')}>
            <Plus size={14} /> {t('手动记一笔', 'Log Trade')}
          </button>
          <button type="button" className="btn btn-teal btn-sm" onClick={() => setShowPlanCard(true)}>
            <Calculator size={14} /> {t('A股交易计划卡', 'Position Plan Card')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowExecSlot(true)}
            title={t('可选用户自购券商官方 MiniQMT 本地合规插件槽位（默认关闭）', 'Optional local broker MiniQMT slot (disabled by default)')}
          >
            <Sliders size={14} /> MiniQMT ({execSlotState?.slot.miniqmt.enabled ? t('已开启', 'ON') : t('默认关闭', 'OFF')})
          </button>
          <button
            type="button"
            className="btn btn-teal btn-sm"
            onClick={() => {
              setStagedTrades([]);
              setModalMode('csv');
            }}
          >
            <FileSpreadsheet size={14} /> {t('券商 CSV 导入', 'Import CSV')}
          </button>
          <button
            type="button"
            className="btn btn-amber btn-sm"
            onClick={() => {
              setStagedTrades([]);
              setModalMode('ai');
            }}
          >
            <Camera size={14} /> {t('AI 截图/短信识别入账', 'AI Parse')}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setModalMode('settings')}>
            <Settings2 size={14} /> {t('资金与红线设置', 'Risk Settings')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={refreshing} onClick={() => loadAnalytics(true)}>
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> {t('刷新实盘价', 'Refresh')}
          </button>
        </div>
      </div>

      {/* 持仓止损触发红警条 */}
      {(data?.holdingStopAlerts || []).length > 0 && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 9,
            background: 'var(--crimson-soft)',
            border: '1px solid color-mix(in srgb, var(--crimson) 35%, transparent)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontSize: 12.5,
          }}
        >
          <div style={{ fontWeight: 700, color: 'var(--crimson)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={15} /> 持仓触破入场硬止损红线预警：
          </div>
          {data!.holdingStopAlerts.map((sa) => (
            <div key={sa.code}>
              • <strong>{sa.name} ({sa.code})</strong>：{sa.detail}
            </div>
          ))}
        </div>
      )}

      {/* 6 格核心机构级 KPI */}
      {kpi && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 10 }}>
          <div className="panel panel-pad" style={{ padding: '11px 13px' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>总盈亏（已实现+浮盈）</div>
            <div className="mono num" style={{ fontSize: 18, fontWeight: 800, marginTop: 3, color: pnlColor(kpi.totalPnl) }}>
              {fmtMoney(kpi.totalPnl)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              已实现 {fmtMoney(kpi.totalRealizedPnl)} · 浮盈 {fmtMoney(kpi.totalUnrealizedPnl)}
            </div>
          </div>

          <div className="panel panel-pad" style={{ padding: '11px 13px' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>胜率 / 盈亏比 (PF)</div>
            <div className="mono num" style={{ fontSize: 18, fontWeight: 800, marginTop: 3 }}>
              {kpi.winRatePct != null ? `${kpi.winRatePct}%` : '--'} / {kpi.profitFactor ?? '--'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              已平仓 {kpi.closedCount} 笔 · 均值 R={kpi.avgR ?? '--'}
            </div>
          </div>

          <div className="panel panel-pad" style={{ padding: '11px 13px' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>综合优势分 (Edge Score)</div>
            <div className="mono num" style={{ fontSize: 18, fontWeight: 800, marginTop: 3, color: 'var(--navy)' }}>
              {kpi.edgeScore} / 100
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              计划执行均分 {kpi.avgPlanScore} / 10
            </div>
          </div>

          <div className="panel panel-pad" style={{ padding: '11px 13px' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>当前仓位 / 市值</div>
            <div className="mono num" style={{ fontSize: 18, fontWeight: 800, marginTop: 3 }}>
              {kpi.positionRatioPct}%
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              持仓 {kpi.openHoldingsCount} 只 · ¥{kpi.totalMarketValue.toLocaleString()}
            </div>
          </div>

          <div className="panel panel-pad" style={{ padding: '11px 13px' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>日内「做T」净战绩</div>
            <div className="mono num" style={{ fontSize: 18, fontWeight: 800, marginTop: 3, color: pnlColor(kpi.dayTPnl) }}>
              {fmtMoney(kpi.dayTPnl)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              自动识别配对 {kpi.dayTCount} 笔做T
            </div>
          </div>

          <div className="panel panel-pad" style={{ padding: '11px 13px' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>违纪坏习惯亏钱成本</div>
            <div className="mono num" style={{ fontSize: 18, fontWeight: 800, marginTop: 3, color: kpi.totalMistakeCost > 0 ? '#dc2626' : 'var(--emerald)' }}>
              {kpi.totalMistakeCost > 0 ? `-¥${kpi.totalMistakeCost.toLocaleString()}` : '¥0'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Edgewonk Mistake Cost 计量
            </div>
          </div>
        </div>
      )}

      {/* 中部双栏：月度盈亏热力日历 + 在途持仓与同方向多标签集中度风控 */}
      <div className="grid-2" style={{ gap: 14, alignItems: 'start' }}>
        {/* 1. 月度盈亏日历（TradeZella 核心体验） */}
        <div className="panel panel-pad">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Calendar size={16} color="var(--amber)" /> 月度盈亏热力日历（PnL Calendar）
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {selectedDay && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedDay(null)}>
                  清除日期筛选 ({selectedDay})
                </button>
              )}
              <input
                type="month"
                className="input mono"
                style={{ width: 132, padding: '3px 7px', fontSize: 12 }}
                value={calMonth}
                onChange={(e) => setCalMonth(e.target.value)}
              />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, fontSize: 11, textAlign: 'center', marginBottom: 5, color: 'var(--text-muted)' }}>
            {['日', '一', '二', '三', '四', '五', '六'].map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 5 }}>
            {calendarCells.map((c, idx) => {
              if (!c.day) return <div key={`pad-${idx}`} />;
              const hasRec = Boolean(c.rec);
              const isPos = hasRec && c.rec!.pnl > 0;
              const isNeg = hasRec && c.rec!.pnl < 0;
              const isSelected = selectedDay === c.dateStr;
              return (
                <div
                  key={c.dateStr}
                  onClick={() => hasRec && setSelectedDay(isSelected ? null : c.dateStr!)}
                  style={{
                    minHeight: 52,
                    padding: '4px 5px',
                    borderRadius: 7,
                    cursor: hasRec ? 'pointer' : 'default',
                    background: isPos
                      ? 'rgba(220,38,38,0.12)'
                      : isNeg
                      ? 'rgba(22,163,74,0.12)'
                      : 'var(--bg-soft)',
                    border: isSelected
                      ? '2px solid var(--navy)'
                      : `1px solid ${isPos ? 'rgba(220,38,38,0.35)' : isNeg ? 'rgba(22,163,74,0.35)' : 'var(--border)'}`,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-muted)' }}>
                    <span>{c.day}</span>
                    {hasRec && <span className="mono">{c.rec!.count}笔</span>}
                  </div>
                  {hasRec && (
                    <div className="mono" style={{ fontSize: 10.5, fontWeight: 800, color: pnlColor(c.rec!.pnl), overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.rec!.pnl >= 0 ? '+' : ''}
                      {Math.round(c.rec!.pnl)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 2. 当前持仓 & 同方向多标签集中度红线（ai-mock-trade 5重钳制思想） */}
        <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ShieldAlert size={16} color="var(--navy)" /> 当前在途持仓 & 同方向集中度红线
            </span>
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
              单股上限 {data?.settings.maxSinglePct}% · 同主题上限 {data?.settings.maxThemePct}%
            </span>
          </div>

          {(data?.holdings || []).length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5, background: 'var(--bg-soft)', borderRadius: 8 }}>
              当前无在途持仓。点击右上角「手动记一笔」或「券商 CSV / AI 截图导入」即可自动核算持仓成本、止损线并直接画到 K 线图上！
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>标的 / 主题</th>
                    <th>股数 / 仓位</th>
                    <th>成本 / 现价</th>
                    <th>浮盈</th>
                    <th>止损距离</th>
                    <th>K线</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.holdings.map((h) => (
                    <tr key={h.code}>
                      <td>
                        <strong>{h.name}</strong>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {h.code} {h.themes.length ? `· ${h.themes.join('/')}` : ''}
                        </div>
                      </td>
                      <td className="mono">
                        <div>{h.quantity}</div>
                        <span className={`badge ${h.exceedsSingleCap ? 'badge-crimson' : 'badge-muted'}`} style={{ fontSize: 10 }}>
                          {h.weightPct}%{h.exceedsSingleCap ? ' 超红线!' : ''}
                        </span>
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {h.avgCost} → <strong>{h.currentPrice}</strong>
                      </td>
                      <td className="mono" style={{ color: pnlColor(h.unrealizedPnl), fontWeight: 700 }}>
                        <div>{h.unrealizedPct >= 0 ? '+' : ''}{h.unrealizedPct}%</div>
                        <div style={{ fontSize: 11 }}>{fmtMoney(h.unrealizedPnl, h.currency)}</div>
                      </td>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {h.stopLossPrice ? (
                          <span style={{ color: h.hitStop ? 'var(--crimson)' : 'var(--text-secondary)', fontWeight: h.hitStop ? 800 : 500 }}>
                            {h.stopLossPrice} ({h.stopDistPct != null ? `${h.stopDistPct}%` : '-'})
                          </span>
                        ) : (
                          <span style={{ color: 'var(--amber)' }}>未设止损</span>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: '2px 6px' }}
                          onClick={() => onOpenTechnical(h.secid || h.code)}
                          title="在技术实验室 K 线图上查看 B/S 点位与支撑压力"
                        >
                          <Crosshair size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 同方向多标签集中度暴露条 */}
          {(data?.themeExposure || []).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)' }}>
                同方向 / 同主题持仓集中度暴露（防隐性押注同一因子）：
              </div>
              {data!.themeExposure.map((te) => (
                <div key={te.theme} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ width: 92, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {te.theme}
                  </span>
                  <div className="cred-bar-track" style={{ flex: 1 }}>
                    <div
                      className="cred-bar-fill"
                      style={{
                        width: `${Math.min(100, te.weightPct)}%`,
                        background: te.exceedsThemeCap ? '#dc2626' : '#2563eb',
                      }}
                    />
                  </div>
                  <span className="mono" style={{ width: 76, textAlign: 'right', color: te.exceedsThemeCap ? '#dc2626' : 'var(--text)', fontWeight: 700 }}>
                    {te.weightPct}%{te.exceedsThemeCap ? ' ⚠' : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 归因双雄：Playbook 方法论卡片实盘胜率矩阵 + Edgewonk 坏习惯亏钱榜 */}
      <div className="grid-2" style={{ gap: 14 }}>
        <div className="panel panel-pad">
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Award size={16} color="var(--emerald)" /> Playbook 方法论卡片实战胜率与期望归因
          </div>
          {(data?.cardAttribution || []).length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>暂无已平仓交易归因数据（录单时标注触发卡片编号如 067/159/190 即可自动统计）</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>方法论卡片</th>
                  <th>平仓笔数</th>
                  <th>胜率</th>
                  <th>平均 R 倍数</th>
                  <th>累计盈亏</th>
                </tr>
              </thead>
              <tbody>
                {data!.cardAttribution.map((c) => (
                  <tr key={c.cardId}>
                    <td>
                      {c.cardId !== '未标卡' ? (
                        <button
                          type="button"
                          className="ref-chip ref-chip-method"
                          onClick={() => onOpenEntity({ kind: 'methodology', id: c.cardId })}
                        >
                          卡{c.cardId} · {c.cardTitle.slice(0, 18)}
                        </button>
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{c.cardTitle}</span>
                      )}
                    </td>
                    <td className="mono">{c.count}</td>
                    <td className="mono" style={{ fontWeight: 700 }}>{c.winRatePct}%</td>
                    <td className="mono">{c.avgR != null ? `${c.avgR}R` : '--'}</td>
                    <td className="mono" style={{ color: pnlColor(c.totalPnl), fontWeight: 700 }}>
                      {fmtMoney(c.totalPnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel panel-pad">
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Flame size={16} color="var(--crimson)" /> 行为错因成本榜（Edgewonk Mistake Cost）
          </div>
          {(data?.mistakeAttribution || []).length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>暂无平仓交易行为标签归因</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>交易行为 / 情绪标签</th>
                  <th>笔数</th>
                  <th>胜率</th>
                  <th>累计净盈亏</th>
                  <th>纯亏损成本</th>
                </tr>
              </thead>
              <tbody>
                {data!.mistakeAttribution.map((m) => (
                  <tr key={m.tag}>
                    <td>
                      <span className={`badge ${m.isDiscipline ? 'badge-emerald' : 'badge-crimson'}`}>
                        {m.tag}
                      </span>
                    </td>
                    <td className="mono">{m.count}</td>
                    <td className="mono">{m.winRatePct}%</td>
                    <td className="mono" style={{ color: pnlColor(m.totalPnl), fontWeight: 700 }}>
                      {fmtMoney(m.totalPnl)}
                    </td>
                    <td className="mono" style={{ color: m.lossCost > 0 ? '#dc2626' : 'var(--text-muted)' }}>
                      {m.lossCost > 0 ? `-¥${m.lossCost.toLocaleString()}` : '¥0'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* 全量交易流水明细表（含做T标识、卖飞/逃顶 T+1/T+5/T+20 审计、MFE/MAE、一键看 K 线 B/S 点位） */}
      <div className="panel">
        <div className="panel-header">
          <h3 className="panel-title">
            <BookOpen size={16} color="var(--navy)" /> 交易执行流水与卖后择时审计（{filteredTrades.length} 条{selectedDay ? ` · 筛选 ${selectedDay}` : ''}）
          </h3>
          {selectedDay && (
            <button type="button" className="btn btn-sm" onClick={() => setSelectedDay(null)}>
              显示全部日期
            </button>
          )}
        </div>
        {filteredTrades.length === 0 ? (
          <div className="panel-pad" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            尚无交易记录。你可以点击「手动记一笔」「券商 CSV 导入」或「AI 截图识别入账」建立你的实盘/模拟账本！
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>日期 / 方向</th>
                  <th>标的</th>
                  <th>成交价 × 数量 (费用)</th>
                  <th>FIFO 盈亏 / R倍数</th>
                  <th>持仓极值 MFE/MAE</th>
                  <th>卖后 T+5 / T+20 审计</th>
                  <th>卡片 & 行为标签</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredTrades.map((t) => (
                  <tr key={t.id}>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      <div>{t.date} {t.time}</div>
                      <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                        <span className={`badge ${t.side === 'BUY' ? 'badge-crimson' : 'badge-teal'}`} style={{ fontSize: 10 }}>
                          {t.side === 'BUY' ? '买入 B' : '卖出 S'}
                        </span>
                        {t.isDayT && (
                          <span className="badge badge-violet" style={{ fontSize: 10 }}>
                            日内做T
                          </span>
                        )}
                        {t.accountType === 'sim' && (
                          <span className="badge badge-muted" style={{ fontSize: 10 }}>
                            模拟
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <strong>{t.name}</strong>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {t.code} {t.themes.length ? `· ${t.themes.join('/')}` : ''}
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      <div>
                        {t.price} × {t.quantity}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>费 {t.fee}</div>
                    </td>
                    <td className="mono">
                      {t.side === 'SELL' && t.realizedPnl != null ? (
                        <>
                          <div style={{ color: pnlColor(t.realizedPnl), fontWeight: 700 }}>
                            {fmtMoney(t.realizedPnl, t.currency)} ({t.returnPct! >= 0 ? '+' : ''}{t.returnPct}%)
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {t.holdingDays}天 {t.rMultiple != null ? `· ${t.rMultiple}R` : ''}
                          </div>
                        </>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {t.stopLossPrice ? `止损 ${t.stopLossPrice}` : '建仓'}
                        </span>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {t.mfePct != null ? (
                        <>
                          <span style={{ color: '#dc2626' }}>+{t.mfePct}%</span> /{' '}
                          <span style={{ color: '#16a34a' }}>{t.maePct}%</span>
                        </>
                      ) : (
                        '--'
                      )}
                    </td>
                    <td style={{ fontSize: 11.5 }}>
                      {t.exitAudit ? (
                        <div>
                          <span
                            className={`badge ${
                              t.exitAudit.verdict === '神级逃顶' || t.exitAudit.verdict === '有效止盈/避险'
                                ? 'badge-emerald'
                                : t.exitAudit.verdict === '严重卖飞'
                                ? 'badge-crimson'
                                : 'badge-amber'
                            }`}
                            style={{ fontSize: 10.5 }}
                          >
                            {t.exitAudit.verdict}
                          </span>
                          <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
                            T+5: {t.exitAudit.afterT5Pct != null ? `${t.exitAudit.afterT5Pct}%` : '-'} · T+20:{' '}
                            {t.exitAudit.afterT20Pct != null ? `${t.exitAudit.afterT20Pct}%` : '-'}
                          </div>
                        </div>
                      ) : (
                        '--'
                      )}
                    </td>
                    <td style={{ fontSize: 11.5 }}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 2 }}>
                        <span className={`badge ${t.emotionTag === '按计划执行' ? 'badge-emerald' : 'badge-amber'}`} style={{ fontSize: 10 }}>
                          {t.emotionTag}
                        </span>
                        {t.cardIds.map((cid) => (
                          <button
                            key={cid}
                            type="button"
                            className="ref-chip ref-chip-method"
                            onClick={() => onOpenEntity({ kind: 'methodology', id: cid })}
                          >
                            卡{cid}
                          </button>
                        ))}
                      </div>
                      {t.note && <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{t.note}</div>}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: '2px 5px' }}
                          onClick={() => onOpenTechnical(t.code)}
                          title="在 K 线图查看 B/S 点位"
                        >
                          <Crosshair size={12} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: '2px 5px' }}
                          onClick={() => handleDeleteTrade(t.id)}
                          title="删除"
                        >
                          <Trash2 size={12} color="var(--crimson)" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ================================================================= */}
      {/* 弹窗：手动录单 / CSV 导入 / AI 截图识别导入 / 账户设置              */}
      {/* ================================================================= */}
      {modalMode !== 'none' && (
        <div className="modal-backdrop" onClick={() => setModalMode('none')}>
          <div className="modal-box" style={{ maxWidth: 740, width: '92vw' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <strong>
                {modalMode === 'manual'
                  ? '手动记录一笔实盘 / 模拟交易'
                  : modalMode === 'csv'
                  ? '券商交割单 CSV / Excel 制表符批量导入'
                  : modalMode === 'ai'
                  ? 'AI 识别券商交割单截图 / 成交短信一键入账'
                  : '账户资金基准与风控红线设置'}
              </strong>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModalMode('none')}>
                <X size={16} />
              </button>
            </div>

            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {modalMode === 'manual' && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                    <div>
                      <label className="field-label">方向</label>
                      <select className="select" value={form.side} onChange={(e) => setForm((p) => ({ ...p, side: e.target.value as any }))}>
                        <option value="BUY">买入 (BUY)</option>
                        <option value="SELL">卖出 (SELL)</option>
                      </select>
                    </div>
                    <div>
                      <label className="field-label">账户性质</label>
                      <select className="select" value={form.accountType} onChange={(e) => setForm((p) => ({ ...p, accountType: e.target.value as any }))}>
                        <option value="real">实盘账户</option>
                        <option value="sim">模拟演练</option>
                      </select>
                    </div>
                    <div>
                      <label className="field-label">成交日期</label>
                      <input type="date" className="input mono" value={form.date} onChange={(e) => setForm((p) => ({ ...p, date: e.target.value }))} />
                    </div>
                    <div>
                      <label className="field-label">成交时间</label>
                      <input className="input mono" value={form.time} onChange={(e) => setForm((p) => ({ ...p, time: e.target.value }))} />
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
                    <div>
                      <label className="field-label">代码 *</label>
                      <input className="input mono" placeholder="300308 / NVDA" value={form.code} onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))} />
                    </div>
                    <div>
                      <label className="field-label">标的简称</label>
                      <input className="input" placeholder="中际旭创" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
                    </div>
                    <div>
                      <label className="field-label">成交均价 *</label>
                      <input type="number" step="0.01" className="input mono" value={form.price} onChange={(e) => setForm((p) => ({ ...p, price: e.target.value }))} />
                    </div>
                    <div>
                      <label className="field-label">成交股数 *</label>
                      <input type="number" className="input mono" value={form.quantity} onChange={(e) => setForm((p) => ({ ...p, quantity: e.target.value }))} />
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
                    <div>
                      <label className="field-label">入场预设硬止损价 (算R倍数)</label>
                      <input type="number" step="0.01" className="input mono" placeholder="如 112.50" value={form.stopLossPrice} onChange={(e) => setForm((p) => ({ ...p, stopLossPrice: e.target.value }))} />
                    </div>
                    <div>
                      <label className="field-label">目标止盈价</label>
                      <input type="number" step="0.01" className="input mono" value={form.targetPrice} onChange={(e) => setForm((p) => ({ ...p, targetPrice: e.target.value }))} />
                    </div>
                    <div>
                      <label className="field-label">关联方法论卡号</label>
                      <input className="input mono" placeholder="如 061/159/190" value={form.cardIds} onChange={(e) => setForm((p) => ({ ...p, cardIds: e.target.value }))} />
                    </div>
                    <div>
                      <label className="field-label">所属主题 (算集中度)</label>
                      <input className="input" placeholder="如 光模块/AI算力" value={form.themes} onChange={(e) => setForm((p) => ({ ...p, themes: e.target.value }))} />
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 2fr', gap: 8 }}>
                    <div>
                      <label className="field-label">行为与情绪标签</label>
                      <select className="select" value={form.emotionTag} onChange={(e) => setForm((p) => ({ ...p, emotionTag: e.target.value }))}>
                        {(data?.emotionTagOptions || ['按计划执行', 'FOMO追高', '扛单不止损']).map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="field-label">计划执行打分(1-10)</label>
                      <input type="number" min={1} max={10} className="input mono" value={form.planScore} onChange={(e) => setForm((p) => ({ ...p, planScore: e.target.value }))} />
                    </div>
                    <div>
                      <label className="field-label">复盘备注</label>
                      <input className="input" placeholder="简记买/卖逻辑触发器..." value={form.note} onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))} />
                    </div>
                  </div>
                </>
              )}

              {modalMode === 'csv' && (
                <>
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                    直接粘贴同花顺 / 东方财富 / 华泰 / 富途导出的交割单 CSV 或 Excel 复制表格（自动识别中文/英文表头并自动扣除印花税与过户费）：
                  </div>
                  <textarea
                    className="textarea textarea-mono"
                    style={{ minHeight: 160 }}
                    placeholder={'成交日期,证券代码,证券名称,买卖标志,成交均价,成交数量,手续费\n2026-11-18,300308,中际旭创,买入,135.20,500,16.90\n2026-11-24,300308,中际旭创,卖出,149.80,500,56.18'}
                    value={csvText}
                    onChange={(e) => setCsvText(e.target.value)}
                  />
                  <div>
                    <button type="button" className="btn btn-teal btn-sm" disabled={parsingImport || !csvText.trim()} onClick={handleParseCsv}>
                      {parsingImport ? <Loader2 size={13} className="spin" /> : <FileSpreadsheet size={13} />} 解析预检交割单
                    </button>
                  </div>
                </>
              )}

              {modalMode === 'ai' && (
                <>
                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: '1px solid rgba(245, 158, 11, 0.4)',
                      background: 'rgba(245, 158, 11, 0.08)',
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 10,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <strong style={{ color: 'var(--amber)' }}>
                        {t('数据流向告知：', 'Outbound AI Data Notice: ')}
                      </strong>
                      {t(
                        `点击下方识别按钮后，本次上传的交割单截图或粘贴文本将直接发送至你所选的 AI 服务商（当前：${selectedProvider}）用于结构化提取，建议自行遮挡资金账号等敏感信息；若需 100% 离线零外发，请改用本地 CSV 解析。`,
                        `Clicking extract sends the uploaded image or pasted trade text directly to your selected AI provider (${selectedProvider}). Mask sensitive account IDs first, or switch to 100% offline local CSV parsing.`
                      )}
                    </div>
                    <button type="button" className="btn btn-sm" onClick={() => setModalMode('csv')}>
                      <FileSpreadsheet size={12} /> {t('切至本地 CSV 零外发解析', 'Use Offline CSV Parser')}
                    </button>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                      {t(
                        '上传券商成交截图（支持 Codex CLI / Gemini / GPT 视觉）或直接粘贴成交短信文本：',
                        'Upload broker fill screenshot or paste execution SMS text:'
                      )}
                    </span>
                    <AiProviderPicker value={selectedProvider} config={aiConfig} onChange={setSelectedProvider} onOpenSettings={onOpenAiSettings} />
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input ref={imgInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handlePickImage(e.target.files?.[0])} />
                    <button type="button" className="btn btn-sm" onClick={() => imgInputRef.current?.click()}>
                      <Camera size={13} /> 选择交割单 / 成交截图
                    </button>
                    {aiImageDataUrl && (
                      <span className="badge badge-emerald">
                        <CheckCircle2 size={12} /> 已载入图片 ({Math.round(aiImageDataUrl.length / 1024)} KB)
                      </span>
                    )}
                  </div>
                  <textarea
                    className="textarea"
                    style={{ minHeight: 90 }}
                    placeholder="（可选）或直接粘贴券商成交提醒短信，例如：2026-11-24 10:15 买入 300308 中际旭创 500股 成交价 142.5元..."
                    value={aiRawText}
                    onChange={(e) => setAiRawText(e.target.value)}
                  />
                  <div>
                    <button
                      type="button"
                      className="btn btn-amber btn-sm"
                      disabled={parsingImport || (!aiImageDataUrl && !aiRawText.trim())}
                      onClick={handleParseAi}
                    >
                      {parsingImport ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                      {parsingImport ? 'AI 正在识别成交明细...' : 'AI 智能识别提取成交记录'}
                    </button>
                  </div>
                </>
              )}

              {stagedTrades.length > 0 && (modalMode === 'csv' || modalMode === 'ai') && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, background: 'var(--bg-soft)' }}>
                  <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>
                    已解析待入账记录（共 {stagedTrades.length} 笔，核对无误后点击底部入账）：
                  </div>
                  <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                    <table className="data-table">
                      <thead>
                        <tr><th>日期</th><th>方向</th><th>标的</th><th>价格 × 数量</th><th>费用</th></tr>
                      </thead>
                      <tbody>
                        {stagedTrades.map((st, idx) => (
                          <tr key={idx}>
                            <td className="mono">{st.date}</td>
                            <td>{st.side === 'BUY' ? '买入' : '卖出'}</td>
                            <td>{st.name} ({st.code})</td>
                            <td className="mono">{st.price} × {st.quantity}</td>
                            <td className="mono">{st.fee}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {modalMode === 'settings' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
                  <div>
                    <label className="field-label">账户总资产基准（元）</label>
                    <input type="number" className="input mono" value={settingsForm.accountCapital} onChange={(e) => setSettingsForm((p) => ({ ...p, accountCapital: e.target.value }))} />
                  </div>
                  <div>
                    <label className="field-label">默认佣金费率（如 0.00025 = 万2.5）</label>
                    <input type="number" step="0.00005" className="input mono" value={settingsForm.commissionRate} onChange={(e) => setSettingsForm((p) => ({ ...p, commissionRate: e.target.value }))} />
                  </div>
                  <div>
                    <label className="field-label">单只股票仓位红线上限 (%)</label>
                    <input type="number" className="input mono" value={settingsForm.maxSinglePct} onChange={(e) => setSettingsForm((p) => ({ ...p, maxSinglePct: e.target.value }))} />
                  </div>
                  <div>
                    <label className="field-label">同方向 / 同主题暴露红线上限 (%)</label>
                    <input type="number" className="input mono" value={settingsForm.maxThemePct} onChange={(e) => setSettingsForm((p) => ({ ...p, maxThemePct: e.target.value }))} />
                  </div>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setModalMode('none')}>取消</button>
              {modalMode === 'manual' && (
                <button type="button" className="btn btn-primary" disabled={saving} onClick={handleManualSubmit}>
                  {saving ? '保存中...' : '确认入账并重算归因'}
                </button>
              )}
              {(modalMode === 'csv' || modalMode === 'ai') && (
                <button type="button" className="btn btn-primary" disabled={saving || stagedTrades.length === 0} onClick={handleCommitStaged}>
                  {saving ? '入账中...' : `确认批量入账 (${stagedTrades.length} 笔)`}
                </button>
              )}
              {modalMode === 'settings' && (
                <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSaveSettings}>
                  保存账户与红线设置
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      <TradePlanCardModal
        open={showPlanCard}
        seed={{
          accountCapital: Number(settingsForm.accountCapital) || 500000,
          maxSinglePct: Number(settingsForm.maxSinglePct) || 25,
          commissionRate: Number(settingsForm.commissionRate) || 0.00025,
        }}
        onClose={() => setShowPlanCard(false)}
        onApplyToManualTrade={(draft) => {
          setForm((prev) => ({
            ...prev,
            marketKind: 'CN',
            side: 'BUY',
            code: draft.code,
            name: draft.name,
            price: draft.price,
            quantity: draft.quantity,
            stopLossPrice: draft.stopLossPrice,
            targetPrice: draft.targetPrice,
            note: draft.note,
          }));
          setModalMode('manual');
        }}
        onToast={onToast}
      />

      <ExecutionSlotModal
        open={showExecSlot}
        onClose={() => setShowExecSlot(false)}
        onUpdated={(st) => setExecSlotState(st)}
        onToast={onToast}
      />

      {pendingDeleteTradeId && (
        <div className="modal-backdrop" onClick={() => setPendingDeleteTradeId(null)}>
          <div className="modal-box" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <strong style={{ fontSize: 14.5 }}>确认删除交易记录</strong>
            </div>
            <div className="modal-body" style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
              确认删除该条成交记录吗？删除后将自动重新核算当前持仓成本、收益曲线与方法论归因统计。
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-sm" onClick={() => setPendingDeleteTradeId(null)}>
                取消
              </button>
              <button type="button" className="btn btn-danger btn-sm" onClick={executeDeleteTrade}>
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
