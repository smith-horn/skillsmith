/**
 * SMI-4578 / SMI-6529: the fan-out link manifest
 * (`~/.skillsmith/links/manifest.json`), split out of fan-out.ts to stay
 * under the 500-line gate.
 *
 * Reads are best-effort. Every change goes through {@link updateManifest},
 * which takes the manifest's own lock and never overwrites a file it couldn't
 * read.
 *
 * @module @skillsmith/core/install/fan-out.manifest
 */
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as fsp from 'node:fs/promises'
import { assertNotRealUserHome } from '../services/skill-manifest.js'
import { withFileLock } from './fan-out.overwrite.js'

/** How a fan-out destination was made: a relative symlink, or a recursive copy. */
export type LinkKind = 'symlink' | 'copy'

/** One fan-out Skillsmith made: which skill, from where, to where, how, and when. */
export interface LinkRecord {
  skillId: string
  from: string
  to: string
  kind: LinkKind
  createdAt: string
}

/** The on-disk link manifest: every fan-out Skillsmith has recorded. */
export interface LinkManifest {
  version: 1
  links: LinkRecord[]
}

const MANIFEST_VERSION = 1 as const

/**
 * Resolve the manifest file path. Sits under `~/.skillsmith/` so it shares
 * the existing allow-list entry for that directory (DEFAULT_ALLOWED_DIRS in
 * `pathValidation.ts`).
 */
export function getLinkManifestPath(): string {
  return path.join(homedir(), '.skillsmith', 'links', 'manifest.json')
}

/** What reading the manifest found. `unreadable` means it exists but must not be written over. */
export interface ManifestRead {
  state: 'ok' | 'missing' | 'corrupt' | 'unreadable'
  manifest: LinkManifest
  reason?: string
}

/**
 * Read the manifest and report its state. Valid JSON with a higher version is
 * `unreadable`, not `corrupt`: a newer Skillsmith wrote it, and moving it
 * aside would drop its records too (SMI-6529 round 10).
 */
export async function readManifestFile(): Promise<ManifestRead> {
  const empty: LinkManifest = { version: MANIFEST_VERSION, links: [] }
  let raw: string
  try {
    raw = await fsp.readFile(getLinkManifestPath(), 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { state: 'missing', manifest: empty }
    return { state: 'unreadable', manifest: empty, reason: code ?? String(err) }
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; links?: unknown } | null
    if (parsed?.version === MANIFEST_VERSION && Array.isArray(parsed.links)) {
      return { state: 'ok', manifest: parsed as LinkManifest }
    }
    if (typeof parsed?.version === 'number' && parsed.version > MANIFEST_VERSION) {
      return {
        state: 'unreadable',
        manifest: empty,
        reason: `version ${parsed.version}, written by a newer Skillsmith`,
      }
    }
  } catch {
    // Not JSON: reported as corrupt below.
  }
  return { state: 'corrupt', manifest: empty }
}

/** Error for a manifest that exists but can't be read; nothing is written over it. */
export function unreadableManifestError(reason: string | undefined): Error {
  return new Error(
    `could not read the fan-out link manifest at ${getLinkManifestPath()} (${reason}); ` +
      `refusing to overwrite it.`
  )
}

/**
 * Load the manifest for reading. Returns an empty manifest if the file is
 * missing, unreadable or corrupt — fan-out is best-effort, never crash on
 * cold start. Changes go through {@link updateManifest}, which never
 * overwrites a file it couldn't read.
 */
export async function loadManifest(): Promise<LinkManifest> {
  return (await readManifestFile()).manifest
}

/**
 * Apply `change` to the manifest and save it, under the manifest's own lock.
 * Returns a warning for the user, if any.
 *
 * SMI-6529 round 9: destination locks only serialize calls for one
 * destination, so fan-outs of different skills loaded, changed and saved the
 * manifest at the same time, through one shared temp file; twelve concurrent
 * fan-outs kept one record, and could leave the file corrupt. Callers may
 * hold a destination lock when they call this, but no destination lock is
 * ever requested while this lock is held, so the two can't deadlock.
 *
 * A corrupt file used to be replaced with an empty manifest, dropping every
 * other skill's record. It is now moved aside, with a warning; a file that
 * can't be read at all is left alone and the call fails.
 */
export async function updateManifest(
  change: (manifest: LinkManifest) => void
): Promise<string | undefined> {
  const manifestPath = getLinkManifestPath()
  assertNotRealUserHome(manifestPath, 'write')
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true })
  return withFileLock(manifestPath, 'fan-out link manifest lock', async () => {
    const read = await readManifestFile()
    if (read.state === 'unreadable') throw unreadableManifestError(read.reason)
    let warning: string | undefined
    if (read.state === 'corrupt') {
      const aside = `${manifestPath}.corrupt-${Date.now()}`
      await fsp.rename(manifestPath, aside)
      warning =
        `the fan-out link manifest at ${manifestPath} could not be parsed; it was moved to ` +
        `${aside} and a new one started. Copies recorded only in the old file are no longer tracked.`
    }
    change(read.manifest)
    await saveManifest(read.manifest)
    return warning
  })
}

/**
 * Persist the manifest atomically (write-temp + rename) so a crash mid-write
 * never leaves the file in a partial state.
 */
export async function saveManifest(manifest: LinkManifest): Promise<void> {
  const manifestPath = getLinkManifestPath()
  // SMI-6343 follow-up (adversarial review): a fourth parallel manifest-write
  // implementation (a different file, `links/manifest.json`, but the same
  // homedir-derived-with-no-override shape). The $HOME sandbox
  // (vitest.setup.ts) was this file's only defense until this guard.
  assertNotRealUserHome(manifestPath, 'write')
  const dir = path.dirname(manifestPath)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = `${manifestPath}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf-8')
  await fsp.rename(tmp, manifestPath)
}
