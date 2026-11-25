import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const rawEdition = (process.env.VITE_EDITION || 'personal').trim();
const isCnEdition = rawEdition === 'cn_commercial';
const isPartnerEdition = rawEdition === 'partner';
const isCommercialEdition = isCnEdition || isPartnerEdition || rawEdition === 'global_commercial';
const enableCrypto =
  isCnEdition || isPartnerEdition
    ? false
    : process.env.VITE_ENABLE_CRYPTO !== undefined
    ? process.env.VITE_ENABLE_CRYPTO === 'true'
    : true;

/**
 * Compile-time constant folding for imports from `src/config/edition.ts`.
 * Replaces imported edition flags with static literals before Rollup/esbuild
 * dead-code elimination so disabled branches & strings are 100% physically tree-shaken.
 */
function editionConstantFoldPlugin(): Plugin {
  const literals: Record<string, string> = {
    APP_EDITION: JSON.stringify(rawEdition),
    IS_CN_EDITION: JSON.stringify(isCnEdition),
    IS_PARTNER_EDITION: JSON.stringify(isPartnerEdition),
    IS_COMMERCIAL_EDITION: JSON.stringify(isCommercialEdition),
    CRYPTO_ENABLED: JSON.stringify(enableCrypto),
    ALLOW_COMMUNITY_SCRAPERS: JSON.stringify(!isCommercialEdition),
  };
  return {
    name: 'srw-edition-constant-fold',
    enforce: 'pre',
    transform(code, id) {
      const norm = id.replace(/\\/g, '/');
      if (!/\.(ts|tsx)$/.test(norm) || norm.endsWith('/config/edition.ts')) return null;
      const importMatch = code.match(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]*config\/edition['"]\s*;?/);
      if (!importMatch) return null;

      const importedNames = importMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const foldTargets: string[] = [];
      const keptImports: string[] = [];
      for (const spec of importedNames) {
        if (!spec.includes(' as ') && Object.prototype.hasOwnProperty.call(literals, spec)) {
          foldTargets.push(spec);
        } else {
          keptImports.push(spec);
        }
      }
      if (foldTargets.length === 0) return null;

      const replacementImport = keptImports.length
        ? `import { ${keptImports.join(', ')} } from '${importMatch[0].match(/['"]([^'"]+)['"]/)![1]}';`
        : '';
      let out = code.replace(importMatch[0], replacementImport);
      for (const name of foldTargets) {
        out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), literals[name]);
      }
      return { code: out, map: null };
    },
  };
}

export default defineConfig({
  plugins: [editionConstantFoldPlugin(), react()],
  define: {
    'import.meta.env.VITE_EDITION': JSON.stringify(rawEdition),
    'import.meta.env.VITE_ENABLE_CRYPTO': JSON.stringify(enableCrypto ? 'true' : 'false'),
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.SRW_API_PORT || 3721}`,
        changeOrigin: false,
      },
    },
  },
  preview: {
    proxy: {},
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/klinecharts')) return 'klinecharts';
          if (id.includes('node_modules/lucide-react')) return 'lucide-icons';
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) return 'react-vendor';
          return undefined;
        },
      },
    },
  },
});
