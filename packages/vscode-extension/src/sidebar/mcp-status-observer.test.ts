/**
 * Tests for the proactive MCP-offline observer (SMI-5345 / #1438).
 *
 * A fake client exposes a manually-fireable `onStatusChange` so status
 * transitions are driven deterministically. `debounceMs: 0` collapses the
 * debounce, but the timer is still asynchronous (a 0ms `setTimeout`), so the
 * tests await a macrotask flush before asserting offline side effects.
 *
 * Covers: drop→(debounce)→offline; reconnect-after-offline→online; initial
 * connect with no prior offline = zero calls (must not erase the first-run
 * hint); 'connecting' no-op; debounce cancelled when a reconnect arrives first;
 * rebind disposes the old sub without double-subscribing; dispose cleans up.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SidebarMessageState } from './message-state.js'
import { registerMcpSidebarObserver, type OfflineRowController } from './mcp-status-observer.js'

/** Flush pending 0ms timers (the debounce fires on a macrotask). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

interface FakeDisposable {
  dispose: () => void
  disposed: boolean
}

/**
 * A manually-driven MCP client. `fire(status)` invokes every live listener;
 * each `onStatusChange` returns a disposable whose `dispose()` removes the
 * listener and flips `disposed` so tests can assert teardown.
 */
function makeFakeClient(): {
  client: { onStatusChange: (l: (s: string) => void) => FakeDisposable; getStatus: () => string }
  fire: (status: string) => void
  liveListenerCount: () => number
  disposables: FakeDisposable[]
} {
  const listeners = new Set<(s: string) => void>()
  const disposables: FakeDisposable[] = []
  let status = 'connected'

  const client = {
    onStatusChange(listener: (s: string) => void): FakeDisposable {
      listeners.add(listener)
      const disposable: FakeDisposable = {
        disposed: false,
        dispose(): void {
          listeners.delete(listener)
          disposable.disposed = true
        },
      }
      disposables.push(disposable)
      return disposable
    },
    getStatus(): string {
      return status
    },
  }

  return {
    client,
    fire(next: string): void {
      status = next
      listeners.forEach((l) => l(next))
    },
    liveListenerCount: () => listeners.size,
    disposables,
  }
}

function makeMessageState(): { state: SidebarMessageState; setOffline: ReturnType<typeof vi.fn> } {
  const setOffline = vi.fn()
  const state: SidebarMessageState = {
    setFirstRunHint: vi.fn(),
    setSearchBanner: vi.fn(),
    setOffline,
  }
  return { state, setOffline }
}

function makeOfflineRow(): { row: OfflineRowController; setMcpOffline: ReturnType<typeof vi.fn> } {
  const setMcpOffline = vi.fn()
  return { row: { setMcpOffline }, setMcpOffline }
}

describe('registerMcpSidebarObserver — offline surfacing', () => {
  it('a drop surfaces offline (message + row) after the debounce', async () => {
    const fake = makeFakeClient()
    const { state, setOffline } = makeMessageState()
    const { row, setMcpOffline } = makeOfflineRow()
    const observer = registerMcpSidebarObserver({
      getClient: () => fake.client,
      messageState: state,
      offlineRow: row,
      debounceMs: 0,
    })

    fake.fire('disconnected')
    // Side effects are deferred to the (0ms) timer.
    expect(setOffline).not.toHaveBeenCalled()
    await flush()
    expect(setOffline).toHaveBeenCalledWith(true)
    expect(setMcpOffline).toHaveBeenCalledWith(true)

    observer.dispose()
  })

  it("'error' also surfaces offline", async () => {
    const fake = makeFakeClient()
    const { state, setOffline } = makeMessageState()
    const { row, setMcpOffline } = makeOfflineRow()
    const observer = registerMcpSidebarObserver({
      getClient: () => fake.client,
      messageState: state,
      offlineRow: row,
      debounceMs: 0,
    })

    fake.fire('error')
    await flush()
    expect(setOffline).toHaveBeenCalledWith(true)
    expect(setMcpOffline).toHaveBeenCalledWith(true)

    observer.dispose()
  })
})

