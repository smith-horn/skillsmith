/**
 * BackgroundSyncService - Session-based automatic sync
 *
 * Runs sync operations during active MCP server sessions based on
 * user-configured frequency (daily/weekly). Uses non-blocking timers
 * that don't prevent process exit.
 */

import type { SyncEngine, SyncResult } from './SyncEngine.js'
import type { SyncConfigRepository } from '../repositories/SyncConfigRepository.js'
import { createLogger } from '../logging/index.js'

// SMI-5649: sync errors were previously invisible by default (a no-op
// `onSyncError`); mirrors shutdown.ts's SMI-5615 stderr-visibility pattern
// so a background sync failure is never silently swallowed.
const logger = createLogger('mcp')

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
  // SMI-5649: abort + in-flight tracking so stop() can await settlement
  // instead of being fire-and-forget (the root cause of the shutdown race).
  private abortController: AbortController | null = null
  private inFlightSync: Promise<void> | null = null

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
      // SMI-5649: default now logs (was a silent no-op) — mirrors
      // closeDbOnShutdown's SMI-5615 stderr-visibility rationale so a
      // background sync failure is visible even when no caller overrides it.
      onSyncError:
        options.onSyncError ??
        ((error: Error) => {
          logger.error('[skillsmith] Background sync failed', { err: error })
        }),
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
    // SMI-5649: fresh controller per start() so a stop()->start() cycle
    // (e.g. in tests) doesn't reuse an already-aborted signal.
    this.abortController = new AbortController()
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
   * Stop the background sync service.
   *
   * SMI-5649: returns `Promise<void>` (was `void`, fire-and-forget) so a
   * caller — namely the shutdown coordinator — can await settlement of any
   * in-flight sync before proceeding to close the database. Non-awaiting
   * callers still get the synchronous timer-clear + abort-signal behavior
   * unchanged, since steps 1-2 below run before any `await` point.
   */
  stop(): Promise<void> {
    this.log('Stopping background sync service')
    // 1. Synchronous first — preserves fire-and-forget semantics for
    //    existing non-awaiting callers.
    this.isStopped = true
    this.state.isStarted = false

    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    // 2. Signal the in-flight sync (if any) to bail at its next checkpoint.
    this.abortController?.abort()

    // 3. Await settlement, never letting a rejection escape.
    return Promise.resolve(this.inFlightSync ?? undefined).catch(() => {
      // inFlightSync is already normalized to never reject (see
      // triggerSync/manualSync below); this is belt-and-suspenders.
    })
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

    // SMI-5649: track the raw sync() promise (never rejects — SyncEngine.sync
    // try/catches everything internally) so stop() can await its settlement
    // without depending on this method's own try/catch/finally timing.
    const syncPromise = this.syncEngine.sync({ signal: this.abortController?.signal })
    this.inFlightSync = syncPromise.then(
      () => undefined,
      () => undefined
    )

    try {
      this.log('Starting sync')
      const result = await syncPromise
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
      this.inFlightSync = null
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

    const syncPromise = this.syncEngine.sync({ signal: this.abortController?.signal })
    this.inFlightSync = syncPromise.then(
      () => undefined,
      () => undefined
    )

    try {
      const result = await syncPromise
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
      this.inFlightSync = null
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
