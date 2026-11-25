import React from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

export type ToastLevel = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  message: string;
  level: ToastLevel;
}

export function inferToastLevel(message: string): ToastLevel {
  const m = String(message || '');
  if (
    /(?:失败|错误|报错|异常|拒绝|无法|未能|禁止|超时|崩溃|无权限|权限不足|空间不足|磁盘已满|只读|损坏|不存在|无效|未通过|fail|failed|error|denied|invalid|timeout|permission|not permitted|no space|read-only|enospc|eacces|eperm|enoent|ebusy|erofs|econnrefused|etimedout|emfile|syntaxerror|typeerror)/i.test(
      m
    )
  ) {
    return 'error';
  }
  if (/(?:告警|警告|注意|拦截|限流|未配置|未就绪|请先|缺失|暂不|尚未|未找到|不能为空|warn|blocked|quota|limit)/i.test(m)) {
    return 'warning';
  }
  if (
    /(?:成功|已保存|已落库|已写入|已入库|已加入|已添加|已完成|已导出|已下载|已更新|已删除|已清空|已清除|已恢复|已还原|已创建|已切换|已激活|已启用|已关闭|已重置|已同步|已加载|已载入|已抓回|已生成|已取消|已收藏|通过|saved|succeeded|completed|exported|created|switched|activated|restored|deleted|synced)/i.test(
      m
    )
  ) {
    return 'success';
  }
  return 'info';
}

interface ToastStackProps {
  items: ToastItem[];
  onDismiss: (id: string) => void;
}

export const ToastStack: React.FC<ToastStackProps> = ({ items, onDismiss }) => {
  if (!items.length) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {items.map((item) => {
        const icon =
          item.level === 'error' ? (
            <XCircle size={16} color="var(--crimson)" style={{ flexShrink: 0 }} />
          ) : item.level === 'warning' ? (
            <AlertTriangle size={16} color="var(--amber)" style={{ flexShrink: 0 }} />
          ) : item.level === 'info' ? (
            <Info size={16} color="var(--navy)" style={{ flexShrink: 0 }} />
          ) : (
            <CheckCircle2 size={16} color="var(--emerald)" style={{ flexShrink: 0 }} />
          );

        return (
          <div key={item.id} className={`toast toast-${item.level}`}>
            {icon}
            <span style={{ flex: 1, lineHeight: 1.45, wordBreak: 'break-word' }}>{item.message}</span>
            <button
              type="button"
              className="toast-close"
              onClick={() => onDismiss(item.id)}
              aria-label="关闭提示"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
};
