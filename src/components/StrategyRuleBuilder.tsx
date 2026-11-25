import React, { useMemo, useState } from 'react';
import { BookOpen, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { api } from '../api';
import type { AiProvider, MethodologyCard, VisualRuleCondition, VisualRuleConfig } from '../types';

interface StrategyRuleBuilderProps {
  ruleConfig: VisualRuleConfig;
  onChange: (next: VisualRuleConfig) => void;
}

const INDICATOR_OPTIONS: { value: VisualRuleCondition['indicator']; label: string; hasPeriod: boolean }[] = [
  { value: 'CLOSE', label: '收盘价 (CLOSE)', hasPeriod: false },
  { value: 'MA', label: '简单均线 (MA)', hasPeriod: true },
  { value: 'EMA', label: '指数均线 (EMA)', hasPeriod: true },
  { value: 'RSI', label: '强弱指标 (RSI)', hasPeriod: true },
  { value: 'BIAS', label: '均线乖离率% (BIAS)', hasPeriod: true },
  { value: 'MACD_HIST', label: 'MACD 动能柱', hasPeriod: false },
  { value: 'BOLL_UPPER', label: '布林上轨', hasPeriod: true },
  { value: 'BOLL_LOWER', label: '布林下轨', hasPeriod: true },
  { value: 'VOL_RATIO', label: '量能倍数 (较N日均量)', hasPeriod: true },
];

const OP_OPTIONS: { value: VisualRuleCondition['op']; label: string }[] = [
  { value: 'cross_above', label: '金叉 / 上穿' },
  { value: 'cross_below', label: '死叉 / 下穿' },
  { value: '>', label: '大于 (>)' },
  { value: '>=', label: '大于等于 (>=)' },
  { value: '<', label: '小于 (<)' },
  { value: '<=', label: '小于等于 (<=)' },
];

const RHS_INDICATORS: { value: NonNullable<VisualRuleCondition['rhsIndicator']>; label: string }[] = [
  { value: 'MA', label: '均线 (MA)' },
  { value: 'EMA', label: '指数均线 (EMA)' },
  { value: 'BOLL_UPPER', label: '布林上轨' },
  { value: 'BOLL_LOWER', label: '布林下轨' },
];

function ConditionRow({
  cond,
  onChange,
  onRemove,
}: {
  cond: VisualRuleCondition;
  onChange: (next: VisualRuleCondition) => void;
  onRemove: () => void;
}) {
  const indMeta = INDICATOR_OPTIONS.find((o) => o.value === cond.indicator);
  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '6px 8px',
        borderRadius: 8,
        background: 'var(--bg-subtle)',
        border: '1px solid var(--border)',
      }}
    >
      <select
        className="input"
        style={{ width: 160, fontSize: 12 }}
        value={cond.indicator}
        onChange={(e) => onChange({ ...cond, indicator: e.target.value as VisualRuleCondition['indicator'] })}
      >
        {INDICATOR_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {indMeta?.hasPeriod && (
        <input
          type="number"
          className="input mono"
          style={{ width: 64, fontSize: 12 }}
          min={2}
          max={250}
          value={cond.period ?? 20}
          onChange={(e) => onChange({ ...cond, period: Math.max(2, Number(e.target.value) || 5) })}
          title="指标周期 N"
        />
      )}

      <select
        className="input"
        style={{ width: 125, fontSize: 12 }}
        value={cond.op}
        onChange={(e) => onChange({ ...cond, op: e.target.value as VisualRuleCondition['op'] })}
      >
        {OP_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <select
        className="input"
        style={{ width: 105, fontSize: 12 }}
        value={cond.rhsType}
        onChange={(e) =>
          onChange({
            ...cond,
            rhsType: e.target.value as 'value' | 'indicator',
            rhsIndicator: cond.rhsIndicator || 'MA',
            rhsPeriod: cond.rhsPeriod ?? 20,
            value: cond.value ?? 0,
          })
        }
      >
        <option value="indicator">对比指标</option>
        <option value="value">固定阈值</option>
      </select>

      {cond.rhsType === 'indicator' ? (
        <>
          <select
            className="input"
            style={{ width: 125, fontSize: 12 }}
            value={cond.rhsIndicator || 'MA'}
            onChange={(e) =>
              onChange({ ...cond, rhsIndicator: e.target.value as VisualRuleCondition['rhsIndicator'] })
            }
          >
            {RHS_INDICATORS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <input
            type="number"
            className="input mono"
            style={{ width: 64, fontSize: 12 }}
            min={2}
            max={250}
            value={cond.rhsPeriod ?? 20}
            onChange={(e) => onChange({ ...cond, rhsPeriod: Math.max(2, Number(e.target.value) || 20) })}
            title="右侧指标周期"
          />
        </>
      ) : (
        <input
          type="number"
          step="0.5"
          className="input mono"
          style={{ width: 92, fontSize: 12 }}
          value={cond.value ?? 0}
          onChange={(e) => onChange({ ...cond, value: Number(e.target.value) })}
          placeholder="数值"
        />
      )}

      <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove} title="删除条件">
        <Trash2 size={13} color="var(--crimson)" />
      </button>
    </div>
  );
}

