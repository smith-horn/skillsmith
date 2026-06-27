/**
 * Sync Module - Registry synchronization
 *
 * Provides functionality for synchronizing the local skill database
 * with the live Skillsmith registry.
 */

// Repositories
export {
  SyncConfigRepository,
  type SyncConfig,
  type SyncConfigUpdate,
  type SyncFrequency,
  FREQUENCY_INTERVALS,
} from '../repositories/SyncConfigRepository.js'

export {
  SyncHistoryRepository,
  type SyncHistoryEntry,
  type SyncStatus,
  type SyncRunResult,
} from '../repositories/SyncHistoryRepository.js'

// Core sync engine
export { SyncEngine, type SyncOptions, type SyncProgress, type SyncResult } from './SyncEngine.js'

// Background service
export {
  BackgroundSyncService,
  createBackgroundSyncService,
  type BackgroundSyncOptions,
  type BackgroundSyncState,
} from './BackgroundSyncService.js'

// Cross-harness inventory payload contract (SMI-5389)
export {
  INVENTORY_LIMITS,
  INVENTORY_UPDATE_POLICIES,
  type InventoryDevice,
  type InventorySkillEntry,
  type InventoryUpdatePolicy,
  type InventoryUploadPayload,
  type InventoryUploadResult,
} from './inventory-types.js'

// Cross-harness inventory service — shared local agent (SMI-5392)
export { collectDeviceSkills } from './inventory-collector.js'
export { buildInventoryDevice, type BuildInventoryDeviceOptions } from './inventory-device.js'
export { buildInventoryPayload } from './inventory-builder.js'
export {
  uploadInventory,
  InventoryAuthError,
  InventoryConflictError,
  InventoryValidationError,
  InventoryUploadError,
} from './inventory-client.js'
export {
  pushInventory,
  maybeAutoPush,
  type PushInventoryOptions,
  type MaybeAutoPushOptions,
} from './inventory-push.js'
