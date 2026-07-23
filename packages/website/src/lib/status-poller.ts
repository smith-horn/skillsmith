/**
 * Roving-tabindex keyboard nav + poll lifecycle controller for the status
 * page (SMI-5755, Wave 5). Split out of status-client.ts to stay under the
 * repo's 500-line-per-file gate — see status-client.ts's barrel re-export +
 * header comment for the full module-split rationale.
 */

import { validateStatusPayload } from './status-payload'
import type { StatusResponse } from './status-vocab'

// ---------------------------------------------------------------------------
// Roving-tabindex keyboard navigation (Codex #14) — pure arithmetic. The
// imperative DOM wiring (querySelectorAll/closest/focus/setAttribute) lives in
// the small wireUptimeStripKeyboardNav() below, which calls this calculator;
// see UptimeBarStrip.astro's own comment pointing back here.
// ---------------------------------------------------------------------------

const ROVING_KEYS = new Set(['ArrowRight', 'ArrowLeft', 'Home', 'End'])

export function isRovingNavKey(key: string): boolean {
  return ROVING_KEYS.has(key)
}

/** Returns the next tile index for a roving-tabindex keypress, or null if the key is irrelevant. */
export function computeRovingTabindexMove(
  currentIndex: number,
  tileCount: number,
  key: string
): number | null {
  if (tileCount <= 0) return null
  switch (key) {
    case 'ArrowRight':
      return Math.min(currentIndex + 1, tileCount - 1)
    case 'ArrowLeft':
      return Math.max(currentIndex - 1, 0)
    case 'Home':
      return 0
    case 'End':
      return tileCount - 1
    default:
      return null
  }
}

/**
 * Wires ONE delegated keydown listener implementing roving tabindex across
 * every `[data-uptime-strip]` on the page (shared handler, not per-component —
 * see UptimeBarStrip.astro's comment). Returns an unwire function.
 */
export function wireUptimeStripKeyboardNav(root: ParentNode = document): () => void {
  const handler = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent
    if (!isRovingNavKey(keyboardEvent.key)) return
    const target = event.target
    if (!(target instanceof Element)) return
    const tile = target.closest('[data-uptime-tile]')
    if (!tile) return
    const strip = tile.closest('[data-uptime-strip]')
    if (!strip) return
    const tiles = Array.from(strip.querySelectorAll('[data-uptime-tile]'))
    const currentIndex = tiles.indexOf(tile)
    if (currentIndex === -1) return

    const nextIndex = computeRovingTabindexMove(currentIndex, tiles.length, keyboardEvent.key)
    if (nextIndex === null || nextIndex === currentIndex) return

    keyboardEvent.preventDefault()
    tiles[currentIndex].setAttribute('tabindex', '-1')
    const nextTile = tiles[nextIndex] as HTMLElement
    nextTile.setAttribute('tabindex', '0')
    nextTile.focus()
  }
  root.addEventListener('keydown', handler)
  return () => root.removeEventListener('keydown', handler)
}

// ---------------------------------------------------------------------------
// Staleness tracking (Codex #10) — pure decision logic. A single transient
// failure must NOT wipe good data or show an error state; only 3 consecutive
// failures (~2+ minutes at the 45s poll interval) flags the displayed data as
// potentially stale.
// ---------------------------------------------------------------------------

export const STALE_AFTER_CONSECUTIVE_FAILURES = 3

export interface PollOutcomeState {
  consecutiveFailures: number
  isStale: boolean
}

export function nextPollOutcomeState(
  previous: PollOutcomeState,
  succeeded: boolean
): PollOutcomeState {
  if (succeeded) {
    return { consecutiveFailures: 0, isStale: false }
  }
  const consecutiveFailures = previous.consecutiveFailures + 1
  return {
    consecutiveFailures,
    isStale: consecutiveFailures >= STALE_AFTER_CONSECUTIVE_FAILURES,
  }
}

export const INITIAL_POLL_OUTCOME_STATE: PollOutcomeState = {
  consecutiveFailures: 0,
  isStale: false,
}

// ---------------------------------------------------------------------------
// Poll lifecycle controller (Codex #4) — recursive setTimeout (never
// setInterval), AbortController per in-flight fetch, and a monotonically
// incrementing generation counter so a response resolving after
// astro:before-swap is discarded rather than applied to a torn-down page.
// ---------------------------------------------------------------------------

export interface StatusPollerCallbacks {
  onResult(payload: StatusResponse): void
  onStaleChange(isStale: boolean): void
}

export interface StatusPollerOptions {
  apiUrl: string
  fetchImpl?: typeof fetch
  intervalMs?: number
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

export interface StatusPoller {
  /** Fires an immediate poll, then starts the recursive-timeout loop. */
  start(): void
  /** Permanently tears down the poller (page unload). */
  stop(): void
  /** astro:before-swap — abort in-flight, clear pending timeout, bump generation. */
  handleBeforeSwap(): void
  /** visibilitychange → hidden — true pause; does not abort an almost-done fetch. */
  handleVisibilityHidden(): void
  /** visibilitychange → visible — fetch immediately if idle; otherwise let the loop resume. */
  handleVisibilityVisible(): void
}

const DEFAULT_POLL_INTERVAL_MS = 45_000

export function createStatusPoller(
  options: StatusPollerOptions,
  callbacks: StatusPollerCallbacks
): StatusPoller {
  const fetchImpl = options.fetchImpl ?? fetch
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout

  let generation = 0
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let abortController: AbortController | null = null
  let inFlight = false
  let paused = false
  let outcomeState: PollOutcomeState = INITIAL_POLL_OUTCOME_STATE

  function clearPendingTimeout(): void {
    if (timeoutHandle !== null) {
      clearTimeoutImpl(timeoutHandle)
      timeoutHandle = null
    }
  }

  function scheduleNext(): void {
    clearPendingTimeout()
    if (paused) return
    timeoutHandle = setTimeoutImpl(() => {
      void runPoll()
    }, intervalMs)
  }

  async function runPoll(): Promise<void> {
    const thisGeneration = generation
    abortController = new AbortController()
    inFlight = true
    try {
      const res = await fetchImpl(options.apiUrl, { signal: abortController.signal })
      if (thisGeneration !== generation) return
      if (!res.ok) throw new Error(`status-public HTTP ${res.status}`)
      const json: unknown = await res.json()
      if (thisGeneration !== generation) return
      const validated = validateStatusPayload(json)
      if (!validated) throw new Error('status-public: invalid payload shape')

      outcomeState = nextPollOutcomeState(outcomeState, true)
      callbacks.onResult(validated)
      callbacks.onStaleChange(outcomeState.isStale)
    } catch {
      if (thisGeneration !== generation) return
      outcomeState = nextPollOutcomeState(outcomeState, false)
      callbacks.onStaleChange(outcomeState.isStale)
    } finally {
      inFlight = false
      abortController = null
      if (thisGeneration === generation) scheduleNext()
    }
  }

  return {
    start() {
      void runPoll()
    },
    stop() {
      generation++
      clearPendingTimeout()
      abortController?.abort()
    },
    handleBeforeSwap() {
      abortController?.abort()
      clearPendingTimeout()
      generation++
    },
    handleVisibilityHidden() {
      paused = true
      clearPendingTimeout()
    },
    handleVisibilityVisible() {
      paused = false
      if (!inFlight && timeoutHandle === null) {
        void runPoll()
      }
      // If a fetch is already in-flight, runPoll's `finally` block calls
      // scheduleNext() once it settles — paused is already false by then.
    },
  }
}
