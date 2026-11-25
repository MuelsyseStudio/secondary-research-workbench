import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ImagePlus, Loader2, Palette, RotateCcw, Save, Sparkles, Wand2, X } from 'lucide-react';
import { api } from '../api';
import type { AiProvider, AiSafeConfig, BrandProfile, BrandStateResponse } from '../types';
import { BrandMark, PresetBrandSvg } from './BrandMark';
import { AiProviderPicker } from './AiProviderPicker';

interface BrandCustomizeModalProps {
  open: boolean;
  brandState: BrandStateResponse | null;
  aiConfig: AiSafeConfig | null;
  onClose: () => void;
  onSaved: (state: BrandStateResponse) => void;
  onOpenAiSettings: () => void;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

const IMAGE_STYLES: { id: BrandProfile['customImageStyle']; label: string; desc: string }[] = [
  { id: 'workbench_harmonize', label: '工作台柔光徽章（推荐）', desc: '自动暖羊皮纸色调平衡 + 藏青金边圆角统一框' },
  { id: 'ink_seal', label: '藏青鎏金双色印章', desc: '转为工作台标志性深海藏青×象牙白研报质感' },
  { id: 'clean_cutout', label: '智能去白底贴纸融合', desc: '自动抠除四周纯白/浅灰底并叠加柔雅衬底' },
  { id: 'original', label: '高清原图居中裁切', desc: '保留原始色彩，仅做 1:1 居中安全裁切' },
];

/**
 * 零延迟浏览器 Canvas 图像风格一致性处理器：
 * 保证任意用户上传的照片/头像/Logo 都能与工作台「暖羊皮纸 / 机构藏青 / 鎏金」审美完美融合！
 */
function harmonizeImageOnCanvas(
  rawDataUrl: string,
  style: BrandProfile['customImageStyle']
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = 192;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Canvas 不可用'));

      // 居中 1:1 裁切源图
      const minSide = Math.min(img.width, img.height);
      const sx = (img.width - minSide) / 2;
      const sy = (img.height - minSide) / 2;

      if (style === 'original') {
        ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
        return resolve(canvas.toDataURL('image/png'));
      }

      // 先画入临时画布做像素级处理
      ctx.fillStyle = '#faf7f0';
      ctx.fillRect(0, 0, size, size);
      const pad = style === 'workbench_harmonize' ? 10 : style === 'clean_cutout' ? 12 : 8;
      ctx.drawImage(img, sx, sy, minSide, minSide, pad, pad, size - pad * 2, size - pad * 2);

      const imgData = ctx.getImageData(0, 0, size, size);
      const d = imgData.data;

      if (style === 'ink_seal') {
        // 藏青 #183153 -> 鎏金 #c89b3c -> 暖象牙 #faf7f0 优雅三段色调映射
        for (let i = 0; i < d.length; i += 4) {
          const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
          if (lum < 0.55) {
            const t = lum / 0.55;
            d[i] = Math.round(24 + t * (200 - 24));
            d[i + 1] = Math.round(49 + t * (155 - 49));
            d[i + 2] = Math.round(83 + t * (60 - 83));
          } else {
            const t = (lum - 0.55) / 0.45;
            d[i] = Math.round(200 + t * (250 - 200));
            d[i + 1] = Math.round(155 + t * (247 - 155));
            d[i + 2] = Math.round(60 + t * (240 - 60));
          }
        }
        ctx.putImageData(imgData, 0, 0);
      } else if (style === 'clean_cutout') {
        // 柔和去白底并铺上暖羊皮纸微蓝光底
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          if (r > 232 && g > 232 && b > 232) {
            d[i] = 244;
            d[i + 1] = 247;
            d[i + 2] = 252;
          }
        }
        ctx.putImageData(imgData, 0, 0);
      } else if (style === 'workbench_harmonize') {
        // 柔和降低过高荧光饱和度并轻混 8% 暖羊皮纸氛围色，避免突兀刺眼
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const avg = 0.299 * r + 0.587 * g + 0.114 * b;
          const sr = r * 0.88 + avg * 0.12;
          const sg = g * 0.88 + avg * 0.12;
          const sb = b * 0.88 + avg * 0.12;
          d[i] = Math.min(255, Math.round(sr * 0.92 + 250 * 0.08));
          d[i + 1] = Math.min(255, Math.round(sg * 0.92 + 245 * 0.08));
          d[i + 2] = Math.min(255, Math.round(sb * 0.92 + 236 * 0.08));
        }
        ctx.putImageData(imgData, 0, 0);
      }

      // 统一绘制精致藏青/鎏金内描边（保证左上角质感统一）
      ctx.strokeStyle = style === 'ink_seal' ? '#c89b3c' : '#183153';
      ctx.lineWidth = 6;
      ctx.strokeRect(3, 3, size - 6, size - 6);
      ctx.strokeStyle = 'rgba(200, 155, 60, 0.72)';
      ctx.lineWidth = 2;
      ctx.strokeRect(9, 9, size - 18, size - 18);

      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = rawDataUrl;
  });
}

