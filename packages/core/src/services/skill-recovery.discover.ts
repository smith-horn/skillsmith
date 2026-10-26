/**
 * SMI-6531 (A1 step 6a-i): root and state-root discovery for `doctor`
 * (plan §3.9, UD22).
 *
 * Doctor scans every skills root from four sources: all nine
 * `CLIENT_NATIVE_PATHS`, the workspace root each client resolves to from `cwd`,
 * every root the state root's manifest names (the folder holding a manifest
 * entry's `installPath`), and each `--root`. They are deduplicated by native
 * real path, so `~/.agents/skills` symlinked into `~/.claude/skills` is one
 * root (E43), and a root that does not exist is skipped without being created.
 * A crash during a client's first install is therefore found without `--root`.
 *
 * Discovery is read-only. It finds a workspace root with `findWorkspaceRoot`
 * (an `existsSync` walk) and never with `resolveSkillScope`, whose explicit
 * workspace request (`--scope`, `SKILLSMITH_SCOPE`, a config default) can
 * `mkdir` a marker (`workspace-scope.ts`); it reads no environment variable
 * that selects a scope. State roots are `~/.skillsmith` and any
 * `<workspaceRoot>/.skillsmith` that exists; `--state-root` replaces that set.
 *
 * @module @skillsmith/core/services/skill-recovery.discover
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CLIENT_NATIVE_PATHS } from '../install/paths.js'
import type { ClientId } from '../install/paths.js'
import { CLIENT_WORKSPACE_SEGMENTS, findWorkspaceRoot } from '../install/workspace-scope.js'
import { readManifestState } from './skill-manifest.read-state.js'

export interface DiscoverOptions {
  /** Where the workspace walk starts (default `process.cwd()`). */
  cwd?: string
  /** Replaces the set of state roots (`--state-root`). */
  stateRoot?: string
  /** `--root`: extra skills roots to scan. */
  roots?: readonly string[]
  /** @internal Test seam: the home directory (default `os.homedir()`). */
  homeDir?: string
  /** @internal Test seam: the nine client roots (default `CLIENT_NATIVE_PATHS`). */
  nativePaths?: Readonly<Record<ClientId, string>>
}

/** One skills root, by its native real path, with every way discovery reached it. */
export interface DiscoveredRoot {
  /** The native `realpath`. */
  root: string
  /** Why it is scanned: `client:<id>`, `workspace:<id>`, `manifest:<key>` or `--root`. */
  sources: string[]
  /** Every spelling that resolved to it. */
  spellings: string[]
}

export interface SkippedRoot {
  path: string
  source: string
  /** `ENOENT` for a root that does not exist (never created), or the errno, or `ENOTDIR`. */
  errno: string
}

export interface Discovery {
  /** The state roots, by native real path (those that exist). */
  stateRoots: string[]
  roots: DiscoveredRoot[]
  skipped: SkippedRoot[]
}

const errnoOf = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && code !== '' ? code : 'UNKNOWN'
}

/** The native real path of an existing directory, or why it is not one. */
async function realDirectory(
  p: string
): Promise<{ ok: true; real: string } | { ok: false; errno: string }> {
  try {
    const real = await fs.promises.realpath(p)
    return (await fs.promises.stat(real)).isDirectory()
      ? { ok: true, real }
      : { ok: false, errno: 'ENOTDIR' }
  } catch (err) {
    return { ok: false, errno: errnoOf(err) }
  }
}

/** The folders manifest entries name as holding their skill: `dirname(installPath)`. */
async function manifestRoots(stateRoot: string): Promise<Array<{ key: string; dir: string }>> {
  const read = await readManifestState(path.join(stateRoot, 'manifest.json'))
  if (read.state !== 'ok') return []
  const found: Array<{ key: string; dir: string }> = []
  for (const [key, entry] of Object.entries(read.manifest.installedSkills ?? {})) {
    const installPath = (entry as { installPath?: unknown } | null)?.installPath
    if (typeof installPath === 'string' && path.isAbsolute(installPath)) {
      found.push({ key, dir: path.dirname(installPath) })
    }
  }
  return found
}

/** Finds every skills root and state root `doctor` scans. Creates nothing. */
export async function discoverRoots(options: DiscoverOptions = {}): Promise<Discovery> {
  const cwd = options.cwd ?? process.cwd()
  const home = options.homeDir ?? os.homedir()
  const native = options.nativePaths ?? CLIENT_NATIVE_PATHS
  const clients = Object.keys(native) as ClientId[]

  // Workspace roots and their skills folders, per client (read-only walk).
  const workspaces = new Map<string, string>()
  const candidates: Array<{ dir: string; source: string }> = []
  for (const client of clients) {
    candidates.push({ dir: native[client], source: `client:${client}` })
    const segments = CLIENT_WORKSPACE_SEGMENTS[client]
    if (!segments) continue
    const found = findWorkspaceRoot(cwd, client, { homeDirOverride: home })
    if (found === null) continue
    workspaces.set(found.root, found.root)
    candidates.push({ dir: path.join(found.root, ...segments), source: `workspace:${client}` })
  }

  // State roots: `--state-root` replaces the set.
  const stateCandidates =
    options.stateRoot !== undefined
      ? [path.resolve(options.stateRoot)]
      : [
          path.join(home, '.skillsmith'),
          ...[...workspaces.keys()].map((w) => path.join(w, '.skillsmith')),
        ]
  const stateRoots: string[] = []
  for (const s of stateCandidates) {
    const r = await realDirectory(s)
    if (r.ok && !stateRoots.includes(r.real)) stateRoots.push(r.real)
  }
  for (const s of stateRoots) {
    for (const m of await manifestRoots(s))
      candidates.push({ dir: m.dir, source: `manifest:${m.key}` })
  }
  for (const extra of options.roots ?? [])
    candidates.push({ dir: path.resolve(extra), source: '--root' })

  const byReal = new Map<string, DiscoveredRoot>()
  const skipped: SkippedRoot[] = []
  for (const c of candidates) {
    const r = await realDirectory(c.dir)
    if (!r.ok) {
      skipped.push({ path: c.dir, source: c.source, errno: r.errno })
      continue
    }
    const known = byReal.get(r.real)
    if (known === undefined) {
      byReal.set(r.real, { root: r.real, sources: [c.source], spellings: [c.dir] })
    } else {
      if (!known.sources.includes(c.source)) known.sources.push(c.source)
      if (!known.spellings.includes(c.dir)) known.spellings.push(c.dir)
    }
  }
  return { stateRoots, roots: [...byReal.values()], skipped }
}
