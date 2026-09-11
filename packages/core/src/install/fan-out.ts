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
 * during uninstall. The manifest itself lives in fan-out.manifest.ts.
 *
 * @module @skillsmith/core/install/fan-out
 */
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { CLIENT_NATIVE_PATHS, CANONICAL_CLIENT, type ClientId } from './paths.js'
import {
  assertOverwritable,
  leftoverBackupWarning,
  listLeftoverBackups,
  recoverDestination,
  replaceDestination,
  withDestinationLock,
} from './fan-out.overwrite.js'
import {
  getLinkManifestPath,
  loadManifest,
  readManifestFile,
  unreadableManifestError,
  updateManifest,
  type LinkKind,
  type LinkManifest,
  type LinkRecord,
  type ManifestRead,
} from './fan-out.manifest.js'
import { removeRecordedLink, undoUnrecordedWrite } from './fan-out.cleanup.js'

export { getLinkManifestPath, loadManifest, saveManifest } from './fan-out.manifest.js'
export type { LinkKind, LinkManifest, LinkRecord } from './fan-out.manifest.js'

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
      // Round 10: say why there's no record, rather than "not recorded".
      if (read.state === 'corrupt' && !existing.isSymbolicLink()) {
        throw new Error(
          `addLink: ${toDir} already exists, and the fan-out link manifest at ` +
            `${getLinkManifestPath()} could not be parsed, so nothing shows Skillsmith made ` +
            `this copy. Fix or move the manifest, or remove ${toDir} yourself, then retry.`
        )
      }
      await assertOverwritable(toDir, existing, manifest)
    }

    // Round 11: a symlink is replaced with no backup, so keep its target in
    // case the new record can't be saved and it has to be put back.
    const oldLinkTarget = existing?.isSymbolicLink() ? await fsp.readlink(toDir) : undefined
    let kind: LinkKind = 'copy'
    let fellBackToCopy = false
    // The new copy or symlink is written to a staging path and swapped into
    // place; a failure here never touches the existing destination. `placed`
    // is what this call put in place, so an undo only removes that.
    const { placed, warnings: swapWarnings } = await replaceDestination(toDir, async (staged) => {
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
    let manifestWarning: string | undefined
    try {
      manifestWarning = await updateManifest((current) => {
        current.links = current.links.filter((l) => path.resolve(l.to) !== resolvedToDir)
        current.links.push(record)
      })
    } catch (err) {
      if (!existing || oldLinkTarget !== undefined) {
        await undoUnrecordedWrite(toDir, err, oldLinkTarget, placed)
      }
      throw err
    }
    const warnings = [
      ...(manifestWarning ? [manifestWarning] : []),
      ...swapWarnings,
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
   * (SMI-6529 round 7), a corrupt link manifest moved aside (round 9), or a
   * manifest this uninstall couldn't use (round 11). Omitted when none.
   */
  warnings?: string[]
}

/**
 * Warning for an uninstall that couldn't use the manifest (rounds 11–12). By
 * then the canonical skill is gone, so a second uninstall stops at "not
 * installed" and never gets here: any fan-out copy left is the user's to
 * remove. List the ones on disk so they know where to look.
 */
async function unusableManifestWarning(read: ManifestRead, skillId: string): Promise<string> {
  const why =
    read.state === 'corrupt' ? 'could not be parsed' : `could not be read (${read.reason})`
  const canonical = path.resolve(CLIENT_NATIVE_PATHS[CANONICAL_CLIENT])
  const candidates: string[] = []
  for (const root of new Set(Object.values(CLIENT_NATIVE_PATHS))) {
    if (path.resolve(root) === canonical) continue
    const dir = path.join(root, skillId)
    const present = await fsp.lstat(dir).then(
      () => true,
      () => false
    )
    if (present) candidates.push(dir)
  }
  const next =
    candidates.length > 0
      ? ` These may be fan-out copies Skillsmith made; check each one and delete it yourself ` +
        `if you don't need it: ${candidates.join(', ')}.`
      : ` No other client's skills folder has a ${skillId} folder, so there is nothing to clean up.`
  return (
    `the fan-out link manifest at ${getLinkManifestPath()} ${why}, so no fan-out copies of ` +
    `${skillId} were checked or removed.${next}`
  )
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
  const read = await readManifestFile()
  // Round 11: an unusable manifest used to read as empty, so an uninstall
  // said nothing and left every fan-out copy behind. Say so instead, and
  // leave the file alone.
  if (read.state === 'unreadable' || read.state === 'corrupt') {
    return { removed: 0, refused: [], warnings: [await unusableManifestWarning(read, skillId)] }
  }
  const matching = read.manifest.links.filter((l) => l.skillId === skillId)
  if (matching.length === 0) return { removed: 0, refused: [] }

  const refused: Array<{ to: string; reason: string }> = []
  const warnings: string[] = []
  const removedTargets = new Set<string>()
  for (const link of matching) {
    // SMI-6529 round 6: same per-destination lock as addLink. The record is
    // dropped while that lock is still held (round 10): filtering after the
    // loop also dropped a record a later re-link had saved, leaving its copy
    // untracked. Round 11: drop the records the manifest holds for this
    // destination now, not the one read above; a force refresh that ran
    // first had replaced it, and dropping only the old one left a record for
    // the folder just removed. Every writer of a destination's records holds
    // its lock, so this read is current.
    const resolvedTo = path.resolve(link.to)
    const step = await withDestinationLock(link.to, async () => {
      const outcome = await removeRecordedLink(link.to)
      const manifestWarning = outcome.removed
        ? await updateManifest((current) => {
            current.links = current.links.filter(
              (l) => l.skillId !== skillId || path.resolve(l.to) !== resolvedTo
            )
          })
        : undefined
      return { outcome, manifestWarning, leftovers: await listLeftoverBackups(link.to) }
    })
    if (step.manifestWarning) warnings.push(step.manifestWarning)
    if (step.outcome.removed) {
      removedTargets.add(link.to)
    } else {
      refused.push({ to: link.to, reason: step.outcome.reason })
    }
    warnings.push(...step.leftovers.map(leftoverBackupWarning))
  }

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
