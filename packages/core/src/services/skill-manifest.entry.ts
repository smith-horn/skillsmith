/**
 * SMI-6531 (A1 step 7a): the manifest entry model the in-place update and
 * doctor share (A1 plan §3.6, PLAN:1747-1759).
 *
 * An entry is classified against two sealed values: `pre` (the entry as it was
 * planned) and `post` (the entry the update commits). Everything here works on
 * the raw `JSON.parse` document, so an unknown field, a `null` and a key the
 * type does not know are all kept exactly as written.
 *
 * `postEntry = buildPostEntry(rawPreEntry, writable)`: the raw entry with at
 * most five fields replaced (`ENTRY_WRITABLE_FIELDS`). `contentHash`,
 * `verifiedAt`, `provenance`, `pinnedVersion`, `updatePolicy`, `installedAt`
 * and anything unknown are carried over untouched.
 *
 * @module @skillsmith/core/services/skill-manifest.entry
 */
import { canonicalJson, isPlainObject } from './skill-manifest.canonical.js'
import type { JsonObject, JsonValue } from './skill-manifest.canonical.js'
import { readManifestState } from './skill-manifest.read-state.js'
import type { ManifestRefusalState } from './skill-manifest.read-state.js'

/** The only entry fields an update may write (an exact set; A1 plan PLAN:1751-1754). */
export const ENTRY_WRITABLE_FIELDS = [
  'version',
  'lastUpdated',
  'originalContentHash',
  'upstreamContentHash',
  'fileHashes',
] as const

export type EntryWritableField = (typeof ENTRY_WRITABLE_FIELDS)[number]

export type EntryWritable = Partial<{
  version: string
  lastUpdated: string
  originalContentHash: string
  upstreamContentHash: string
  /** The hashes of the files this update fetched; merged into the entry's existing map. */
  fileHashes: Record<string, string>
}>

/** What the entry at a key is, relative to the sealed `pre` and `post`. */
export type EntryState = 'pre' | 'post' | 'other'

/** The entry no longer equals `preEntry`: someone changed it after the plan. Nothing was written. */
export class ManifestEntryChanged extends Error {
  readonly manifestKey: string
  readonly found: EntryState
  constructor(manifestKey: string, found: EntryState) {
    super(
      `[skillsmith] The manifest entry "${manifestKey}" changed after it was planned ` +
        `(it is now ${found === 'post' ? 'already the updated entry' : 'neither the planned nor the updated entry'}); nothing was written.`
    )
    this.name = 'ManifestEntryChanged'
    this.manifestKey = manifestKey
    this.found = found
  }
}

/**
 * The raw entry at `key`, or `null` when there is none. Own properties only
 * (`Object.hasOwn`): a folder named `constructor` or `__proto__` must not read
 * a prototype member. A missing, non-object or `null` `installedSkills` holds no entry.
 */
export function rawEntryAt(rawManifest: unknown, key: string): JsonValue | null {
  if (!isPlainObject(rawManifest) || !Object.hasOwn(rawManifest, 'installedSkills')) return null
  const installed = rawManifest.installedSkills
  if (!isPlainObject(installed) || !Object.hasOwn(installed, key)) return null
  return installed[key] as JsonValue
}

/** `pre`, `post` or `other`, by canonical equality. `pre` wins if the two were ever equal. */
export function classifyEntry(
  rawManifest: unknown,
  key: string,
  pre: unknown,
  post: unknown
): EntryState {
  const found = canonicalJson(rawEntryAt(rawManifest, key))
  if (found === canonicalJson(pre)) return 'pre'
  if (found === canonicalJson(post)) return 'post'
  return 'other'
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((v) => typeof v === 'string')
}

/**
 * The entry an update commits: `rawPreEntry` with the writable fields set.
 * Throws a `TypeError` for a field outside `ENTRY_WRITABLE_FIELDS` or of the
 * wrong type (a bug, not a state). An `undefined` field is left out, so
 * absent stays absent. `fileHashes` is merged over the entry's existing map;
 * an existing value that is not a map of strings counts as no baseline.
 * `verifiedAt` is never written.
 */
export function buildPostEntry(rawPreEntry: JsonObject, writable: EntryWritable): JsonObject {
  const allowed: ReadonlySet<string> = new Set(ENTRY_WRITABLE_FIELDS)
  for (const field of Object.keys(writable)) {
    if (!allowed.has(field)) throw new TypeError(`buildPostEntry: "${field}" is not writable`)
  }
  const post: JsonObject = { ...rawPreEntry }
  for (const field of ENTRY_WRITABLE_FIELDS) {
    const value = writable[field]
    if (value === undefined) continue
    if (field === 'fileHashes') {
      if (!isStringMap(value))
        throw new TypeError('buildPostEntry: fileHashes must map paths to strings')
      const existing = isStringMap(rawPreEntry.fileHashes) ? rawPreEntry.fileHashes : {}
      // fromEntries, not assignment: a path named `__proto__` stays an own key.
      post.fileHashes = Object.fromEntries([...Object.entries(existing), ...Object.entries(value)])
    } else {
      if (typeof value !== 'string')
        throw new TypeError(`buildPostEntry: ${field} must be a string`)
      post[field] = value
    }
  }
  return post
}

/**
 * An unlocked classification of the entry at `key` in the manifest at
 * `manifestPath` (for planning; the committing path classifies under lock 3).
 * A missing manifest holds no entry. A corrupt, unreadable or newer-major
 * manifest is returned as a refusal, never repaired.
 */
export async function readEntryState(
  manifestPath: string,
  key: string,
  pre: unknown,
  post: unknown
): Promise<{ ok: true; state: EntryState } | { ok: false; refusal: ManifestRefusalState }> {
  const read = await readManifestState(manifestPath)
  if (read.state === 'ok' || read.state === 'missing') {
    return { ok: true, state: classifyEntry(read.raw, key, pre, post) }
  }
  return { ok: false, refusal: read }
}
