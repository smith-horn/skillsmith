/**
 * Shared Configuration Module
 * @module @skillsmith/core/config
 *
 * SMI-1851: Shared Config Module
 *
 * Provides cross-platform configuration loading from:
 * - Environment variables (highest precedence)
 * - ~/.skillsmith/config.json
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

  const mergedConfig = { ...existingConfig, ...config }
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
 * Validate API key format
 *
 * @param key - API key to validate
 * @returns true if key has valid format (sk_live_...)
 */
export function isValidApiKeyFormat(key: string): boolean {
  return /^sk_live_[A-Za-z0-9_-]{32,}$/.test(key)
}
