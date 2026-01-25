/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_API_BASE_URL: string;
  readonly PUBLIC_SITE_URL: string;
  readonly PUBLIC_SUPABASE_URL: string;
  readonly PUBLIC_SUPABASE_ANON_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Global type declarations for window augmentation
 */
interface SupabaseWindowConfig {
  url: string;
  anonKey: string;
  apiBaseUrl: string;
}

declare global {
  interface Window {
    __SUPABASE_CONFIG__?: SupabaseWindowConfig;
    __AUTH_REDIRECT_TO__?: string;
  }
}

export {};
