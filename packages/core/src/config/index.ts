/**
 * Shared Configuration Module
 * @module @skillsmith/core/config
 *
 * SMI-1851: Shared Config Module
 * SMI-2714: CLI Login Device Flow - credential storage
 *
 * Provides cross-platform configuration loading from:
 * - Environment variables (highest precedence)
 * - ~/.skillsmith/config.json
 * - OS keyring (via @isaacs/keytar, optional)
 *
 * @example
 * ```typescript
 * import { loadConfig, getApiKey, saveConfig } from '@skillsmith/core/config'
 *
 * // Load full config
 * const config = loadConfig()
 *
 * // Get API key (env var takes precedence)
 * const apiKey = getApiKey()
 *
 * // Save config (creates file with 0600 permissions)
 * saveConfig({ apiKey: 'sk_live_...' })
 *
 * // Store API key (tries keyring first, falls back to config file)
 * await storeApiKey('sk_live_...')
 *
 * // Get auth status
 * const status = await getAuthStatus()
 * ```
 */

import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'

/**
 * Skillsmith configuration schema
 */
export interface SkillsmithConfig {
  /** API key for authenticated requests (sk_live_...) */
  apiKey?: string
  /** API base URL override */
  apiBaseUrl?: string
  /** Enable debug logging */
  debug?: boolean
  /** Telemetry settings */
  telemetry?: {
    /** Enable telemetry (default: false, opt-in) */
    enabled?: boolean
  }
  /** Sync settings */
  sync?: {
    /** Enable background sync */
    enabled?: boolean
    /** Sync interval in milliseconds */
    intervalMs?: number
  }
}

/** Default config directory name */
const CONFIG_DIR = '.skillsmith'

/** Default config file name */
const CONFIG_FILE = 'config.json'

// ============================================================================
// Keyring integration (SMI-2714)
// @isaacs/keytar is optional — gracefully absent in Docker/CI environments.
// We use a structural interface to avoid a hard dependency on the types package.
// ============================================================================

/**
 * Structural interface matching @isaacs/keytar's public API.
 * Avoids importing the types package in core (keytar is optional in cli).
 */
interface KeytarLike {
  setPassword(service: string, account: string, password: string): Promise<void>
  getPassword(service: string, account: string): Promise<string | null>
  deletePassword(service: string, account: string): Promise<boolean>
}

/** Lazy-loaded keytar module; null means unavailable */
let keytarModule: KeytarLike | null | undefined = undefined

/**
 * Lazily import @isaacs/keytar and cache the result.
 * Returns null if the module is unavailable (CI, Docker, unsupported platform).
 */
async function getKeytar(): Promise<KeytarLike | null> {
  if (keytarModule !== undefined) return keytarModule
  try {
    // @ts-expect-error — @isaacs/keytar is an optional dependency with no type declarations
    // in @skillsmith/core. We use a structural interface (KeytarLike) to type the
    // result. The import is a standard dynamic import so Vitest can intercept it.
    const mod = (await import('@isaacs/keytar')) as { default?: KeytarLike } & KeytarLike
    keytarModule = mod.default ?? mod
  } catch {
    keytarModule = null
  }
  return keytarModule
}

/** Service name used in the OS keyring */
const KEYTAR_SERVICE = 'skillsmith-cli'

/** Account key used in the OS keyring */
const KEYTAR_ACCOUNT = 'api-key'

// ============================================================================
// Config file helpers
// ============================================================================

/**
 * Get the config directory path
 * Cross-platform: uses os.homedir()
 *
 * @returns Absolute path to ~/.skillsmith/
 */
export function getConfigDir(): string {
  return join(homedir(), CONFIG_DIR)
}

/**
 * Get the config file path
 *
 * @returns Absolute path to ~/.skillsmith/config.json
 */
export function getConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILE)
}

/**
 * Ensure config directory exists with secure permissions
 * Creates ~/.skillsmith/ if it doesn't exist
 */
export function ensureConfigDir(): void {
  const configDir = getConfigDir()
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 })
  }
}

/**
 * Load configuration from ~/.skillsmith/config.json
 *
 * @returns Parsed config or empty object if file doesn't exist
 */
export function loadConfig(): SkillsmithConfig {
  const configPath = getConfigPath()

  if (!existsSync(configPath)) {
    return {}
  }

  try {
    const configData = readFileSync(configPath, 'utf-8')
    return JSON.parse(configData) as SkillsmithConfig
  } catch {
    // Silently ignore parse errors, return empty config
    return {}
  }
}

/**
 * Save configuration to ~/.skillsmith/config.json
 * Creates the file with 0600 permissions (owner read/write only)
 *
 * @param config - Configuration to save (merged with existing)
 * @param options - Save options
 */
export function saveConfig(
  config: Partial<SkillsmithConfig>,
  options: { merge?: boolean } = { merge: true }
): void {
  ensureConfigDir()

  const configPath = getConfigPath()
  let existingConfig: SkillsmithConfig = {}

  if (options.merge && existsSync(configPath)) {
    existingConfig = loadConfig()
  }

  // Remove undefined values so they are omitted from JSON output
  const updates = Object.fromEntries(
    Object.entries(config).filter(([, v]) => v !== undefined)
  ) as Partial<SkillsmithConfig>

  // Explicit undefined fields are deletions — remove them from existing config
  const deletions = Object.keys(config).filter(
    (k) => config[k as keyof SkillsmithConfig] === undefined
  )
  const cleaned = { ...existingConfig }
  for (const key of deletions) {
    delete cleaned[key as keyof SkillsmithConfig]
  }

  const mergedConfig = { ...cleaned, ...updates }
  const configJson = JSON.stringify(mergedConfig, null, 2)

  writeFileSync(configPath, configJson, { encoding: 'utf-8', mode: 0o600 })

  // Ensure permissions are set correctly (in case file existed)
  try {
    chmodSync(configPath, 0o600)
  } catch {
    // Ignore chmod errors on Windows
  }
}

