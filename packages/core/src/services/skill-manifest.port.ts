/**
 * SMI-6531 (A1 step 7a): `createManifestPort`, the real `ManifestPort` the
 * in-place update and doctor commit through (A1 plan §3.6, step 10).
 *
 * One lock-3 hold (`withManifestLockHeld`, so the same protocol as
 * `runManifestUpdate`) hands the caller a handle of three methods:
 *
 * - `classify()`: a strict load of the raw manifest under this hold; the entry
 *   at `manifestKey` is `pre`, `post` or `other`.
 * - `casMatches()`: `classify() === 'pre'`.
 * - `write()`: reloads, requires `pre` (else `ManifestEntryChanged`), replaces
 *   only that one key with the canonical form of `postEntry` (its keys, nested
 *   ones included, land sorted) and saves with the pre-commit lock check
 *   inside `writeManifestAtomic`'s `beforeRename`, so the file clock is the
 *   temp file just written. A lost lock throws `ManifestLockLost`; the hold is
 *   retried once from a fresh acquisition, so the callback must be idempotent
 *   per attempt.
 *
 * The port only ever moves an entry from `pre` to `post`; it never writes
 * `preEntry` back. A strict load refuses a corrupt, unreadable or newer-major
 * manifest with `ManifestUnwritableError`; a missing manifest holds no entry.
 *
 * @module @skillsmith/core/services/skill-manifest.port
 */
import { runPureCallback } from '../config/lock-tracker.js'
import { writeManifestAtomic } from './skill-manifest.atomic.js'
import { canonicalJson, canonicalize, isPlainObject } from './skill-manifest.canonical.js'
import type { JsonValue } from './skill-manifest.canonical.js'
import { classifyEntry, ManifestEntryChanged } from './skill-manifest.entry.js'
import type { EntryState } from './skill-manifest.entry.js'
import { withManifestLockHeld } from './skill-manifest.lock.js'
import type { ManifestLockHold } from './skill-manifest.lock.js'
import { loadManifestForWrite } from './skill-manifest.read-state.js'
import type { ManifestCommitHandle, ManifestPort } from './skill-swap.types.js'

export interface ManifestPortTarget {
  manifestPath: string
  manifestKey: string
  /** The raw entry as planned; `null` for no entry. */
  preEntry: unknown
  /** The entry to commit: a plain object, different from `preEntry`. */
  postEntry: unknown
}

export interface ManifestPortOptions {
  /** Called once per acquisition that waits on an older version's bare-PID claim. */
  onLegacyWait?: (pid: number | null) => void
}

/** `raw` with only `installedSkills[key]` replaced; every other key is carried over. */
function replaceEntry(raw: Record<string, unknown>, key: string, post: JsonValue): unknown {
  const installed = isPlainObject(raw.installedSkills) ? raw.installedSkills : {}
  return { ...raw, installedSkills: { ...installed, [key]: post } }
}

/**
 * Builds the port. Throws a `TypeError` (a bug, not a state) for a
 * `postEntry` that is not a plain object, a `preEntry` that is neither `null`
 * nor a plain object, or a pair that is canonically equal (the `pre`/`post`
 * classification would be ambiguous). Both entries are canonicalized here, so
 * a record's key order is not trusted.
 */
export function createManifestPort(
  target: ManifestPortTarget,
  opts: ManifestPortOptions = {}
): ManifestPort {
  const { manifestPath, manifestKey } = target
  if (!isPlainObject(target.postEntry)) {
    throw new TypeError('createManifestPort: postEntry must be a plain object')
  }
  if (target.preEntry !== null && !isPlainObject(target.preEntry)) {
    throw new TypeError('createManifestPort: preEntry must be null or a plain object')
  }
  const pre = canonicalize(target.preEntry)
  const post = canonicalize(target.postEntry)
  if (canonicalJson(pre) === canonicalJson(post)) {
    throw new TypeError('createManifestPort: preEntry and postEntry must differ')
  }

  const handleFor = (hold: ManifestLockHold): ManifestCommitHandle => {
    const classify = async (): Promise<EntryState> =>
      classifyEntry(await loadManifestForWrite(manifestPath), manifestKey, pre, post)
    return {
      classify,
      casMatches: async () => (await classify()) === 'pre',
      write: async () => {
        const raw = await loadManifestForWrite(manifestPath)
        const found = classifyEntry(raw, manifestKey, pre, post)
        if (found !== 'pre') throw new ManifestEntryChanged(manifestKey, found)
        const next = runPureCallback(() =>
          replaceEntry(raw as unknown as Record<string, unknown>, manifestKey, post)
        )
        await writeManifestAtomic(manifestPath, JSON.stringify(next, null, 2), {
          beforeRename: hold.beforeRename,
        })
      },
    }
  }

  return {
    withManifestLock: (fn) =>
      withManifestLockHeld(
        manifestPath,
        'manifest commit',
        (hold) => fn(handleFor(hold)),
        opts.onLegacyWait
      ),
  }
}
