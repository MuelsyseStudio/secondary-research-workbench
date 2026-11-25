import React from 'react';
import type { BrandProfile } from '../types';

const TONE_MAP: Record<string, { bg: string; fg: string; border: string }> = {
  navy: { bg: '#183153', fg: '#f8f5ee', border: '#c89b3c' },
  crimson: { bg: '#b8322c', fg: '#fff8f2', border: '#e6b877' },
  emerald: { bg: '#166549', fg: '#f2fbf7', border: '#9ad5bc' },
  amber: { bg: '#9a6518', fg: '#fffaf0', border: '#f0cf85' },
  sky: { bg: '#0369a1', fg: '#f0f9ff', border: '#7dd3fc' },
};

export const PresetBrandSvg: React.FC<{ presetId: string; size?: number }> = ({ presetId, size = 36 }) => {
  if (presetId === 'bull_crest') {
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" style={{ display: 'block', borderRadius: 10 }}>
        <rect x="2" y="2" width="60" height="60" rx="14" fill="#183153" stroke="#c89b3c" strokeWidth="2.5" />
        <path
          d="M15 22 C15 14 23 14 25 22 L39 22 C41 14 49 14 49 22 C49 28 44 30 42 32 L40 44 C39 48 35 50 32 50 C29 50 25 48 24 44 L22 32 C20 30 15 28 15 22 Z"
          fill="#c89b3c"
        />
        <circle cx="27" cy="33" r="2.2" fill="#183153" />
        <circle cx="37" cy="33" r="2.2" fill="#183153" />
        <path d="M27 42 Q32 45 37 42" fill="none" stroke="#183153" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (presetId === 'kline_peak') {
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" style={{ display: 'block', borderRadius: 10 }}>
        <rect x="2" y="2" width="60" height="60" rx="14" fill="#183153" stroke="#c89b3c" strokeWidth="2.2" />
        <line x1="18" y1="22" x2="18" y2="48" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" />
        <rect x="14" y="30" width="8" height="12" rx="2" fill="#34d399" />
        <line x1="32" y1="16" x2="32" y2="46" stroke="#f87171" strokeWidth="2.5" strokeLinecap="round" />
        <rect x="28" y="22" width="8" height="16" rx="2" fill="#f87171" />
        <line x1="46" y1="12" x2="46" y2="38" stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round" />
        <rect x="42" y="16" width="8" height="15" rx="2" fill="#f59e0b" />
        <path d="M12 49 L27 36 L38 40 L52 18" fill="none" stroke="#faf7f0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
      </svg>
    );
  }
  if (presetId === 'alpha_compass') {
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" style={{ display: 'block', borderRadius: 10 }}>
        <rect x="2" y="2" width="60" height="60" rx="14" fill="#183153" stroke="#c89b3c" strokeWidth="2.4" />
        <circle cx="32" cy="32" r="20" fill="none" stroke="#c89b3c" strokeWidth="2" strokeDasharray="3 3" />
        <polygon points="32,12 38,32 32,37 26,32" fill="#f87171" />
        <polygon points="32,52 38,32 32,27 26,32" fill="#faf7f0" />
        <circle cx="32" cy="32" r="3.5" fill="#183153" stroke="#c89b3c" strokeWidth="2" />
      </svg>
    );
  }
  if (presetId === 'slime_seal') {
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" style={{ display: 'block', borderRadius: 10 }}>
        <rect x="2" y="2" width="60" height="60" rx="14" fill="#e0f2fe" stroke="#38bdf8" strokeWidth="2.4" />
        <path d="M13 42 C13 24 22 17 32 17 C42 17 51 24 51 42 C51 48 44 50 32 50 C20 50 13 48 13 42 Z" fill="#7dd3fc" stroke="#0284c7" strokeWidth="2.2" />
        <path d="M22 35 Q25 32 28 35" fill="none" stroke="#0f172a" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M36 35 Q39 32 42 35" fill="none" stroke="#0f172a" strokeWidth="2.4" strokeLinecap="round" />
        <ellipse cx="21" cy="39" rx="3.2" ry="1.8" fill="#fb7185" opacity="0.65" />
        <ellipse cx="43" cy="39" rx="3.2" ry="1.8" fill="#fb7185" opacity="0.65" />
        <path d="M29 37 Q32 40 35 37" fill="none" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" />
        <ellipse cx="40" cy="25" rx="5" ry="2.4" transform="rotate(28 40 25)" fill="#ffffff" opacity="0.85" />
      </svg>
    );
  }
  if (presetId === 'whale_seal') {
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" style={{ display: 'block', borderRadius: 10 }}>
        <rect x="2" y="2" width="60" height="60" rx="14" fill="#0f294a" stroke="#7dd3fc" strokeWidth="2.4" />
        <path d="M14 38 C14 26 24 21 35 23 C43 24 46 31 45 38 C49 36 52 31 53 26 C55 31 54 37 50 40 C53 41 55 43 55 46 C50 46 47 44 44 42 C39 45 20 46 14 38 Z" fill="#60a5fa" stroke="#e0f2fe" strokeWidth="1.8" />
        <circle cx="24" cy="33" r="2.2" fill="#0f172a" />
        <ellipse cx="27" cy="37" rx="3" ry="1.6" fill="#fda4af" opacity="0.7" />
        <path d="M32 17 Q32 12 28 11 M32 17 Q33 12 37 11" fill="none" stroke="#bae6fd" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (presetId === 'scroll_tri') {
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" style={{ display: 'block', borderRadius: 10 }}>
        <rect x="2" y="2" width="60" height="60" rx="14" fill="#183153" stroke="#c89b3c" strokeWidth="2.4" />
        <rect x="14" y="16" width="36" height="8" rx="3" fill="#faf7f0" />
        <rect x="14" y="28" width="36" height="8" rx="3" fill="#e6c478" />
        <rect x="14" y="40" width="36" height="8" rx="3" fill="#7dd3fc" />
        <circle cx="21" cy="20" r="2" fill="#183153" />
        <circle cx="21" cy="32" r="2" fill="#183153" />
        <circle cx="21" cy="44" r="2" fill="#183153" />
      </svg>
    );
  }

  // Default: seal_yan
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" style={{ display: 'block', borderRadius: 10 }}>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="#183153" stroke="#c89b3c" strokeWidth="2.4" />
      <rect x="7" y="7" width="50" height="50" rx="10" fill="none" stroke="#c89b3c" strokeWidth="1" opacity="0.55" />
      <text
        x="32"
        y="42"
        textAnchor="middle"
        fill="#f8f5ee"
        fontSize="28"
        fontWeight="700"
        fontFamily="Noto Serif SC, Songti SC, Microsoft YaHei, serif"
      >
        研
      </text>
    </svg>
  );
};

