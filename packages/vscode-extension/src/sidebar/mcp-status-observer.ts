/**
 * Proactive MCP-offline observer (SMI-5345 / #1438).
 *
 * Subscribes to the MCP client's `onStatusChange` and drives both the sidebar
 * message (via the single-owner {@link SidebarMessageState}) and the offline
 * row controller when the server drops out of band. A short debounce avoids
 * flickering the offline copy during the client's own transient reconnect
 * churn (`disconnected` → `connecting` → `connected`).
 *
 * The observer NEVER acts on the initial `connected` (when `wasOffline` is
 * false) — doing so would erase the first-run hint before the user has even
 * searched. It only clears offline state after a prior offline was shown.
 */
import type * as vscode from 'vscode'
import type { SidebarMessageState } from './message-state.js'

/** Default debounce before surfacing offline copy on a drop (ms). */
const DEFAULT_DEBOUNCE_MS = 1500

/**
 * The offline-row side of the sidebar (the tree's "MCP offline" affordance).
 * Kept minimal so the observer depends only on what it drives — the concrete
 * `SkillTreeDataProvider` implements this.
 */
export interface OfflineRowController {
  setMcpOffline(isOffline: boolean): void
}

/** A minimal view of the MCP client the observer needs. */
interface ObservableClient {
  onStatusChange(listener: (status: string) => void): vscode.Disposable
  getStatus(): string
}

interface McpSidebarObserverDeps {
  /** Resolves the (possibly hot-swapped) singleton MCP client. */
  getClient: () => ObservableClient
  /** The single owner of `TreeView.message`. */
  messageState: SidebarMessageState
  /** The offline-row affordance on the tree. */
  offlineRow: OfflineRowController
  /** Debounce before surfacing offline copy (default 1500ms; pass 0 in tests). */
  debounceMs?: number
}

/** Handle for rebinding (after a singleton swap) and disposing the observer. */
export interface McpSidebarObserver {
  /** Dispose the prior subscription and re-subscribe to the current singleton. */
  rebind(): void
  /** Dispose the subscription and clear any pending debounce timer. */
  dispose(): void
}

/**
 * Registers the proactive MCP-offline observer. Returns a handle whose
 * `rebind()` must be called whenever the MCP client singleton is swapped (e.g.
 * on a config change), and whose `dispose()` tears down the subscription + timer.
 */
export function registerMcpSidebarObserver(deps: McpSidebarObserverDeps): McpSidebarObserver {
  const { getClient, messageState, offlineRow } = deps
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS

  let subscription: vscode.Disposable | undefined
  let pendingTimer: ReturnType<typeof setTimeout> | undefined
  // Survives rebind so a reconnect after a singleton swap still clears offline.
  let wasOffline = false

  function clearPendingTimer(): void {
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer)
      pendingTimer = undefined
    }
  }

  function goOffline(): void {
    wasOffline = true
    messageState.setOffline(true)
    offlineRow.setMcpOffline(true)
  }

  function goOnline(): void {
    wasOffline = false
    messageState.setOffline(false)
    offlineRow.setMcpOffline(false)
  }

  function handleStatus(status: string): void {
    if (status === 'disconnected' || status === 'error') {
      // Debounce: a transient drop the client itself recovers from should not
      // flash the offline copy. A later status cancels this timer first.
      clearPendingTimer()
      pendingTimer = setTimeout(() => {
        pendingTimer = undefined
        goOffline()
      }, debounceMs)
      return
    }

    if (status === 'connected') {
      // Cancel a pending offline regardless — the drop self-healed.
      clearPendingTimer()
      // Only act if we previously surfaced offline. The initial connect must
      // NOT clear offline (it would erase the first-run hint).
      if (wasOffline) {
        goOnline()
      }
      return
    }

    // 'connecting' (and any unknown status): no-op.
  }

  function subscribe(): void {
    subscription = getClient().onStatusChange(handleStatus)
  }

  subscribe()

  return {
    rebind(): void {
      // Cancel any in-flight offline debounce from the OLD client — otherwise a
      // stale timer could fire goOffline() onto the freshly-swapped client even
      // after it has already connected (governance, plan-review follow-up).
      clearPendingTimer()
      subscription?.dispose()
      subscription = undefined
      // Preserve wasOffline across the swap; a reconnect on the new singleton
      // must still be able to clear a previously-shown offline state.
      subscribe()
    },
    dispose(): void {
      clearPendingTimer()
      subscription?.dispose()
      subscription = undefined
    },
  }
}
