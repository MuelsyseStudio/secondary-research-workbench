import React from 'react';
import { ArrowUpRight, BookOpen, Flame, Lightbulb, Target, X } from 'lucide-react';
import type { EntityRef, WorkspaceData } from '../types';
import { CardLinkText } from './CardLinkText';
import { MarkdownBlock } from './MarkdownBlock';

interface EntityPreviewDrawerProps {
  entity: EntityRef | null;
  workspace: WorkspaceData;
  onClose: () => void;
  onJumpToMain: (ref: EntityRef) => void;
  onPreviewEntity: (ref: EntityRef) => void;
}

/**
 * 跨库双链右侧快速预览抽屉：
 * 读台账或认知卡时，点击「卡片 159」「认知卡 044」「冲突 24」即可就地检视全文，不打断当前阅读上下文。
 */
export const EntityPreviewDrawer: React.FC<EntityPreviewDrawerProps> = ({
  entity,
  workspace,
  onClose,
  onJumpToMain,
  onPreviewEntity,
}) => {
  if (!entity) return null;

  let headerIcon = <BookOpen size={17} color="var(--navy)" />;
  let badgeText = '';
  let titleText = '';
  let body: React.ReactNode = <div className="empty-state">未找到对应条目。</div>;

  if (entity.kind === 'methodology') {
    const card = workspace.methodology.cards.find((c) => c.id === entity.id);
    badgeText = `方法论卡片 ${entity.id}`;
    if (card) {
      titleText = card.title;
      body = (
        <div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            <span className="badge badge-navy">{card.system}</span>
            <span className="badge badge-emerald num">可信度 {card.credibilityScore ?? '-'}</span>
            {card.isArchived && <span className="badge badge-violet">封存</span>}
            {card.isHighPaused && <span className="badge badge-amber">高位暂停</span>}
            {card.isRevoked && <span className="badge badge-crimson">已撤销</span>}
            {card.reviewLogs.length > 0 && <span className="badge badge-muted">{card.reviewLogs.length} 条复盘</span>}
          </div>
          <div className="field-block field-block-thesis">
            <div className="field-block-label">核心论断</div>
            <CardLinkText text={card.coreThesis} onOpenEntity={onPreviewEntity} />
          </div>
          {card.logicChain && (
            <div className="field-block">
              <div className="field-block-label">逻辑链条</div>
              <CardLinkText text={card.logicChain} onOpenEntity={onPreviewEntity} />
            </div>
          )}
          <div className="field-block">
            <div className="field-block-label">适用条件</div>
            <CardLinkText text={card.applicableConditions} onOpenEntity={onPreviewEntity} />
          </div>
          <div className="field-block field-block-danger">
            <div className="field-block-label" style={{ color: 'var(--crimson)' }}>失效信号</div>
            <CardLinkText text={card.invalidationSignals} onOpenEntity={onPreviewEntity} />
          </div>
          <div className="field-block">
            <div className="field-block-label">历史案例与来源</div>
            <div style={{ marginBottom: 6 }}>
              <CardLinkText text={card.historicalCases} onOpenEntity={onPreviewEntity} />
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
              来源：<CardLinkText text={card.source} onOpenEntity={onPreviewEntity} />
            </div>
          </div>
        </div>
      );
    }
  } else if (entity.kind === 'cognition') {
    headerIcon = <Lightbulb size={17} color="var(--teal)" />;
    const card = workspace.cognition.cards.find((c) => c.id === entity.id);
    badgeText = `产业认知卡 ${entity.id}`;
    if (card) {
      titleText = card.title;
      body = (
        <div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            <span className={`badge ${card.primaryGrade === 'A' ? 'badge-emerald' : card.primaryGrade === 'B' ? 'badge-navy' : 'badge-amber'}`}>
              证据等级 {card.evidenceGrades.join('/')}
            </span>
            {card.ingestedDate && <span className="badge badge-muted">{card.ingestedDate} 入库</span>}
            {card.isPartiallyFalsified && <span className="badge badge-crimson">部分证伪</span>}
            {card.isArchived && <span className="badge badge-muted">已归档</span>}
          </div>
          <div className="field-block field-block-fact">
            <div className="field-block-label" style={{ color: 'var(--emerald)' }}>客观事实 / 要点</div>
            <CardLinkText text={card.facts} onOpenEntity={onPreviewEntity} />
          </div>
          <div className="field-block field-block-analysis">
            <div className="field-block-label" style={{ color: 'var(--navy)' }}>产业含义（分析）</div>
            <CardLinkText text={card.industryImplications} onOpenEntity={onPreviewEntity} />
          </div>
          <div className="field-block field-block-mapping">
            <div className="field-block-label" style={{ color: 'var(--teal)' }}>A 股映射（分析，非事实）</div>
            <CardLinkText text={card.aShareMapping} onOpenEntity={onPreviewEntity} />
          </div>
          <div className="field-block field-block-danger">
            <div className="field-block-label" style={{ color: 'var(--crimson)' }}>失效 / 更新条件</div>
            <CardLinkText text={card.invalidationConditions} onOpenEntity={onPreviewEntity} />
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            来源：{card.source}
          </div>
        </div>
      );
    }
  } else if (entity.kind === 'conflict') {
    headerIcon = <Flame size={17} color="var(--crimson)" />;
    const cf = workspace.methodology.conflicts.find((c) => String(c.id) === entity.id);
    badgeText = `冲突矩阵 #${entity.id}`;
    if (cf) {
      titleText = cf.title;
      body = (
        <div>
          <div className="field-block">
            <div className="field-block-label">冲突双方</div>
            <CardLinkText text={cf.sides} onOpenEntity={onPreviewEntity} />
          </div>
          <div className="field-block field-block-danger">
            <div className="field-block-label" style={{ color: 'var(--crimson)' }}>核心冲突点</div>
            <CardLinkText text={cf.conflictPoint} onOpenEntity={onPreviewEntity} />
          </div>
          <div className="field-block field-block-mapping">
            <div className="field-block-label" style={{ color: 'var(--teal)' }}>折中思路与判别变量</div>
            <CardLinkText text={cf.resolution} onOpenEntity={onPreviewEntity} />
          </div>
        </div>
      );
    }
  } else if (entity.kind === 'judgment') {
    headerIcon = <Target size={17} color="var(--amber)" />;
    const judge = workspace.ledger.judgments.find((j) => j.id === entity.id || j.recordKey === entity.id);
    badgeText = judge ? `历史研判 ${judge.recordKey}` : `研判 ${entity.id}`;
    if (judge) {
      titleText = judge.target;
      const sameGroup = (workspace.ledger.targetGroups || []).find((g) => g.judgmentIds.includes(judge.id));
      const matchedBackfills = sameGroup
        ? workspace.ledger.backfills.filter((b) => sameGroup.backfillIds.includes(b.id) && (b.recordKey === judge.recordKey || b.title.includes(judge.recordKey)))
        : workspace.ledger.backfills.filter((b) => b.recordKey === judge.recordKey);

      body = (
        <div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            <span className="badge badge-amber mono">{judge.recordKey}</span>
            {judge.date && <span className="badge badge-muted">{judge.date}</span>}
            {judge.score !== null && (
              <span className={`badge num ${judge.score >= 6.5 ? 'badge-emerald' : judge.score >= 5 ? 'badge-amber' : 'badge-crimson'}`}>
                评分 {judge.score} / 10
              </span>
            )}
            {sameGroup && sameGroup.count > 1 && (
              <span className="badge badge-navy">同标的共 {sameGroup.count} 次研判</span>
            )}
          </div>
          {judge.conclusion && (
            <div className="field-block field-block-thesis">
              <div className="field-block-label">一句话结论</div>
              <CardLinkText text={judge.conclusion} onOpenEntity={onPreviewEntity} />
            </div>
          )}
          {judge.hypotheses.length > 0 && (
            <div className="field-block">
              <div className="field-block-label">事前关键假设（{judge.hypotheses.length} 条）</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {judge.hypotheses.map((h) => (
                  <div key={h.id} style={{ fontSize: 12.5 }}>
                    <span className="badge badge-amber mono" style={{ marginRight: 6 }}>{h.id}</span>
                    <CardLinkText text={h.content} onOpenEntity={onPreviewEntity} />
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="field-block">
            <div className="field-block-label">研判正文档案</div>
            <MarkdownBlock content={judge.rawMarkdown} onOpenEntity={onPreviewEntity} />
          </div>
          {matchedBackfills.length > 0 && (
            <div className="field-block field-block-mapping">
              <div className="field-block-label" style={{ color: 'var(--teal)' }}>
                配套复盘回填（{matchedBackfills.length} 条）
              </div>
              {matchedBackfills.map((bf) => (
                <div key={bf.id} style={{ marginTop: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 4 }}>{bf.title}</div>
                  <MarkdownBlock content={bf.rawMarkdown} onOpenEntity={onPreviewEntity} />
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
              {headerIcon}
              <span className="badge badge-muted mono">{badgeText}</span>
            </div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', lineHeight: 1.35 }}>
              {titleText || '未找到条目'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                onJumpToMain(entity);
                onClose();
              }}
            >
              主屏打开 <ArrowUpRight size={13} />
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="modal-body">{body}</div>
      </div>
    </div>
  );
};
