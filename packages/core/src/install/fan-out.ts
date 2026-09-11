/**
 * SMI-4578: Multi-client install fan-out + link manifest.
 *
 * When a user installs a skill via `--also-link <client>`, the canonical
 * directory (`~/.claude/skills/<skill>`) is fanned out to the named client's
 * directory (e.g. `~/.cursor/skills/<skill>`). By default the fan-out is a
 * recursive directory copy — per SMI-4287, `LocalFilesystemAdapter` rejects
 * symlinks whose target resolves outside `rootDir`, so a scanner pointed at
 * `~/.cursor/skills/` would silently skip a symlinked entry. `--symlink` is
 * the explicit POSIX opt-in for users who accept that tradeoff.
 *
 * Every fan-out is recorded in `~/.skillsmith/links/manifest.json` so
 * `removeLinks(skillId)` can tear down both copies and symlinks atomically
 * during uninstall.
 *
 * @module @skillsmith/core/install/fan-out
 */
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { CLIENT_NATIVE_PATHS, CANONICAL_CLIENT, type ClientId } from './paths.js'
import { assertNotRealUserHome } from '../services/skill-manifest.js'
import {
  assertOverwritable,
  checkGitAtRoot,
  gitRefusal,
  leftoverBackupWarning,
  listLeftoverBackups,
  recoverDestination,
  replaceDestination,
  withDestinationLock,
  withFileLock,
} from './fan-out.overwrite.js'

export type LinkKind = 'symlink' | 'copy'

export interface LinkRecord {
  skillId: string
  from: string
  to: string
  kind: LinkKind
  createdAt: string
}

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

interface ManifestRead {
  state: 'ok' | 'missing' | 'corrupt' | 'unreadable'
  manifest: LinkManifest
  reason?: string
}

async function readManifestFile(): Promise<ManifestRead> {
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
    const parsed = JSON.parse(raw) as LinkManifest
    if (parsed?.version === MANIFEST_VERSION && Array.isArray(parsed.links)) {
      return { state: 'ok', manifest: parsed }
    }
  } catch {
    // Not JSON: reported as corrupt below.
  }
  return { state: 'corrupt', manifest: empty }
}

