/**
 * @fileoverview `sklx config` command — get/set Skillsmith configuration values.
 * @module @skillsmith/cli/commands/config
 * @see SMI-4590 Wave 4 PR 5/6 §8 — `audit_mode` CLI plumbing + tier-revalidation
 *
 * v1 surface (intentionally narrow):
 * - `sklx config get audit_mode`         → prints the resolved audit-mode for
 *                                           the caller (config-file value when
 *                                           set, else tier default).
 * - `sklx config set audit_mode <value>` → writes `audit_mode` to
 *                                           `~/.skillsmith/config.json`. Atomic
 *                                           write via `<path>.tmp` + rename.
 *                                           Tier-revalidated against
 *                                           `tierAllowsAuditMode` —
 *                                           community/individual cannot select
 *                                           `power_user` or `governance`.
 *
 * Typed error codes (printed to stderr; exit 1):
 *   audit.mode.invalid_value     — value not in {preventative,power_user,governance,off}
 *   audit.mode.tier_ineligible   — tier cannot select the requested mode
 *
 * No file write occurs on either error path. Other keys are rejected with a
 * generic "unsupported key" message — the surface intentionally locks down
 * to v1 deliverables; v2 extends with additional keys.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

import { Command } from 'commander'
import chalk from 'chalk'

import { isAuditMode, resolveAuditMode, type AuditMode } from '@skillsmith/core/config/audit-mode'
import { tierAllowsAuditMode } from '@skillsmith/core/audit'

import { sanitizeError } from '../utils/sanitize.js'
import { getLicenseStatus } from '../utils/license.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_DIR = '.skillsmith'
const CONFIG_FILE = 'config.json'

const SUPPORTED_KEYS = ['audit_mode'] as const
type SupportedKey = (typeof SUPPORTED_KEYS)[number]

const VALID_AUDIT_MODES: ReadonlyArray<AuditMode> = [
  'preventative',
  'power_user',
  'governance',
  'off',
]

// ---------------------------------------------------------------------------
// Typed error envelope (stderr-only; never logged with secrets)
// ---------------------------------------------------------------------------

class ConfigError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

function isSupportedKey(key: string): key is SupportedKey {
  return (SUPPORTED_KEYS as ReadonlyArray<string>).includes(key)
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function configPath(): string {
  // Re-evaluates os.homedir() each call so test harnesses that toggle
  // process.env.HOME observe the updated location (mirrors the
  // `defaultLedgerPath` pattern in namespace-overrides.ts).
  return join(homedir(), CONFIG_DIR, CONFIG_FILE)
}

// ---------------------------------------------------------------------------
// Atomic read/write
// ---------------------------------------------------------------------------

interface ConfigFile {
  audit_mode?: AuditMode
  // Permissive: preserve unknown keys on read-modify-write.
  [otherKey: string]: unknown
}

function readConfigFile(): ConfigFile {
  const path = configPath()
  if (!fs.existsSync(path)) return {}
  try {
    const raw = fs.readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as ConfigFile
  } catch {
    // Malformed JSON: degrade to empty rather than fail-loud — the user can
    // still set audit_mode (write will overwrite the malformed file).
    return {}
  }
}

/**
 * Atomic write of the config file: `<path>.<rand>.tmp` + `fs.rename`.
 * Plan §403 explicitly requires atomic writes for `sklx config set` so a
 * crashed process never leaves a half-written config behind.
 *
 * The unique tmp suffix prevents two concurrent writers from clobbering
 * each other's staging file (mirrors the namespace-overrides ledger
 * writer's pattern).
 */
