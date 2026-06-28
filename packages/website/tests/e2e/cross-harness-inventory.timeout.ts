/**
 * cross-harness-inventory.timeout.ts
 *
 * SMI-5395 — small Promise.race timeout wrapper used by the cross-harness
 * inventory e2e helpers. Copied from device-login-roundtrip.timeout.ts
 * (SMI-4506) and extracted to a companion file to keep helpers.ts under the
 * 500-line cap (CLAUDE.md CI Health Requirements).
 *
 * supabase-js + node:fetch don't bail on hung connections, so a single
 * staging-side stall would eat the entire 2-min Playwright budget with
 * no useful error. Wrapping every external-system call in withTimeout
 * gives "fail fast with a real cause" instead.
 */

/**
 * Race `p` against a timeout that throws a labelled error after `ms`.
 *
 * `p` is typed `PromiseLike<T>` (not `Promise<T>`) so supabase-js query builders
 * — which are thenables, not real Promises — can be wrapped directly without an
 * intermediate `Promise.resolve(...)`. `Promise.race` accepts PromiseLike.
 */
export async function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
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
