/**
 * @fileoverview `skillsmith telemetry` action implementations + telemetry wrappers.
 * @module @skillsmith/cli/commands/telemetry.action
 * @see SMI-5128 batch D — sibling-split of telemetry.ts so the 6 subcommand
 *   handlers can be wrapped with withTelemetry without exceeding the 500-LOC
 *   gate. Mirrors the sync.action.ts / search.action.ts convention (SMI-5127):
 *   the run* business logic + the wrapped *Action exports live here; the
 *   commander factory stays in telemetry.ts and imports the wrapped actions.
 *
 * Privacy invariants (plan line 719):
 *   - anonymousId is NEVER printed in full. Only the last 8 hex chars appear in stdout.
 *   - The full SHA-256 hex travels only to the events endpoint in hook payloads.
 *
 * SMI-6358: every write below now goes through updateManifestEntry()
 * (manifest.ts) instead of a bare loadManifest()+saveManifest() pair — the
 * old pattern read the manifest, computed an update from that snapshot, and
 * saved it back with no lock, so a `skillsmith telemetry enable` racing a
 * `skillsmith pin`/`unpin` (or two overlapping telemetry commands) could
 * lose one side's write. updateManifestEntry() now takes the same
 * cross-process lock @skillsmith/core's ManifestManager uses and returns
 * the manifest AFTER the update, so functions that need the resulting value
 * (e.g. runEnable's printed anonymousId) read it off that return rather
 * than a second, unlocked loadManifest() call.
 */

import { existsSync, copyFileSync, chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { readdirSync, unlinkSync, statSync } from 'node:fs'
import { packageRoot } from '../utils/package-root.js'

import chalk from 'chalk'

import {
  loadManifest,
  updateManifestEntry,
  generateAnonymousId,
  shouldRotateAnonymousId,
  rotateAnonymousId,
  sweepExpiredPreviousId,
  type TelemetryManifest,
} from '../utils/manifest.js'
import {
  loadClaudeSettings,
  addSkillHookEntries,
  removeSkillHookEntries,
  writeClaudeSettings,
  TelemetryHookError,
} from './telemetry.helpers.js'
import { sanitizeError } from '../utils/sanitize.js'
import { getCliLogger } from '../cli-logger.js'
import { withTelemetry } from '@skillsmith/core/telemetry'

const logger = getCliLogger()

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRIVACY_URL = 'https://skillsmith.app/privacy#telemetry'
const DEFAULT_ENDPOINT = 'https://vrcnzpmndtroqxxoqkzy.supabase.co/functions/v1/events'
const ORPHAN_TTL_MS = 60 * 60 * 1000 // 1 hour

// All path helpers resolved at call time so test harnesses that swap HOME work.
function hookScriptPath(): string {
  return join(homedir(), '.skillsmith', 'hooks', 'skill-telemetry.sh')
}
function runDir(): string {
  return join(homedir(), '.skillsmith', 'run')
}

// ---------------------------------------------------------------------------
// Privacy helper — NEVER print full anonymousId
// ---------------------------------------------------------------------------

function idTail(id: string | undefined): string {
  if (!id) return '(none)'
  return `...${id.slice(-8)}`
}

// ---------------------------------------------------------------------------
// Orphan GC (plan line 714)
// ---------------------------------------------------------------------------

function gcOrphanRunFiles(): void {
  try {
    const dir = runDir()
    if (!existsSync(dir)) return
    const now = Date.now()
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('skill-')) continue
      const fp = join(dir, f)
      try {
        const st = statSync(fp)
        if (now - st.mtimeMs > ORPHAN_TTL_MS) unlinkSync(fp)
      } catch {
        // best-effort
      }
    }
  } catch {
    // never throw from GC
  }
}

// ---------------------------------------------------------------------------
// enable
// ---------------------------------------------------------------------------