function writeConfigFileAtomic(config: ConfigFile): void {
  const path = configPath()
  const dir = dirname(path)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  const tmpSuffix = crypto.randomBytes(6).toString('hex')
  const tmpPath = `${path}.${tmpSuffix}.tmp`

  const json = JSON.stringify(config, null, 2)
  fs.writeFileSync(tmpPath, json, { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmpPath, path)

  // chmod the final path defensively; ignore errors (Windows / read-only FS).
  try {
    fs.chmodSync(path, 0o600)
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// `config get` / `config set` action handlers
// ---------------------------------------------------------------------------

async function runConfigGet(key: string): Promise<void> {
  if (!isSupportedKey(key)) {
    throw new ConfigError('config.unsupported_key', `Unsupported config key: ${key}`)
  }

  if (key === 'audit_mode') {
    const file = readConfigFile()
    const status = await getLicenseStatus()
    const tier = status.tier ?? 'community'
    const fileValue = isAuditMode(file.audit_mode) ? file.audit_mode : null
    const resolved = resolveAuditMode({ tier, override: fileValue })

    if (fileValue) {
      console.log(`${fileValue}`)
    } else {
      console.log(`${resolved} ${chalk.dim('(tier default)')}`)
    }
  }
}

/**
 * Validate + write `audit_mode`. Two-stage gate:
 *   1. Value validation: must be in VALID_AUDIT_MODES → else `audit.mode.invalid_value`.
 *   2. Tier revalidation: `tierAllowsAuditMode` → else `audit.mode.tier_ineligible`.
 *
 * Both errors are raised BEFORE any file IO so a rejected write leaves the
 * existing config untouched (load-bearing per plan §810-813 security test).
 */
async function runConfigSet(key: string, value: string): Promise<void> {
  if (!isSupportedKey(key)) {
    throw new ConfigError('config.unsupported_key', `Unsupported config key: ${key}`)
  }

  if (key === 'audit_mode') {
    if (!isAuditMode(value)) {
      throw new ConfigError(
        'audit.mode.invalid_value',
        `Invalid audit_mode value: ${value}. Expected one of: ${VALID_AUDIT_MODES.join(', ')}`
      )
    }

    const status = await getLicenseStatus()
    const tier = status.tier ?? 'community'

    if (!tierAllowsAuditMode(tier, value)) {
      throw new ConfigError(
        'audit.mode.tier_ineligible',
        `Tier '${tier}' cannot select audit_mode '${value}'. ` +
          `Upgrade required — see https://skillsmith.app/upgrade`
      )
    }

    const existing = readConfigFile()
    const updated: ConfigFile = { ...existing, audit_mode: value }
    writeConfigFileAtomic(updated)
    console.log(`${chalk.green('OK')} audit_mode = ${value}`)
  }
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

/**
 * Build the `config` parent command. v1 supports `get` / `set` subcommands
 * with a single supported key (`audit_mode`). Additional keys land in v2.
 */
export function createConfigCommand(): Command {
  const config = new Command('config').description(
    'Get or set Skillsmith configuration values (~/.skillsmith/config.json)'
  )

  config
    .command('get <key>')
    .description('Read a configuration value (e.g. `audit_mode`)')
    .action(async (key: string) => {
      try {
        await runConfigGet(key)
      } catch (error) {
        if (error instanceof ConfigError) {
          console.error(chalk.red(`Error [${error.code}]:`), error.message)
        } else {
          console.error(chalk.red('Error:'), sanitizeError(error))
        }
        process.exit(1)
      }
    })

  config
    .command('set <key> <value>')
    .description('Write a configuration value (atomic; tier-revalidated for audit_mode)')
    .action(async (key: string, value: string) => {
      try {
        await runConfigSet(key, value)
      } catch (error) {
        if (error instanceof ConfigError) {
          console.error(chalk.red(`Error [${error.code}]:`), error.message)
        } else {
          console.error(chalk.red('Error:'), sanitizeError(error))
        }
        process.exit(1)
      }
    })

  return config
}

// Internal exports for tests. Consumers should use `createConfigCommand`.
export { runConfigGet, runConfigSet, ConfigError, configPath, readConfigFile }
export default createConfigCommand
