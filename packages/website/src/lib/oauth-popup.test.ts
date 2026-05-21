import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openOAuthPopup, type PopupHandle, type PopupHostWindow } from './oauth-popup'

interface MockPopup extends PopupHandle {
  closed: boolean
  closeCalls: number
}

function makePopup(): MockPopup {
  const popup: MockPopup = {
    closed: false,
    closeCalls: 0,
    close() {
      this.closeCalls += 1
      this.closed = true
    },
  }
  return popup
}

interface MockHost extends PopupHostWindow {
  listeners: Array<(_event: MessageEvent) => void>
  dispatch(_payload: { data: unknown; origin: string }): void
  openCalls: Array<{ url: string; target: string; features: string }>
}

function makeHost(opts: { popup: MockPopup | null }): MockHost {
  const listeners: Array<(event: MessageEvent) => void> = []
  return {
    listeners,
    openCalls: [],
    open(url, target, features) {
      this.openCalls.push({ url, target, features })
      return opts.popup
    },
    addEventListener(_type, listener) {
      listeners.push(listener)
    },
    removeEventListener(_type, listener) {
      const idx = listeners.indexOf(listener)
      if (idx >= 0) listeners.splice(idx, 1)
    },
    dispatch(payload) {
      const evt = { data: payload.data, origin: payload.origin } as MessageEvent
      for (const l of [...listeners]) l(evt)
    },
  }
}

describe('openOAuthPopup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves "success" with the next destination on a same-origin oauth-success message', async () => {
    const popup = makePopup()
    const host = makeHost({ popup })
    const result = openOAuthPopup({
      url: 'https://example.supabase.co/auth/v1/authorize',
      expectedOrigin: 'https://www.skillsmith.app',
      win: host,
    })

    // Listener must be registered before window.open returns.
    expect(host.listeners).toHaveLength(1)
    expect(host.openCalls).toHaveLength(1)
    expect(host.openCalls[0]?.url).toBe('https://example.supabase.co/auth/v1/authorize')

    host.dispatch({
      data: { type: 'oauth-success', next: '/account' },
      origin: 'https://www.skillsmith.app',
    })

    await expect(result).resolves.toEqual({ outcome: 'success', next: '/account' })
    expect(popup.closeCalls).toBe(1)
    expect(host.listeners).toHaveLength(0)
  })

  it('resolves "timeout" when the deadline elapses with no message', async () => {
    const popup = makePopup()
    const host = makeHost({ popup })
    const result = openOAuthPopup({
      url: 'https://example.supabase.co/auth/v1/authorize',
      expectedOrigin: 'https://www.skillsmith.app',
      deadlineMs: 1000,
      win: host,
    })

    vi.advanceTimersByTime(1000)
    await expect(result).resolves.toEqual({ outcome: 'timeout' })
    expect(popup.closeCalls).toBe(1)
    expect(host.listeners).toHaveLength(0)
  })

  it('resolves "cancelled" when the user closes the popup before completion', async () => {
    const popup = makePopup()
    const host = makeHost({ popup })
    const result = openOAuthPopup({
      url: 'https://example.supabase.co/auth/v1/authorize',
      expectedOrigin: 'https://www.skillsmith.app',
      deadlineMs: 10_000,
      win: host,
    })

    // User manually closes the popup before the deadline.
    popup.closed = true
    vi.advanceTimersByTime(250)

    await expect(result).resolves.toEqual({ outcome: 'cancelled' })
    expect(host.listeners).toHaveLength(0)
  })

  it('resolves "blocked" when window.open returns null (popup blocker)', async () => {
    const host = makeHost({ popup: null })
    const result = openOAuthPopup({
      url: 'https://example.supabase.co/auth/v1/authorize',
      expectedOrigin: 'https://www.skillsmith.app',
      win: host,
    })

    await expect(result).resolves.toEqual({ outcome: 'blocked' })
    expect(host.listeners).toHaveLength(0)
  })

  it('ignores postMessage from a different origin', async () => {
    const popup = makePopup()
    const host = makeHost({ popup })
    const result = openOAuthPopup({
      url: 'https://example.supabase.co/auth/v1/authorize',
      expectedOrigin: 'https://www.skillsmith.app',
      deadlineMs: 1000,
      win: host,
    })

    host.dispatch({
      data: { type: 'oauth-success', next: '/account' },
      origin: 'https://evil.example.com',
    })

    // Spoofed message must NOT resolve. Advance to deadline → timeout.
    vi.advanceTimersByTime(1000)
    await expect(result).resolves.toEqual({ outcome: 'timeout' })
  })

  it('ignores postMessage events whose type is not oauth-success', async () => {
    const popup = makePopup()
    const host = makeHost({ popup })
    const result = openOAuthPopup({
      url: 'https://example.supabase.co/auth/v1/authorize',
      expectedOrigin: 'https://www.skillsmith.app',
      deadlineMs: 1000,
      win: host,
    })

    host.dispatch({
      data: { type: 'unrelated-event', payload: 'whatever' },
      origin: 'https://www.skillsmith.app',
    })
    host.dispatch({ data: null, origin: 'https://www.skillsmith.app' })

    vi.advanceTimersByTime(1000)
    await expect(result).resolves.toEqual({ outcome: 'timeout' })
  })
})
