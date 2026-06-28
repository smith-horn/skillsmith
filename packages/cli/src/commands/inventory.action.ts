/**
 * @fileoverview `skillsmith inventory` action implementations + telemetry wrappers.
 * @module @skillsmith/cli/commands/inventory.action
 * @see SMI-5392 Wave 3 — CLI `inventory push/status/forget-device` subcommands
 *   (umbrella SMI-5382). Follows the SMI-5128 sibling-split convention: the run*
 *   business logic + typed-error handling + withTelemetry-wrapped exports live here;
 *   the commander factory stays in inventory.ts.
 *
 * Error-mapping contract for `push`:
 *   InventoryAuthError      → "Not logged in. Run `skillsmith login` and try again."
 *   InventoryConflictError  → device already owned; instruct forget-device
 *   InventoryValidationError → err.message (server-supplied reason)
 *   InventoryUploadError    → "Inventory upload failed. " + err.message
 */

import chalk from 'chalk'

import {
  pushInventory,
  getDeviceId,
  forgetDevice,
  getLastInventoryPushAt,
  isInventorySyncDisabledLocally,
  InventoryAuthError,
  InventoryConflictError,
  InventoryValidationError,
  InventoryUploadError,
} from '@skillsmith/core'
import { enumerateHarnessPresence } from '@skillsmith/core/install'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { sanitizeError } from '../utils/sanitize.js'
import { getInstalledSkillsPerHarness } from '../utils/skills-directory.js'
import { VERSION } from '../version.js'

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

/**
 * Build and upload this device's cross-harness skill inventory snapshot.
 *
 * The local opt-out (`SKILLSMITH_INVENTORY_DISABLE`) and the server-side
 * consent-disabled path are both rendered as informational messages rather
 * than errors.
 *
 * @see SMI-5392
 */
export async function runPush(): Promise<void> {
  const r = await pushInventory({ cliVersion: VERSION })

  if (r.reason === 'disabled_locally') {
    console.log(
      chalk.dim('Inventory sync disabled locally via SKILLSMITH_INVENTORY_DISABLE; nothing sent.')
    )
    return
  }

  if (!r.applied && r.reason === 'consent_disabled') {
    console.log(
      chalk.yellow(
        'Inventory sync is OFF for your account. Enable it in account settings; nothing stored.'
      )
    )
    return
  }

  if (r.applied) {
    console.log(
      chalk.green(
        `Pushed for device ${r.device_id ?? '(unknown)'}: ` +
          `${r.skills_present ?? 0} present, ${r.skills_absent ?? 0} marked absent.`
      )
    )
    return
  }

  // Defensive: unexpected ok/reason combo — relay raw fields.
  console.log(`Inventory push result: ok=${String(r.ok)} reason=${r.reason ?? '(none)'}`)
}

/** @internal Exported for unit tests. */
export async function inventoryPushActionImpl(): Promise<void> {
  try {
    await runPush()
  } catch (err) {
    if (err instanceof InventoryAuthError) {
      console.error(chalk.red('Not logged in. Run `skillsmith login` and try again.'))
    } else if (err instanceof InventoryConflictError) {
      console.error(
        chalk.red(
          'This device is registered to another account. ' +
            'Run `skillsmith inventory forget-device` and push again.'
        )
      )
    } else if (err instanceof InventoryValidationError) {
      console.error(chalk.red(err.message))
    } else if (err instanceof InventoryUploadError) {
      console.error(chalk.red('Inventory upload failed. ' + err.message))
    } else {
      console.error(chalk.red('Error:'), sanitizeError(err))
    }
    process.exit(1)
  }
}

export const inventoryPushAction = withTelemetry(inventoryPushActionImpl, {
  source: 'cli',
  extractSkillId: () => 'inventory push',
  extractFramework: () => 'cli',
})

// ---------------------------------------------------------------------------
// status  (read-only, no network)
// ---------------------------------------------------------------------------

