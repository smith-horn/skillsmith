/**
 * SMI-6531 (A1 step 8-i-a-1): shared fixture and spies for the uninstall park
 * tests (A1 plan §3.8 row 3: Q3, Q7, R2, T-X17, T-X18, T-W4c, T-PW1, T-N1).
 *
 * The fixture is a real temp tree: a skills root, a state root holding the
 * manifest, and one tracked skill of the kind asked for. `uninstall` runs
 * `performUninstall` directly, with the listing seams pointed at the fixture
 * so the space warning never reads the real home directory.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { CLIENT_IDS } from '../../../src/install/paths.js'
import type { ClientId } from '../../../src/install/paths.js'
import type { SkillDependencyRepository } from '../../../src/repositories/SkillDependencyRepository.js'
import type { ListBackupsOptions } from '../../../src/services/skill-backups.listing.js'
import type {
  UninstallParkSeams,
  UninstallResult,
} from '../../../src/services/skill-installation.types.js'
import { performUninstall } from '../../../src/services/skill-installation.uninstall.js'
import { ManifestManager } from '../../../src/services/skill-manifest.js'

type AnyFn = (...args: unknown[]) => unknown
const fsTable = fs as unknown as Record<string, unknown>

export const PARKED = '.skillsmith-parked'

export type RootKind = 'dir' | 'file' | 'symlink-dir' | 'dangling'

export interface UFixture {
  root: string
  skillsDir: string
  stateDir: string
  manifestPath: string
  name: string
  installPath: string
  manifest: ManifestManager
}

/** A tracked skill of `kind` at `<skillsDir>/<name>`; installedAt is ahead of every file. */
export function makeFixture(prefix: string, kind: RootKind = 'dir', name = 'park-skill'): UFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const skillsDir = path.join(root, 'skills')
  const stateDir = path.join(root, 'state')
  fs.mkdirSync(skillsDir)
  fs.mkdirSync(stateDir)
  const installPath = path.join(skillsDir, name)
  if (kind === 'dir') {
    fs.mkdirSync(path.join(installPath, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(installPath, 'SKILL.md'), '# Installed\n'.repeat(40))
    fs.writeFileSync(path.join(installPath, 'sub', 'a.txt'), 'user bytes\n')
  } else if (kind === 'file') {
    fs.writeFileSync(installPath, 'a single file\n')
  } else if (kind === 'symlink-dir') {
    const target = path.join(root, 'target')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'SKILL.md'), '# linked\n')
    fs.symlinkSync(target, installPath)
  } else {
    fs.symlinkSync(path.join(root, 'nowhere'), installPath)
  }
  const manifestPath = path.join(stateDir, 'manifest.json')
  const later = new Date(Date.now() + 60_000).toISOString()
  const entry = {
    id: `author/${name}`,
    name,
    version: '1.0.0',
    source: `github:author/${name}`,
    installPath,
    installedAt: later,
    lastUpdated: later,
  }
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ version: '1.0.0', installedSkills: { [name]: entry } }, null, 2)
  )
  return {
    root,
    skillsDir,
    stateDir,
    manifestPath,
    name,
    installPath,
    manifest: new ManifestManager(manifestPath),
  }
}

export const cleanupFixture = (f: UFixture): void => {
  fs.rmSync(f.root, { recursive: true, force: true })
}

/** Discovery confined to the fixture: no real home, no client roots. */
export function listingFor(f: UFixture, extra: ListBackupsOptions = {}): ListBackupsOptions {
  const nowhere = path.join(f.root, 'no-client-root')
  const nativePaths = Object.fromEntries(CLIENT_IDS.map((c) => [c, nowhere])) as Record<
    ClientId,
    string
  >
  return {
    stateRoot: f.stateDir,
    discovery: { homeDir: path.join(f.root, 'home'), cwd: f.root, nativePaths },
    ...extra,
  }
}

const noDeps = { clearAll: () => undefined } as unknown as SkillDependencyRepository

/** `performUninstall` against the fixture, with its listing confined to it. */
export function uninstall(
  f: UFixture,
  o: { force?: boolean; seams?: UninstallParkSeams } = {}
): Promise<UninstallResult> {
  const seams = o.seams ?? {}
  return performUninstall({
    skillName: f.name,
    force: o.force ?? true,
    skillsDir: f.skillsDir,
    manifest: f.manifest,
    skillDependencyRepo: noDeps,
    onProgress: () => undefined,
    park: { ...seams, usage: listingFor(f, seams.usage) },
  })
}

