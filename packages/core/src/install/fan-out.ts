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

/**
 * Load the manifest from disk. Returns an empty manifest if the file is
 * missing or unreadable — fan-out is best-effort, never crash on cold start.
 */
export async function loadManifest(): Promise<LinkManifest> {
  const manifestPath = getLinkManifestPath()
  try {
    const raw = await fsp.readFile(manifestPath, 'utf-8')
    const parsed = JSON.parse(raw) as LinkManifest
    if (parsed?.version !== MANIFEST_VERSION || !Array.isArray(parsed.links)) {
      return { version: MANIFEST_VERSION, links: [] }
    }
    return parsed
  } catch {
    return { version: MANIFEST_VERSION, links: [] }
  }
}

/**
 * Persist the manifest atomically (write-temp + rename) so a crash mid-write
 * never leaves the file in a partial state.
 */
export async function saveManifest(manifest: LinkManifest): Promise<void> {
  const manifestPath = getLinkManifestPath()
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

async function removePath(p: string): Promise<void> {
  try {
    const stat = await fsp.lstat(p)
    if (stat.isSymbolicLink() || stat.isFile()) {
      await fsp.unlink(p)
    } else {
      await fsp.rm(p, { recursive: true, force: true })
    }
  } catch {
    // Best-effort — uninstall should not fail because cleanup races with
    // an external editor that already moved the file.
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

  const manifest = await loadManifest()
  const cycle = detectCycle(manifest, fromDir, toDir)
  if (cycle) throw new Error(`addLink: ${cycle}`)

  if (await pathExists(toDir)) {
    if (!force) {
      throw new Error(
        `addLink: ${toDir} already exists. Pass force: true (CLI: --force) to overwrite.`
      )
    }
    await removePath(toDir)
  }

  await fsp.mkdir(path.dirname(toDir), { recursive: true })

  let kind: LinkKind = 'copy'
  let fellBackToCopy = false

  if (preferSymlink) {
    // Use a relative symlink so the manifest entry stays portable across
    // homedir changes (matters for users who rsync their home directory).
    const relTarget = path.relative(path.dirname(toDir), fromDir)
    try {
      await fsp.symlink(relTarget, toDir, 'dir')
      kind = 'symlink'
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'ENOSYS') {
        await copyDirectoryRecursive(fromDir, toDir)
        kind = 'copy'
        fellBackToCopy = true
      } else {
        throw err
      }
    }
  } else {
    await copyDirectoryRecursive(fromDir, toDir)
  }

  const record: LinkRecord = {
    skillId,
    from: fromDir,
    to: toDir,
    kind,
    createdAt: new Date().toISOString(),
  }
  manifest.links.push(record)
  await saveManifest(manifest)
  return { record, fellBackToCopy }
}

/**
 * Remove every fan-out link recorded for `skillId`. Returns the number of
 * destinations removed. Safe to call when no manifest exists (returns 0).
 *
 * Uninstall callers should invoke this BEFORE removing the canonical
 * directory so symlinks resolve cleanly during their lstat checks.
 */
export async function removeLinks(skillId: string): Promise<number> {
  const manifest = await loadManifest()
  const matching = manifest.links.filter((l) => l.skillId === skillId)
  if (matching.length === 0) return 0

  for (const link of matching) {
    await removePath(link.to)
  }

  manifest.links = manifest.links.filter((l) => l.skillId !== skillId)
  await saveManifest(manifest)
  return matching.length
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