export const StrategyRuleBuilder: React.FC<StrategyRuleBuilderProps> = ({ ruleConfig, onChange }) => {
  const updateList = (key: 'entryConditions' | 'exitConditions', idx: number, nextItem: VisualRuleCondition) => {
    const arr = [...ruleConfig[key]];
    arr[idx] = nextItem;
    onChange({ ...ruleConfig, [key]: arr });
  };
  const removeList = (key: 'entryConditions' | 'exitConditions', idx: number) => {
    const arr = ruleConfig[key].filter((_, i) => i !== idx);
    onChange({ ...ruleConfig, [key]: arr });
  };
  const addCond = (key: 'entryConditions' | 'exitConditions') => {
    const def: VisualRuleCondition =
      key === 'entryConditions'
        ? { indicator: 'MA', period: 5, op: 'cross_above', rhsType: 'indicator', rhsIndicator: 'MA', rhsPeriod: 20 }
        : { indicator: 'MA', period: 5, op: 'cross_below', rhsType: 'indicator', rhsIndicator: 'MA', rhsPeriod: 20 };
    onChange({ ...ruleConfig, [key]: [...ruleConfig[key], def] });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px' }}>
          <label className="field-label">规则策略名称</label>
          <input
            className="input"
            value={ruleConfig.name}
            onChange={(e) => onChange({ ...ruleConfig, name: e.target.value })}
            placeholder="例如：均线多头+不追高乖离策略"
          />
        </div>
        <div style={{ width: 160 }}>
          <label className="field-label">单标的目标仓位 (%)</label>
          <input
            type="number"
            className="input mono"
            min={5}
            max={100}
            step={5}
            value={Math.round((ruleConfig.positionWeight || 0.35) * 100)}
            onChange={(e) =>
              onChange({ ...ruleConfig, positionWeight: Math.max(0.05, Math.min(1, Number(e.target.value) / 100)) })
            }
          />
        </div>
      </div>

      {/* 入场条件 */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="badge badge-emerald">入场买入条件</span>
            <select
              className="input"
              style={{ width: 110, fontSize: 11.5, padding: '2px 6px' }}
              value={ruleConfig.entryLogic}
              onChange={(e) => onChange({ ...ruleConfig, entryLogic: e.target.value as 'AND' | 'OR' })}
            >
              <option value="AND">同时满足 (AND)</option>
              <option value="OR">任一满足 (OR)</option>
            </select>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => addCond('entryConditions')}>
            <Plus size={12} /> 添加入场条件
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ruleConfig.entryConditions.map((c, idx) => (
            <ConditionRow
              key={idx}
              cond={c}
              onChange={(next) => updateList('entryConditions', idx, next)}
              onRemove={() => removeList('entryConditions', idx)}
            />
          ))}
          {ruleConfig.entryConditions.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>请至少添加 1 条入场买入条件</div>
          )}
        </div>
      </div>

      {/* 出场条件 */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="badge badge-crimson">出场平仓条件</span>
            <select
              className="input"
              style={{ width: 110, fontSize: 11.5, padding: '2px 6px' }}
              value={ruleConfig.exitLogic}
              onChange={(e) => onChange({ ...ruleConfig, exitLogic: e.target.value as 'AND' | 'OR' })}
            >
              <option value="OR">任一触发即走 (OR)</option>
              <option value="AND">同时满足 (AND)</option>
            </select>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => addCond('exitConditions')}>
            <Plus size={12} /> 添加出场条件
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ruleConfig.exitConditions.map((c, idx) => (
            <ConditionRow
              key={idx}
              cond={c}
              onChange={(next) => updateList('exitConditions', idx, next)}
              onRemove={() => removeList('exitConditions', idx)}
            />
          ))}
          {ruleConfig.exitConditions.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>可添加止盈/死叉出场条件，或依赖下方风控止损退出</div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 从《方法论卡片库》AI 生成策略弹窗
// ============================================================================

export const CardToStrategyModal: React.FC<{
  open: boolean;
  cards: MethodologyCard[];
  market: string;
  provider?: AiProvider;
  onClose: () => void;
  onGenerated: (draft: {
    name: string;
    description: string;
    cardRefs: string[];
    defaultParams: Record<string, any>;
    code: string;
  }) => void;
  onToast: (msg: string) => void;
}> = ({ open, cards, market, provider, onClose, onGenerated, onToast }) => {
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [extraReq, setExtraReq] = useState('');
  const [loading, setLoading] = useState(false);

  const activeCards = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cards
      .filter((c) => !c.isRevoked)
      .filter(
        (c) =>
          !q ||
          c.id.toLowerCase().includes(q) ||
          c.title.toLowerCase().includes(q) ||
          (c.coreThesis || '').toLowerCase().includes(q)
      )
      .slice(0, 60);
  }, [cards, search]);

  if (!open) return null;

  const toggleId = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-6)));
  };

  const handleGenerate = async () => {
    if (!selectedIds.length) {
      onToast('请至少勾选 1 张方法论卡片');
      return;
    }
    setLoading(true);
    try {
      const res = await api.generateQuantStrategyFromCards({
        cardIds: selectedIds,
        market,
        extraRequirements: extraReq,
        provider,
      });
      onGenerated(res.draft);
      onToast(`已基于卡片 ${res.draft.cardRefs.join(', ')} 生成原创策略代码 (${res.model})`);
      onClose();
    } catch (err: any) {
      onToast(`AI 策略生成失败：${err.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        style={{ width: 'min(760px, 94vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <BookOpen size={17} color="var(--navy)" />
            <span style={{ fontWeight: 700, fontSize: 15 }}>从《方法论卡片库》AI 生成可执行回测策略</span>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <input
          className="input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索卡号或关键词（如 053、乖离、均线、止损、2B、情绪周期）..."
          style={{ marginBottom: 8 }}
        />

        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
          已选卡片 ({selectedIds.length}/6)：{selectedIds.length ? selectedIds.join(', ') : '未选择'}
        </div>

        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            minHeight: 200,
          }}
        >
          {activeCards.map((c) => {
            const checked = selectedIds.includes(c.id);
            return (
              <label
                key={c.id}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'flex-start',
                  padding: '6px 8px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: checked ? 'var(--navy-soft)' : 'transparent',
                  border: checked ? '1px solid var(--navy)' : '1px solid transparent',
                }}
              >
                <input type="checkbox" checked={checked} onChange={() => toggleId(c.id)} style={{ marginTop: 3 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                    <span className="mono">卡片 {c.id}</span> · {c.title}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.coreThesis || c.logicChain || '—'}
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        <div style={{ marginTop: 10 }}>
          <label className="field-label">补充实现要求（选填）</label>
          <input
            className="input"
            value={extraReq}
            onChange={(e) => setExtraReq(e.target.value)}
            placeholder="例如：严格限制 MA5 乖离 < 8%，跌破 MA20 无条件清仓，带中文注释"
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={loading || !selectedIds.length} onClick={handleGenerate}>
            {loading ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
            {loading ? 'AI 正在转译策略代码...' : '生成 Python 策略草稿'}
          </button>
        </div>
      </div>
    </div>
  );
};
