/**
 * OAuth popup state machine (SMI-5059)
 *
 * When Supabase GoTrue is degraded the OAuth authorize endpoint can return a
 * Cloudflare 5xx page (504 / 522) after 30+ s. With a full-page navigation the
 * opener page is gone by then and there's no JS context left to surface an
 * in-app banner — the user is stranded on Cloudflare's error page.
 *
 * This helper opens the OAuth URL in a popup so the opener stays alive. It
 * races a configurable deadline against three settle signals:
 *   - postMessage({ type: 'oauth-success', next? }) from same origin → 'success'
 *   - popup.closed becomes true before success → 'cancelled' (user closed it)
 *   - deadline elapses with no message → 'timeout'
 * A null return from window.open is reported as 'blocked' so the caller can
 * fall back to a full-page navigation (preserving today's behavior for users
 * with strict popup blockers).
 */

export type OAuthPopupOutcome = 'success' | 'timeout' | 'cancelled' | 'blocked'

export interface OAuthPopupResult {
  outcome: OAuthPopupOutcome
  /** Next destination from the popup's postMessage; only set on 'success'. */
  next?: string
}

export interface OpenOAuthPopupOptions {
  /** OAuth URL to load in the popup (already built by signInWithOAuth). */
  url: string
  /** Hard deadline before resolving 'timeout'. Default 45 s. */
  deadlineMs?: number
  /** window.open target name. Default 'skillsmith-oauth'. */
  popupName?: string
  /** window.open features string. Default centers a 600x720 popup. */
  popupFeatures?: string
  /** Only accept postMessage events from this origin. Default window.location.origin. */
  expectedOrigin?: string
  /**
   * Window implementation for testing. Tests inject a stub whose open() returns
   * either null (blocker) or a controllable { closed: boolean; close(): void }
   * stub. Defaults to the real `window`.
   */
  win?: PopupHostWindow
}

/**
 * Minimum window surface this helper uses. Lets tests inject a stub without
 * pulling in DOM globals through Object.defineProperty hacks.
 */
export interface PopupHostWindow {
  open(_url: string, _target: string, _features: string): PopupHandle | null
  addEventListener(
    _type: 'message',
    _listener: (event: MessageEvent) => void,
    _options?: AddEventListenerOptions
  ): void
  removeEventListener(
    _type: 'message',
    _listener: (event: MessageEvent) => void,
    _options?: EventListenerOptions
  ): void
}

/** Just the bits of the popup Window we touch — `closed` and `close()`. */
export interface PopupHandle {
  readonly closed: boolean
  close(): void
}

export function openOAuthPopup(options: OpenOAuthPopupOptions): Promise<OAuthPopupResult> {
  const {
    url,
    deadlineMs = 45_000,
    popupName = 'skillsmith-oauth',
    popupFeatures = defaultPopupFeatures(),
    expectedOrigin = typeof window !== 'undefined' ? window.location.origin : '',
    win = typeof window !== 'undefined' ? (window as unknown as PopupHostWindow) : undefined,
  } = options

  if (!win) {
    return Promise.resolve({ outcome: 'blocked' })
  }

  return new Promise<OAuthPopupResult>((resolve) => {
    // Timers and the popup handle live on a const state bag so the closures
    // below can read/write them without `let` reassignment warnings.
    const state: {
      settled: boolean
      deadlineTimer?: ReturnType<typeof setTimeout>
      closedPoller?: ReturnType<typeof setInterval>
      popup: PopupHandle | null
    } = { settled: false, popup: null }

    const settle = (outcome: OAuthPopupOutcome, next?: string) => {
      if (state.settled) return
      state.settled = true
      win.removeEventListener('message', onMessage)
      if (state.deadlineTimer !== undefined) clearTimeout(state.deadlineTimer)
      if (state.closedPoller !== undefined) clearInterval(state.closedPoller)
      resolve(next === undefined ? { outcome } : { outcome, next })
    }

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) return
      const data = event.data as { type?: unknown; next?: unknown } | null | undefined
      if (!data || data.type !== 'oauth-success') return
      try {
        state.popup?.close()
      } catch {
        // Cross-origin close can throw in some browsers; benign.
      }
      settle('success', typeof data.next === 'string' ? data.next : undefined)
    }

    // Register message listener BEFORE window.open so a fast-completing popup
    // can't postMessage before we're listening (race noted in SMI-5059 risks).
    win.addEventListener('message', onMessage)

    state.popup = win.open(url, popupName, popupFeatures)

    if (!state.popup) {
      win.removeEventListener('message', onMessage)
      state.settled = true
      resolve({ outcome: 'blocked' })
      return
    }

    state.deadlineTimer = setTimeout(() => {
      try {
        state.popup?.close()
      } catch {
        // ignore
      }
      settle('timeout')
    }, deadlineMs)

    // popup.closed is the only reliable cross-origin signal of a manual close.
    // 250 ms cadence is fast enough that a user clicking the X feels responsive
    // and slow enough that we're not torching CPU.
    state.closedPoller = setInterval(() => {
      if (state.popup && state.popup.closed) {
        settle('cancelled')
      }
    }, 250)
  })
}

function defaultPopupFeatures(): string {
  if (typeof window === 'undefined') return ''
  const width = 600
  const height = 720
  const left = Math.max(0, Math.floor((window.screen.width - width) / 2))
  const top = Math.max(0, Math.floor((window.screen.height - height) / 2))
  return (
    `width=${width},height=${height},left=${left},top=${top},` +
    'menubar=no,toolbar=no,location=yes,status=no,resizable=yes,scrollbars=yes'
  )
}
