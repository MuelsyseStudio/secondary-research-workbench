import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Calendar,
  Database,
  Flame,
  Lightbulb,
  Loader2,
  Maximize2,
  Plus,
  Search,
  ShieldAlert,
  TrendingUp,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { EntityRef, KbSearchResponse, SecuritySearchItem, WorkspaceData } from '../types';
import { useI18n } from '../i18n';

interface CommandPaletteProps {
  open: boolean;
  workspace: WorkspaceData;
  onClose: () => void;
  onSelectEntity: (ref: EntityRef) => void;
  onOpenFullscreenStock?: (secid: string, name?: string) => void;
  onAddToWatchlist?: (item: SecuritySearchItem) => Promise<void> | void;
  initialFocusHint?: 'all' | 'stock';
}

function parseKbIdToEntityRef(rawId: string, kindHint?: string): EntityRef | null {
  const s = String(rawId || '').trim();
  const mMethod = s.match(/^M[:\-]?(\d+)$/i);
  if (mMethod) return { kind: 'methodology', id: mMethod[1].padStart(3, '0') };
  const mCog = s.match(/^C[:\-]?(\d+)$/i);
  if (mCog) return { kind: 'cognition', id: mCog[1].padStart(3, '0') };
  const mCf = s.match(/^CF[:\-]?(\d+)$/i);
  if (mCf) return { kind: 'conflict', id: String(Number(mCf[1])) };
  if (kindHint === 'methodology') return { kind: 'methodology', id: s.padStart(3, '0') };
  if (kindHint === 'cognition') return { kind: 'cognition', id: s.padStart(3, '0') };
  if (kindHint === 'conflict') return { kind: 'conflict', id: String(Number(s) || s) };
  return null;
}