async function runEnable(): Promise<void> {
  // Unlocked peek only for the "already enabled" fast-path message — the
  // actual mutation (and the SAME check, re-applied) happens inside the
  // locked updateFn below so a racing enable/rotate never lose each other.
  const peek = await loadManifest()
  if ((peek.telemetry ?? { enabled: false }).enabled) {
    const t = peek.telemetry as TelemetryManifest
    console.log(chalk.green('Telemetry is already enabled.'))
    console.log(chalk.dim(`  Anonymous ID tail: ${idTail(t.anonymousId)}`))
    return
  }

  const now = new Date().toISOString()
  let updated: TelemetryManifest = { enabled: false }
  await updateManifestEntry((manifest) => {
    const t: TelemetryManifest = manifest.telemetry ?? { enabled: false }
    updated = {
      ...t,
      enabled: true,
      anonymousId: t.anonymousId ?? generateAnonymousId(),
      anonymousIdCreatedAt: t.anonymousIdCreatedAt ?? now,
      scope: t.scope ?? 'personal',
      endpoint: t.endpoint ?? DEFAULT_ENDPOINT,
    }
    return { ...manifest, telemetry: updated }
  })

  console.log(chalk.green('Telemetry enabled.'))
  console.log()
  console.log(
    'Skillsmith telemetry collects anonymous skill-invocation counts to help improve\n' +
      'the registry and surface stale skills. No personal data, file contents, or\n' +
      `paths are captured. Full privacy policy: ${chalk.cyan(PRIVACY_URL)}`
  )
  console.log()
  console.log(chalk.dim(`  Anonymous ID tail: ${idTail(updated.anonymousId)}`))
  console.log(chalk.dim('  Disable at any time: ') + chalk.cyan('skillsmith telemetry disable'))
}

// ---------------------------------------------------------------------------
// disable
// ---------------------------------------------------------------------------

