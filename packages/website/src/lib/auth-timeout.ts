/**
 * Auth-call timeout helper (SMI-5055)
 *
 * Wraps a Supabase Auth promise (getSession, signInWithOAuth, etc.) with a
 * deadline so the website's UI degrades gracefully when GoTrue is unreachable
 * (e.g. the 2026-05-20 status.supabase.com "Partially Degraded Service" incident,
 * where /auth/v1/authorize returned HTTP 504 after 30+ s).
 *
 * Throws AuthTimeoutError on timeout; callers can branch on `err.isTimeout`.
 */

export class AuthTimeoutError extends Error {
  readonly isTimeout = true
  constructor(message: string) {
    super(message)
    this.name = 'AuthTimeoutError'
  }
}

export async function withAuthTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage = 'Authentication service timed out'
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new AuthTimeoutError(timeoutMessage)), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}
