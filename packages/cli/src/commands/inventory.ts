/**
 * @fileoverview `skillsmith inventory` command group — cross-harness inventory management.
 * @module @skillsmith/cli/commands/inventory
 * @see SMI-5392 Wave 3 — CLI `inventory` subcommands (umbrella SMI-5382).
 * @see SMI-5128 sibling-split convention — action impls + withTelemetry wrappers
 *   live in inventory.action.ts; this file retains only the commander factory.
 *
 * Subcommands:
 *   skillsmith inventory push
 *   skillsmith inventory status [--verbose]
 *   skillsmith inventory forget-device
 */

import { Command } from 'commander'

import {
  inventoryPushAction,
  inventoryStatusAction,
  inventoryForgetDeviceAction,
} from './inventory.action.js'

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

/**
 * Build and return the `inventory` commander group with its three subcommands.
 *
 * @see SMI-5392
 */
export function createInventoryCommand(): Command {
  const inventory = new Command('inventory').description(
    'Manage cross-harness skill inventory sync and device registration'
  )

  inventory
    .command('push')
    .description("Push this device's skill inventory snapshot to the registry")
    .action(inventoryPushAction)

  inventory
    .command('status')
    .description('Show local inventory state (read-only, no network calls)')
    .option('--verbose', 'List individual skill IDs under each harness')
    .action(inventoryStatusAction)

  inventory
    .command('forget-device')
    .description('Clear the local device registration; the next push will create a fresh device')
    .action(inventoryForgetDeviceAction)

  return inventory
}

// Internal exports for tests — sourced from inventory.action.ts (SMI-5128 split).
export {
  runPush,
  runStatus,
  runForgetDevice,
  inventoryPushActionImpl,
  inventoryStatusActionImpl,
  inventoryForgetDeviceActionImpl,
} from './inventory.action.js'
