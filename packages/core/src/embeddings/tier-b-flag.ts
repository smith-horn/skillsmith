/**
 * SMI-7201 Wave 3: runtime reader for the Tier-B native/JS pair flag.
 *
 * The dev container's boot check (scripts/lib/entrypoint-tier-b-pairs.sh)
 * writes /run/skillsmith/tier-b-pairs.state when a native package and its JS
 * parent have drifted apart. Line 1 is `state=<mismatch|not-evaluated|
 * unavailable|disabled>`. A clean result removes the file.
 *
 * A present flag means the embedding stack may be serving mock vectors for a
 * reason the model-load warning does not explain, so EmbeddingService reads
 * it on every mock path and reports it loudly. That includes a deliberately
 * configured fallback (useFallback: true): the vector is a mock either way, and
 * the plan reports every mock-serving call. Such callers are noisy while the
 * flag exists, by design; the fix is the remedy, not a quieter report.
 */

import { readFileSync } from 'node:fs'

/** Location of the flag written at container boot. */
export const TIER_B_PAIRS_FLAG_PATH = '/run/skillsmith/tier-b-pairs.state'

/** State reported when the flag exists but cannot be read or parsed. */
export const TIER_B_UNREADABLE_STATE = 'unreadable'

/**
 * Read the state value from the flag file.
 *
 * @returns the value after `state=` on line 1; null only when the file does
 * not exist. A present-but-broken flag (unreadable, or no `state=` first
 * line) returns `unreadable`, so it can never read as healthy.
 */
export function readTierBPairsState(path: string = TIER_B_PAIRS_FLAG_PATH): string | null {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    return TIER_B_UNREADABLE_STATE
  }
  const firstLine = content.split('\n', 1)[0].trim()
  const match = /^state=(.+)$/.exec(firstLine)
  return match && match[1].trim().length > 0 ? match[1].trim() : TIER_B_UNREADABLE_STATE
}

/**
 * Report on stderr, on every call, that a mock vector is being served while
 * the Tier-B flag is set. Deliberately not gated on SKILLSMITH_QUIET or any
 * other suppression. No-op when the flag is absent. Never throws: if
 * console.error throws (a replaced or broken console), it falls back to a
 * direct stderr write, and a failure there is swallowed, so reporting can
 * never make embed() or embedBatch() reject.
 */
export function reportMockUnderTierBFlag(flagPath: string): void {
  const state = readTierBPairsState(flagPath)
  if (state === null) return
  const message =
    `[EmbeddingService] serving a MOCK embedding (no real model): Tier-B native/JS pairs are ${state} ` +
    `(SMI-7201, see ${flagPath}). Rebuild per the container boot output's Remedy line.`
  try {
    console.error(message)
  } catch {
    try {
      process.stderr.write(message + '\n')
    } catch {
      // nothing left to report with; the caller still gets its vector
    }
  }
}
