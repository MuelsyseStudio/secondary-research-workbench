import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { I18nProvider } from './i18n';
import './styles/theme.css';

interface RootBoundaryState {
  hasError: boolean;
  message: string;
}

class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, RootBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): RootBoundaryState {
    return {
      hasError: true,
      message: error?.message || '界面渲染遇到未知异常',
    };
  }

  componentDidCatch(error: Error) {
    console.error('[SRW RootErrorBoundary]', error);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: '#f8fafc',
          color: '#0f172a',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif',
        }}
      >
        <div
          style={{
            maxWidth: 520,
            width: '100%',
            background: '#ffffff',
            border: '1px solid #cbd5e1',
            borderRadius: 12,
            padding: 24,
            boxShadow: '0 10px 30px rgba(15,23,42,0.08)',
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 800, color: '#b91c1c', marginBottom: 8 }}>
            工作台界面遇到意外中断
          </div>
          <div style={{ fontSize: 13.5, color: '#334155', lineHeight: 1.65, marginBottom: 12 }}>
            您的本地「现行三库」文件与配置数据均安全保存在硬盘中，未受影响。您可以尝试重新加载界面，或一键导出脱敏诊断包发送给技术支持。
          </div>
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              background: '#f1f5f9',
              fontSize: 12,
              fontFamily: 'monospace',
              color: '#475569',
              marginBottom: 16,
              wordBreak: 'break-all',
            }}
          >
            {this.state.message}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 16px',
                borderRadius: 8,
                border: 'none',
                background: '#1d4ed8',
                color: '#ffffff',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              重新加载工作台
            </button>
            <a
              href="/api/maintenance/diagnostic-zip"
              download
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                border: '1px solid #94a3b8',
                background: '#ffffff',
                color: '#0f172a',
                fontWeight: 600,
                textDecoration: 'none',
                fontSize: 13,
              }}
            >
              导出脱敏诊断包 (.zip)
            </a>
          </div>
        </div>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <I18nProvider>
        <App />
      </I18nProvider>
    </RootErrorBoundary>
  </React.StrictMode>
);
