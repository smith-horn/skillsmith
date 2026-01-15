/**
 * BackgroundSyncService - Session-based automatic sync
 *
 * Runs sync operations during active MCP server sessions based on
 * user-configured frequency (daily/weekly). Uses non-blocking timers
 * that don't prevent process exit.
 */

import type { SyncEngine, SyncResult } from './SyncEngine.js'
import type { SyncConfigRepository } from '../repositories/SyncConfigRepository.js'

/**
 * Background sync service options
 */
export interface BackgroundSyncOptions {
  /** Check interval in ms (default: 60000 = 1 minute) */
  checkIntervalMs?: number
  /** Run sync immediately on start if due */
  syncOnStart?: boolean
  /** Callback when sync completes */
  onSyncComplete?: (result: SyncResult) => void
  /** Callback when sync fails */
  onSyncError?: (error: Error) => void
  /** Enable debug logging */
  debug?: boolean
}

/**
 * Service state
 */
export interface BackgroundSyncState {
  isStarted: boolean
  isRunning: boolean
  lastResult: SyncResult | null
  lastError: Error | null
  checksPerformed: number
  syncsTriggered: number
}

/**
 * Background sync service for automatic registry synchronization
 */
export class BackgroundSyncService {
  private syncEngine: SyncEngine
  private configRepo: SyncConfigRepository
  private options: Required<BackgroundSyncOptions>

  private timer: ReturnType<typeof setInterval> | null = null
  private isRunning = false
  private isStopped = false

  private state: BackgroundSyncState = {
    isStarted: false,
    isRunning: false,
    lastResult: null,
    lastError: null,
    checksPerformed: 0,
    syncsTriggered: 0,
  }

  constructor(
    syncEngine: SyncEngine,
    configRepo: SyncConfigRepository,
    options: BackgroundSyncOptions = {}
  ) {
    this.syncEngine = syncEngine
    this.configRepo = configRepo
    this.options = {
      checkIntervalMs: options.checkIntervalMs ?? 60000, // 1 minute
      syncOnStart: options.syncOnStart ?? true,
      onSyncComplete: options.onSyncComplete ?? (() => {}),
      onSyncError: options.onSyncError ?? (() => {}),
      debug: options.debug ?? false,
    }
  }

  private log(message: string, data?: unknown): void {
    if (this.options.debug) {
      console.log(`[BackgroundSync] ${message}`, data ?? '')
    }
  }

  /**
   * Start the background sync service
   */
  start(): void {
    if (this.state.isStarted) {
      this.log('Already started, ignoring')
      return
    }

    const config = this.configRepo.getConfig()
    if (!config.enabled) {
      this.log('Auto-sync is disabled, not starting')
      return
    }

    this.state.isStarted = true
    this.isStopped = false
    this.log('Starting background sync service', {
      frequency: config.frequency,
      intervalMs: config.intervalMs,
      lastSyncAt: config.lastSyncAt,
    })

    // Check if sync is due on startup
    if (this.options.syncOnStart && this.shouldSyncNow()) {
      this.log('Sync is due, triggering immediately')
      this.triggerSync()
    }

    // Start periodic check timer
    this.timer = setInterval(() => this.checkAndSync(), this.options.checkIntervalMs)

    // Don't block process exit
    if (this.timer.unref) {
      this.timer.unref()
    }
  }

  /**
   * Stop the background sync service
   */
  stop(): void {
    this.log('Stopping background sync service')
    this.isStopped = true
    this.state.isStarted = false

    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Check if sync should run now
   */
  private shouldSyncNow(): boolean {
    const config = this.configRepo.getConfig()

    // Must be enabled
    if (!config.enabled) {
      return false
    }

    // If never synced, sync now
    if (!config.lastSyncAt) {
      return true
    }

    // Check if next sync time has passed
    return this.configRepo.isSyncDue()
  }

  /**
   * Check if sync is due and trigger if needed
   */
  private async checkAndSync(): Promise<void> {
    this.state.checksPerformed++

    if (this.isStopped) {
      return
    }

    // Re-check config in case it changed
    const config = this.configRepo.getConfig()
    if (!config.enabled) {
      this.log('Auto-sync disabled during check')
      return
    }

    if (this.shouldSyncNow()) {
      this.log('Sync is due, triggering')
      await this.triggerSync()
    }
  }

  /**
   * Trigger a sync operation
   */
  private async triggerSync(): Promise<void> {
    // Prevent concurrent syncs
    if (this.isRunning) {
      this.log('Sync already in progress, skipping')
      return
    }

    this.isRunning = true
    this.state.isRunning = true
    this.state.syncsTriggered++

    try {
      this.log('Starting sync')
      const result = await this.syncEngine.sync()
      this.state.lastResult = result
      this.state.lastError = null

      this.log('Sync completed', {
        success: result.success,
        added: result.skillsAdded,
        updated: result.skillsUpdated,
        unchanged: result.skillsUnchanged,
        durationMs: result.durationMs,
      })

      this.options.onSyncComplete(result)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.state.lastError = err
      this.log('Sync failed', { error: err.message })
      this.options.onSyncError(err)
    } finally {
      this.isRunning = false
      this.state.isRunning = false
    }
  }

  /**
   * Manually trigger a sync (for testing or manual intervention)
   */
  async manualSync(): Promise<SyncResult> {
    this.log('Manual sync triggered')
    this.state.syncsTriggered++

    if (this.isRunning) {
      throw new Error('Sync already in progress')
    }

    this.isRunning = true
    this.state.isRunning = true

    try {
      const result = await this.syncEngine.sync()
      this.state.lastResult = result
      this.state.lastError = null
      this.options.onSyncComplete(result)
      return result
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.state.lastError = err
      this.options.onSyncError(err)
      throw err
    } finally {
      this.isRunning = false
      this.state.isRunning = false
    }
  }

  /**
   * Get current service state
   */
  getState(): BackgroundSyncState {
    return { ...this.state }
  }

  /**
   * Check if service is actively running syncs
   */
  isSyncRunning(): boolean {
    return this.isRunning
  }

  /**
   * Check if service is started
   */
  isServiceStarted(): boolean {
    return this.state.isStarted
  }
}

/**
 * Create and start a background sync service
 */
export function createBackgroundSyncService(
  syncEngine: SyncEngine,
  configRepo: SyncConfigRepository,
  options?: BackgroundSyncOptions
): BackgroundSyncService {
  const service = new BackgroundSyncService(syncEngine, configRepo, options)
  service.start()
  return service
}