export const BrandMark: React.FC<{ profile?: BrandProfile | null; size?: number; institutional?: boolean }> = ({
  profile,
  size = 36,
  institutional = false,
}) => {
  const mode = profile?.iconMode || 'preset';

  // 专注专业模式下将萌系预设自动切换为克制严谨的机构徽标（自定义上传图片保留）
  if (institutional && mode !== 'custom_image') {
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" style={{ display: 'block', borderRadius: 7, flexShrink: 0 }}>
        <rect x="2" y="2" width="60" height="60" rx="10" fill="#0f294a" stroke="#94a3b8" strokeWidth="2" />
        <rect x="8" y="8" width="48" height="48" rx="6" fill="none" stroke="#c89b3c" strokeWidth="1.2" opacity="0.7" />
        <path d="M18 44 L26 30 L34 36 L46 20" fill="none" stroke="#f8fafc" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="46" cy="20" r="3" fill="#c89b3c" />
      </svg>
    );
  }

  if (mode === 'custom_image' && profile?.customImageDataUrl) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: 10,
          overflow: 'hidden',
          border: '1.5px solid var(--border-strong)',
          background: 'var(--bg-card)',
          flexShrink: 0,
          boxShadow: '0 2px 6px rgba(15, 23, 42, 0.10)',
        }}
      >
        <img
          src={profile.customImageDataUrl}
          alt={profile.title || 'Logo'}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </div>
    );
  }

  if (mode === 'ai_svg' && profile?.aiSvgMarkup) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: 10,
          overflow: 'hidden',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        dangerouslySetInnerHTML={{ __html: profile.aiSvgMarkup }}
      />
    );
  }

  if (mode === 'monogram' || profile?.presetId === 'monogram') {
    const tone = TONE_MAP[profile?.monogramTone || 'navy'] || TONE_MAP.navy;
    const text = (profile?.monogramText || '研').slice(0, 2);
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" style={{ display: 'block', borderRadius: 10, flexShrink: 0 }}>
        <rect x="2" y="2" width="60" height="60" rx="14" fill={tone.bg} stroke={tone.border} strokeWidth="2.4" />
        <rect x="7" y="7" width="50" height="50" rx="10" fill="none" stroke={tone.border} strokeWidth="1" opacity="0.55" />
        <text
          x="32"
          y={text.length > 1 ? 40 : 42}
          textAnchor="middle"
          fill={tone.fg}
          fontSize={text.length > 1 ? 21 : 28}
          fontWeight="700"
          fontFamily="Noto Serif SC, Songti SC, Microsoft YaHei, serif"
        >
          {text}
        </text>
      </svg>
    );
  }

  return (
    <div style={{ flexShrink: 0 }}>
      <PresetBrandSvg presetId={profile?.presetId || 'seal_yan'} size={size} />
    </div>
  );
};