describe('registerMcpSidebarObserver — reconnect / clear', () => {
  it('connected after an offline clears both message and row', async () => {
    const fake = makeFakeClient()
    const { state, setOffline } = makeMessageState()
    const { row, setMcpOffline } = makeOfflineRow()
    const observer = registerMcpSidebarObserver({
      getClient: () => fake.client,
      messageState: state,
      offlineRow: row,
      debounceMs: 0,
    })

    fake.fire('disconnected')
    await flush()
    setOffline.mockClear()
    setMcpOffline.mockClear()

    fake.fire('connected')
    expect(setOffline).toHaveBeenCalledWith(false)
    expect(setMcpOffline).toHaveBeenCalledWith(false)

    observer.dispose()
  })

  it('initial connected with NO prior offline does nothing (preserves the hint)', () => {
    const fake = makeFakeClient()
    const { state, setOffline } = makeMessageState()
    const { row, setMcpOffline } = makeOfflineRow()
    const observer = registerMcpSidebarObserver({
      getClient: () => fake.client,
      messageState: state,
      offlineRow: row,
      debounceMs: 0,
    })

    fake.fire('connected')
    expect(setOffline).not.toHaveBeenCalled()
    expect(setMcpOffline).not.toHaveBeenCalled()

    observer.dispose()
  })

  it("'connecting' is a no-op", () => {
    const fake = makeFakeClient()
    const { state, setOffline } = makeMessageState()
    const { row, setMcpOffline } = makeOfflineRow()
    const observer = registerMcpSidebarObserver({
      getClient: () => fake.client,
      messageState: state,
      offlineRow: row,
      debounceMs: 0,
    })

    fake.fire('connecting')
    expect(setOffline).not.toHaveBeenCalled()
    expect(setMcpOffline).not.toHaveBeenCalled()

    observer.dispose()
  })

  it('a reconnect arriving before the debounce fires cancels the offline', async () => {
    const fake = makeFakeClient()
    const { state, setOffline } = makeMessageState()
    const { row, setMcpOffline } = makeOfflineRow()
    const observer = registerMcpSidebarObserver({
      getClient: () => fake.client,
      messageState: state,
      offlineRow: row,
      debounceMs: 0,
    })

    fake.fire('disconnected')
    // Reconnect before the (0ms) debounce timer has run.
    fake.fire('connected')
    await flush()

    // No offline was ever surfaced, and the connect did not clear (no prior
    // offline) — zero calls in either direction.
    expect(setOffline).not.toHaveBeenCalled()
    expect(setMcpOffline).not.toHaveBeenCalled()

    observer.dispose()
  })
})

describe('registerMcpSidebarObserver — rebind / dispose', () => {
  it('rebind disposes the old subscription without double-subscribing', () => {
    const fake = makeFakeClient()
    const { state } = makeMessageState()
    const { row } = makeOfflineRow()
    const observer = registerMcpSidebarObserver({
      getClient: () => fake.client,
      messageState: state,
      offlineRow: row,
      debounceMs: 0,
    })

    expect(fake.liveListenerCount()).toBe(1)
    observer.rebind()
    // Old listener gone, exactly one live (no leak / double-sub).
    expect(fake.liveListenerCount()).toBe(1)
    expect(fake.disposables[0]?.disposed).toBe(true)
    expect(fake.disposables.length).toBe(2)

    observer.dispose()
  })

  it('rebind preserves wasOffline so a later reconnect still clears', async () => {
    const fake = makeFakeClient()
    const { state, setOffline } = makeMessageState()
    const { row, setMcpOffline } = makeOfflineRow()
    const observer = registerMcpSidebarObserver({
      getClient: () => fake.client,
      messageState: state,
      offlineRow: row,
      debounceMs: 0,
    })

    fake.fire('disconnected')
    await flush()
    expect(setOffline).toHaveBeenCalledWith(true)
    setOffline.mockClear()
    setMcpOffline.mockClear()

    observer.rebind()
    fake.fire('connected')
    expect(setOffline).toHaveBeenCalledWith(false)
    expect(setMcpOffline).toHaveBeenCalledWith(false)

    observer.dispose()
  })

  it('dispose tears down the subscription and clears a pending timer', async () => {
    const fake = makeFakeClient()
    const { state, setOffline } = makeMessageState()
    const { row } = makeOfflineRow()
    const observer = registerMcpSidebarObserver({
      getClient: () => fake.client,
      messageState: state,
      offlineRow: row,
      debounceMs: 0,
    })

    fake.fire('disconnected')
    // Dispose before the debounce timer fires — it must be cancelled.
    observer.dispose()
    await flush()
    expect(setOffline).not.toHaveBeenCalled()
    expect(fake.liveListenerCount()).toBe(0)
    expect(fake.disposables[0]?.disposed).toBe(true)
  })
})