/** The manifest entry for the fixture's skill, read from disk. */
export const entryOf = (f: UFixture): unknown =>
  (
    JSON.parse(fs.readFileSync(f.manifestPath, 'utf8')) as {
      installedSkills: Record<string, unknown>
    }
  ).installedSkills[f.name]

/** Every op dir's entries under the parked area: `<opId>/<entry>` (sidecars included). */
export function parkedEntries(f: UFixture): string[] {
  const area = path.join(f.skillsDir, PARKED)
  if (!fs.existsSync(area)) return []
  return fs
    .readdirSync(area)
    .flatMap((op) => fs.readdirSync(path.join(area, op)).map((e) => `${op}/${e}`))
}

/** sha256 of every regular file and every link text under `dir`, by path relative to `dir`. */
export function contentSnapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (abs: string, rel: string): void => {
    const st = fs.lstatSync(abs)
    if (st.isSymbolicLink()) {
      out.set(rel, `link:${fs.readlinkSync(abs)}`)
    } else if (st.isFile()) {
      out.set(rel, createHash('sha256').update(fs.readFileSync(abs)).digest('hex'))
    } else if (st.isDirectory()) {
      for (const n of fs.readdirSync(abs)) walk(path.join(abs, n), path.join(rel, n))
    }
  }
  walk(dir, '.')
  return out
}

/** Every hash present before is still present somewhere after (origin or parked area). */
export function lostContent(before: Map<string, string>, after: Map<string, string>): string[] {
  const now = new Set(after.values())
  return [...before.entries()].filter(([, h]) => !now.has(h)).map(([p]) => p)
}

/**
 * Records every delete call in all three fs API families while `body` runs
 * (A1 plan R2: a recursive `fsp.rm` reaches the callback family). Async, so
 * the spies stay until the body settles.
 */
export async function withDeleteSpy<T>(
  body: () => Promise<T>
): Promise<{ value: T; deletes: { family: string; fn: string; path: string }[] }> {
  const deletes: { family: string; fn: string; path: string }[] = []
  const promises = fs.promises as unknown as Record<string, unknown>
  const saved: [Record<string, unknown>, string, unknown][] = []
  const wrap = (obj: Record<string, unknown>, n: string, family: string): void => {
    const orig = obj[n] as AnyFn
    saved.push([obj, n, orig])
    obj[n] = function spied(this: unknown, ...args: unknown[]): unknown {
      deletes.push({ family, fn: n, path: String(args[0]) })
      return orig.apply(this, args)
    }
  }
  for (const n of ['unlinkSync', 'rmdirSync', 'rmSync']) wrap(fsTable, n, 'sync')
  for (const n of ['unlink', 'rmdir', 'rm']) wrap(fsTable, n, 'callback')
  for (const n of ['unlink', 'rmdir', 'rm']) wrap(promises, n, 'promise')
  // `import * as fsp from 'node:fs/promises'` reads a snapshot of the builtin's
  // exports: sync it so a namespace import sees the spies too, and again after.
  syncBuiltinESMExports()
  try {
    return { value: await body(), deletes }
  } finally {
    for (const [obj, n, orig] of saved.reverse()) obj[n] = orig
    syncBuiltinESMExports()
  }
}

/** Deletes aimed at the subject (the skill entry or anything in the parked area). */
export function subjectDeletes(
  f: UFixture,
  deletes: { family: string; fn: string; path: string }[]
): string[] {
  const parked = path.join(f.skillsDir, PARKED)
  return deletes
    .filter(
      (d) =>
        d.path === f.installPath ||
        d.path.startsWith(`${f.installPath}${path.sep}`) ||
        d.path.startsWith(`${parked}${path.sep}`)
    )
    .map((d) => `${d.family}:${d.fn}(${d.path})`)
}

/** Replaces `fs[name]` until the returned restore runs. */
export function stubFs(name: string, impl: (orig: AnyFn) => AnyFn): () => void {
  const orig = fsTable[name] as AnyFn
  fsTable[name] = impl(orig.bind(fs) as AnyFn)
  return () => {
    fsTable[name] = orig
  }
}

/** An Error carrying an errno code, as fs throws. */
export function errnoError(code: string): NodeJS.ErrnoException {
  const e = new Error(`forced ${code}`) as NodeJS.ErrnoException
  e.code = code
  return e
}
