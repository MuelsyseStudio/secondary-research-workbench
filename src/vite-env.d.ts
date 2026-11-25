/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_EDITION?: 'personal' | 'cn_commercial' | 'global_commercial';
  readonly VITE_ENABLE_CRYPTO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
