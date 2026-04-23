// SMI-4402: v2 credential schema (JWT + refresh) replacing raw sk_live_* paste.
// Schema v2: { accessToken, refreshToken, expiresAt, apiKey?, version: 2 }

import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { ensureConfigDir } from './index.js'
import { PRODUCTION_ANON_KEY } from '../api/utils.js'

const CONFIG_DIR = '.skillsmith'
const CONFIG_FILE = 'config.json'
const KEYTAR_SERVICE = 'skillsmith-cli'
const KEYTAR_ACCOUNT_REFRESH = 'refresh-token'

// Supabase project URL — used for the native refresh-token endpoint.
// Works in dev (SUPABASE_URL env) and prod (hardcoded project ref).
const SUPABASE_AUTH_URL =
  (process.env.SUPABASE_URL ?? 'https://vrcnzpmndtroqxxoqkzy.supabase.co') + '/auth/v1'

export interface TokenCredentials {
  accessToken: string
  refreshToken: string
  /** Unix epoch ms when accessToken expires */
  expiresAt: number
  /** Legacy apiKey, kept during Wave 4 grace window */
  apiKey?: string
  version: 2
}

function getConfigPath(): string {
  return join(homedir(), CONFIG_DIR, CONFIG_FILE)
}

interface StoredConfig {
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  version?: number
  [key: string]: unknown
}

function readConfigFile(): StoredConfig {
  const p = getConfigPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as StoredConfig
  } catch {
    return {}
  }
}

function writeConfigFile(data: StoredConfig): void {
  ensureConfigDir()
  const p = getConfigPath()
  writeFileSync(p, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
  try {
    chmodSync(p, 0o600)
  } catch {
    // Ignore on Windows
  }
}

async function getKeytar(): Promise<{
  setPassword(s: string, a: string, p: string): Promise<void>
  getPassword(s: string, a: string): Promise<string | null>
} | null> {
  try {
    // @ts-expect-error — optional dep, no type declarations in core
    const mod = (await import('@isaacs/keytar')) as { default?: unknown }
    return (mod.default ?? mod) as {
      setPassword(s: string, a: string, p: string): Promise<void>
      getPassword(s: string, a: string): Promise<string | null>
    }
  } catch {
    return null
  }
}

export async function storeCredentials(creds: TokenCredentials): Promise<void> {
  const existing = readConfigFile()
  const keytar = await getKeytar()

  let refreshStoredInKeyring = false
  if (keytar) {
    try {
      await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_REFRESH, creds.refreshToken)
      refreshStoredInKeyring = true
    } catch {
      // Fall through to config file
    }
  }

  writeConfigFile({
    ...existing,
    accessToken: creds.accessToken,
    expiresAt: creds.expiresAt,
    version: 2,
    ...(creds.apiKey !== undefined && { apiKey: creds.apiKey }),
    ...(refreshStoredInKeyring ? {} : { refreshToken: creds.refreshToken }),
  })
}

export async function loadCredentials(): Promise<TokenCredentials | null> {
  const config = readConfigFile()
  if (config.version !== 2 || !config.accessToken || !config.expiresAt) {
    return null
  }

  let refreshToken = config.refreshToken as string | undefined
  if (!refreshToken) {
    const keytar = await getKeytar()
    if (keytar) {
      try {
        refreshToken =
          (await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_REFRESH)) ?? undefined
      } catch {
        // Keyring unavailable
      }
    }
  }

  if (!refreshToken) return null

  return {
    accessToken: config.accessToken as string,
    refreshToken,
    expiresAt: config.expiresAt as number,
    apiKey: config.apiKey,
    version: 2,
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenCredentials | null> {
  try {
    const resp = await fetch(`${SUPABASE_AUTH_URL}/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: PRODUCTION_ANON_KEY,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })

    if (!resp.ok) return null

    const data = (await resp.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!data.access_token || !data.refresh_token) return null

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      version: 2,
    }
  } catch {
    return null
  }
}