/**
 * Print a local inventory snapshot: device ID, last-push timestamp, local
 * opt-out flag, harness presence, and per-harness skill counts.
 *
 * @param opts.verbose - When true, list individual skill IDs under each harness.
 * @see SMI-5392
 */
export async function runStatus(opts?: { verbose?: boolean }): Promise<void> {
  const deviceId = getDeviceId()
  const lastPush = getLastInventoryPushAt()
  const syncDisabled = isInventorySyncDisabledLocally()
  const harnessPresence = enumerateHarnessPresence()

  const allSkills = await getInstalledSkillsPerHarness()

  // Group skill counts by harness key.
  const countByHarness = new Map<string, number>()
  for (const entry of allSkills) {
    const key = String(entry.harness)
    countByHarness.set(key, (countByHarness.get(key) ?? 0) + 1)
  }

  console.log(chalk.bold('Skillsmith Inventory Status'))
  console.log()
  console.log(
    `  Device ID:      ${
      deviceId ? chalk.cyan(deviceId) : chalk.dim('(not yet registered — a push will create one)')
    }`
  )
  console.log(`  Last push:      ${lastPush ? chalk.dim(lastPush) : chalk.dim('never')}`)
  console.log(
    `  Local opt-out:  ${
      syncDisabled ? chalk.yellow('yes (SKILLSMITH_INVENTORY_DISABLE set)') : chalk.dim('no')
    }`
  )

  // Local (./.claude/skills) skills count.
  const localCount = countByHarness.get('local') ?? 0
  if (localCount > 0) {
    console.log(
      `  Local skills:   ${chalk.dim(`${localCount} skill${localCount === 1 ? '' : 's'} in ./.claude/skills (repo-local — not synced to your account)`)}`
    )
    if (opts?.verbose) {
      for (const s of allSkills.filter((e) => e.harness === 'local')) {
        console.log(`    - ${s.skillId}`)
      }
    }
  }

  console.log()
  console.log('  Harness presence:')
  for (const { harness, present } of harnessPresence) {
    const count = countByHarness.get(harness) ?? 0
    const badge = present ? chalk.green('yes') : chalk.dim('no ')
    const skillStr = present ? chalk.dim(`${count} skill${count === 1 ? '' : 's'}`) : ''
    console.log(`    ${String(harness).padEnd(14)} ${badge}  ${skillStr}`)
    if (opts?.verbose && present) {
      for (const s of allSkills.filter((e) => e.harness === harness)) {
        console.log(`      - ${s.skillId}`)
      }
    }
  }
}

/** @internal Exported for unit tests. */
export async function inventoryStatusActionImpl(options: { verbose?: boolean }): Promise<void> {
  try {
    await runStatus(options)
  } catch (err) {
    console.error(chalk.red('Error:'), sanitizeError(err))
    process.exit(1)
  }
}

export const inventoryStatusAction = withTelemetry(inventoryStatusActionImpl, {
  source: 'cli',
  extractSkillId: () => 'inventory status',
  extractFramework: () => 'cli',
})

// ---------------------------------------------------------------------------
// forget-device
// ---------------------------------------------------------------------------

/**
 * Clear the locally-persisted device registration so that the next push
 * registers a fresh device UUID.
 *
 * @see SMI-5392
 */
export async function runForgetDevice(): Promise<void> {
  const had = getDeviceId()
  forgetDevice()
  console.log(chalk.green('Device registration cleared.'))
  console.log(chalk.dim(`  Was: ${had ?? '(none)'}`))
  console.log(chalk.dim('  The next push will register a fresh device.'))
}

/** @internal Exported for unit tests. */
export async function inventoryForgetDeviceActionImpl(): Promise<void> {
  try {
    await runForgetDevice()
  } catch (err) {
    console.error(chalk.red('Error:'), sanitizeError(err))
    process.exit(1)
  }
}

export const inventoryForgetDeviceAction = withTelemetry(inventoryForgetDeviceActionImpl, {
  source: 'cli',
  extractSkillId: () => 'inventory forget-device',
  extractFramework: () => 'cli',
})