export const BrandCustomizeModal: React.FC<BrandCustomizeModalProps> = ({
  open,
  brandState,
  aiConfig,
  onClose,
  onSaved,
  onOpenAiSettings,
  onToast,
}) => {
  const [draft, setDraft] = useState<BrandProfile | null>(null);
  const [rawUploadDataUrl, setRawUploadDataUrl] = useState<string>('');
  const [rawUploadMime, setRawUploadMime] = useState<string>('image/png');
  const [aiPromptHint, setAiPromptHint] = useState('');
  const [aiStylePreset, setAiStylePreset] = useState('editorial_navy');
  const [provider, setProvider] = useState<AiProvider>(aiConfig?.provider || 'codex_cli');
  const [stylizing, setStylizing] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open && brandState?.profile) {
      setDraft({ ...brandState.profile });
      setRawUploadDataUrl(brandState.profile.customImageDataUrl || '');
    }
  }, [open, brandState]);

  useEffect(() => {
    if (aiConfig?.provider) setProvider(aiConfig.provider);
  }, [aiConfig?.provider]);

  if (!open || !draft || !brandState) return null;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      onToast('请选择 5MB 以内的图片文件');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const rawUrl = String(reader.result || '');
      setRawUploadDataUrl(rawUrl);
      setRawUploadMime(file.type || 'image/png');
      try {
        const processed = await harmonizeImageOnCanvas(rawUrl, draft.customImageStyle || 'workbench_harmonize');
        setDraft((prev) => (prev ? { ...prev, iconMode: 'custom_image', customImageDataUrl: processed } : prev));
        onToast('已自动应用工作台统一风格滤镜，可切换 4 种融合模式或点 AI 重绘', 'success');
      } catch (err: any) {
        onToast(err.message || '处理自定义图片失败', 'error');
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSwitchImageStyle = async (style: BrandProfile['customImageStyle']) => {
    setDraft((prev) => (prev ? { ...prev, customImageStyle: style } : prev));
    if (rawUploadDataUrl) {
      try {
        const processed = await harmonizeImageOnCanvas(rawUploadDataUrl, style);
        setDraft((prev) => (prev ? { ...prev, iconMode: 'custom_image', customImageStyle: style, customImageDataUrl: processed } : prev));
      } catch {
        // ignore
      }
    }
  };

  const handleAiStylize = async () => {
    setStylizing(true);
    try {
      const base64 = rawUploadDataUrl.includes(',') ? rawUploadDataUrl.split(',')[1] : '';
      const res = await api.stylizeBrandIconWithAi({
        imageBase64: base64 || undefined,
        imageMimeType: base64 ? rawUploadMime : undefined,
        promptHint: aiPromptHint.trim() || `${draft.title} 专属金融投研徽标`,
        title: draft.title,
        stylePreset: aiStylePreset,
        provider,
      });
      setDraft((prev) => (prev ? { ...prev, iconMode: 'ai_svg', aiSvgMarkup: res.svgMarkup } : prev));
      onToast(`AI (${res.provider}) 已重绘完成与工作台风格 100% 统一的高清矢量图标！`);
    } catch (err: any) {
      onToast(`AI 重绘失败：${err.message}`);
    } finally {
      setStylizing(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.saveBrandProfile(draft);
      onSaved(res);
      onToast('工作台左上角品牌形象已保存生效', 'success');
      onClose();
    } catch (err: any) {
      onToast(`保存失败：${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      const res = await api.saveBrandProfile({ reset: true });
      onSaved(res);
      setDraft({ ...res.profile });
      setRawUploadDataUrl('');
      onToast('已恢复默认「二级投研工作台」品牌设置', 'success');
    } catch (err: any) {
      onToast(err.message || '恢复默认品牌设置失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 820 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Palette size={19} color="var(--navy)" />
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>个性化工作台品牌（左上角图标、标题 & AI 风格融合）</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                打造你的专属投研终端 · 内置 8 款统一审美预制徽标 · 支持上传图片自动调色与 AI 重绘矢量 Logo
              </div>
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Live Brand Block Preview + Editable Title & Subtitle */}
          <div
            className="panel panel-pad"
            style={{
              background: 'var(--bg-subtle)',
              display: 'grid',
              gridTemplateColumns: '240px 1fr',
              gap: 16,
              alignItems: 'center',
            }}
          >
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 10,
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <BrandMark profile={draft} size={42} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {draft.title || '二级投研工作台'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {draft.subtitle || '三库闭环 · 日常维护与复盘'}
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="field-group" style={{ margin: 0 }}>
                <label className="field-label">左上角主标题（同步浏览器标签名）</label>
                <input
                  className="input"
                  maxLength={24}
                  placeholder="例如：阿强的 Alpha 投研终端"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
              </div>
              <div className="field-group" style={{ margin: 0 }}>
                <label className="field-label">副标题 / 座右铭</label>
                <input
                  className="input"
                  maxLength={36}
                  placeholder="例如：慢就是快 · 严守止损与赔率"
                  value={draft.subtitle}
                  onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })}
                />
              </div>
            </div>
          </div>

          {/* 8 Preset Workbench Icons */}
          <div>
            <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 8, color: 'var(--text-secondary)' }}>
              方式一：精选 8 款预制统一风格图标（与浅色羊皮纸 & 深色终端 100% 协调）
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
              {brandState.presets.map((p) => {
                const isMono = p.id === 'monogram';
                const selected =
                  (isMono && draft.iconMode === 'monogram') ||
                  (!isMono && draft.iconMode === 'preset' && draft.presetId === p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="btn"
                    style={{
                      padding: '8px 10px',
                      height: 'auto',
                      justifyContent: 'flex-start',
                      gap: 9,
                      textAlign: 'left',
                      border: selected ? '1.8px solid var(--navy)' : '1px solid var(--border)',
                      background: selected ? 'var(--navy-soft)' : 'var(--bg-card)',
                    }}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        iconMode: isMono ? 'monogram' : 'preset',
                        presetId: p.id,
                      })
                    }
                  >
                    {isMono ? (
                      <BrandMark profile={{ ...draft, iconMode: 'monogram' }} size={34} />
                    ) : (
                      <PresetBrandSvg presetId={p.id} size={34} />
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 12 }}>{p.name}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{p.tag}</div>
                    </div>
                  </button>
                );
              })}
            </div>

            {draft.iconMode === 'monogram' && (
              <div
                style={{
                  marginTop: 8,
                  padding: '9px 12px',
                  borderRadius: 8,
                  background: 'var(--bg-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>印章文字（1-2字）</span>
                  <input
                    className="input"
                    style={{ width: 72, textAlign: 'center', fontWeight: 700 }}
                    maxLength={2}
                    value={draft.monogramText}
                    onChange={(e) => setDraft({ ...draft, monogramText: e.target.value })}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>印章配色</span>
                  {brandState.monogramTones.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="btn btn-sm"
                      style={{
                        padding: '3px 8px',
                        fontSize: 11,
                        background: t.bg,
                        color: t.fg,
                        border: draft.monogramTone === t.id ? `2px solid ${t.border}` : '1px solid transparent',
                      }}
                      onClick={() => setDraft({ ...draft, monogramTone: t.id as BrandProfile['monogramTone'] })}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Custom Upload + Local Style Harmonization + AI Vector Restyle */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>方式二：上传图片 + 自动 UI 风格统一滤镜</span>
                <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
                <button type="button" className="btn btn-sm btn-primary" onClick={() => fileRef.current?.click()}>
                  <ImagePlus size={13} /> 上传图片
                </button>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                上传任意头像/贴纸/Logo 后，本地 Canvas 即刻自动调色并加上工作台统一边框，避免违和突兀：
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {IMAGE_STYLES.map((st) => {
                  const active = draft.customImageStyle === st.id && draft.iconMode === 'custom_image';
                  return (
                    <button
                      key={st.id}
                      type="button"
                      className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                      style={{
                        height: 'auto',
                        padding: '6px 8px',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        textAlign: 'left',
                        gap: 2,
                      }}
                      onClick={() => handleSwitchImageStyle(st.id)}
                    >
                      <span style={{ fontWeight: 700, fontSize: 11.5 }}>{st.label}</span>
                      <span style={{ fontSize: 10, opacity: active ? 0.88 : 0.68, fontWeight: 400 }}>{st.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13 }}>
                <Wand2 size={15} color="var(--navy)" />
                <span>方式三：AI 风格重构为工作台统一矢量 Logo</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                将你上传的图片或一句创意描述，由 AI 重绘为严格契合工作台色板的高清矢量 SVG 徽标（支持所有 AI 引擎）：
              </div>
              <input
                className="input"
                style={{ fontSize: 12 }}
                placeholder="描述想要的图标，如：戴眼镜的蓝鲸鱼 + K线元素"
                value={aiPromptHint}
                onChange={(e) => setAiPromptHint(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select
                  className="input"
                  style={{ flex: 1, fontSize: 12 }}
                  value={aiStylePreset}
                  onChange={(e) => setAiStylePreset(e.target.value)}
                >
                  <option value="editorial_navy">机构藏青鎏金风（最百搭）</option>
                  <option value="pastel_cute">日系粉彩手绘萌系风</option>
                  <option value="crimson_seal">复古朱砂金融印章风</option>
                  <option value="minimal_mono">极简现代线条徽标风</option>
                </select>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={stylizing}
                  onClick={handleAiStylize}
                >
                  {stylizing ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                  <span>{stylizing ? 'AI 绘制中...' : 'AI 统一风格生成'}</span>
                </button>
              </div>
              <div style={{ marginTop: 2 }}>
                <AiProviderPicker value={provider} config={aiConfig} onChange={setProvider} onOpenSettings={onOpenAiSettings} />
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={handleReset}>
            <RotateCcw size={13} /> 恢复默认品牌
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-sm" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={handleSave}>
              {saving ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
              <span>保存并立即生效</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
