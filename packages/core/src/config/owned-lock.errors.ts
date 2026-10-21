/**
 * Total formatting of thrown values for owned-lock warnings (SMI-7148).
 * @module @skillsmith/core/config/owned-lock.errors
 *
 * INTERNAL module -- not part of the public surface. The release paths
 * (`releaseClaimFile`, `releaseOwned`) promise never to throw because they run
 * in callers' `finally` blocks, so building a warning from a caught value must
 * not throw either. `instanceof` and property reads can themselves throw (a
 * revoked proxy, a throwing getter); every read here is guarded.
 */

/** A thrown value as warning text; anything unreadable becomes a fixed string. */
export function thrownText(err: unknown): string {
  try {
    if (err instanceof Error) {
      const message: unknown = err.message
      return typeof message === 'string' ? message : 'an Error with no message'
    }
    return 'not an Error'
  } catch {
    return 'an unreadable thrown value'
  }
}

/** A thrown value's errno `code`, or its text when it has none. Total, like {@link thrownText}. */
export function thrownCode(err: unknown): string {
  try {
    const code: unknown = (err as NodeJS.ErrnoException | null)?.code
    if (typeof code === 'string') return code
  } catch {
    // fall through to the text
  }
  return thrownText(err)
}
