/** Type declarations for the usage-counter E2E fixture (SMI-4462). */

export type UserTier = 'community' | 'individual' | 'team' | 'enterprise'

export interface ProvisionedUser {
  userId: string
  email: string
  password: string
  /** Supabase access JWT (Bearer-style) issued by signInWithPassword. */
  jwt: string
  /** Supabase refresh token, written into the CLI ~/.skillsmith/config.json. */
  refreshToken: string
  /** Plain sk_live_* license key — write to X-API-Key / Bearer header. */
  apiKey: string
}

export interface ProvisionOptions {
  tier?: UserTier
  /** Optional name for the license_keys row (defaults to 'CLI Token'). */
  apiKeyName?: string
}

export interface UsageRow {
  user_id: string
  hour_bucket: string
  search_count: number
  get_count: number
  recommend_count: number
}

export interface ResolvedEnv {
  url: string
  serviceRoleKey: string
  anonKey: string
}

export interface RestErrorShape {
  code?: string
  message?: string
  details?: string
}

export interface SignInResponse {
  access_token: string
  refresh_token: string
}

export interface SkillRow {
  author?: string | null
  name?: string | null
}

export type CounterColumn = 'search_count' | 'get_count' | 'recommend_count'
