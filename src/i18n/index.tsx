import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { CRYPTO_ENABLED } from '../config/edition';

export type AppLang = 'zh' | 'en';
export type ColorConvention = 'cn_red_up' | 'global_green_up';

export interface I18nContextValue {
  lang: AppLang;
  setLang: (next: AppLang) => void;
  toggleLang: () => void;
  colorConvention: ColorConvention;
  setColorConvention: (next: ColorConvention) => void;
  toggleColorConvention: () => void;
  upColor: string;
  downColor: string;
  pctColor: (v: number | null | undefined) => string;
  t: (zh: string, en: string) => string;
  currencySymbol: (currency?: string) => string;
  marketBadgeLabel: (marketKind?: string) => string;
  formatPrice: (v: number | null | undefined, currency?: string) => string;
  formatPct: (v: number | null | undefined) => string;
  formatYi: (yi: number | null | undefined) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function currencyPrefixStatic(currency?: string): string {
  if (CRYPTO_ENABLED && currency === 'USDT') return '$';
  switch (currency) {
    case 'USD':
      return '$';
    case 'HKD':
      return 'HK$';
    case 'TWD':
      return 'NT$';
    case 'KRW':
      return '₩';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    case 'GBp':
      return 'p ';
    case 'JPY':
      return '¥';
    case 'PTS':
      return '';
    case 'CNY':
    default:
      return '¥';
  }
}

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<AppLang>(() => {
    const saved = localStorage.getItem('srw-lang');
    return saved === 'en' ? 'en' : 'zh';
  });

  const [colorConvention, setColorConventionState] = useState<ColorConvention>(() => {
    const saved = localStorage.getItem('srw-color-convention');
    if (saved === 'global_green_up' || saved === 'cn_red_up') return saved;
    return localStorage.getItem('srw-lang') === 'en' ? 'global_green_up' : 'cn_red_up';
  });

  const setLang = useCallback((next: AppLang) => {
    setLangState(next);
    localStorage.setItem('srw-lang', next);
    // 自动联动涨跌颜色惯例：中文默认红涨绿跌，英文默认国际绿涨红跌（用户仍可手动覆盖）
    const autoColor: ColorConvention = next === 'en' ? 'global_green_up' : 'cn_red_up';
    setColorConventionState(autoColor);
    localStorage.setItem('srw-color-convention', autoColor);
  }, []);

  const toggleLang = useCallback(() => {
    setLang(lang === 'zh' ? 'en' : 'zh');
  }, [lang, setLang]);

  const setColorConvention = useCallback((next: ColorConvention) => {
    setColorConventionState(next);
    localStorage.setItem('srw-color-convention', next);
  }, []);

  const toggleColorConvention = useCallback(() => {
    setColorConvention(colorConvention === 'cn_red_up' ? 'global_green_up' : 'cn_red_up');
  }, [colorConvention, setColorConvention]);

  const upColor = colorConvention === 'global_green_up' ? '#16a34a' : '#dc2626';
  const downColor = colorConvention === 'global_green_up' ? '#dc2626' : '#16a34a';

  useEffect(() => {
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN');
    document.documentElement.style.setProperty('--up-color', upColor);
    document.documentElement.style.setProperty('--down-color', downColor);
  }, [lang, upColor, downColor]);

  const value = useMemo<I18nContextValue>(() => {
    const t = (zh: string, en: string) => (lang === 'en' ? en : zh);
    const pctColor = (v: number | null | undefined) => {
      if (v == null || !Number.isFinite(v)) return 'var(--text-muted)';
      if (v > 0) return upColor;
      if (v < 0) return downColor;
      return 'var(--text-secondary)';
    };
    const currencySymbol = (currency?: string) => currencyPrefixStatic(currency);
    const marketBadgeLabel = (mk?: string) => {
      const zhMap: Record<string, string> = {
        CN: 'A股',
        US: '美股',
        HK: '港股',
        TW: '台股',
        KR: '韩股',
        FR: '法股',
        UK: '英股',
        JP: '日股',
        DE: '德股',
        FUT: '期货',
        ...(CRYPTO_ENABLED ? { CRYPTO: '加密' } : {}),
      };
      const enMap: Record<string, string> = {
        CN: 'CN',
        US: 'US',
        HK: 'HK',
        TW: 'TWSE',
        KR: 'KRX',
        FR: 'PAR',
        UK: 'LSE',
        JP: 'JPX',
        DE: 'XETR',
        FUT: 'FUT',
        ...(CRYPTO_ENABLED ? { CRYPTO: 'CRYPTO' } : {}),
      };
      const key = String(mk || 'CN').toUpperCase();
      return lang === 'en' ? enMap[key] || key : zhMap[key] || key;
    };
    const formatPrice = (v: number | null | undefined, currency?: string) => {
      if (v == null || !Number.isFinite(v)) return '--';
      const decimals = Math.abs(v) >= 1000 ? 2 : Math.abs(v) >= 1 ? 2 : 4;
      const sym = currencyPrefixStatic(currency);
      if (currency === 'GBp') return `${v.toFixed(1)}p`;
      if (currency === 'KRW' || currency === 'JPY') return `${sym}${Math.round(v).toLocaleString()}`;
      return `${sym}${v.toFixed(decimals)}`;
    };
    const formatPct = (v: number | null | undefined) => {
      if (v == null || !Number.isFinite(v)) return '--';
      return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
    };
    const formatYi = (yi: number | null | undefined) => {
      if (yi == null || !Number.isFinite(yi)) return '--';
      if (lang === 'en') {
        const abs = Math.abs(yi);
        if (abs >= 10) return `${(yi / 10).toFixed(2)}B`;
        return `${(yi * 100).toFixed(0)}M`;
      }
      if (Math.abs(yi) >= 10000) return `${(yi / 10000).toFixed(2)}万亿`;
      return `${yi.toFixed(2)}亿`;
    };

    return {
      lang,
      setLang,
      toggleLang,
      colorConvention,
      setColorConvention,
      toggleColorConvention,
      upColor,
      downColor,
      pctColor,
      t,
      currencySymbol,
      marketBadgeLabel,
      formatPrice,
      formatPct,
      formatYi,
    };
  }, [lang, setLang, toggleLang, colorConvention, setColorConvention, toggleColorConvention, upColor, downColor]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
