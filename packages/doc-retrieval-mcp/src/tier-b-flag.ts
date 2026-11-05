/**
 * SMI-7201 Wave 3: local reader for the Tier-B native/JS pair flag.
 *
 * Deliberately duplicated from `@skillsmith/core`'s
 * `embeddings/tier-b-flag.ts`: this package depends on core through a
 * published version range, so importing a module that only exists on the
 * branch would fail to resolve against the published core. Keep the semantics
 * identical: the `state=` value on line 1, null only when the file is absent,
 * and `unreadable` for a present-but-broken flag.
 */

import { readFileSync } from 'node:fs'

export const TIER_B_PAIRS_FLAG_PATH = '/run/skillsmith/tier-b-pairs.state'

export function readTierBPairsState(path: string = TIER_B_PAIRS_FLAG_PATH): string | null {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    return 'unreadable'
  }
  const match = /^state=(.+)$/.exec(content.split('\n', 1)[0].trim())
  return match && match[1].trim().length > 0 ? match[1].trim() : 'unreadable'
}
