import React, { useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Database,
  Download,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  Square,
  Upload,
} from 'lucide-react';
import { api } from '../api';
import { CRYPTO_ENABLED } from '../config/edition';
import type { BackgroundJobDetail, QuantDataSummary, QuantEnvStatus } from '../types';

interface QuantDataManagerPanelProps {
  env: QuantEnvStatus | null;
  summary: QuantDataSummary | null;
  activeSyncJob: BackgroundJobDetail | null;
  watchlistSymbols: { cn: string[]; us: string[]; hk: string[]; crypto: string[] };
  onSyncJobStarted: (jobId: string) => void;
  onCancelJob: (jobId: string) => void;
  onDataDirSaved: (nextEnv: QuantEnvStatus) => void;
  onRefresh: () => void;
  onToast: (msg: string) => void;
}

const MARKET_FILTERS = CRYPTO_ENABLED
  ? (['ALL', 'CN', 'US', 'HK', 'CRYPTO', 'FUT'] as const)
  : (['ALL', 'CN', 'US', 'HK', 'FUT'] as const);

export const QuantDataManagerPanel: React.FC<QuantDataManagerPanelProps> = ({
  env,
  summary,
  activeSyncJob,
  watchlistSymbols,
  onSyncJobStarted,
  onCancelJob,
  onDataDirSaved,
  onRefresh,
  onToast,
}) => {
  const [marketFilter, setMarketFilter] = useState<string>('ALL');
  const [syncMarket, setSyncMarket] = useState<string>('CN');
  const [syncSymbolsText, setSyncSymbolsText] = useState<string>('000300.SH, 300308.SZ, 002384.SZ');
  const [syncStart, setSyncStart] = useState<string>('2024-11-01');
  const [syncEnd, setSyncEnd] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [syncFreq, setSyncFreq] = useState<string>('1d');
  const [syncSource, setSyncSource] = useState<string>('auto');
  const [forceFull, setForceFull] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // CSV / Parquet 离线导入
  const [csvSymbol, setCsvSymbol] = useState<string>('');
  const [csvMarket, setCsvMarket] = useState<string>('CN');
  const [csvFreq, setCsvFreq] = useState<string>('1d');
  const [csvName, setCsvName] = useState<string>('');
  const [csvFilePath, setCsvFilePath] = useState<string>('');
  const [csvVolMult, setCsvVolMult] = useState<string>('1');
  const [importingCsv, setImportingCsv] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 自定义数据目录
  const [dataDirDraft, setDataDirDraft] = useState<string>(env?.dataDir || '');
  const [savingDir, setSavingDir] = useState<boolean>(false);

  const items = summary?.items || [];
  const filteredItems = useMemo(() => {
    if (marketFilter === 'ALL') return items;
    return items.filter((it) => it.market === marketFilter);
  }, [items, marketFilter]);

  const isSyncRunning = activeSyncJob?.status === 'running';

  const triggerSync = async (symbols: string[] | string, mkt?: string, forceFlag = false) => {
    if (!env?.available) {
      onToast('Python 量化环境尚未就绪，请先初始化隔离环境');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.startQuantDataSync({
        symbols,
        market: mkt || undefined,
        start: syncStart,
        end: syncEnd,
        freq: syncFreq,
        source: syncSource,
        force: forceFlag,
      });
      onSyncJobStarted(res.job.id);
      onToast(`已启动 DuckDB 增量同步任务：${res.job.title}`);
    } catch (err: any) {
      onToast(`同步启动失败：${err.message || err}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveDataDir = async () => {
    if (!dataDirDraft.trim()) return;
    setSavingDir(true);
    try {
      const next = await api.saveQuantConfig({ dataDir: dataDirDraft.trim() });
      onDataDirSaved(next);
      onRefresh();
      onToast(`DuckDB 数据仓目录已更新至 ${next.dataDir}`);
    } catch (err: any) {
      onToast(`保存目录失败：${err.message || err}`);
    } finally {
      setSavingDir(false);
    }
  };

  const handleCsvFileUpload = async (file: File) => {
    if (!csvSymbol.trim()) {
      onToast('请先填写目标标的代码（例如 300308.SZ 或 NVDA.US）再上传 CSV');
      return;
    }
    setImportingCsv(true);
    try {
      const csvText = await file.text();
      const res = await api.importQuantCsv({
        symbol: csvSymbol.trim(),
        market: csvMarket,
        freq: csvFreq,
        csvText,
        fileName: file.name,
        volumeMultiplier: Number(csvVolMult) || 1,
        name: csvName.trim() || undefined,
      });
      onToast(`离线导入完成：${res.result?.symbol || csvSymbol} 入库 ${res.result?.rows || 0} 条`);
      onRefresh();
    } catch (err: any) {
      onToast(`CSV 导入失败：${err.message || err}`);
    } finally {
      setImportingCsv(false);
    }
  };

  const handleLocalPathImport = async () => {
    if (!csvSymbol.trim() || !csvFilePath.trim()) {
      onToast('请填写标的代码与本地 CSV/Parquet 文件绝对路径');
      return;
    }
    setImportingCsv(true);
    try {
      const res = await api.importQuantCsv({
        symbol: csvSymbol.trim(),
        market: csvMarket,
        freq: csvFreq,
        filePath: csvFilePath.trim(),
        volumeMultiplier: Number(csvVolMult) || 1,
        name: csvName.trim() || undefined,
      });
      onToast(`本地文件导入成功：${res.result?.symbol || csvSymbol} 入库 ${res.result?.rows || 0} 条`);
      onRefresh();
    } catch (err: any) {
      onToast(`本地导入失败：${err.message || err}`);
    } finally {
      setImportingCsv(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 顶部概览 & 磁盘配置 */}
      <div className="panel" style={{ padding: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Database size={18} color="var(--navy)" />
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>本地 DuckDB 多市场历史数据仓</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                所有回测严格只读本地 DuckDB，绝不编造历史 K 线；已支持自动增量续传与跨市场基准校验
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="badge badge-navy mono">
              <HardDrive size={11} /> {summary?.dbSizeMb ?? 0} MB · {summary?.totalSeries ?? 0} 序列
            </span>
            {(CRYPTO_ENABLED ? (['CN', 'US', 'CRYPTO'] as const) : (['CN', 'US'] as const)).map((mk) => (
              <span
                key={mk}
                className={`badge ${summary?.benchmarksReady?.[mk] ? 'badge-emerald' : 'badge-amber'}`}
                style={{ fontSize: 11 }}
              >
                {summary?.benchmarksReady?.[mk] ? <CheckCircle2 size={11} /> : null}
                {mk} 基准{summary?.benchmarksReady?.[mk] ? '就绪' : '待同步'}
              </span>
            ))}
            <button type="button" className="btn btn-sm" onClick={onRefresh}>
              <RefreshCw size={12} /> 刷新仓况
            </button>
          </div>
        </div>

        {/* 存储路径自定义 */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
          <FolderOpen size={14} color="var(--text-muted)" />
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>数据目录 (dataDir)：</span>
          <input
            type="text"
            className="input mono"
            style={{ flex: '1 1 320px', fontSize: 12 }}
            value={dataDirDraft}
            onChange={(e) => setDataDirDraft(e.target.value)}
            placeholder="默认 quant_data/，可改到 D:\QuantData 等大空间磁盘"
          />
          <button type="button" className="btn btn-sm" onClick={handleSaveDataDir} disabled={savingDir}>
            {savingDir ? <Loader2 size={12} className="spin" /> : null} 保存路径
          </button>
          {typeof env?.diskFreeGb === 'number' && (
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }} className="mono">
              剩余磁盘 {env.diskFreeGb} GB
            </span>
          )}
        </div>
      </div>

      {/* 一键免费数据包 & 自定义同步面板 */}
      <div className="panel" style={{ padding: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10 }}>一键同步历史 K 线（支持增量续传与免费/付费多源切换）</div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={submitting || isSyncRunning}
            onClick={() => {
              const list = Array.from(new Set(['000300.SH', '300308.SZ', '002384.SZ', ...watchlistSymbols.cn.slice(0, 10)]));
              triggerSync(list, 'CN', false);
            }}
          >
            <Download size={13} /> A股基础包（沪深300 + 自选股）
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={submitting || isSyncRunning}
            onClick={() => {
              const list = Array.from(new Set(['SPY.US', 'NVDA.US', 'AAPL.US', ...watchlistSymbols.us.slice(0, 6)]));
              triggerSync(list, 'US', false);
            }}
          >
            <Download size={13} /> 美股基础包（SPY + NVDA + 自选）
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={submitting || isSyncRunning}
            onClick={() => {
              const list = Array.from(new Set(['00700.HK', '09988.HK', '02800.HK', ...watchlistSymbols.hk.slice(0, 5)]));
              triggerSync(list, 'HK', false);
            }}
          >
            <Download size={13} /> 港股基础包（盈富 + 腾讯 + 阿里）
          </button>
          {CRYPTO_ENABLED && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={submitting || isSyncRunning}
              onClick={() => {
                const list = Array.from(new Set(['BTC_USDT.CRYPTO', 'ETH_USDT.CRYPTO', ...watchlistSymbols.crypto.slice(0, 4)]));
                triggerSync(list, 'CRYPTO', false);
              }}
            >
              <Download size={13} /> Crypto 基础包（BTC / ETH 24×7）
            </button>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 10 }}>
          <div>
            <label className="field-label">市场类型</label>
            <select className="input" value={syncMarket} onChange={(e) => setSyncMarket(e.target.value)}>
              <option value="CN">CN · A股</option>
              <option value="US">US · 美股</option>
              <option value="HK">HK · 港股</option>
              {CRYPTO_ENABLED && <option value="CRYPTO">CRYPTO · 加密</option>}
              <option value="FUT">FUT · 期货</option>
            </select>
          </div>
          <div>
            <label className="field-label">起始日期</label>
            <input type="date" className="input mono" value={syncStart} onChange={(e) => setSyncStart(e.target.value)} />
          </div>
          <div>
            <label className="field-label">结束日期</label>
            <input type="date" className="input mono" value={syncEnd} onChange={(e) => setSyncEnd(e.target.value)} />
          </div>
          <div>
            <label className="field-label">K 线周期</label>
            <select className="input" value={syncFreq} onChange={(e) => setSyncFreq(e.target.value)}>
              <option value="1d">日线 (1d)</option>
              <option value="60m">60分钟 (60m)</option>
              <option value="15m">15分钟 (15m)</option>
              <option value="5m">5分钟 (5m)</option>
            </select>
          </div>
          <div>
            <label className="field-label">数据通道</label>
            <select className="input" value={syncSource} onChange={(e) => setSyncSource(e.target.value)}>
              <option value="auto">{CRYPTO_ENABLED ? '免费自动路由 (BaoStock/镜像/Gate)' : '免费自动路由 (BaoStock/腾讯东财镜像)'}</option>
              <option value="eastmoney">腾讯/东财镜像 (免代理)</option>
              <option value="yfinance">yfinance (海外免费)</option>
              <option value="tushare">Tushare Pro (复用数据源Token)</option>
              <option value="custom_rest">自定义付费 REST 网关</option>
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            className="input mono"
            style={{ flex: '1 1 320px' }}
            value={syncSymbolsText}
            onChange={(e) => setSyncSymbolsText(e.target.value)}
            placeholder={CRYPTO_ENABLED ? '输入逗号分隔代码，如 000300.SH, 300308.SZ 或 NVDA.US, SPY.US 或 BTC_USDT.CRYPTO' : '输入逗号分隔代码，如 000300.SH, 300308.SZ 或 NVDA.US, SPY.US 或 00700.HK'}
          />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={forceFull} onChange={(e) => setForceFull(e.target.checked)} />
            强制全量重刷
          </label>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={submitting || isSyncRunning}
            onClick={() => triggerSync(syncSymbolsText, syncMarket, forceFull)}
          >
            {submitting || isSyncRunning ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
            同步上述标的
          </button>
          {isSyncRunning && activeSyncJob && (
            <button type="button" className="btn btn-sm" style={{ color: 'var(--crimson)' }} onClick={() => onCancelJob(activeSyncJob.id)}>
              <Square size={12} /> 停止同步
            </button>
          )}
        </div>

        {/* 同步实时进度条与日志 */}
        {activeSyncJob && (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              borderRadius: 8,
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
              <span style={{ fontWeight: 600 }}>
                {activeSyncJob.status === 'running' ? '正在同步：' : activeSyncJob.status === 'completed' ? '同步完成：' : '同步状态：'}
                {activeSyncJob.stage || activeSyncJob.title}
              </span>
              <span className="mono">{Math.round(activeSyncJob.pct || 0)}%</span>
            </div>
            <div style={{ height: 6, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${Math.min(100, Math.max(4, activeSyncJob.pct || 0))}%`,
                  height: '100%',
                  background: activeSyncJob.status === 'failed' ? 'var(--crimson)' : 'var(--emerald)',
                  transition: 'width 0.25s ease',
                }}
              />
            </div>
            {activeSyncJob.logs && activeSyncJob.logs.length > 0 && (
              <div
                className="mono"
                style={{
                  marginTop: 8,
                  maxHeight: 96,
                  overflowY: 'auto',
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  lineHeight: 1.5,
                }}
              >
                {activeSyncJob.logs.slice(-8).map((l, idx) => (
                  <div key={idx} style={{ color: l.level === 'error' ? 'var(--crimson)' : l.level === 'warn' ? 'var(--amber)' : undefined }}>
                    [{l.level}] {l.msg}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 已入库历史序列清单 */}
      <div className="panel" style={{ padding: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>已入库本地 K 线序列 ({filteredItems.length})</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {MARKET_FILTERS.map((mk) => (
              <button
                key={mk}
                type="button"
                className={`btn btn-sm ${marketFilter === mk ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setMarketFilter(mk)}
              >
                {mk === 'ALL' ? '全部' : mk}
                {mk !== 'ALL' && summary?.marketsCount?.[mk] ? ` (${summary.marketsCount[mk]})` : ''}
              </button>
            ))}
          </div>
        </div>

        {filteredItems.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
            当前筛选下尚无已同步的历史序列，点击上方「基础包」按钮即可 10 秒免费下载入库。
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%', fontSize: 12 }}>
              <thead>
                <tr>
                  <th>标的代码</th>
                  <th>名称</th>
                  <th>市场/板块</th>
                  <th>周期</th>
                  <th>日期覆盖区间</th>
                  <th style={{ textAlign: 'right' }}>K线条数</th>
                  <th>来源</th>
                  <th>最小手数</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((it) => (
                  <tr key={`${it.symbol}-${it.freq}`}>
                    <td className="mono" style={{ fontWeight: 700 }}>{it.symbol}</td>
                    <td>{it.name}</td>
                    <td>
                      <span className="badge badge-navy" style={{ fontSize: 10.5 }}>
                        {it.market} · {it.boardType}
                      </span>
                    </td>
                    <td className="mono">{it.freq}</td>
                    <td className="mono">{it.minDate} → {it.maxDate}</td>
                    <td className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>{it.rowCount.toLocaleString()}</td>
                    <td className="mono" style={{ color: 'var(--text-muted)' }}>{it.source}</td>
                    <td className="mono">{it.lotSize}</td>
                    <td className="mono" style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                      {it.updatedAt ? it.updatedAt.slice(0, 16).replace('T', ' ') : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 离线 CSV / Parquet 通用导入器（兼容通达信/聚宽/券商导出） */}
      <div className="panel" style={{ padding: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 4 }}>离线 CSV / Parquet 通用导入器</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
          自动识别中文/英文表头（日期/Date、开盘/Open、最高/High、最低/Low、收盘/Close、成交量/Volume），通达信“手”导出可将成交量倍数设为 100
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 10 }}>
          <div>
            <label className="field-label">标的代码 *</label>
            <input className="input mono" value={csvSymbol} onChange={(e) => setCsvSymbol(e.target.value)} placeholder="如 300308.SZ" />
          </div>
          <div>
            <label className="field-label">市场</label>
            <select className="input" value={csvMarket} onChange={(e) => setCsvMarket(e.target.value)}>
              <option value="CN">CN</option>
              <option value="US">US</option>
              <option value="HK">HK</option>
              {CRYPTO_ENABLED && <option value="CRYPTO">CRYPTO</option>}
              <option value="FUT">FUT</option>
            </select>
          </div>
          <div>
            <label className="field-label">周期</label>
            <select className="input" value={csvFreq} onChange={(e) => setCsvFreq(e.target.value)}>
              <option value="1d">1d (日线)</option>
              <option value="60m">60m</option>
              <option value="15m">15m</option>
              <option value="5m">5m</option>
            </select>
          </div>
          <div>
            <label className="field-label">中文名称 (选填)</label>
            <input className="input" value={csvName} onChange={(e) => setCsvName(e.target.value)} placeholder="如 中际旭创" />
          </div>
          <div>
            <label className="field-label">成交量倍数</label>
            <input className="input mono" value={csvVolMult} onChange={(e) => setCsvVolMult(e.target.value)} placeholder="1 或 100" />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleCsvFileUpload(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={importingCsv}
            onClick={() => fileInputRef.current?.click()}
          >
            {importingCsv ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}
            上传 CSV 导入 DuckDB
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>或指定本机绝对路径（支持大文件 / Parquet）：</span>
          <input
            className="input mono"
            style={{ flex: '1 1 260px', fontSize: 12 }}
            value={csvFilePath}
            onChange={(e) => setCsvFilePath(e.target.value)}
            placeholder="D:\Data\300308.parquet"
          />
          <button type="button" className="btn btn-sm" disabled={importingCsv} onClick={handleLocalPathImport}>
            路径导入
          </button>
        </div>
      </div>
    </div>
  );
};
