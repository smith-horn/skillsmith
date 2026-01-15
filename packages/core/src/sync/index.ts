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
