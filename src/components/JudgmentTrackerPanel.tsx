import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Crosshair,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import type { EntityRef, JudgmentTrackerResponse } from '../types';

interface JudgmentTrackerPanelProps {
  onOpenEntity: (ref: EntityRef) => void;
  onOpenTechnical?: (secidOrQuery: string) => void;
  onToast: (msg: string) => void;
}

function pctStyle(v: number | null | undefined) {
  if (v == null) return { color: 'var(--text-muted)' };
  if (v > 0) return { color: '#dc2626', fontWeight: 700 };
  if (v < 0) return { color: '#16a34a', fontWeight: 700 };
  return { color: 'var(--text-secondary)' };
}

function fmtPct(v: number | null | undefined) {
  if (v == null) return '--';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

export const JudgmentTrackerPanel: React.FC<JudgmentTrackerPanelProps> = ({
  onOpenEntity,
  onOpenTechnical,
  onToast,
}) => {
  const [data, setData] = useState<JudgmentTrackerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // 新增否决/放弃记录表单
  const [showVetoForm, setShowVetoForm] = useState(false);
  const [vetoForm, setVetoForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    code: '',
    name: '',
    marketKind: 'CN' as 'CN' | 'US' | 'HK',
    vetoType: 'veto' as 'veto' | 'watch_pass' | 'missed',
    direction: '',
    cardIds: '',
    reason: '',
  });
  const [submittingVeto, setSubmittingVeto] = useState(false);

  const loadTracker = useCallback(
    async (force = false) => {
      if (force) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await api.getJudgmentTracker(force);
        setData(res);
      } catch (err: any) {
        onToast(`加载研判 T+N 追踪失败：${err.message}`);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [onToast]
  );

  useEffect(() => {
    loadTracker(false);
  }, [loadTracker]);

  const handleAddVeto = async () => {
    if (!vetoForm.code.trim() && !vetoForm.name.trim()) {
      onToast('请填写标的代码或名称');
      return;
    }
    if (!vetoForm.reason.trim()) {
      onToast('按否决留痕纪律，必须填写放弃/否决原因（禁止静默放弃）');
      return;
    }
    setSubmittingVeto(true);
    try {
      await api.addVetoEntry({
        ...vetoForm,
        cardIds: vetoForm.cardIds
          .split(/[,，/\s]+/)
          .map((x) => x.trim())
          .filter(Boolean),
      });
      onToast('已录入否决观察池，并开始自动追踪 T+5 / T+20 对照表现！');
      setVetoForm((p) => ({ ...p, code: '', name: '', reason: '', cardIds: '' }));
      setShowVetoForm(false);
      await loadTracker(false);
    } catch (err: any) {
      onToast(`保存失败：${err.message}`);
    } finally {
      setSubmittingVeto(false);
    }
  };

  const handleDeleteVeto = async (id: string) => {
    try {
      await api.deleteVetoEntry(id);
      onToast('已删除该条否决记录');
      await loadTracker(false);
    } catch (err: any) {
      onToast(`删除失败：${err.message}`);
    }
  };

  if (loading && !data) {
    return (
      <div className="panel panel-pad" style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
        <Loader2 size={20} className="spin" /> 正在并发拉取历史研判与否决池的真实 T+5 / T+20 / T+60 行情走势...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 顶栏：评分校准曲线 + 看多 vs 否决 胜率对照审计 */}
      <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 15.5, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 7 }}>
              <BarChart3 size={17} color="var(--navy)" />
              研判假设 T+N 自动回填追踪 & 否决池对照审计（Veto Ledger）
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              自动拉取台账每份研判与被否决候选的真实后续涨跌幅，检验「评分体系区分度」与「红线是否过严踏空」
            </div>
          </div>
          <div style={{ display: 'flex', gap: 7 }}>
            <button type="button" className="btn btn-amber btn-sm" onClick={() => setShowVetoForm((v) => !v)}>
              <Plus size={13} /> 登记否决/放弃标的
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={refreshing} onClick={() => loadTracker(true)}>
              <RefreshCw size={13} className={refreshing ? 'spin' : ''} /> {refreshing ? '强制重算行情...' : '刷新最新实盘价'}
            </button>
          </div>
        </div>

        {/* 评分校准分桶三卡片 */}
        {data && (
          <div className="grid-3" style={{ gap: 10 }}>
            {data.calibrationBuckets.map((b) => (
              <div
                key={b.key}
                style={{
                  padding: '10px 13px',
                  borderRadius: 9,
                  background: 'var(--bg-soft)',
                  border: '1px solid var(--border)',
                  borderTop: `3px solid ${b.key === 'high' ? '#dc2626' : b.key === 'mid' ? '#d97706' : '#0f766e'}`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginBottom: 4 }}>
                  <strong>{b.label}</strong>
                  <span className="badge badge-muted mono">{b.count} 份</span>
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: 12, flexWrap: 'wrap' }}>
                  <span>
                    胜率：<strong className="mono">{b.winRatePct != null ? `${b.winRatePct}%` : '--'}</strong>
                  </span>
                  <span>
                    T+5均：<span className="mono" style={pctStyle(b.avgRetT5Pct)}>{fmtPct(b.avgRetT5Pct)}</span>
                  </span>
                  <span>
                    T+20均：<span className="mono" style={pctStyle(b.avgRetT20Pct)}>{fmtPct(b.avgRetT20Pct)}</span>
                  </span>
                  <span>
                    至今均：<span className="mono" style={pctStyle(b.avgRetSincePct)}>{fmtPct(b.avgRetSincePct)}</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 看多研判 vs 否决池对照诊断条（ai-mock-trade 精华） */}
        {data && (
          <div
            style={{
              padding: '10px 13px',
              borderRadius: 9,
              background: data.buyVsVetoAudit.overTighteningWarning ? 'var(--crimson-soft)' : 'var(--navy-soft)',
              border: `1px solid ${
                data.buyVsVetoAudit.overTighteningWarning
                  ? 'color-mix(in srgb, var(--crimson) 35%, transparent)'
                  : 'color-mix(in srgb, var(--navy) 28%, transparent)'
              }`,
              fontSize: 12.5,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {data.buyVsVetoAudit.overTighteningWarning ? (
                <AlertTriangle size={16} color="var(--crimson)" />
              ) : (
                <CheckCircle2 size={16} color="var(--navy)" />
              )}
              <span>
                <strong>看多研判 vs 否决池对照审计：</strong>
                {data.buyVsVetoAudit.verdict}
              </span>
            </div>
            <div className="mono" style={{ fontSize: 11.5, display: 'flex', gap: 10 }}>
              <span>精准排雷 {data.buyVsVetoAudit.dodgeCrashCount} 次</span>
              <span>误杀大牛 {data.buyVsVetoAudit.missedBigWinCount} 次</span>
            </div>
          </div>
        )}
      </div>

      {/* 登记否决标的抽屉表单 */}
      {showVetoForm && (
        <div className="panel panel-pad" style={{ background: 'var(--bg-soft)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>
            <ShieldAlert size={15} color="var(--amber)" />
            新增否决 / 放弃观察记录（记录"为何不买"，事后自动验证是精准排雷还是规则过严踏空）
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
            <input
              className="input mono"
              type="date"
              value={vetoForm.date}
              onChange={(e) => setVetoForm((p) => ({ ...p, date: e.target.value }))}
            />
            <input
              className="input mono"
              placeholder="代码（如 300308 / NVDA）"
              value={vetoForm.code}
              onChange={(e) => setVetoForm((p) => ({ ...p, code: e.target.value }))}
            />
            <input
              className="input"
              placeholder="标的简称（如 中际旭创）"
              value={vetoForm.name}
              onChange={(e) => setVetoForm((p) => ({ ...p, name: e.target.value }))}
            />
            <select
              className="select"
              value={vetoForm.vetoType}
              onChange={(e) => setVetoForm((p) => ({ ...p, vetoType: e.target.value as any }))}
            >
              <option value="veto">红线否决（主动放弃）</option>
              <option value="watch_pass">观察放过（赔率不够）</option>
              <option value="missed">盘中踏空（未及时下手）</option>
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 8 }}>
            <input
              className="input"
              placeholder="所属主线/方向（如 光模块/AI算力）"
              value={vetoForm.direction}
              onChange={(e) => setVetoForm((p) => ({ ...p, direction: e.target.value }))}
            />
            <input
              className="input mono"
              placeholder="触发方法论卡号（如 174/178）"
              value={vetoForm.cardIds}
              onChange={(e) => setVetoForm((p) => ({ ...p, cardIds: e.target.value }))}
            />
            <input
              className="input"
              placeholder="否决/放弃硬理由（必填，如 MA5乖离+11%追高红线 / 板块尾盘炸板退潮）"
              value={vetoForm.reason}
              onChange={(e) => setVetoForm((p) => ({ ...p, reason: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn btn-sm" onClick={() => setShowVetoForm(false)}>
              取消
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={submittingVeto} onClick={handleAddVeto}>
              {submittingVeto ? '保存中...' : '落入否决观察池'}
            </button>
          </div>
        </div>
      )}

      {/* 正式研判全量 T+5 / T+20 / T+60 真实绩效追踪表 */}
      <div className="panel">
        <div className="panel-header">
          <h3 className="panel-title">台账正式研判 T+N 实盘走势回填追踪（共 {data?.judgments.length || 0} 份）</h3>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            更新于 {data?.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : '--'}
          </span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>编号 / 标的</th>
                <th>研判日 / 评分</th>
                <th>基准价 → 现价</th>
                <th>T+5</th>
                <th>T+20</th>
                <th>T+60</th>
                <th>至今收益</th>
                <th>区间极值(高/回撤)</th>
                <th>假设到期</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {(data?.judgments || []).map((j) => {
                const sym = j.currency === 'USD' ? '$' : j.currency === 'HKD' ? 'HK$' : '¥';
                return (
                  <tr key={j.id}>
                    <td>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ padding: 0, textAlign: 'left', cursor: 'pointer', border: 'none', background: 'none' }}
                        onClick={() => onOpenEntity({ kind: 'judgment', id: j.id })}
                      >
                        <strong style={{ color: 'var(--navy)' }}>{j.recordKey}</strong>{' '}
                        <strong style={{ color: 'var(--text)' }}>{j.stockName}</strong>
                      </button>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {j.stockCode || j.target}
                      </div>
                    </td>
                    <td className="mono">
                      <div>{j.date}</div>
                      <span className={`badge ${(j.score || 0) >= 7 ? 'badge-crimson' : (j.score || 0) >= 6 ? 'badge-amber' : 'badge-muted'}`} style={{ fontSize: 10.5 }}>
                        {j.score ?? '-'} 分
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {j.perf.matched ? `${sym}${j.perf.entryPrice} → ${sym}${j.perf.latestPrice}` : '待匹配代码'}
                    </td>
                    <td className="mono" style={pctStyle(j.perf.retT5Pct)}>{fmtPct(j.perf.retT5Pct)}</td>
                    <td className="mono" style={pctStyle(j.perf.retT20Pct)}>{fmtPct(j.perf.retT20Pct)}</td>
                    <td className="mono" style={pctStyle(j.perf.retT60Pct)}>{fmtPct(j.perf.retT60Pct)}</td>
                    <td className="mono" style={pctStyle(j.perf.retSincePct)}>{fmtPct(j.perf.retSincePct)}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {j.perf.matched ? (
                        <>
                          <span style={{ color: '#dc2626' }}>{fmtPct(j.perf.maxGainPct)}</span> /{' '}
                          <span style={{ color: '#16a34a' }}>{fmtPct(j.perf.maxDrawdownPct)}</span>
                        </>
                      ) : (
                        '--'
                      )}
                    </td>
                    <td>
                      {j.dueCount > 0 ? (
                        <span className="badge badge-crimson">{j.dueCount}条已到期</span>
                      ) : j.soonCount > 0 ? (
                        <span className="badge badge-amber">{j.soonCount}条临期</span>
                      ) : (
                        <span className="badge badge-muted">{j.hypothesisAlerts.length}条跟踪</span>
                      )}
                    </td>
                    <td>
                      {j.secid && onOpenTechnical && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: '2px 6px', fontSize: 11 }}
                          onClick={() => onOpenTechnical(j.secid)}
                        >
                          <Crosshair size={11} /> 技术图
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 否决观察池明细表 */}
      <div className="panel">
        <div className="panel-header">
          <h3 className="panel-title">否决 / 放弃观察池（Veto Ledger · 共 {data?.vetos.length || 0} 条）</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowVetoForm(true)}>
            <Plus size={13} /> 新增否决记录
          </button>
        </div>
        {(data?.vetos || []).length === 0 ? (
          <div className="panel-pad" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            暂无否决记录。每当你看完一只票决定“不买/放弃”时，花 10 秒记下放弃理由与触发卡号，系统会自动追踪其 T+5/T+20 涨跌，用客观数据检验你的筛选标准！
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>日期 / 标的</th>
                  <th>类型 / 方向</th>
                  <th>否决硬理由 & 卡号</th>
                  <th>否决后 T+5</th>
                  <th>否决后 T+20</th>
                  <th>至今涨跌</th>
                  <th>排雷/踏空判定</th>
                  <th style={{ width: 52 }}>删</th>
                </tr>
              </thead>
              <tbody>
                {data!.vetos.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <strong>{v.resolvedName || v.name || v.code}</strong>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {v.date} · {v.code}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${v.vetoType === 'veto' ? 'badge-crimson' : v.vetoType === 'missed' ? 'badge-amber' : 'badge-muted'}`} style={{ fontSize: 10.5 }}>
                        {v.vetoType === 'veto' ? '红线否决' : v.vetoType === 'missed' ? '踏空记录' : '观察放弃'}
                      </span>
                      {v.direction && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{v.direction}</div>}
                    </td>
                    <td style={{ fontSize: 12, maxWidth: 320 }}>
                      <div>{v.reason}</div>
                      {(v.cardIds || []).length > 0 && (
                        <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
                          {v.cardIds.map((cid) => (
                            <button
                              key={cid}
                              type="button"
                              className="ref-chip ref-chip-method"
                              onClick={() => onOpenEntity({ kind: 'methodology', id: cid.padStart(3, '0') })}
                            >
                              卡{cid}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="mono" style={pctStyle(v.perf?.retT5Pct)}>{fmtPct(v.perf?.retT5Pct)}</td>
                    <td className="mono" style={pctStyle(v.perf?.retT20Pct)}>{fmtPct(v.perf?.retT20Pct)}</td>
                    <td className="mono" style={pctStyle(v.perf?.retSincePct)}>{fmtPct(v.perf?.retSincePct)}</td>
                    <td>
                      <span
                        className={`badge ${
                          v.qualityLabel === '精准排雷'
                            ? 'badge-emerald'
                            : v.qualityLabel === '严重踏空/误杀'
                            ? 'badge-crimson'
                            : v.qualityLabel === '合理规避'
                            ? 'badge-teal'
                            : 'badge-amber'
                        }`}
                      >
                        {v.qualityLabel || '待验证'}
                      </span>
                    </td>
                    <td>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleDeleteVeto(v.id)}>
                        <Trash2 size={13} color="var(--crimson)" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
