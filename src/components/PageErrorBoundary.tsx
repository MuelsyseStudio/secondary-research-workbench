import React from 'react';
import { AlertTriangle, Copy, Download, RotateCcw } from 'lucide-react';

interface PageErrorBoundaryProps {
  pageName: string;
  children: React.ReactNode;
  onToast?: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

interface PageErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  componentStack: string;
  resetCounter: number;
}

export class PageErrorBoundary extends React.Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  constructor(props: PageErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      componentStack: '',
      resetCounter: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<PageErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ componentStack: info?.componentStack || '' });
    // eslint-disable-next-line no-console
    console.error(`[PageErrorBoundary:${this.props.pageName}]`, error, info?.componentStack);
  }

  handleReloadPage = () => {
    this.setState((prev) => ({
      hasError: false,
      error: null,
      componentStack: '',
      resetCounter: prev.resetCounter + 1,
    }));
  };

  handleCopyError = async () => {
    const detail = [
      `Page: ${this.props.pageName}`,
      `Time: ${new Date().toISOString()}`,
      `Error: ${this.state.error?.name || 'Error'}: ${this.state.error?.message || 'Unknown error'}`,
      this.state.error?.stack ? `\nStack:\n${this.state.error.stack}` : '',
      this.state.componentStack ? `\nComponent Stack:${this.state.componentStack}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    try {
      await navigator.clipboard.writeText(detail);
      this.props.onToast?.('已复制页面报错详情，可用于排查或提交反馈', 'info');
    } catch {
      this.props.onToast?.('复制失败，请手动选中上方报错文本', 'warning');
    }
  };

  handleExportDiagnostic = async () => {
    try {
      const resp = await fetch('/api/maintenance/diagnostic-zip', {
        headers: { 'X-SRW-Client': 'workbench' },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `srw-diagnostic-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      this.props.onToast?.('已导出脱敏诊断包 (.zip)', 'success');
    } catch (err: any) {
      this.props.onToast?.(`导出诊断包失败：${err?.message || '未知错误'}`, 'error');
    }
  };

  render() {
    if (!this.state.hasError) {
      return <React.Fragment key={this.state.resetCounter}>{this.props.children}</React.Fragment>;
    }

    return (
      <div
        className="scroll-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 380 }}
      >
        <div
          className="panel panel-pad"
          style={{
            maxWidth: 620,
            width: '100%',
            borderColor: 'var(--crimson)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertTriangle size={22} color="var(--crimson)" style={{ flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--crimson)' }}>
                当前页面渲染遇到异常（已隔离保护，不影响其他页签与本地三库数据）
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                模块：{this.props.pageName}
              </div>
            </div>
          </div>

          <div
            className="mono"
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              background: 'var(--crimson-soft)',
              color: 'var(--crimson)',
              fontSize: 12,
              lineHeight: 1.55,
              wordBreak: 'break-word',
              maxHeight: 180,
              overflowY: 'auto',
            }}
          >
            {this.state.error?.message || '未知渲染错误'}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={this.handleReloadPage}>
              <RotateCcw size={13} /> 重载本页
            </button>
            <button type="button" className="btn btn-sm" onClick={this.handleCopyError}>
              <Copy size={13} /> 复制报错详情
            </button>
            <button type="button" className="btn btn-sm" onClick={this.handleExportDiagnostic}>
              <Download size={13} /> 导出脱敏诊断包 (.zip)
            </button>
          </div>
        </div>
      </div>
    );
  }
}