/** Error for a manifest that exists but can't be read; nothing is written over it. */
function unreadableManifestError(reason: string | undefined): Error {
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
 * fan-outs kept one record, and could leave the file corrupt. No destination
 * lock is ever requested while this lock is held, so the two can't deadlock.
 *
 * A corrupt file used to be replaced with an empty manifest, dropping every
 * other skill's record. It is now moved aside, with a warning; a file that
 * can't be read at all is left alone and the call fails.
 */
async function updateManifest(
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

export interface AddLinkOptions {
  /** Skill identifier (e.g. `author/name`). Used as the directory name on disk. */
  skillId: string
  /** Source-of-truth client (almost always `claude-code`). */
  fromClient: ClientId
  /** Destination client (must differ from `fromClient`). */
  toClient: ClientId
  /** Try `fs.symlink` first; fall back to copy on EPERM. Default: false (copy). */
  preferSymlink?: boolean
  /**
   * Overwrite if destination already contains an entry of the same name.
   * Without `--force`, addLink refuses to clobber a different on-disk skill.
   */
  force?: boolean
}

export interface AddLinkResult {
  record: LinkRecord
  /** True if `preferSymlink` was set but EPERM forced a fallback to copy. */
  fellBackToCopy: boolean
  /**
   * Things to tell the user: hidden backups left by an interrupted refresh
   * (SMI-6529 round 7), or a corrupt link manifest moved aside (round 9).
   * Omitted when none.
   */
  warnings?: string[]
}

/**
 * Detect a fan-out cycle: refuses to link `from → to` when `to` is already
 * the source of any entry, OR when `from` is already the destination of any
 * entry pointing back at us. Compares via resolved-path so a chain like
 * `claude-code → agents → claude-code` is caught even if one hop uses a
 * symlinked agents directory that resolves back to claude-code.
 */
function detectCycle(manifest: LinkManifest, from: string, to: string): string | null {
  const resolvedFrom = path.resolve(from)
  const resolvedTo = path.resolve(to)
  if (resolvedFrom === resolvedTo) {
    return `from and to resolve to the same path (${resolvedFrom}) — refusing to link a directory to itself`
  }
  for (const link of manifest.links) {
    const linkFrom = path.resolve(link.from)
    const linkTo = path.resolve(link.to)
    if (linkFrom === resolvedTo && linkTo === resolvedFrom) {
      return `cycle detected: ${linkFrom} ↔ ${linkTo} is already linked in the reverse direction`
    }
  }
  return null
}

/**
 * Recursively copy a directory. Mirrors the install command's existing
 * symlink-rejection policy: any symlink encountered inside the source tree
 * is skipped (not followed) so the destination stays a clean materialized
 * copy.
 */
async function copyDirectoryRecursive(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isSymbolicLink()) {
      continue
    }
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath)
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath)
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * SMI-6529 H3 (round 2) / N6 (round 4): recursive teardown for
 * `removeLinks()`'s legitimate uninstall cleanup of a copy-mode fan-out (or
 * symlink) THIS module created and recorded in the link manifest.
 *
 * N6: a recorded COPY can drift into a real git working tree after
 * Skillsmith created it (the user `git init`/`git clone`s into that exact
 * path later) — round 2's fix already stopped `addLink --force` from
 * clobbering that, but `removeLinks` (the UNINSTALL path) still happily
 * recursively deleted it on the strength of a stale manifest record alone.
 * Refuse — report and leave it in place — when a non-symlink recorded copy
 * contains `.git` at its root. Symlinks are always still just unlinked
 * (disposable regardless of what they point at; the pointed-to content is
 * untouched either way).
 *
 * Returns `{ removed: true }` on an actual removal (or a harmless "already
 * gone" ENOENT), `{ removed: false, reason }` on the N6 refusal so the
 * caller (`removeLinks`) can keep the manifest entry and report it instead
 * of silently discarding both the entry and the content.
 */
async function removeRecordedLink(
  p: string
): Promise<{ removed: true } | { removed: false; reason: string }> {
  let stat
  try {
    stat = await fsp.lstat(p)
  } catch {
    // Already gone — races with an external editor/uninstall are expected;
    // treat as successfully removed (nothing left to report).
    return { removed: true }
  }
  try {
    if (stat.isSymbolicLink() || stat.isFile()) {
      await fsp.unlink(p)
      return { removed: true }
    }
    const refusal = gitRefusal(p, await checkGitAtRoot(p), 'delete')
    if (refusal) {
      return { removed: false, reason: refusal }
    }
    await fsp.rm(p, { recursive: true, force: true })
    return { removed: true }
  } catch (err) {
    // Best-effort — uninstall should not fail because cleanup races with
    // an external editor that already moved the file. Report it as a
    // (different) refusal rather than silently pretending success, so
    // `removeLinks` still keeps the manifest entry for a future retry.
    return {
      removed: false,
      reason: `${p} could not be removed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Create a fan-out link from one client's skill directory into another's.
 *
 * - Default kind is `'copy'` (recursive directory copy). `preferSymlink`
 *   opts into a relative symlink and falls back to copy on EPERM (Windows
 *   non-developer-mode users).
 * - Refuses on cycle. Refuses on conflict unless `force: true`.
 * - Appends a `LinkRecord` to the manifest at
 *   `~/.skillsmith/links/manifest.json` so uninstall can tear it down.
 */
export async function addLink(opts: AddLinkOptions): Promise<AddLinkResult> {
  const { skillId, fromClient, toClient, preferSymlink = false, force = false } = opts

  if (fromClient === toClient) {
    throw new Error(`addLink: fromClient and toClient must differ (both were '${fromClient}')`)
  }

  const fromDir = path.join(CLIENT_NATIVE_PATHS[fromClient], skillId)
  const toDir = path.join(CLIENT_NATIVE_PATHS[toClient], skillId)

  if (!(await pathExists(fromDir))) {
    throw new Error(
      `addLink: source skill '${skillId}' does not exist at ${fromDir} — install for ${fromClient} first`
    )
  }

  const cycle = detectCycle(await loadManifest(), fromDir, toDir)
  if (cycle) throw new Error(`addLink: ${cycle}`)

  // SMI-6529 round 6: everything that reads or writes the destination runs
  // under its lock, so a concurrent call can never touch another call's
  // staging or backup folder (see fan-out.overwrite.ts).
  return withDestinationLock(toDir, async () => {
    // Round 9: fail before writing anything if the manifest can't be read,
    // since the new copy could never be recorded.
    const read = await readManifestFile()
    if (read.state === 'unreadable') throw unreadableManifestError(read.reason)
    const manifest = read.manifest
    await recoverDestination(toDir, manifest)

    let existing: fs.Stats | null = null
    try {
      existing = await fsp.lstat(toDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    if (existing) {
      if (!force) {
        throw new Error(
          `addLink: ${toDir} already exists. Pass force: true (CLI: --force) to overwrite.`
        )
      }
      await assertOverwritable(toDir, existing, manifest)
    }

    let kind: LinkKind = 'copy'
    let fellBackToCopy = false
    // The new copy or symlink is written to a staging path and swapped into
    // place; a failure here never touches the existing destination.
    await replaceDestination(toDir, async (staged) => {
      if (preferSymlink) {
        // A relative symlink keeps the manifest entry portable across homedir
        // changes. It is computed for the FINAL location, not the staging path.
        const relTarget = path.relative(path.dirname(toDir), fromDir)
        try {
          await fsp.symlink(relTarget, staged, 'dir')
          kind = 'symlink'
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'EPERM' || code === 'ENOSYS') {
            await copyDirectoryRecursive(fromDir, staged)
            kind = 'copy'
            fellBackToCopy = true
          } else {
            throw err
          }
        }
      } else {
        await copyDirectoryRecursive(fromDir, staged)
      }
    })

    const record: LinkRecord = {
      skillId,
      from: fromDir,
      to: toDir,
      kind,
      createdAt: new Date().toISOString(),
    }
    // SMI-6529 N7: a force-overwrite of an already-recorded destination
    // replaces its manifest entry rather than appending a second one.
    const resolvedToDir = path.resolve(toDir)
    const manifestWarning = await updateManifest((current) => {
      current.links = current.links.filter((l) => path.resolve(l.to) !== resolvedToDir)
      current.links.push(record)
    })
    const warnings = [
      ...(manifestWarning ? [manifestWarning] : []),
      ...(await listLeftoverBackups(toDir)).map(leftoverBackupWarning),
    ]
    return warnings.length > 0 ? { record, fellBackToCopy, warnings } : { record, fellBackToCopy }
  })
}

/** Result of {@link removeLinks} — see N6's doc comment on `removeRecordedLink`. */
export interface RemoveLinksResult {
  /** Count of destinations actually removed from disk. */
  removed: number
  /**
   * Destinations refused (left in place, e.g. N6's `.git`-at-root guard, or
   * a removal error) — each entry stays in the manifest so a future
   * `removeLinks` call retries it, and callers should surface `reason` to
   * the user rather than silently discarding it.
   */
  refused: Array<{ to: string; reason: string }>
  /**
   * Things to tell the user: hidden backups left by an interrupted refresh
   * (SMI-6529 round 7), or a corrupt link manifest moved aside (round 9).
   * Omitted when none.
   */
  warnings?: string[]
}

/**
 * Remove every fan-out link recorded for `skillId`. Safe to call when no
 * manifest exists (returns `{ removed: 0, refused: [] }`).
 *
 * Uninstall callers should invoke this BEFORE removing the canonical
 * directory so symlinks resolve cleanly during their lstat checks.
 *
 * SMI-6529 N6 (round 4): a destination `removeRecordedLink` refuses (a
 * recorded copy that now contains `.git` at its root, or a removal error)
 * keeps its manifest entry instead of being unconditionally dropped — the
 * old unconditional `manifest.links = manifest.links.filter(...)` discarded
 * the record for EVERY matching link regardless of whether the on-disk
 * removal actually succeeded, so a refused destination could never be
 * retried and its refusal was never reported anywhere.
 */
export async function removeLinks(skillId: string): Promise<RemoveLinksResult> {
  const manifest = await loadManifest()
  const matching = manifest.links.filter((l) => l.skillId === skillId)
  if (matching.length === 0) return { removed: 0, refused: [] }

  const refused: Array<{ to: string; reason: string }> = []
  const warnings: string[] = []
  const removedTargets = new Set<string>()
  for (const link of matching) {
    // SMI-6529 round 6: same per-destination lock as addLink.
    const { outcome, leftovers } = await withDestinationLock(link.to, async () => ({
      outcome: await removeRecordedLink(link.to),
      leftovers: await listLeftoverBackups(link.to),
    }))
    if (outcome.removed) {
      removedTargets.add(link.to)
    } else {
      refused.push({ to: link.to, reason: outcome.reason })
    }
    warnings.push(...leftovers.map(leftoverBackupWarning))
  }

  const manifestWarning = await updateManifest((current) => {
    current.links = current.links.filter((l) => l.skillId !== skillId || !removedTargets.has(l.to))
  })
  if (manifestWarning) warnings.unshift(manifestWarning)
  return warnings.length > 0
    ? { removed: removedTargets.size, refused, warnings }
    : { removed: removedTargets.size, refused }
}

/**
 * List all fan-out links for a skill (or all skills when `skillId` is
 * undefined). Read-only — for `skillsmith list --client X` and the
 * cross-client `getInstalledSkills` consolidator.
 */
export async function listLinks(skillId?: string): Promise<LinkRecord[]> {
  const manifest = await loadManifest()
  if (skillId === undefined) return [...manifest.links]
  return manifest.links.filter((l) => l.skillId === skillId)
}

/**
 * Convenience: derive the default `fromClient` for fan-out (the canonical
 * client). Exists so callers don't have to import `CANONICAL_CLIENT`
 * separately when they only need the fan-out helpers.
 */
export function getDefaultFromClient(): ClientId {
  return CANONICAL_CLIENT
}
