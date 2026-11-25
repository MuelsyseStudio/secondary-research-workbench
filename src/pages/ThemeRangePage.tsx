import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  CalendarRange,
  Compass,
  Edit3,
  Grid,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type { SecuritySearchItem } from '../types';

interface ThemeRangePageProps {
  isActive?: boolean;
  onOpenFullscreenStock: (secidOrQuery: string) => void;
  onOpenUnifiedReview?: () => void;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

export const ThemeRangePage: React.FC<ThemeRangePageProps> = ({
  isActive = true,
  onOpenFullscreenStock,
  onOpenUnifiedReview,
  onToast,
}) => {
  const { t, pctColor, formatPct, formatYi, upColor, downColor } = useI18n();
  const [subTab, setSubTab] = useState<'matrix' | 'quadrant' | 'range'>('matrix');

  // Theme Matrix + Range Stats state
  const [data, setData] = useState<any | null>(null);
  const [themeCode, setThemeCode] = useState('');
  const [indexSecid, setIndexSecid] = useState('1.000001');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [matrixMode, setMatrixMode] = useState<'live' | 'cognition'>('live');
  const [dragAnchor, setDragAnchor] = useState<number | null>(null);

  // Full-market theme directory search + filter + custom theme CRUD
  const [themeFilterTab, setThemeFilterTab] = useState<'hot' | 'industry' | 'mine'>('hot');
  const [themeSearchQ, setThemeSearchQ] = useState('');
  const [themeSearchResults, setThemeSearchResults] = useState<any[] | null>(null);
  const [searchingThemes, setSearchingThemes] = useState(false);

  // Custom theme create/edit modal state
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [editingCustomId, setEditingCustomId] = useState<string>('');
  const [customName, setCustomName] = useState('');
  const [customThesis, setCustomThesis] = useState('');
  const [customStocks, setCustomStocks] = useState<{ secid: string; code: string; name: string }[]>([]);
  const [stockSearchQ, setStockSearchQ] = useState('');
  const [stockSearchResults, setStockSearchResults] = useState<SecuritySearchItem[]>([]);
  const [savingCustom, setSavingCustom] = useState(false);

  // Sector Rotation Quadrant
  const [quadData, setQuadData] = useState<any | null>(null);

  const loadThemeRange = useCallback(
    async (opts?: { indexSecid?: string; themeCode?: string; startDate?: string; endDate?: string }) => {
      setLoading(true);
      try {
        const res = await api.getShortTermThemesRange({
          indexSecid: opts?.indexSecid ?? indexSecid,
          themeCode: opts?.themeCode ?? themeCode,
          startDate: opts?.startDate ?? startDate,
          endDate: opts?.endDate ?? endDate,
        });
        setData(res);
        if (!themeCode && res?.selectedTheme?.code) setThemeCode(res.selectedTheme.code);
        if (!startDate && res?.rangeStats?.startDate) setStartDate(res.rangeStats.startDate);
        if (!endDate && res?.rangeStats?.endDate) setEndDate(res.rangeStats.endDate);
      } catch (err: any) {
        onToast(err.message || '加载题材与区间统计失败', 'error');
      } finally {
        setLoading(false);
      }
    },
    [indexSecid, themeCode, startDate, endDate, onToast]
  );

  const loadThemeRangeRef = useRef(loadThemeRange);
  loadThemeRangeRef.current = loadThemeRange;
  const prevActiveRef = useRef(isActive);

  useEffect(() => {
    loadThemeRangeRef.current();
    api.getSectorRotationQuadrant().then(setQuadData).catch(() => {});
  }, []);

  // 重新切回题材区间页时按当前保留的题材/起止日期刷新最新行情，不重置任何筛选与表单
  useEffect(() => {
    if (isActive && !prevActiveRef.current) {
      loadThemeRangeRef.current();
      api.getSectorRotationQuadrant().then(setQuadData).catch(() => {});
    }
    prevActiveRef.current = isActive;
  }, [isActive]);

  // 实时搜索全市场 500+ 概念/行业 + 自定义题材
  useEffect(() => {
    const q = themeSearchQ.trim();
    if (!q) {
      setThemeSearchResults(null);
      setSearchingThemes(false);
      return;
    }
    let alive = true;
    setSearchingThemes(true);
    const timer = window.setTimeout(() => {
      api
        .searchShortTermThemes(q, 'all', 100)
        .then((res) => {
          if (alive) setThemeSearchResults(res.items || []);
        })
        .catch(() => {
          if (alive) setThemeSearchResults([]);
        })
        .finally(() => {
          if (alive) setSearchingThemes(false);
        });
    }, 220);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [themeSearchQ]);

  // 自定义题材弹窗内搜索添加成分股
  useEffect(() => {
    if (!customModalOpen) return;
    const q = stockSearchQ.trim();
    if (!q) {
      setStockSearchResults([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      api
        .searchSecurities(q)
        .then((res) => {
          if (!alive) return;
          setStockSearchResults((res.items || []).filter((it) => it.marketKind === 'CN').slice(0, 10));
        })
        .catch(() => {
          if (alive) setStockSearchResults([]);
        });
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [customModalOpen, stockSearchQ]);

  const openCreateCustomTheme = () => {
    setEditingCustomId('');
    setCustomName('');
    setCustomThesis('');
    setCustomStocks([]);
    setStockSearchQ('');
    setStockSearchResults([]);
    setCustomModalOpen(true);
  };

  const openEditCustomTheme = (ct: any) => {
    setEditingCustomId(ct.id || String(ct.code || '').replace(/^custom:/, ''));
    setCustomName(ct.name || '');
    setCustomThesis(ct.thesis || '');
    setCustomStocks(Array.isArray(ct.stocks) ? ct.stocks.map((s: any) => ({ secid: s.secid, code: s.code, name: s.name })) : []);
    setStockSearchQ('');
    setStockSearchResults([]);
    setCustomModalOpen(true);
  };

  const handleSaveCustomTheme = async () => {
    if (!customName.trim()) {
      onToast(t('请填写自定义题材名称', 'Please enter a custom theme name'), 'warning');
      return;
    }
    setSavingCustom(true);
    try {
      const res = await api.saveCustomTheme({
        id: editingCustomId || undefined,
        name: customName.trim(),
        thesis: customThesis.trim(),
        stocks: customStocks,
      });
      setCustomModalOpen(false);
      onToast(
        editingCustomId
          ? t(`已更新自定义题材「${res.theme?.name}」`, `Updated custom theme ${res.theme?.name}`)
          : t(`已创建自定义题材「${res.theme?.name}」`, `Created custom theme ${res.theme?.name}`),
        'success'
      );
      const nextCode = res.theme?.code || '';
      if (nextCode) {
        setThemeFilterTab('mine');
        setThemeCode(nextCode);
        await loadThemeRange({ themeCode: nextCode });
      } else {
        await loadThemeRange();
      }
    } catch (err: any) {
      onToast(err.message || '保存自定义题材失败', 'error');
    } finally {
      setSavingCustom(false);
    }
  };

  const handleDeleteCustomTheme = async (id: string, name: string) => {
    try {
      await api.deleteCustomTheme(id);
      onToast(t(`已删除自定义题材「${name}」`, `Deleted custom theme ${name}`), 'info');
      setThemeCode('');
      await loadThemeRange({ themeCode: '' });
    } catch (err: any) {
      onToast(err.message || '删除失败', 'error');
    }
  };

  const handleTogglePin = async (e: React.MouseEvent, code: string, name: string) => {
    e.stopPropagation();
    try {
      const res = await api.togglePinTheme(code);
      onToast(
        res.pinned
          ? t(`已将「${name}」收藏置顶到我的题材库`, `Pinned ${name}`)
          : t(`已取消收藏「${name}」`, `Unpinned ${name}`),
        'info'
      );
      if (themeSearchQ.trim()) {
        api.searchShortTermThemes(themeSearchQ.trim(), 'all', 100).then((r) => setThemeSearchResults(r.items || [])).catch(() => {});
      }
      loadThemeRange({ themeCode: data?.selectedTheme?.code || themeCode });
    } catch (err: any) {
      onToast(err.message || '收藏切换失败', 'error');
    }
  };

  const pinnedCodeSet = useMemo(() => new Set<string>(data?.pinnedCodes || []), [data?.pinnedCodes]);

  const displayedThemeList = useMemo(() => {
    if (themeSearchQ.trim() && themeSearchResults !== null) {
      return themeSearchResults;
    }
    if (themeFilterTab === 'industry') {
      return data?.hotIndustries || [];
    }
    if (themeFilterTab === 'mine') {
      const customs = (data?.customThemes || []).map((c: any) => ({ ...c, kind: 'custom', pinned: true }));
      const pinned = data?.pinnedThemes || [];
      return [...customs, ...pinned];
    }
    // hot: show pinned market themes + custom themes on top, then top 40 concepts
    const customs = (data?.customThemes || []).map((c: any) => ({ ...c, kind: 'custom', pinned: true }));
    const pinned = data?.pinnedThemes || [];
    const seen = new Set<string>([...customs.map((x: any) => x.code), ...pinned.map((x: any) => x.code)]);
    const hotRest = (data?.hotThemes || []).filter((x: any) => !seen.has(x.code));
    return [...customs, ...pinned, ...hotRest];
  }, [data, themeFilterTab, themeSearchQ, themeSearchResults]);

  const applyQuickWindow = (days: number) => {
    const ks = data?.rangeStats?.indexKlines || [];
    if (ks.length < 2) return;
    const ed = ks[ks.length - 1].date;
    const sd = ks[Math.max(0, ks.length - 1 - days)].date;
    setStartDate(sd);
    setEndDate(ed);
    loadThemeRange({ startDate: sd, endDate: ed });
  };

  const idxKlines = data?.rangeStats?.indexKlines || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Sub-navigation */}
      <div className="card" style={{ padding: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className={`btn btn-sm ${subTab === 'matrix' ? 'btn-primary' : ''}`} onClick={() => setSubTab('matrix')}>
            <Grid size={13} /> {t('题材小表格（实时 + 认知库产业链）', 'Theme Matrix & Chain')}
          </button>
          <button type="button" className={`btn btn-sm ${subTab === 'quadrant' ? 'btn-primary' : ''}`} onClick={() => setSubTab('quadrant')}>
            <Compass size={13} /> {t('板块轮动四象限', '4-Quadrant Rotation')}
          </button>
          <button type="button" className={`btn btn-sm ${subTab === 'range' ? 'btn-primary' : ''}`} onClick={() => setSubTab('range')}>
            <CalendarRange size={13} /> {t('K 线拖拽区间统计', 'K-Line Range Stats')}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {onOpenUnifiedReview && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={onOpenUnifiedReview}
              title={t('短线行情情绪、题材趋势与产业逻辑统一沉淀到「深度复盘与台账」', 'Review short-term tape, theme trends & industry logic in Unified Review Ledger')}
            >
              <BookOpen size={12} /> {t('去统一深度复盘台账', 'Unified Review Ledger')} <ArrowRight size={12} />
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => loadThemeRange()}>
            <RefreshCw size={12} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {/* Sub-tab 1: 题材小表格（左侧热门题材 + 右侧分层成分表 / 认知库产业链小表格） */}
      {subTab === 'matrix' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" className={`btn btn-sm ${matrixMode === 'live' ? 'btn-primary' : ''}`} onClick={() => setMatrixMode('live')}>
                {t('全市场题材目录（概念 + 行业 + 自建）', 'Full-Market Theme Catalog')}
              </button>
              <button type="button" className={`btn btn-sm ${matrixMode === 'cognition' ? 'btn-primary' : ''}`} onClick={() => setMatrixMode('cognition')}>
                <BookOpen size={12} /> {t('我的认知库 · 独家产业链小表格', 'My Cognition Library Chain Matrix')}
              </button>
              {data?.catalogStats && (
                <span className="badge badge-muted" style={{ fontSize: 11 }}>
                  全市场 {data.catalogStats.totalConcepts || 0} 概念 · {data.catalogStats.totalIndustries || 0} 行业 · 自建 {data.catalogStats.customCount || 0}
                </span>
              )}
            </div>
            <button type="button" className="btn btn-sm btn-primary" onClick={openCreateCustomTheme}>
              <Plus size={13} /> {t('新建自定义题材', 'New Custom Theme')}
            </button>
          </div>

          {matrixMode === 'live' ? (
            <div style={{ display: 'grid', gridTemplateColumns: '292px minmax(0, 1fr)', gap: 10 }}>
              {/* Left full-market searchable themes list */}
              <div className="card" style={{ padding: 8, maxHeight: 620, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {/* Real-time full catalog search */}
                <div style={{ position: 'relative' }}>
                  <Search size={13} style={{ position: 'absolute', left: 8, top: 8, color: 'var(--text-muted)' }} />
                  <input
                    className="input"
                    style={{ width: '100%', height: 30, paddingLeft: 26, paddingRight: 24, fontSize: 12 }}
                    placeholder={t('搜全市场500+概念/行业（如 CPO/机器人/芯片）', 'Search 500+ themes/industries...')}
                    value={themeSearchQ}
                    onChange={(e) => setThemeSearchQ(e.target.value)}
                  />
                  {themeSearchQ && (
                    <button
                      type="button"
                      onClick={() => setThemeSearchQ('')}
                      style={{ position: 'absolute', right: 6, top: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>

                {/* Category pills */}
                {!themeSearchQ.trim() ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
                    {[
                      { id: 'hot', label: t('热门概念', 'Hot') },
                      { id: 'industry', label: t(`行业(${data?.catalogStats?.totalIndustries || 0})`, 'Ind.') },
                      { id: 'mine', label: t(`收藏/自建(${(data?.customThemes?.length || 0) + (data?.pinnedThemes?.length || 0)})`, 'Mine') },
                    ].map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        className={`btn btn-sm ${themeFilterTab === tab.id ? 'btn-primary' : ''}`}
                        style={{ fontSize: 11, padding: '3px 4px', justifyContent: 'center' }}
                        onClick={() => setThemeFilterTab(tab.id as any)}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    {searchingThemes ? <Loader2 size={11} className="spin" /> : null}
                    {searchingThemes
                      ? t('正在全市场题材目录检索...', 'Searching full market catalog...')
                      : t(`找到 ${displayedThemeList.length} 个匹配题材/行业（点击★可收藏置顶）`, `${displayedThemeList.length} matches found`)}
                  </div>
                )}

                <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {displayedThemeList.length === 0 ? (
                    <div style={{ padding: 14, textAlign: 'center', fontSize: 11.5, color: 'var(--text-muted)' }}>
                      {themeFilterTab === 'mine' && !themeSearchQ.trim() ? (
                        <>
                          <div>{t('暂无收藏或自建题材', 'No pinned or custom themes yet')}</div>
                          <button type="button" className="btn btn-sm btn-primary" style={{ marginTop: 8 }} onClick={openCreateCustomTheme}>
                            <Plus size={12} /> {t('创建首个自定义题材', 'Create First Custom Theme')}
                          </button>
                        </>
                      ) : (
                        <div>{t('未匹配到该题材，可直接点右上角「新建自定义题材」自由组合成分股', 'No matching board — click New Custom Theme to create your own')}</div>
                      )}
                    </div>
                  ) : (
                    displayedThemeList.map((th: any) => {
                      const active = th.code === (data?.selectedTheme?.code || themeCode);
                      const isCustom = th.kind === 'custom' || String(th.code || '').startsWith('custom:');
                      const isPinned = isCustom || th.pinned || pinnedCodeSet.has(th.code);
                      return (
                        <div
                          key={th.code}
                          role="button"
                          tabIndex={0}
                          className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                          style={{ justifyContent: 'space-between', height: 'auto', padding: '6px 7px', gap: 4, cursor: 'pointer' }}
                          onClick={() => {
                            setThemeCode(th.code);
                            loadThemeRange({ themeCode: th.code });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              setThemeCode(th.code);
                              loadThemeRange({ themeCode: th.code });
                            }
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, flex: 1 }}>
                            {!isCustom && (
                              <span
                                title={isPinned ? '取消置顶收藏' : '收藏置顶到常用题材'}
                                onClick={(e) => handleTogglePin(e, th.code, th.name)}
                                style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, color: isPinned ? '#f59e0b' : active ? 'rgba(255,255,255,0.65)' : 'var(--text-muted)' }}
                              >
                                <Star size={11} fill={isPinned ? '#f59e0b' : 'none'} />
                              </span>
                            )}
                            <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {th.name}
                            </span>
                            {isCustom && (
                              <span className="badge" style={{ fontSize: 9.5, padding: '0 4px', background: active ? 'rgba(255,255,255,0.2)' : 'var(--teal-soft)', color: active ? '#fff' : 'var(--teal)' }}>
                                自建
                              </span>
                            )}
                            {th.kind === 'industry' && themeSearchQ.trim() && (
                              <span className="badge" style={{ fontSize: 9.5, padding: '0 4px', opacity: 0.8 }}>行业</span>
                            )}
                          </div>
                          <span className="mono" style={{ fontWeight: 700, fontSize: 11.5, flexShrink: 0, color: active ? '#fff' : pctColor(th.pct) }}>
                            {isCustom && th.pct == null ? `${th.stockCount ?? th.stocks?.length ?? 0}股` : formatPct(th.pct)}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Right structured hierarchical small table */}
              <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 16 }}>{data?.selectedTheme?.name || '--'}</strong>
                      {data?.selectedTheme?.kind === 'custom' ? (
                        <span className="badge badge-teal" style={{ fontSize: 10.5 }}>自定义题材</span>
                      ) : data?.selectedTheme?.kind === 'industry' ? (
                        <span className="badge badge-navy" style={{ fontSize: 10.5 }}>行业板块</span>
                      ) : (
                        <span className="badge badge-muted" style={{ fontSize: 10.5 }}>概念题材</span>
                      )}
                      <span className="mono" style={{ fontWeight: 800, color: pctColor(data?.selectedTheme?.pct) }}>
                        {formatPct(data?.selectedTheme?.pct)}
                      </span>
                      {data?.selectedTheme?.code && data?.selectedTheme?.kind !== 'custom' && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{ padding: '2px 7px', fontSize: 11 }}
                          onClick={(e) => handleTogglePin(e, data.selectedTheme.code, data.selectedTheme.name)}
                        >
                          <Star size={11} fill={pinnedCodeSet.has(data.selectedTheme.code) ? '#f59e0b' : 'none'} color={pinnedCodeSet.has(data.selectedTheme.code) ? '#f59e0b' : 'currentColor'} />
                          {pinnedCodeSet.has(data.selectedTheme.code) ? '已收藏' : '收藏置顶'}
                        </button>
                      )}
                      {data?.selectedTheme?.kind === 'custom' && (
                        <>
                          <button type="button" className="btn btn-sm" style={{ padding: '2px 7px', fontSize: 11 }} onClick={() => openEditCustomTheme(data.selectedTheme)}>
                            <Edit3 size={11} /> 编辑成分股
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            style={{ padding: '2px 7px', fontSize: 11 }}
                            onClick={() => handleDeleteCustomTheme(data.selectedTheme.id, data.selectedTheme.name)}
                          >
                            <Trash2 size={11} /> 删除
                          </button>
                        </>
                      )}
                    </div>
                    {data?.selectedTheme?.thesis && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                        核心逻辑：{data.selectedTheme.thesis}
                      </div>
                    )}
                  </div>
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    {t('点击个股一键打开全屏研究工作台', 'Click any ticker for Fullscreen Terminal')}
                  </span>
                </div>
                {(data?.themeTiers || []).map((tier: any) => (
                  <div key={tier.tier} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
                    <div style={{ fontWeight: 800, fontSize: 12.5, marginBottom: 8, color: 'var(--navy)' }}>
                      {t(tier.tier, tier.tierEn)} ({tier.stocks.length})
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(126px, 1fr))', gap: 6 }}>
                      {tier.stocks.map((st: any) => (
                        <div
                          key={st.code}
                          onClick={() => onOpenFullscreenStock(st.secid)}
                          style={{
                            cursor: 'pointer',
                            padding: '6px 8px',
                            borderRadius: 6,
                            background: 'var(--bg-subtle)',
                            border: '1px solid var(--border)',
                            textAlign: 'center',
                          }}
                        >
                          <div style={{ fontWeight: 700, fontSize: 12 }}>{st.name}</div>
                          <div className="mono" style={{ fontSize: 11.5, fontWeight: 800, color: pctColor(st.pct) }}>{formatPct(st.pct)}</div>
                          <div className="mono" style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{st.code} · {formatYi(st.amountYi)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              {(data?.cognitionChains || []).map((ch: any) => (
                <div key={ch.domain} className="card" style={{ padding: 12 }}>
                  <div style={{ fontWeight: 800, fontSize: 13.5, marginBottom: 8, color: 'var(--navy)' }}>
                    {ch.domain} ({ch.cardCount} {t('张认知卡', 'cards')})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {ch.cards.map((c: any) => (
                      <div key={c.cardId} style={{ padding: 8, borderRadius: 7, background: 'var(--bg-subtle)', fontSize: 11.5 }}>
                        <div style={{ fontWeight: 700 }}>[{c.cardId} · {c.grade}] {c.title}</div>
                        <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>{c.summary}</div>
                        {c.codes.length > 0 && (
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 5 }}>
                            {c.codes.map((cd: string) => (
                              <button
                                key={cd}
                                type="button"
                                className="btn btn-sm"
                                style={{ padding: '1px 6px', fontSize: 10.5 }}
                                onClick={() => onOpenFullscreenStock(cd)}
                              >
                                {cd}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sub-tab 2: 弈盘板块轮动四象限散点图 (60日涨幅 vs 近5日涨幅) */}
      {subTab === 'quadrant' && quadData && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="card" style={{ padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ fontSize: 13.5 }}>{t('板块轮动四象限散点图（横轴 60 日位置 × 纵轴 近 5 日动能）', 'Sector Rotation 4-Quadrant (60D Position × 5D Momentum)')}</strong>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                {t('重点盯防「低强」潜伏转强象限与「高强」主升象限', 'Focus on Low-Strong (turnaround) & High-Strong (leaders)')}
              </span>
            </div>
            {(() => {
              const items = quadData.items || [];
              const maxX = Math.max(12, ...items.map((i: any) => Math.abs(i.ret60dPct || 0)));
              const maxY = Math.max(6, ...items.map((i: any) => Math.abs(i.ret5dPct || 0)));
              const w = 780;
              const h = 320;
              const cx = w / 2;
              const cy = h / 2;
              return (
                <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 320, background: 'var(--bg-subtle)', borderRadius: 8 }}>
                  <rect x={0} y={0} width={cx} height={cy} fill="rgba(14,165,233,0.06)" />
                  <rect x={cx} y={0} width={cx} height={cy} fill="rgba(220,38,38,0.06)" />
                  <rect x={0} y={cy} width={cx} height={cy} fill="rgba(148,163,184,0.08)" />
                  <rect x={cx} y={cy} width={cx} height={cy} fill="rgba(245,158,11,0.06)" />
                  <line x1={0} y1={cy} x2={w} y2={cy} stroke="var(--border-strong)" strokeWidth={1.2} />
                  <line x1={cx} y1={0} x2={cx} y2={h} stroke="var(--border-strong)" strokeWidth={1.2} />
                  <text x={14} y={20} fontSize={12} fontWeight={800} fill="#0284c7">{t('低强 · 低位转强（潜伏修复）', 'Low-Strong (Turnaround)')}</text>
                  <text x={w - 190} y={20} fontSize={12} fontWeight={800} fill="#dc2626">{t('高强 · 高位走强（主线主升）', 'High-Strong (Leaders)')}</text>
                  <text x={14} y={h - 10} fontSize={12} fontWeight={800} fill="#64748b">{t('低弱 · 弱势回避', 'Low-Weak (Avoid)')}</text>
                  <text x={w - 180} y={h - 10} fontSize={12} fontWeight={800} fill="#b45309">{t('高弱 · 高位分歧兑现', 'High-Weak (Pullback)')}</text>
                  {items.map((it: any) => {
                    const x = cx + ((it.ret60dPct || 0) / maxX) * (cx - 48);
                    const y = cy - ((it.ret5dPct || 0) / maxY) * (cy - 34);
                    const color =
                      it.quadrant === 'high_strong' ? '#dc2626' : it.quadrant === 'low_strong' ? '#0284c7' : it.quadrant === 'high_weak' ? '#d97706' : '#64748b';
                    return (
                      <g key={it.code}>
                        <circle cx={x} cy={y} r={5} fill={color} opacity={0.85} />
                        <text x={x + 7} y={y + 3} fontSize={10.5} fontWeight={700} fill="var(--text-primary)">
                          {it.name}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              );
            })()}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
            {[
              { id: 'high_strong', title: t('高强（主升）', 'High-Strong'), color: '#dc2626' },
              { id: 'low_strong', title: t('低强（转强潜伏）', 'Low-Strong'), color: '#0284c7' },
              { id: 'high_weak', title: t('高弱（分歧兑现）', 'High-Weak'), color: '#d97706' },
              { id: 'low_weak', title: t('低弱（弱势）', 'Low-Weak'), color: '#64748b' },
            ].map((q) => (
              <div key={q.id} className="card" style={{ padding: 8 }}>
                <div style={{ fontWeight: 800, fontSize: 12, color: q.color, marginBottom: 6 }}>{q.title}</div>
                {(quadData.items || [])
                  .filter((x: any) => x.quadrant === q.id)
                  .slice(0, 8)
                  .map((x: any) => (
                    <div key={x.code} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '3px 0', borderBottom: '1px dashed var(--border)' }}>
                      <span style={{ fontWeight: 600 }}>{x.name}</span>
                      <span className="mono" style={{ color: pctColor(x.ret5dPct) }}>5D {formatPct(x.ret5dPct)}</span>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sub-tab 3: 弈盘 K 线拖拽框选区间统计 */}
      {subTab === 'range' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="card" style={{ padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <select
                  className="input"
                  style={{ width: 120, height: 30, fontSize: 12 }}
                  value={indexSecid}
                  onChange={(e) => {
                    setIndexSecid(e.target.value);
                    loadThemeRange({ indexSecid: e.target.value });
                  }}
                >
                  <option value="1.000001">上证指数</option>
                  <option value="0.399006">创业板指</option>
                  <option value="1.000688">科创50</option>
                  <option value="0.399001">深证成指</option>
                </select>
                {[3, 5, 10, 20, 40].map((d) => (
                  <button key={d} type="button" className="btn btn-sm" onClick={() => applyQuickWindow(d)}>
                    {t(`近${d}日`, `${d}D`)}
                  </button>
                ))}
                <input type="date" className="input" style={{ width: 135, height: 30, fontSize: 11.5 }} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                <span>~</span>
                <input type="date" className="input" style={{ width: 135, height: 30, fontSize: 11.5 }} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                <button type="button" className="btn btn-sm btn-primary" onClick={() => loadThemeRange({ startDate, endDate })}>
                  {t('计算区间榜', 'Analyze Range')}
                </button>
              </div>
              <div style={{ fontSize: 12 }}>
                {t('区间指数涨跌', 'Index Return')}:{' '}
                <b className="mono" style={{ color: pctColor(data?.rangeStats?.indexRangePct) }}>
                  {formatPct(data?.rangeStats?.indexRangePct)}
                </b>
              </div>
            </div>

            {/* Interactive Brushable Index K-Line Chart */}
            {idxKlines.length > 2 && (
              <div style={{ userSelect: 'none' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                  {t('提示：在下方大盘 K 线上按住鼠标左键拖拽，可直接框选任意起止区间并刷新下方强弱榜！', 'Tip: Click & drag across the index K-line below to brush any date range!')}
                </div>
                {(() => {
                  const w = 920;
                  const h = 150;
                  const minP = Math.min(...idxKlines.map((k: any) => k.low));
                  const maxP = Math.max(...idxKlines.map((k: any) => k.high));
                  const span = Math.max(0.01, maxP - minP);
                  const step = w / idxKlines.length;
                  return (
                    <svg
                      viewBox={`0 0 ${w} ${h}`}
                      style={{ width: '100%', height: 150, background: 'var(--bg-subtle)', borderRadius: 8, cursor: 'crosshair' }}
                      onMouseUp={() => {
                        if (dragAnchor != null) {
                          setDragAnchor(null);
                          loadThemeRange({ startDate, endDate });
                        }
                      }}
                    >
                      {idxKlines.map((k: any, i: number) => {
                        const x = i * step + step * 0.5;
                        const inRange = startDate && endDate && k.date >= startDate && k.date <= endDate;
                        const yH = h - 16 - ((k.high - minP) / span) * (h - 26);
                        const yL = h - 16 - ((k.low - minP) / span) * (h - 26);
                        const yO = h - 16 - ((k.open - minP) / span) * (h - 26);
                        const yC = h - 16 - ((k.close - minP) / span) * (h - 26);
                        const col = k.close >= k.open ? upColor : downColor;
                        return (
                          <g
                            key={k.date}
                            onMouseDown={() => {
                              setDragAnchor(i);
                              setStartDate(k.date);
                              setEndDate(k.date);
                            }}
                            onMouseEnter={() => {
                              if (dragAnchor != null) {
                                const lo = Math.min(dragAnchor, i);
                                const hi = Math.max(dragAnchor, i);
                                setStartDate(idxKlines[lo].date);
                                setEndDate(idxKlines[hi].date);
                              }
                            }}
                          >
                            {inRange && <rect x={i * step} y={0} width={step} height={h} fill="rgba(220,38,38,0.14)" />}
                            <line x1={x} y1={yH} x2={x} y2={yL} stroke={col} strokeWidth={1} />
                            <rect
                              x={i * step + 1}
                              y={Math.min(yO, yC)}
                              width={Math.max(2, step - 2)}
                              height={Math.max(1.5, Math.abs(yC - yO))}
                              fill={col}
                            />
                          </g>
                        );
                      })}
                      <text x={8} y={h - 3} fontSize={10} fill="var(--text-muted)">{idxKlines[0]?.date}</text>
                      <text x={w - 78} y={h - 3} fontSize={10} fill="var(--text-muted)">{idxKlines[idxKlines.length - 1]?.date}</text>
                    </svg>
                  );
                })()}
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 10 }}>
            <div className="card" style={{ padding: 10 }}>
              <strong style={{ fontSize: 12.5 }}>{t('区间个股涨幅 & 超额 Alpha 榜', 'Interval Stock Gainers & Alpha')}</strong>
              <table className="table" style={{ fontSize: 11.5, marginTop: 6 }}>
                <thead>
                  <tr>
                    <th>{t('标的', 'Stock')}</th>
                    <th>{t('归类', 'Tag')}</th>
                    <th>{t('区间涨幅', 'Range%')}</th>
                    <th>{t('跑赢大盘', 'Alpha')}</th>
                    <th>{t('区间振幅', 'Amp%')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.rangeStats?.stocks || []).map((st: any) => (
                    <tr key={st.secid} style={{ cursor: 'pointer' }} onClick={() => onOpenFullscreenStock(st.secid)}>
                      <td><b>{st.name}</b> <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{st.code}</span></td>
                      <td><span className="badge badge-muted" style={{ fontSize: 10 }}>{st.tag}</span></td>
                      <td className="mono" style={{ fontWeight: 800, color: pctColor(st.rangePct) }}>{formatPct(st.rangePct)}</td>
                      <td className="mono" style={{ color: pctColor(st.alphaVsIndexPct) }}>{formatPct(st.alphaVsIndexPct)}</td>
                      <td className="mono">{st.maxAmpPct ?? '-'}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card" style={{ padding: 10 }}>
              <strong style={{ fontSize: 12.5 }}>{t('区间行业板块强弱榜', 'Interval Sector Strength')}</strong>
              <table className="table" style={{ fontSize: 11.5, marginTop: 6 }}>
                <thead>
                  <tr>
                    <th>{t('板块', 'Sector')}</th>
                    <th>{t('区间涨幅', 'Range%')}</th>
                    <th>{t('超额', 'Alpha')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.rangeStats?.sectors || []).map((sec: any) => (
                    <tr key={sec.code}>
                      <td style={{ fontWeight: 700 }}>{sec.name}</td>
                      <td className="mono" style={{ fontWeight: 800, color: pctColor(sec.rangePct) }}>{formatPct(sec.rangePct)}</td>
                      <td className="mono" style={{ color: pctColor(sec.alphaVsIndexPct) }}>{formatPct(sec.alphaVsIndexPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {/* 新建 / 编辑自定义题材弹窗 */}
      {customModalOpen && (
        <div className="modal-backdrop" style={{ zIndex: 1800 }} onClick={() => setCustomModalOpen(false)}>
          <div className="modal-box" style={{ maxWidth: 560, width: '94vw' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <strong style={{ fontSize: 15 }}>
                {editingCustomId ? t('编辑自定义题材与成分股', 'Edit Custom Theme') : t('新建自定义题材（自由组合产业链核心标的）', 'Create Custom Theme')}
              </strong>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCustomModalOpen(false)}>
                <X size={15} />
              </button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
                  {t('题材名称 *', 'Theme Name *')}
                </label>
                <input
                  className="input"
                  style={{ width: '100%' }}
                  placeholder="例如：1.6T光模块核心链 / 人形机器人丝杠 / 商业航天火箭"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
                  {t('核心逻辑 / 催化备注（可选）', 'Core Thesis / Catalyst (Optional)')}
                </label>
                <textarea
                  className="input"
                  rows={2}
                  style={{ width: '100%', resize: 'vertical' }}
                  placeholder="记录题材核心逻辑、容量中军与催化节点..."
                  value={customThesis}
                  onChange={(e) => setCustomThesis(e.target.value)}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
                  {t('搜索并添加 A 股成分股', 'Search & Add A-Share Constituents')} ({customStocks.length})
                </label>
                <div style={{ position: 'relative' }}>
                  <Search size={13} style={{ position: 'absolute', left: 9, top: 10, color: 'var(--text-muted)' }} />
                  <input
                    className="input"
                    style={{ width: '100%', paddingLeft: 28 }}
                    placeholder="输入代码或名称添加，例如 300308 / 贵州茅台 / 寒武纪"
                    value={stockSearchQ}
                    onChange={(e) => setStockSearchQ(e.target.value)}
                  />
                  {stockSearchResults.length > 0 && (
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: '100%',
                        marginTop: 4,
                        zIndex: 20,
                        background: 'var(--bg-elev)',
                        border: '1px solid var(--border-strong)',
                        borderRadius: 8,
                        maxHeight: 200,
                        overflowY: 'auto',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                      }}
                    >
                      {stockSearchResults.map((it) => {
                        const already = customStocks.some((s) => s.secid === it.secid);
                        return (
                          <button
                            key={it.secid}
                            type="button"
                            disabled={already}
                            style={{
                              width: '100%',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              padding: '7px 10px',
                              border: 'none',
                              borderBottom: '1px solid var(--border)',
                              background: 'transparent',
                              cursor: already ? 'default' : 'pointer',
                              opacity: already ? 0.5 : 1,
                              color: 'var(--text)',
                              fontSize: 12,
                            }}
                            onClick={() => {
                              setCustomStocks((prev) =>
                                prev.some((x) => x.secid === it.secid)
                                  ? prev
                                  : [...prev, { secid: it.secid, code: it.code, name: it.name }]
                              );
                              setStockSearchQ('');
                              setStockSearchResults([]);
                            }}
                          >
                            <span>
                              <b>{it.name}</b> <span className="mono" style={{ color: 'var(--text-muted)' }}>{it.secuCode}</span>
                            </span>
                            <span style={{ fontSize: 11, color: 'var(--navy)' }}>{already ? '已添加' : '+ 添加'}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {customStocks.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {customStocks.map((st) => (
                      <span
                        key={st.secid}
                        className="badge badge-navy"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 8px', fontSize: 11.5 }}
                      >
                        {st.name} <span className="mono">{st.code}</span>
                        <button
                          type="button"
                          onClick={() => setCustomStocks((prev) => prev.filter((x) => x.secid !== st.secid))}
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, display: 'inline-flex' }}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>
                    尚未添加成分股；添加后系统将自动实时拉取成分股涨幅与成交额并按梯队分层展示。
                  </div>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-sm" onClick={() => setCustomModalOpen(false)}>
                {t('取消', 'Cancel')}
              </button>
              <button type="button" className="btn btn-sm btn-primary" disabled={savingCustom} onClick={handleSaveCustomTheme}>
                {savingCustom ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
                {editingCustomId ? t('保存修改', 'Save Changes') : t('创建并查看实时梯队', 'Create & Open Matrix')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