/**
 * Get API key with precedence: env var > config file
 *
 * Checks in order:
 * 1. SKILLSMITH_API_KEY environment variable
 * 2. ~/.skillsmith/config.json apiKey field
 *
 * @returns API key or undefined if not configured
 */
export function getApiKey(): string | undefined {
  // Environment variable takes precedence
  const envKey = process.env.SKILLSMITH_API_KEY
  if (envKey) {
    return envKey
  }

  // Fall back to config file
  const config = loadConfig()
  return config.apiKey
}

/**
 * Get API base URL with precedence: env var > config file > default
 *
 * @param defaultUrl - Default URL if not configured
 * @returns API base URL
 */
export function getApiBaseUrl(defaultUrl = 'https://api.skillsmith.app'): string {
  const envUrl = process.env.SKILLSMITH_API_URL
  if (envUrl) {
    return envUrl
  }

  const config = loadConfig()
  return config.apiBaseUrl || defaultUrl
}

/**
 * Check if debug mode is enabled
 *
 * @returns true if debug is enabled via env var or config
 */
export function isDebugEnabled(): boolean {
  if (process.env.SKILLSMITH_DEBUG === 'true' || process.env.SKILLSMITH_DEBUG === '1') {
    return true
  }

  const config = loadConfig()
  return config.debug === true
}

/**
 * Check if telemetry is enabled (opt-in, default false)
 *
 * @returns true if telemetry is explicitly enabled
 */
export function isTelemetryEnabled(): boolean {
  if (process.env.SKILLSMITH_TELEMETRY_ENABLED === 'true') {
    return true
  }
  if (process.env.SKILLSMITH_TELEMETRY_ENABLED === 'false') {
    return false
  }

  const config = loadConfig()
  return config.telemetry?.enabled === true
}

/**
 * Validate API key format.
 *
 * Expected format: sk_live_ followed by 32-128 alphanumeric/dash/underscore chars.
 * The 200-char pre-check is a ReDoS guard per security standards.
 *
 * @param key - API key to validate
 * @returns true if key has valid format (sk_live_...)
 */
export function isValidApiKeyFormat(key: string): boolean {
  if (key.length > 200) return false // ReDoS guard
  return /^sk_live_[A-Za-z0-9_-]{32,128}$/.test(key)
}

// ============================================================================
// Credential storage (SMI-2714)
// ============================================================================

/**
 * Store an API key securely.
 *
 * Attempts to use the OS keyring first (via @isaacs/keytar).
 * Falls back to saving in ~/.skillsmith/config.json when keyring is unavailable.
 *
 * @param apiKey - The API key to store (must pass isValidApiKeyFormat)
 */
export async function storeApiKey(apiKey: string): Promise<void> {
  const keytar = await getKeytar()
  if (keytar) {
    try {
      await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, apiKey)
      return
    } catch {
      // Keyring failed — fall through to config file
    }
  }
  saveConfig({ apiKey })
}

/**
 * Clear the stored API key from all storage locations.
 *
 * Attempts to delete from the OS keyring AND removes apiKey from the config file.
 * Returns explicit success/failure info so callers can report partial failures.
 *
 * @returns Result indicating which storage locations were cleared and any errors
 */
export async function clearApiKey(): Promise<{
  success: boolean
  source: string
  error?: string
}> {
  const keyringSources: string[] = []
  let keyringError: string | undefined

  const keytar = await getKeytar()
  if (keytar) {
    try {
      const deleted = await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT)
      if (deleted) {
        keyringSources.push('keyring')
      }
    } catch (err) {
      keyringError = err instanceof Error ? err.message : String(err)
    }
  }

  // Always clear from config file — never leave a stale key there
  saveConfig({ apiKey: undefined })
  keyringSources.push('config file')

  if (keyringError) {
    return {
      success: false,
      source: keyringSources.join(' and '),
      error: keyringError,
    }
  }

  return {
    success: true,
    source: keyringSources.join(' and '),
  }
}

/**
 * Get current authentication status.
 *
 * Checks in precedence order:
 * 1. SKILLSMITH_API_KEY environment variable
 * 2. OS keyring (via @isaacs/keytar)
 * 3. ~/.skillsmith/config.json apiKey field
 *
 * @returns Authentication status with masked key prefix and storage source
 */
export async function getAuthStatus(): Promise<{
  authenticated: boolean
  keyPrefix: string | null
  source: 'keyring' | 'config' | 'env' | 'none'
}> {
  // 1. Environment variable (highest precedence)
  const envKey = process.env.SKILLSMITH_API_KEY
  if (envKey && isValidApiKeyFormat(envKey)) {
    return {
      authenticated: true,
      keyPrefix: envKey.substring(0, 12),
      source: 'env',
    }
  }

  // 2. OS keyring
  const keytar = await getKeytar()
  if (keytar) {
    try {
      const keyrKey = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT)
      if (keyrKey && isValidApiKeyFormat(keyrKey)) {
        return {
          authenticated: true,
          keyPrefix: keyrKey.substring(0, 12),
          source: 'keyring',
        }
      }
    } catch {
      // Keyring unavailable or locked — fall through to config file
    }
  }

  // 3. Config file
  const config = loadConfig()
  if (config.apiKey && isValidApiKeyFormat(config.apiKey)) {
    return {
      authenticated: true,
      keyPrefix: config.apiKey.substring(0, 12),
      source: 'config',
    }
  }

  return {
    authenticated: false,
    keyPrefix: null,
    source: 'none',
  }
}