async function runDisable(): Promise<void> {
  // Unlocked peek only for the "already disabled" fast-path message — same
  // rationale as runEnable() above.
  const peek = await loadManifest()
  if (!(peek.telemetry ?? { enabled: false }).enabled) {
    console.log(chalk.dim('Telemetry is already disabled.'))
    return
  }

  await updateManifestEntry((manifest) => {
    const t: TelemetryManifest = manifest.telemetry ?? { enabled: false }
    return { ...manifest, telemetry: { ...t, enabled: false } }
  })

  console.log(chalk.yellow('Telemetry disabled.'))
  console.log(
    chalk.dim(
      '  The anonymous ID is retained in the local manifest for continuity if you re-enable.\n' +
        '  To fully clear it: skillsmith telemetry reset-id'
    )
  )
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function runStatus(): Promise<void> {
  // Unlocked peek to decide WHETHER a write is needed at all — avoids
  // taking the lock (and rewriting the file) on every plain `status` call,
  // the overwhelmingly common case where neither rotation nor sweep apply.
  // The actual decision is re-evaluated fresh INSIDE the lock below, so a
  // stale peek only costs a skipped fast-path, never a wrong write.
  let manifest = await loadManifest()
  let rotationTriggered = false
  const peekNeedsRotation = shouldRotateAnonymousId(manifest)
  const peekSwept = sweepExpiredPreviousId(manifest)
  const peekNeedsSweep = peekSwept !== manifest.telemetry

  if (peekNeedsRotation || peekNeedsSweep) {
    manifest = await updateManifestEntry((current) => {
      let next = current
      // Annual auto-rotation (plan line 706, 713)
      if (shouldRotateAnonymousId(next)) {
        next = { ...next, telemetry: rotateAnonymousId(next) }
        rotationTriggered = true
      }
      // Sweep expired previous id
      const swept = sweepExpiredPreviousId(next)
      if (swept !== next.telemetry) {
        next = { ...next, telemetry: swept }
      }
      return next
    })
  }

  // GC orphan run files (plan line 714)
  gcOrphanRunFiles()

  const t: TelemetryManifest = manifest.telemetry ?? { enabled: false }
  const endpoint = t.endpoint ?? DEFAULT_ENDPOINT

  let ageDays: number | null = null
  if (t.anonymousIdCreatedAt) {
    ageDays = Math.floor((Date.now() - new Date(t.anonymousIdCreatedAt).getTime()) / 86_400_000)
  }

  console.log(chalk.bold('Skillsmith Telemetry Status'))
  console.log()
  console.log(`  Enabled:          ${t.enabled ? chalk.green('yes') : chalk.dim('no')}`)
  console.log(`  Endpoint:         ${chalk.dim(endpoint)}`)
  console.log(`  Anonymous ID:     ${chalk.dim(idTail(t.anonymousId))}`)
  console.log(`  ID age (days):    ${ageDays !== null ? String(ageDays) : chalk.dim('n/a')}`)
  console.log(`  Scope:            ${t.scope ?? chalk.dim('personal')}`)

  if (t.installedAt) {
    console.log(`  Hook installed:   ${chalk.dim(t.installedAt)}`)
  }

  if (rotationTriggered) {
    console.log()
    console.log(
      chalk.yellow('  Annual rotation triggered.') +
        chalk.dim(' New ID tail: ') +
        chalk.cyan(idTail(t.anonymousId))
    )
    if (t.previousAnonymousId) {
      console.log(
        chalk.dim(
          `  Previous ID retained for 7-day overlap window (retired: ${t.previousAnonymousIdRetiredAt ?? 'unknown'})`
        )
      )
    }
  }
}

// ---------------------------------------------------------------------------
// install-hook
// ---------------------------------------------------------------------------

async function runInstallHook(options: {
  scope: 'user' | 'project'
  endpoint?: string
}): Promise<void> {
  // Resolve the template source via packageRoot() — works correctly in the
  // esbuild bundle (dist/cli.js -> .. = package root) and tests mock existsSync.
  const templateSrc = join(packageRoot(), 'templates', 'skill-telemetry.sh')
  if (!existsSync(templateSrc)) {
    throw new Error(
      'skill-telemetry.sh template not found. ' +
        'Ensure the CLI package is fully built: npm run build'
    )
  }

  // Load + validate settings.json — throws TelemetryHookError on foreign Skill matcher
  const scope = options.scope
  const settings = loadClaudeSettings(scope)
  const hookPath = hookScriptPath()
  const updated = addSkillHookEntries(settings, hookPath)

  // Copy hook script to ~/.skillsmith/hooks/
  const destPath = hookScriptPath()
  const hooksDir = dirname(destPath)
  mkdirSync(hooksDir, { recursive: true, mode: 0o700 })
  copyFileSync(templateSrc, destPath)
  try {
    chmodSync(destPath, 0o755)
  } catch {
    // best-effort on Windows
  }

  // Persist settings.json atomically
  writeClaudeSettings(scope, updated)

  // Record installation timestamp (and endpoint, if provided) in the
  // manifest — both fields written in ONE locked update rather than two
  // separate unlocked load+save round trips, so a racing writer can't land
  // between them and have one of the two fields lost.
  const installedAt = new Date().toISOString()
  await updateManifestEntry((manifest) => {
    const t: TelemetryManifest = manifest.telemetry ?? { enabled: false }
    const next: TelemetryManifest = { ...t, installedAt }
    if (options.endpoint) next.endpoint = options.endpoint
    return { ...manifest, telemetry: next }
  })

  const scopeLabel = scope === 'user' ? '~/.claude/settings.json' : './.claude/settings.json'
  console.log(chalk.green('Skillsmith telemetry hook installed.'))
  console.log(chalk.dim(`  Hook script:   ${destPath}`))
  console.log(chalk.dim(`  Settings file: ${scopeLabel}`))
  console.log()
  console.log(
    chalk.dim('Enable telemetry to start collecting: ') + chalk.cyan('skillsmith telemetry enable')
  )
}

// ---------------------------------------------------------------------------
// uninstall-hook
// ---------------------------------------------------------------------------

async function runUninstallHook(options: { scope: 'user' | 'project' }): Promise<void> {
  const scope = options.scope
  const hookPath = hookScriptPath()
  const settings = loadClaudeSettings(scope)
  const updated = removeSkillHookEntries(settings, hookPath)
  writeClaudeSettings(scope, updated)

  // Optionally remove the script file
  try {
    const scriptPath = hookScriptPath()
    if (existsSync(scriptPath)) unlinkSync(scriptPath)
  } catch {
    // best-effort
  }

  const scopeLabel = scope === 'user' ? '~/.claude/settings.json' : './.claude/settings.json'
  console.log(chalk.yellow('Skillsmith telemetry hook removed.'))
  console.log(chalk.dim(`  Removed from: ${scopeLabel}`))
  console.log(chalk.dim('  Foreign hooks (if any) were not touched.'))
}

// ---------------------------------------------------------------------------
// reset-id
// ---------------------------------------------------------------------------

async function runResetId(): Promise<void> {
  let rotated: TelemetryManifest = { enabled: false }
  await updateManifestEntry((manifest) => {
    rotated = rotateAnonymousId(manifest) // unconditional rotation
    return { ...manifest, telemetry: rotated }
  })

  console.log(chalk.green('Anonymous ID rotated.'))
  console.log(chalk.dim(`  New ID tail:      ${idTail(rotated.anonymousId)}`))
  if (rotated.previousAnonymousId) {
    console.log(chalk.dim(`  Previous ID tail: ${idTail(rotated.previousAnonymousId)}`))
    console.log(
      chalk.dim(
        `  Previous ID retirement: ${rotated.previousAnonymousIdRetiredAt ?? 'unknown'} (7-day overlap window)`
      )
    )
  }
}

// ---------------------------------------------------------------------------
// withTelemetry-wrapped action handlers (SMI-5128)
// ---------------------------------------------------------------------------

async function telemetryEnableActionImpl(): Promise<void> {
  try {
    await runEnable()
  } catch (err) {
    logger.error(`${chalk.red('Error:')} ${sanitizeError(err)}`)
    process.exit(1)
  }
}

export const telemetryEnableAction = withTelemetry(telemetryEnableActionImpl, {
  source: 'cli',
  extractSkillId: () => 'telemetry enable',
  extractFramework: () => 'cli',
})

async function telemetryDisableActionImpl(): Promise<void> {
  try {
    await runDisable()
  } catch (err) {
    logger.error(`${chalk.red('Error:')} ${sanitizeError(err)}`)
    process.exit(1)
  }
}

export const telemetryDisableAction = withTelemetry(telemetryDisableActionImpl, {
  source: 'cli',
  extractSkillId: () => 'telemetry disable',
  extractFramework: () => 'cli',
})

async function telemetryStatusActionImpl(): Promise<void> {
  try {
    await runStatus()
  } catch (err) {
    logger.error(`${chalk.red('Error:')} ${sanitizeError(err)}`)
    process.exit(1)
  }
}

export const telemetryStatusAction = withTelemetry(telemetryStatusActionImpl, {
  source: 'cli',
  extractSkillId: () => 'telemetry status',
  extractFramework: () => 'cli',
})

async function telemetryInstallHookActionImpl(options: {
  scope: string
  endpoint?: string
}): Promise<void> {
  const scope = options.scope === 'project' ? 'project' : 'user'
  try {
    await runInstallHook(
      options.endpoint !== undefined ? { scope, endpoint: options.endpoint } : { scope }
    )
  } catch (err) {
    if (err instanceof TelemetryHookError) {
      logger.error(chalk.red(`Error [${err.code}]:`))
      logger.error(err.message)
    } else {
      logger.error(`${chalk.red('Error:')} ${sanitizeError(err)}`)
    }
    process.exit(1)
  }
}

export const telemetryInstallHookAction = withTelemetry(telemetryInstallHookActionImpl, {
  source: 'cli',
  extractSkillId: () => 'telemetry install-hook',
  extractFramework: () => 'cli',
})

async function telemetryUninstallHookActionImpl(options: { scope: string }): Promise<void> {
  const scope = options.scope === 'project' ? 'project' : 'user'
  try {
    await runUninstallHook({ scope })
  } catch (err) {
    logger.error(`${chalk.red('Error:')} ${sanitizeError(err)}`)
    process.exit(1)
  }
}

export const telemetryUninstallHookAction = withTelemetry(telemetryUninstallHookActionImpl, {
  source: 'cli',
  extractSkillId: () => 'telemetry uninstall-hook',
  extractFramework: () => 'cli',
})

async function telemetryResetIdActionImpl(): Promise<void> {
  try {
    await runResetId()
  } catch (err) {
    logger.error(`${chalk.red('Error:')} ${sanitizeError(err)}`)
    process.exit(1)
  }
}

export const telemetryResetIdAction = withTelemetry(telemetryResetIdActionImpl, {
  source: 'cli',
  extractSkillId: () => 'telemetry reset-id',
  extractFramework: () => 'cli',
})

// Internal exports for tests (re-exported from telemetry.ts for back-compat).
export { runEnable, runDisable, runStatus, runInstallHook, runUninstallHook, runResetId, idTail }