type PaletteEntry =
  | {
      kind: 'entity';
      ref: EntityRef;
      group: string;
      code: string;
      title: string;
      snippet: string;
      score: number;
      kbSection?: 'hit' | 'conflict' | 'refuter';
      reasons?: string[];
      warnings?: string[];
    }
  | {
      kind: 'security';
      item: SecuritySearchItem;
      group: string;
      code: string;
      title: string;
      snippet: string;
      score: number;
    };

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  workspace,
  onClose,
  onSelectEntity,
  onOpenFullscreenStock,
  onAddToWatchlist,
  initialFocusHint = 'all',
}) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [secHits, setSecHits] = useState<SecuritySearchItem[]>([]);
  const [secLoading, setSecLoading] = useState(false);
  const [secError, setSecError] = useState<string | null>(null);
  const [kbResp, setKbResp] = useState<KbSearchResponse | null>(null);
  const [kbLoading, setKbLoading] = useState(false);
  const [kbError, setKbError] = useState<string | null>(null);
  const [addingSecid, setAddingSecid] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isKbV2 = workspace.kbMode === 'v2';

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      setSecHits([]);
      setSecError(null);
      setKbResp(null);
      setKbError(null);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // KB v2 混合图谱检索（仅在 v2 模式且输入 >= 2 字符时防抖 180ms 触发，自动取消过期请求）
  useEffect(() => {
    if (!open || !isKbV2) {
      setKbResp(null);
      setKbError(null);
      setKbLoading(false);
      return;
    }
    const q = query.trim();
    if (q.length < 2) {
      setKbResp(null);
      setKbError(null);
      setKbLoading(false);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    setKbLoading(true);
    setKbError(null);
    const timer = setTimeout(() => {
      api
        .kbSearch({ q, limit: 10 }, controller.signal)
        .then((res) => {
          if (!alive) return;
          setKbResp(res);
        })
        .catch((err: any) => {
          if (!alive || err?.name === 'AbortError') return;
          setKbResp(null);
          setKbError(err?.message || t('KB v2 混合检索暂不可用', 'KB v2 hybrid search unavailable'));
        })
        .finally(() => {
          if (alive) setKbLoading(false);
        });
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, isKbV2, query, t]);

  // 实时证券检索（支持空三库/空自选状态下按代码/拼音/名称直接搜股并一键加自选或开全屏 K 线）
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setSecHits([]);
      setSecError(null);
      setSecLoading(false);
      return;
    }
    let alive = true;
    setSecLoading(true);
    setSecError(null);
    const timer = setTimeout(() => {
      api
        .searchSecurities(q)
        .then((res) => {
          if (!alive) return;
          setSecHits((res.items || []).slice(0, 8));
        })
        .catch((err: any) => {
          if (!alive) return;
          setSecHits([]);
          setSecError(err?.message || t('证券检索暂不可用', 'Security search unavailable'));
        })
        .finally(() => {
          if (alive) setSecLoading(false);
        });
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, query, t]);

  const results = useMemo<PaletteEntry[]>(() => {
    const q = query.trim().toLowerCase();
    const hits: PaletteEntry[] = [];

    if (!q) {
      workspace.highFreqCards.slice(0, 4).forEach((c) => {
        hits.push({
          kind: 'entity',
          ref: { kind: 'methodology', id: c.id },
          group: t('高频方法论卡', 'Top Methodology Cards'),
          code: `${t('卡片', 'Card')} ${c.id}`,
          title: c.title,
          snippet: `${t('可信度', 'Credibility')} ${c.credibilityScore ?? '-'} · ${c.reviewCount} ${t('次复盘记录', 'reviews')}`,
          score: 100,
        });
      });
      workspace.cognition.cards
        .slice(-4)
        .reverse()
        .forEach((c) => {
          hits.push({
            kind: 'entity',
            ref: { kind: 'cognition', id: c.id },
            group: t('最新产业认知卡', 'Latest Industry Intel'),
            code: `${t('认知', 'Intel')} ${c.id}`,
            title: c.title,
            snippet: `${t('证据', 'Grade')} ${c.primaryGrade} · ${c.ingestedDate}`,
            score: 90,
          });
        });
      workspace.ledger.dailyReviews.slice(0, 3).forEach((d) => {
        hits.push({
          kind: 'entity',
          ref: { kind: 'daily', id: d.id },
          group: t('近期日度复盘', 'Recent Daily Reviews'),
          code: d.date,
          title: d.title,
          snippet: `${t('评分', 'Score')} ${d.score ?? '-'}/10`,
          score: 80,
        });
      });
      return hits;
    }

    const kbEntries: PaletteEntry[] = [];
    const kbSeenKeys = new Set<string>();
    if (isKbV2 && kbResp && q.length >= 2) {
      (kbResp.results || []).forEach((item, i) => {
        const ref = parseKbIdToEntityRef(item.id, item.kind);
        if (!ref) return;
        const key = `${ref.kind}-${ref.id}`;
        if (kbSeenKeys.has(key)) return;
        kbSeenKeys.add(key);
        kbEntries.push({
          kind: 'entity',
          ref,
          group: t('KB v2 混合图谱检索', 'KB v2 Hybrid Graph'),
          code: item.id,
          title: item.title,
          snippet: (item.coreSummary || item.invalidationText || '').slice(0, 92),
          score: 400 - i,
          kbSection: 'hit',
          reasons: item.reasons || [],
          warnings: item.warnings || [],
        });
      });

      (kbResp.attachedRefuters || []).forEach((rc, i) => {
        const ref = parseKbIdToEntityRef(rc.id, 'cognition');
        if (!ref) return;
        const key = `${ref.kind}-${ref.id}`;
        if (kbSeenKeys.has(key)) return;
        kbSeenKeys.add(key);
        kbEntries.push({
          kind: 'entity',
          ref,
          group: t('1-Hop 反证卡', '1-Hop Refuter'),
          code: rc.id,
          title: rc.title,
          snippet: (rc.coreSummary || '').slice(0, 92),
          score: 360 - i,
          kbSection: 'refuter',
          warnings: [t('反证卡自动挂载', 'Auto-attached refuter')],
        });
      });

      (kbResp.attachedConflicts || []).forEach((cf, i) => {
        const ref = parseKbIdToEntityRef(cf.id, 'conflict');
        if (!ref) return;
        const key = `${ref.kind}-${ref.id}`;
        if (kbSeenKeys.has(key)) return;
        kbSeenKeys.add(key);
        kbEntries.push({
          kind: 'entity',
          ref,
          group: t('1-Hop 关联冲突', '1-Hop Conflict'),
          code: cf.id,
          title: cf.title,
          snippet: (cf.conflictPoint || cf.resolution || '').slice(0, 92),
          score: 340 - i,
          kbSection: 'conflict',
          reasons: [t('图谱冲突判别', 'Graph conflict')],
        });
      });
    }

    // 实时证券标的匹配（支持在空库/空自选场景下直达全屏研股与添加自选）
    if (onOpenFullscreenStock || onAddToWatchlist) {
      secHits.forEach((item, i) => {
        const boost = initialFocusHint === 'stock' || /^[0-9a-zA-Z]{2,8}$/.test(q) ? 185 : 135;
        hits.push({
          kind: 'security',
          item,
          group: t('全市场证券检索', 'Market Securities'),
          code: item.secuCode || item.code,
          title: item.name,
          snippet: `${item.marketKind} · ${item.secid}${onOpenFullscreenStock ? ` · ${t('回车打开全屏 K 线', 'Enter for Fullscreen K-Line')}` : ''}`,
          score: boost - i,
        });
      });
    }

    for (const c of workspace.methodology.cards) {
      let s = 0;
      if (c.id === q || `卡片${c.id}` === q) s += 200;
      if (c.title.toLowerCase().includes(q)) s += 80;
      if (c.system.toLowerCase().includes(q)) s += 40;
      if (c.coreThesis.toLowerCase().includes(q)) s += 30;
      if (c.rawMarkdown.toLowerCase().includes(q)) s += 10;
      if (s > 0) {
        hits.push({
          kind: 'entity',
          ref: { kind: 'methodology', id: c.id },
          group: t('方法论卡片库', 'Methodology'),
          code: `${t('卡片', 'Card')} ${c.id}`,
          title: c.title,
          snippet: c.coreThesis.slice(0, 88),
          score: s,
        });
      }
    }

    for (const cf of workspace.methodology.conflicts) {
      let s = 0;
      if (`冲突${cf.id}` === q || String(cf.id) === q) s += 150;
      if (cf.title.toLowerCase().includes(q)) s += 75;
      if (cf.rawMarkdown.toLowerCase().includes(q)) s += 15;
      if (s > 0) {
        hits.push({
          kind: 'entity',
          ref: { kind: 'conflict', id: String(cf.id) },
          group: t('冲突矩阵', 'Conflicts'),
          code: `${t('冲突', 'Conflict')} ${cf.id}`,
          title: cf.title,
          snippet: cf.conflictPoint.slice(0, 88),
          score: s,
        });
      }
    }

    for (const c of workspace.cognition.cards) {
      let s = 0;
      if (c.id === q || `认知${c.id}` === q) s += 190;
      if (c.title.toLowerCase().includes(q)) s += 80;
      if (c.aShareMapping.toLowerCase().includes(q)) s += 50;
      if (c.facts.toLowerCase().includes(q)) s += 25;
      if (c.rawMarkdown.toLowerCase().includes(q)) s += 10;
      if (s > 0) {
        hits.push({
          kind: 'entity',
          ref: { kind: 'cognition', id: c.id },
          group: t('行业前沿认知库', 'Industry Intel'),
          code: `${t('认知', 'Intel')} ${c.id}`,
          title: c.title,
          snippet: c.aShareMapping.slice(0, 88) || c.facts.slice(0, 88),
          score: s,
        });
      }
    }

    for (const j of workspace.ledger.judgments) {
      let s = 0;
      if (j.recordKey.toLowerCase().includes(q)) s += 120;
      if (j.target.toLowerCase().includes(q)) s += 80;
      if (j.rawMarkdown.toLowerCase().includes(q)) s += 15;
      if (s > 0) {
        hits.push({
          kind: 'entity',
          ref: { kind: 'judgment', id: j.id },
          group: t('标的研判台账', 'Thesis Ledger'),
          code: j.recordKey,
          title: j.target,
          snippet: j.conclusion.slice(0, 88),
          score: s,
        });
      }
    }

    for (const d of workspace.ledger.dailyReviews) {
      let s = 0;
      if (d.date.includes(q)) s += 140;
      if (d.title.toLowerCase().includes(q)) s += 70;
      if (d.rawMarkdown.toLowerCase().includes(q)) s += 12;
      if (s > 0) {
        hits.push({
          kind: 'entity',
          ref: { kind: 'daily', id: d.id },
          group: t('日度复盘台账', 'Daily Reviews'),
          code: d.date,
          title: d.title,
          snippet: d.marketState.slice(0, 88) || `${t('评分', 'Score')} ${d.score ?? '-'}/10`,
          score: s,
        });
      }
    }

    const dedupedLocal = hits
      .filter((h) => h.kind !== 'entity' || !kbSeenKeys.has(`${h.ref.kind}-${h.ref.id}`))
      .sort((a, b) => b.score - a.score)
      .slice(0, 26);

    return [...kbEntries, ...dedupedLocal];
  }, [query, workspace, secHits, kbResp, isKbV2, onOpenFullscreenStock, onAddToWatchlist, initialFocusHint, t]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query, secHits.length, kbResp]);

  if (!open) return null;

  const activateEntry = (hit: PaletteEntry) => {
    if (hit.kind === 'security') {
      onOpenFullscreenStock?.(hit.item.secid, hit.item.name);
      onClose();
      return;
    }
    onSelectEntity(hit.ref);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((idx) => Math.min(Math.max(0, results.length - 1), idx + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((idx) => Math.max(0, idx - 1));
    } else if (e.key === 'Enter' && results[activeIdx]) {
      e.preventDefault();
      activateEntry(results[activeIdx]);
    }
  };

  const iconFor = (entry: PaletteEntry) => {
    if (entry.kind === 'security') return <TrendingUp size={15} color="var(--emerald)" />;
    if (entry.ref.kind === 'methodology') return <BookOpen size={15} color="var(--navy)" />;
    if (entry.ref.kind === 'conflict') return <Flame size={15} color="var(--crimson)" />;
    if (entry.ref.kind === 'cognition') return <Lightbulb size={15} color="var(--teal)" />;
    return <Calendar size={15} color="var(--amber)" />;
  };

  const kbEntryCount = useMemo(
    () => results.filter((r) => r.kind === 'entity' && Boolean(r.kbSection)).length,
    [results]
  );

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('全局三库与证券标的秒搜', 'Global Library & Security Search')}
      onClick={onClose}
      style={{ alignItems: 'flex-start', paddingTop: '9vh' }}
    >
      <div
        className="modal-box"
        style={{ maxWidth: 680, maxHeight: '72vh' }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          {secLoading || kbLoading ? <Loader2 size={18} color="var(--navy)" className="spin" /> : <Search size={18} color="var(--text-muted)" />}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              initialFocusHint === 'stock'
                ? t('输入证券代码、名称或拼音（如 600519 / 茅台 / NVDA）打开全屏 K 线或加入自选…', 'Type stock ticker or name (e.g. 600519 / AAPL / NVDA) to open chart or add to watchlist...')
                : isKbV2
                ? t('KB v2 混合图谱检索 + 全市场标的：输入代码(688809)、同义词(CPO/MEMS)或卡号…', 'KB v2 Hybrid Graph + Tickers: type code (688809), synonym (CPO/MEMS), or card ID...')
                : t('跨三库与全市场检索：输入代码/标的(600519/NVDA)、卡号(001)或关键词…', 'Search 3-library notes or market tickers (e.g. 600519, NVDA, Card 001)...')
            }
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--text)',
              fontSize: 14.5,
            }}
          />
          {isKbV2 && (
            <span className="badge badge-teal mono" style={{ fontSize: 10.5, flexShrink: 0 }}>
              <Database size={10} /> KB v2
            </span>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={t('关闭搜索面板', 'Close search palette')}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ overflowY: 'auto', padding: '8px 10px', flex: 1 }}>
          {kbError && isKbV2 && query.trim().length >= 2 && (
            <div style={{ fontSize: 11.5, color: 'var(--amber)', padding: '4px 10px 4px' }}>
              {t('KB v2 混合检索异常：', 'KB v2 search error: ')}
              {kbError}
            </div>
          )}
          {secError && query.trim().length >= 2 && (
            <div style={{ fontSize: 11.5, color: 'var(--amber)', padding: '4px 10px 6px' }}>
              {t('实时证券检索异常：', 'Live ticker search error: ')}
              {secError}
            </div>
          )}
          {isKbV2 && query.trim().length >= 2 && kbEntryCount > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap',
                padding: '4px 10px 6px',
                fontSize: 11,
                color: 'var(--teal)',
                fontWeight: 700,
              }}
            >
              <Database size={12} />
              <span>{t('KB v2 混合图谱检索', 'KB v2 Hybrid Graph Search')}</span>
              {kbResp && (
                <span className="badge badge-teal mono" style={{ fontSize: 10, padding: '0 5px' }}>
                  {kbResp.elapsedMs}ms
                </span>
              )}
              {kbResp?.matchedSynonyms && kbResp.matchedSynonyms.length > 0 && (
                <span className="badge badge-muted" style={{ fontSize: 10, padding: '0 5px' }}>
                  {t('同义词', 'Syn')}: {kbResp.matchedSynonyms.slice(0, 3).join('/')}
                </span>
              )}
              {kbResp?.attachedConflicts && kbResp.attachedConflicts.length > 0 && (
                <span className="badge badge-crimson" style={{ fontSize: 10, padding: '0 5px' }}>
                  {t(`关联冲突 ${kbResp.attachedConflicts.length}`, `${kbResp.attachedConflicts.length} Conflicts`)}
                </span>
              )}
            </div>
          )}
          {results.length === 0 ? (
            <div className="empty-state">
              {query.trim()
                ? secLoading || kbLoading
                  ? t(`正在检索「${query}」...`, `Searching "${query}"...`)
                  : t(`未在三库或公开证券列表中匹配到「${query}」`, `No matching notes or securities for "${query}"`)
                : t('当前空间暂无三库卡片；直接输入证券代码或名称（如 600519 / AAPL）即可秒搜标的并加入自选。', 'Empty workspace — type a ticker (e.g. 600519 / AAPL) to search securities or open fullscreen charts.')}
            </div>
          ) : (
            results.map((hit, idx) => {
              const isKbHit = hit.kind === 'entity' && Boolean(hit.kbSection);
              const showLocalDivider =
                isKbV2 && kbEntryCount > 0 && idx === kbEntryCount;
              const key =
                hit.kind === 'security'
                  ? `sec-${hit.item.secid}`
                  : `${hit.kbSection ? `kb-${hit.kbSection}-` : ''}${hit.ref.kind}-${hit.ref.id}`;
              return (
                <React.Fragment key={key}>
                  {showLocalDivider && (
                    <div
                      style={{
                        borderTop: '1px solid var(--border)',
                        margin: '6px 8px 4px',
                        paddingTop: 6,
                        fontSize: 11,
                        fontWeight: 700,
                        color: 'var(--text-muted)',
                      }}
                    >
                      {t('本地即时匹配与全市场证券', 'Instant Local & Market Matches')}
                    </div>
                  )}
                  <div
                    onMouseEnter={() => setActiveIdx(idx)}
                    style={{
                      width: '100%',
                      borderRadius: 8,
                      background: idx === activeIdx ? 'var(--navy-soft)' : 'transparent',
                      borderLeft:
                        hit.kind === 'entity' && hit.kbSection === 'conflict'
                          ? '3px solid var(--crimson)'
                          : hit.kind === 'entity' && hit.kbSection === 'refuter'
                          ? '3px solid var(--amber)'
                          : undefined,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      marginBottom: 2,
                      paddingRight: 6,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => activateEntry(hit)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        textAlign: 'left',
                        padding: '9px 11px',
                        border: 'none',
                        cursor: 'pointer',
                        background: 'transparent',
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                      }}
                    >
                      <div style={{ marginTop: 2 }}>
                        {hit.kind === 'entity' && hit.kbSection === 'refuter' ? (
                          <ShieldAlert size={15} color="var(--crimson)" />
                        ) : (
                          iconFor(hit)
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 2 }}>
                          <span
                            className={`badge ${
                              hit.kind === 'security'
                                ? 'badge-emerald'
                                : hit.kind === 'entity' && hit.kbSection === 'conflict'
                                ? 'badge-crimson'
                                : hit.kind === 'entity' && hit.kbSection === 'refuter'
                                ? 'badge-amber'
                                : isKbHit
                                ? 'badge-teal'
                                : 'badge-muted'
                            } mono`}
                          >
                            {hit.code}
                          </span>
                          <span style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {hit.title}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto', flexShrink: 0 }}>
                            {hit.group}
                          </span>
                        </div>
                        {hit.snippet && (
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {hit.snippet}
                          </div>
                        )}
                        {hit.kind === 'entity' && ((hit.reasons && hit.reasons.length > 0) || (hit.warnings && hit.warnings.length > 0)) && (
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                            {(hit.warnings || []).map((w, wi) => (
                              <span
                                key={`w-${wi}`}
                                className="badge badge-crimson"
                                style={{ fontSize: 10, padding: '0 5px', display: 'inline-flex', alignItems: 'center', gap: 3 }}
                              >
                                <AlertTriangle size={9} /> {w}
                              </span>
                            ))}
                            {(hit.reasons || []).slice(0, 3).map((r, ri) => (
                              <span
                                key={`r-${ri}`}
                                className="badge badge-navy"
                                style={{ fontSize: 10, padding: '0 5px' }}
                              >
                                {r}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </button>
                    {hit.kind === 'security' && (
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        {onAddToWatchlist && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            style={{ padding: '3px 7px', fontSize: 11 }}
                            disabled={addingSecid === hit.item.secid}
                            onClick={async (e) => {
                              e.stopPropagation();
                              setAddingSecid(hit.item.secid);
                              try {
                                await onAddToWatchlist(hit.item);
                              } finally {
                                setAddingSecid(null);
                              }
                            }}
                            title={t('加入当前空间自选', 'Add to workspace watchlist')}
                          >
                            <Plus size={11} /> {t('自选', 'Watch')}
                          </button>
                        )}
                        {onOpenFullscreenStock && (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            style={{ padding: '3px 7px', fontSize: 11 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenFullscreenStock(hit.item.secid, hit.item.name);
                              onClose();
                            }}
                            title={t('打开全屏 K 线研究', 'Open fullscreen K-line')}
                          >
                            <Maximize2 size={11} /> {t('研股', 'Chart')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </React.Fragment>
              );
            })
          )}
        </div>

        <div
          style={{
            padding: '8px 14px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 11.5,
            color: 'var(--text-muted)',
          }}
        >
          <span>{t('↑↓ 切换 · Enter 打开 · Esc 关闭', '↑↓ Navigate · Enter Open · Esc Close')}</span>
          <span>
            {isKbV2
              ? t('KB v2 SQLite FTS5 混合图谱 + 全市场证券代码', 'KB v2 Hybrid Graph + Live Market Tickers')
              : t('同时检索本地三库与全市场证券代码', 'Searches 3-library notes & live market tickers')}
          </span>
        </div>
      </div>
    </div>
  );
};
