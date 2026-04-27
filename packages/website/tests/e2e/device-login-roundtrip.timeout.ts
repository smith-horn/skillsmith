/**
 * device-login-roundtrip.timeout.ts
 *
 * SMI-4506 — small Promise.race timeout wrapper used by the round-trip
 * helpers. Extracted to a companion file to keep helpers.ts under the
 * 500-line cap (CLAUDE.md CI Health Requirements).
 *
 * supabase-js + node:net don't bail on hung connections, so a single
 * staging-side stall would eat the entire 2-min Playwright budget with
 * no useful error. Wrapping every external-system call in withTimeout
 * gives "fail fast with a real cause" instead.
 */

/** Race `p` against a timeout that throws a labelled error after `ms`. */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[SMI-4506] ${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Default per-call deadline for staging Supabase REST/auth calls. 10s gives
 * cold-start headroom while leaving enough budget that an actual hang is
 * reported well inside the 2-min Playwright test ceiling.
 */
export const STAGING_CALL_TIMEOUT_MS = 10_000
