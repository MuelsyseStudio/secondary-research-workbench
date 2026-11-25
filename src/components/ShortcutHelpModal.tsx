import React from 'react';
import { Keyboard, X } from 'lucide-react';
import { useI18n } from '../i18n';

interface ShortcutHelpModalProps {
  open: boolean;
  onClose: () => void;
}

export const ShortcutHelpModal: React.FC<ShortcutHelpModalProps> = ({ open, onClose }) => {
  const { t } = useI18n();
  if (!open) return null;

  const groups = [
    {
      title: t('全局导航与检索', 'Global Navigation & Search'),
      items: [
        { keys: 'Ctrl + K / /', desc: t('打开跨三库与全市场标的秒搜面板', 'Open Command Palette (3-Library & Ticker Search)') },
        { keys: 'Ctrl + Shift + N', desc: t('唤起「盘中闪念速记框」，随时记录灵感并绑定股票代码', 'Open Intraday Quick Notes modal') },
        { keys: '?', desc: t('打开 / 关闭全局快捷键速查表', 'Toggle this keyboard shortcut cheat sheet') },
        { keys: 'Esc', desc: t('关闭当前弹窗、抽屉或退出全屏研股模式', 'Close active modal, drawer or fullscreen chart') },
      ],
    },
    {
      title: t('极速切页（Alt + 数字键）', 'Fast Tab Switching (Alt + Number)'),
      items: [
        { keys: 'Alt + 1', desc: t('投研：研究总览驾驶舱 ｜ 短线：全景看盘驾驶舱', 'Research: Cockpit | Short-Term: Panoramic Watch') },
        { keys: 'Alt + 2', desc: t('投研：全球多市场盯盘 ｜ 短线：连板天梯与竞价', 'Research: Global Markets | Short-Term: Board Ladder') },
        { keys: 'Alt + 3', desc: t('投研：技术流派与预警 ｜ 短线：题材与情绪云图', 'Research: Technical Lab | Short-Term: Treemaps') },
        { keys: 'Alt + 4', desc: t('投研：实盘交易账本 ｜ 短线：异动与监管中心', 'Research: Trade Ledger | Short-Term: Anomaly Center') },
        { keys: 'Alt + 5', desc: t('投研：策略回测实验室 ｜ 短线：题材·四象限·区间', 'Research: Backtest Lab | Short-Term: Themes & Range') },
        { keys: 'Alt + 6', desc: t('投研：情报信源与进化 ｜ 短线：龙虎榜与资金', 'Research: Intel Hub | Short-Term: Dragon-Tiger') },
        { keys: 'Alt + 7 / 8 / 9', desc: t('直达：方法论卡片库 / 行业前沿认知库 / 研判与复盘台账', 'Jump to Methodology / Cognition / Review Ledger') },
      ],
    },
    {
      title: t('多屏与盘中效率技巧', 'Multi-Screen & Intraday Tips'),
      items: [
        { keys: t('新窗口弹出', 'Pop-Out Window'), desc: t('全屏研股顶栏点击「新窗口」即可独立弹出纯 K 线窗口拖至副屏', 'Click Pop-Out in Fullscreen K-Line to drag chart onto a second monitor') },
        { keys: t('侧栏 56px 极窄模式', 'Compact 56px Sidebar'), desc: t('点击侧栏顶部折叠按钮，1366/1440 笔记本立省 188px 横向空间', 'Collapse sidebar to 56px icon rail on compact laptop screens') },
      ],
    },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 660 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Keyboard size={18} color="var(--navy)" />
            <strong style={{ fontSize: 15 }}>{t('全局键盘快捷键速查表', 'Keyboard Shortcuts Cheat Sheet')}</strong>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {groups.map((g) => (
            <div key={g.title} className="field-block" style={{ marginBottom: 0 }}>
              <div className="field-block-label">{g.title}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {g.items.map((it) => (
                  <div
                    key={it.keys}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      fontSize: 12.5,
                    }}
                  >
                    <span style={{ color: 'var(--text-secondary)' }}>{it.desc}</span>
                    <kbd
                      className="kbd mono"
                      style={{
                        flexShrink: 0,
                        padding: '2px 7px',
                        fontSize: 11.5,
                        background: 'var(--bg-soft)',
                        border: '1px solid var(--border-strong)',
                        borderRadius: 5,
                        color: 'var(--text)',
                      }}
                    >
                      {it.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
            {t('知道了', 'Got it')}
          </button>
        </div>
      </div>
    </div>
  );
};
