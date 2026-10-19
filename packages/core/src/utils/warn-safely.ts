/**
 * SMI-7143: a warning that cannot itself throw.
 *
 * Lock and manifest code warns from places where a throw would change the
 * outcome it reports: after a manifest rename (a saved manifest reported as a
 * failure), and in a lock release's `finally` (the result of the work done
 * under the lock, or the error it raised, replaced). An embedding
 * application's replaced or throwing `console.warn` must not do either.
 *
 * @module @skillsmith/core/utils/warn-safely
 */

/** `console.warn(message)`, swallowing anything the logger throws. */
export function warnSafely(message: string): void {
  try {
    console.warn(message)
  } catch {
    // Nothing else can report it; the outcome being reported stands either way.
  }
}
