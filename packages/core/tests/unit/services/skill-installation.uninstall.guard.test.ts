/**
 * SMI-6529 round 15 (cross-model review, Critical): uninstall never deletes a
 * skill folder that is a git working tree, and removes only the folder it
 * checked. Before this, `remove` on a git clone adopted it and ran
 * `rm -rf` on it, `.git` and unpushed work included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SkillInstallationService } from '../../../src/services/skill-installation.service.js'
import { ManifestManager } from '../../../src/services/skill-manifest.js'
import { SkillRepository } from '../../../src/repositories/SkillRepository.js'
import { SkillDependencyRepository } from '../../../src/repositories/SkillDependencyRepository.js'
import { createTestDatabase } from '../../helpers/database.js'
import type { Database } from '../../../src/db/database-interface.js'
// F-A (SMI-6732 round 6): `checkNotTrackedElsewhere`'s own malformed-
// `installedSkills` guard is unreachable through `uninstall()` for two of its
// three shapes (see the tests that use it below) -- `manifestData.installedSkills[key]`
// at the uninstall() call site throws first for `undefined`/`null`, so only a
// direct call exercises those two branches.
import {
  checkNotTrackedElsewhere,
  identityChanged,
} from '../../../src/services/skill-installation.removal-identity.js'
// Round 8 (C2): the direct-sequence test below calls `inspectForRemoval`
// itself, exactly as `performUninstall` does, rather than going through the
// whole mocked `uninstall()` call -- see that test's own comment for why.
import { inspectForRemoval } from '../../../src/services/skill-installation.uninstall.helpers.js'
// Round 8 (C1): the regression-control tests below call `removeIfSame`
// directly, to pin the six OTHER (unmodified) callers' `number`-typed
// behaviour independently of the uninstall path.
import { removeIfSame } from '../../../src/install/remove-if-same.js'

// One-shot: the next rename of this exact path first has another program move
// the folder aside and put its own folder there.
const swapBeforeRename = vi.hoisted(() => ({ path: null as string | null }))
// One-shot: while this path is being parked, another install claims the same
// manifest key by rewriting that record's installPath.
const claimOnRename = vi.hoisted(() => ({
  path: null as string | null,
  manifestPath: null as string | null,
  key: null as string | null,
  newInstallPath: null as string | null,
  reinstalledAt: null as string | null,
  newVersion: null as string | null,
}))
// Every rename onto this path fails, so the manifest write fails after the
// skill folder is already gone.
const failRenameTo = vi.hoisted(() => ({ path: null as string | null }))
// Round 25: `access` of this exact path fails, so the existence check cannot
// tell whether the skill is on disk. Round 26: `throws` chooses WHAT it fails
// with — the default is a coded EACCES, and a test can supply an error with no
// `code`, or a value that is not an Error at all.
const accessFailFor = vi.hoisted(() => ({
  path: null as string | null,
  throws: null as { value: unknown } | null,
}))
// F2 (SMI-6732, Linux CI): on ext4 a mis-spelled or NFD alias already fails
// `fs.access` with ENOENT, so a naive F2 test would never reach
// `checkExactEntryName` at all on the only platform CI measures -- that is a
// decorative test, green for the wrong reason. This hook forces `fs.access`
// of one EXACT path to succeed without throwing, standing in for what a
// case-/normalization-insensitive volume (APFS, HFS+) does natively, so the
// Linux run is forced down the same code path macOS takes and
// `checkExactEntryName` itself -- a REAL, unmocked `readdir` -- is what
// produces the refusal.
const accessSucceedFor = vi.hoisted(() => ({ path: null as string | null }))
// Round 25: `readdir` of this exact folder fails, so the parked-leftover scan
// cannot look. F2 failure-mode tests (SMI-6732) reuse this for
// `checkExactEntryName`'s own `readdir(skillsDir)` call, and need a chosen
// error shape rather than always EACCES -- `throws` mirrors `accessFailFor`.
const readdirFailFor = vi.hoisted(() => ({
  path: null as string | null,
  throws: null as { value: unknown } | null,
}))
// F-A (SMI-6732 round 6, Linux CI): `checkNotTrackedElsewhere`'s identity
// check compares two `lstat()` results by dev+ino. No two on-disk
// directories in this sandbox ever share an inode, so a naive F-A test could
// never reach the comparison the way a case-/normalization-insensitive
// volume (APFS, HFS+) does natively -- the same problem `accessSucceedFor`
// solves for `checkExactEntryName`'s own alias tests above. This hook makes
// `lstat(aliasPath)` resolve through the REAL `lstat` of `targetPath`
// instead, so both sides of the comparison come from the SAME real
// directory and genuinely share dev+ino.
const lstatAliasFor = vi.hoisted(() => ({
  aliasPath: null as string | null,
  targetPath: null as string | null,
}))
// Pins the DEV half of that same comparison in isolation. Every path in this
// sandbox shares one device, so no pair of real files can produce "same ino,
// different dev" -- the one case that tells "compare both fields" apart from
// "compare ino alone". This overlays a fabricated, never-real `dev` onto the
// REAL lstat result for one exact (pre-alias) path, leaving `ino` untouched.
const lstatFakeDeviceFor = vi.hoisted(() => ({ path: null as string | null }))
// Round 7 (F1): make ONE exact path's `lstat` fail with a chosen error, so the
// guard's non-ENOENT branch can be exercised. A transient fault here used to be
// treated as absence -- fail-OPEN -- which let a tracked, modified skill be
// adopted and deleted without `force`.
const lstatFailFor = vi.hoisted(() => ({
  path: null as string | null,
  throws: null as { value: unknown } | null,
}))
// Round 7 (F2): after `after` successful lstats of `path`, resolve it through
// `targetPath` instead -- a directory replaced under us between the guard's
// identity reading and the one `removeIfSame` anchors on.
const lstatFlipFor = vi.hoisted(() => ({
  path: null as string | null,
  targetPath: null as string | null,
  after: 0,
  seen: 0,
}))
// Round 8 (C1): overlay a fabricated `ino` onto every lstat of a given REAL
// (pre-fabrication) inode -- keyed by the REAL `ino` a call returns, not by
// path, since `removeIfSame` parks its target under a random SIBLING name
// (a real rename) before its own re-check; a path-keyed fake would silently
// stop applying the moment that rename happens, which is exactly the bug a
// first version of this hook had. Keying by the real, rename-invariant inode
// instead follows the SAME kernel resource under any name it is addressed
// by, matching what an actually-huge inode would do. Narrowed to `Number`
// automatically when the call did not request `{bigint: true}`.
const lstatFakeInoFor = vi.hoisted(() => ({ entries: new Map<bigint, bigint>() }))
// Round 10 (R1): the ONE lstat call naming this exact path throws ENOENT --
// as if the entry genuinely vanished at that instant -- and, as a side effect
// of that SAME call, a REAL rename lands `swapFromPath`'s directory at
// `path`, so every read AFTER this one sees the swapped-in directory rather
// than nothing. Reproduces the exact window round 9 measured:
// `checkNotTrackedElsewhere`'s OWN lstat lands in the gap between the
// original vanishing and a DIFFERENT, tracked and modified skill's directory
// landing in its place.
const vanishThenSwapFor = vi.hoisted(() => ({
  path: null as string | null,
  swapFromPath: null as string | null,
}))
// Round 10 (R5): overlay a fabricated `birthtimeNs: 0n` onto exactly the
// FIRST lstat of this exact path (the removal guard's own read, which
// becomes `adoptedIdentity`), leaving every LATER read of the same path (the
// second `inspectForRemoval`, which becomes `seen.stat`) at its real,
// non-zero value -- so `identityChanged` sees one side reporting "no
// birthtime" while `dev`/`ino` genuinely agree.
const lstatZeroBirthtimeOnceFor = vi.hoisted(() => ({ path: null as string | null, seen: 0 }))
// Round 8 (C2): a REAL (not mocked) filesystem swap, triggered the one time
// `fs.rename` targets `manifestPath` -- `ManifestManager.save`'s own
// write-then-rename, which lands reliably between adoption (which reads the
// PRE-swap directory) and the second `inspectForRemoval` (which must read
// the POST-swap one) for the C2 regression test below.
const swapDiskOnManifestWrite = vi.hoisted(() => ({
  manifestPath: null as string | null,
  diskPath: null as string | null,
  victimContent: null as string | null,
}))

// Round 8: a `{...stat}` spread produces a PLAIN OBJECT, which drops the
// `Stats`/`BigIntStats` PROTOTYPE -- and with it `isFile()`/`isDirectory()`/
// `isSymbolicLink()`, which `inspectForRemoval` calls on every lstat result
// it's handed. `lstatFakeDeviceFor` never tripped over this because its own
// consumer (`checkNotTrackedElsewhere`) only reads `.dev`/`.ino` as fields;
// `lstatFakeInoFor` below reaches `inspectForRemoval` too, so it needs a
// clone that keeps the prototype. `Object.create` + `Object.assign` copies
// every OWN field (the data `stat` carries) onto a fresh object with the
// SAME prototype (where the methods live, reading `this.mode` etc., also
// copied as an own field) -- cheaper and more direct than a `Proxy` here,
// since every field is a known, enumerable own property.
const overrideField = vi.hoisted(
  () =>
    <T extends object>(obj: T, field: keyof T, value: T[typeof field]): T =>
      Object.assign(Object.create(Object.getPrototypeOf(obj)) as T, obj, { [field]: value })
)

// `removeIfSame` imports `node:fs/promises`; `ManifestManager` imports
// `fs/promises`. Both get the same hooks.
const makeFsMock = vi.hoisted(() => (actual: typeof import('node:fs/promises')) => {
  const rename = async (from: string, to: string): Promise<void> => {
    if (String(from) === swapBeforeRename.path) {
      swapBeforeRename.path = null
      await actual.rename(from, `${String(from)}-moved`)
      await actual.mkdir(from)
      await actual.writeFile(`${String(from)}/KEEP.md`, 'not ours', 'utf-8')
    }
    if (String(from) === claimOnRename.path && claimOnRename.manifestPath !== null) {
      const manifestFile = claimOnRename.manifestPath
      const key = claimOnRename.key ?? ''
      const claimed = claimOnRename.newInstallPath ?? ''
      claimOnRename.path = null
      const reinstalledAt = claimOnRename.reinstalledAt
      const newVersion = claimOnRename.newVersion
      const raw = JSON.parse(await actual.readFile(manifestFile, 'utf-8')) as {
        installedSkills: Record<
          string,
          { installPath: string; installedAt?: string; lastUpdated?: string; version?: string }
        >
      }
      const entry = raw.installedSkills[key]
      if (entry) {
        if (claimed !== '') entry.installPath = claimed
        if (reinstalledAt !== null) {
          entry.installedAt = reinstalledAt
          entry.lastUpdated = reinstalledAt
        }
        if (newVersion !== null) entry.version = newVersion
      }
      await actual.writeFile(manifestFile, JSON.stringify(raw, null, 2))
    }
    if (
      String(to) === swapDiskOnManifestWrite.manifestPath &&
      swapDiskOnManifestWrite.diskPath !== null
    ) {
      const disk = swapDiskOnManifestWrite.diskPath
      const content = swapDiskOnManifestWrite.victimContent ?? '# swapped\n'
      swapDiskOnManifestWrite.diskPath = null
      await actual.rename(disk, `${disk}-original`)
      await actual.mkdir(disk)
      await actual.writeFile(`${disk}/SKILL.md`, content, 'utf-8')
    }
    if (String(to) === failRenameTo.path) {
      throw Object.assign(new Error(`EACCES: permission denied, rename '${String(to)}'`), {
        code: 'EACCES',
      })
    }
    return actual.rename(from, to)
  }
  const access = async (p: string, mode?: number): Promise<void> => {
    if (String(p) === accessSucceedFor.path) return
    if (String(p) === accessFailFor.path) {
      if (accessFailFor.throws !== null) throw accessFailFor.throws.value
      throw Object.assign(new Error(`EACCES: permission denied, access '${String(p)}'`), {
        code: 'EACCES',
      })
    }
    return actual.access(p, mode)
  }
  const readdir = (async (...args: Parameters<typeof actual.readdir>) => {
    if (String(args[0]) === readdirFailFor.path) {
      if (readdirFailFor.throws !== null) throw readdirFailFor.throws.value
      throw Object.assign(new Error(`EACCES: permission denied, scandir '${String(args[0])}'`), {
        code: 'EACCES',
      })
    }
    return actual.readdir(...args)
  }) as typeof actual.readdir
  const lstat = (async (...args: Parameters<typeof actual.lstat>) => {
    const key = String(args[0])
    if (lstatFailFor.path !== null && key === lstatFailFor.path) {
      throw lstatFailFor.throws === null ? new Error('lstat failed') : lstatFailFor.throws.value
    }
    // Round 10 (R1): this ONE call throws ENOENT and, as its own side effect,
    // performs the REAL swap-in rename -- see `vanishThenSwapFor`'s own doc
    // comment above. The original entry at `key` is vacated first (a bare
    // rename onto a non-empty directory fails with ENOTEMPTY, which is not
    // the window this hook reproduces), so the net effect is exactly "the
    // original vanished, then something else was renamed into its place."
    if (vanishThenSwapFor.path !== null && key === vanishThenSwapFor.path) {
      const swapFrom = vanishThenSwapFor.swapFromPath
      vanishThenSwapFor.path = null
      vanishThenSwapFor.swapFromPath = null
      if (swapFrom !== null) {
        await actual.rm(key, { recursive: true, force: true })
        await actual.rename(swapFrom, key)
      }
      throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${key}'`), {
        code: 'ENOENT',
      })
    }
    // Round 8: both redirects below now forward `args.slice(1)` (the lstat
    // OPTIONS, e.g. `{bigint: true}`), not just the substituted path -- the
    // original version silently downgraded a redirected read to a
    // `number`-typed `Stats`, which broke `identityChanged`'s now-`bigint`
    // comparison for any test using these hooks.
    let effectiveArgs = args
    if (lstatFlipFor.path !== null && key === lstatFlipFor.path) {
      lstatFlipFor.seen += 1
      if (lstatFlipFor.seen > lstatFlipFor.after) {
        effectiveArgs = [lstatFlipFor.targetPath, ...args.slice(1)] as Parameters<
          typeof actual.lstat
        >
      }
    }
    if (lstatAliasFor.aliasPath !== null && key === lstatAliasFor.aliasPath) {
      effectiveArgs = [lstatAliasFor.targetPath, ...args.slice(1)] as Parameters<
        typeof actual.lstat
      >
    }
    let result = await actual.lstat(...effectiveArgs)
    if (lstatFakeDeviceFor.path !== null && key === lstatFakeDeviceFor.path) {
      // A device number that can never equal a real one, so only `ino`
      // still agrees with the unmodified `target` stat. Round 8: under
      // `{bigint: true}` every numeric field, `dev` included, comes back as
      // a `bigint` -- fabricating a plain `number` here would silently fail
      // every comparison the OTHER way instead.
      const fakeDev = typeof (result as { dev: unknown }).dev === 'bigint' ? -1n : -1
      result = overrideField(result, 'dev', fakeDev)
    }
    // Round 8 (C1): overlay a fabricated `ino`, looked up by the REAL ino
    // this call just returned (so it follows a `removeIfSame` park-rename),
    // narrowed to `Number` only when this exact call did not request
    // `{bigint: true}` -- see `lstatFakeInoFor`'s own doc comment above.
    const realIno = (result as { ino: unknown }).ino
    const realInoKey = typeof realIno === 'bigint' ? realIno : BigInt(realIno as number)
    const fakeIno = lstatFakeInoFor.entries.get(realInoKey)
    if (fakeIno !== undefined) {
      const finalIno = typeof realIno === 'bigint' ? fakeIno : Number(fakeIno)
      result = overrideField(result, 'ino', finalIno)
    }
    // Round 10 (R5): overlay `birthtimeNs: 0n` onto exactly the FIRST lstat of
    // this path -- see `lstatZeroBirthtimeOnceFor`'s own doc comment above.
    if (lstatZeroBirthtimeOnceFor.path !== null && key === lstatZeroBirthtimeOnceFor.path) {
      lstatZeroBirthtimeOnceFor.seen += 1
      const current = result as { birthtimeNs?: unknown }
      if (lstatZeroBirthtimeOnceFor.seen === 1 && typeof current.birthtimeNs === 'bigint') {
        result = Object.assign(
          Object.create(Object.getPrototypeOf(result)) as typeof result,
          result,
          {
            birthtimeNs: 0n,
          }
        )
      }
    }
    return result
  }) as typeof actual.lstat
  return {
    ...actual,
    default: { ...actual, rename, access, readdir, lstat },
    rename,
    access,
    readdir,
    lstat,
  }
})

vi.mock('node:fs/promises', async (importOriginal) =>
  makeFsMock(await importOriginal<typeof import('node:fs/promises')>())
)
vi.mock('fs/promises', async (importOriginal) =>
  makeFsMock(await importOriginal<typeof import('node:fs/promises')>())
)

let tmpDir: string
let skillsDir: string
let manifestPath: string
let db: Database
// F1 (SMI-6732): set only by tests that spy on `ManifestManager.prototype.load`
// to hand `performUninstall` an entry whose `installPath` is a getter.
let manifestLoadSpy: ReturnType<typeof vi.spyOn> | null = null

function createService(
  onProgress?: (stage: string, detail: string) => void
): SkillInstallationService {
  return new SkillInstallationService({
    db,
    skillRepo: new SkillRepository(db),
    skillDependencyRepo: new SkillDependencyRepository(db),
    skillsDir,
    manifestPath,
    ...(onProgress !== undefined && { onProgress }),
  })
}

// F2 (SMI-6732): a timestamp reliably AFTER `track()`'s own +60s
// `installedAt`, for a test that needs a file to genuinely trip the
// modification gate rather than merely being rewritten (which `track()`'s
// own future-dated `installedAt` absorbs harmlessly -- see the comment on
// `track()` below). Computed fresh per call, not as a module-level constant,
// so it stays ahead of `installedAt` no matter how long the suite has been
// running by the time a given test reaches it.
function farFuture(): Date {
  return new Date(Date.now() + 120_000)
}

/** Record `name` in the manifest as installed at `installPath`. */
async function track(name: string, installPath: string): Promise<void> {
  // installedAt is ahead of every file, so the non-force check sees no edits.
  const later = new Date(Date.now() + 60_000).toISOString()
  const manifest = {
    version: '1.0.0',
    installedSkills: {
      [name]: {
        id: `author/${name}`,
        name,
        version: '1.0.0',
        source: `github:author/${name}`,
        installPath,
        installedAt: later,
        lastUpdated: later,
      },
    },
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
}

/** Record `name` with no install timestamps, as an older writer did. */
async function trackLegacy(name: string, installPath: string): Promise<void> {
  const manifest = {
    version: '1.0.0',
    installedSkills: {
      [name]: {
        id: `author/${name}`,
        name,
        version: '1.0.0',
        source: `github:author/${name}`,
        installPath,
      },
    },
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
}

/** Record `name` with an extra field of the given value, as another tool might. */
async function trackWithExtra(name: string, installPath: string, extra: unknown): Promise<void> {
  const later = new Date(Date.now() + 60_000).toISOString()
  const manifest = {
    version: '1.0.0',
    installedSkills: {
      [name]: {
        id: `author/${name}`,
        name,
        version: '1.0.0',
        source: `github:author/${name}`,
        installPath,
        installedAt: later,
        lastUpdated: later,
        tags: extra,
      },
    },
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
}

/**
 * Round 7 (F3): record SEVERAL skills at once. Every earlier fixture used
 * `track()`, which overwrites, so every test ran against a ONE-entry manifest
 * and the guard's central property -- scan EVERY record -- was unpinned. Two
 * data-loss mutants (stop at the first stale record; return ok at the first
 * non-match) passed all 69 tests because the fixture could not express the
 * precondition.
 */
async function trackMany(entries: Array<[string, string]>): Promise<void> {
  const later = new Date(Date.now() + 60_000).toISOString()
  const installedSkills: Record<string, unknown> = {}
  for (const [name, installPath] of entries) {
    installedSkills[name] = {
      id: `author/${name}`,
      name,
      version: '1.0.0',
      source: `github:author/${name}`,
      installPath,
      installedAt: later,
      lastUpdated: later,
    }
  }
  await fs.writeFile(manifestPath, JSON.stringify({ version: '1.0.0', installedSkills }, null, 2))
}

async function manifestEntry(name: string): Promise<unknown> {
  const raw = await fs.readFile(manifestPath, 'utf-8').catch(() => null)
  if (raw === null) return undefined
  return (JSON.parse(raw) as { installedSkills: Record<string, unknown> }).installedSkills[name]
}

async function makeClone(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, '.git'), { recursive: true })
  await fs.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await fs.writeFile(path.join(dir, 'SKILL.md'), '# Local work\n')
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uninstall-guard-'))
  skillsDir = path.join(tmpDir, 'skills')
  manifestPath = path.join(tmpDir, 'manifest.json')
  await fs.mkdir(skillsDir, { recursive: true })
  db = await createTestDatabase()
})

afterEach(async () => {
  swapBeforeRename.path = null
  claimOnRename.path = null
  claimOnRename.manifestPath = null
  claimOnRename.reinstalledAt = null
  claimOnRename.newVersion = null
  claimOnRename.newInstallPath = null
  failRenameTo.path = null
  accessFailFor.path = null
  accessFailFor.throws = null
  accessSucceedFor.path = null
  readdirFailFor.path = null
  readdirFailFor.throws = null
  lstatFailFor.path = null
  lstatFailFor.throws = null
  lstatFlipFor.path = null
  lstatFlipFor.targetPath = null
  lstatFlipFor.after = 0
  lstatFlipFor.seen = 0
  lstatAliasFor.aliasPath = null
  lstatAliasFor.targetPath = null
  lstatFakeDeviceFor.path = null
  lstatFakeInoFor.entries.clear()
  vanishThenSwapFor.path = null
  vanishThenSwapFor.swapFromPath = null
  lstatZeroBirthtimeOnceFor.path = null
  lstatZeroBirthtimeOnceFor.seen = 0
  swapDiskOnManifestWrite.manifestPath = null
  swapDiskOnManifestWrite.diskPath = null
  swapDiskOnManifestWrite.victimContent = null
  manifestLoadSpy?.mockRestore()
  manifestLoadSpy = null
  db.close()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('uninstall never deletes a git working tree (SMI-6529 round 15)', () => {
  it('refuses an untracked skill folder that is a git clone, and adopts nothing', async () => {
    const clone = path.join(skillsDir, 'clone-skill')
    await makeClone(clone)

    const result = await createService().uninstall('clone-skill')

    expect(result.success).toBe(false)
    expect(result.message).toContain('is a git working tree')
    expect(await fs.readFile(path.join(clone, '.git', 'HEAD'), 'utf-8')).toContain('main')
    expect(await manifestEntry('clone-skill')).toBeUndefined()
  })

  it('refuses a tracked skill folder that has become a git clone, even with force', async () => {
    const clone = path.join(skillsDir, 'tracked-clone')
    await makeClone(clone)
    await track('tracked-clone', clone)

    const result = await createService().uninstall('tracked-clone', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('even with force')
    expect(await fs.readFile(path.join(clone, 'SKILL.md'), 'utf-8')).toBe('# Local work\n')
    expect(await manifestEntry('tracked-clone')).toBeDefined()
  })

  it('removes a symlinked skill and leaves the clone it points at alone', async () => {
    const clone = path.join(tmpDir, 'dev', 'linked-skill')
    await makeClone(clone)
    const link = path.join(skillsDir, 'linked-skill')
    await fs.symlink(clone, link)
    await track('linked-skill', link)

    const result = await createService().uninstall('linked-skill', { force: true })

    expect(result.success).toBe(true)
    await expect(fs.lstat(link)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(clone, 'SKILL.md'), 'utf-8')).toBe('# Local work\n')
  })
})

// SMI-6529 round 28 (pre-merge gate, PR-07): a progress listener that throws
// must not change the uninstall's outcome — that part was deliberate — but it
// must not vanish either.
describe('uninstall reports a progress listener that threw (SMI-6529 round 28)', () => {
  // Round 29 (gate confirmation): the success path was covered; the exits that
  // carry no warning of their own were not, and those are exactly where a
  // listener failure used to disappear.
  it('still says the listener threw when the uninstall exits early', async () => {
    const result = await createService(() => {
      throw new Error('listener blew up')
    }).uninstall('never-installed-skill')

    expect(result.success).toBe(false)
    expect(result.message).toContain('is not installed')
    expect(result.warning).toContain('progress listener threw')
  })

  it('finishes the uninstall and says the listener threw', async () => {
    const installPath = path.join(skillsDir, 'listener-skill')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    await track('listener-skill', installPath)

    const result = await createService(() => {
      throw new Error('listener blew up')
    }).uninstall('listener-skill', { force: true })

    // The outcome is unchanged: the skill really is gone.
    expect(result.success).toBe(true)
    await expect(fs.lstat(installPath)).rejects.toMatchObject({ code: 'ENOENT' })
    // And the failure is not silent.
    expect(result.warning).toContain('progress listener threw')
    expect(result.warning).toContain('listener blew up')
  })
})

// SMI-6529 round 25 (cross-model review): a check that could not run is not a
// check that found nothing. Both of these used to be silent.
describe('uninstall says when it could not tell (SMI-6529 round 25)', () => {
  it('does not say "not installed" when the check itself failed', async () => {
    const installPath = path.join(skillsDir, 'unreadable-skill')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    accessFailFor.path = installPath

    const result = await createService().uninstall('unreadable-skill')

    expect(result.success).toBe(false)
    expect(result.message).toContain('Could not tell whether')
    expect(result.message).toContain('EACCES')
    // The skill is still there: the user is not sent away from it.
    expect(await fs.readFile(path.join(installPath, 'SKILL.md'), 'utf-8')).toBe('# Installed\n')
  })

  // Round 26 (cross-model review): the round-25 guard read
  // `code !== undefined && code !== 'ENOENT'`, so an error carrying no code at
  // all fell through to "not installed" — the same false absence it fixed.
  it('does not say "not installed" when the check failed with no error code', async () => {
    const installPath = path.join(skillsDir, 'uncoded-skill')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    accessFailFor.path = installPath
    accessFailFor.throws = { value: new Error('filesystem went away') }

    const result = await createService().uninstall('uncoded-skill')

    expect(result.success).toBe(false)
    expect(result.message).toContain('Could not tell whether')
    expect(result.message).toContain('filesystem went away')
    expect(await fs.readFile(path.join(installPath, 'SKILL.md'), 'utf-8')).toBe('# Installed\n')
  })

  it('survives a thrown value that is not an Error at all', async () => {
    const installPath = path.join(skillsDir, 'nonerror-skill')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    accessFailFor.path = installPath
    accessFailFor.throws = { value: null }

    const result = await createService().uninstall('nonerror-skill')

    expect(result.success).toBe(false)
    expect(result.message).toContain('Could not tell whether')
    expect(await fs.readFile(path.join(installPath, 'SKILL.md'), 'utf-8')).toBe('# Installed\n')
  })

  it('says when it could not look for parked leftovers', async () => {
    const installPath = path.join(skillsDir, 'parkscan-skill')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    await track('parkscan-skill', installPath)
    readdirFailFor.path = skillsDir

    const result = await createService().uninstall('parkscan-skill', { force: true })

    expect(result.success).toBe(true)
    expect(result.warning).toContain('could not be listed (EACCES)')
  })
})

describe('uninstall keeps the manifest honest (SMI-6529 round 16)', () => {
  it('reports what an earlier removal left parked next to the skill', async () => {
    const installPath = path.join(skillsDir, 'leftover-skill')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    const parked = path.join(
      skillsDir,
      '.leftover-skill.skillsmith-removing-0123456789abcdef0123456789abcdef'
    )
    await fs.mkdir(parked)
    await fs.writeFile(path.join(parked, 'part.md'), 'partial')
    await track('leftover-skill', installPath)

    const result = await createService().uninstall('leftover-skill', { force: true })

    expect(result.success).toBe(true)
    expect(result.warning).toContain(parked)
    expect(result.warning).toContain('an interrupted removal')
    // Round 18: the wording does not claim the parked entry is ours.
    expect(result.warning).toContain('restore or delete it yourself')
    expect(await fs.readFile(path.join(parked, 'part.md'), 'utf-8')).toBe('partial')
  })

  // Round 17 (cross-model review): the reinstall lands at the SAME path, so
  // comparing paths alone would read it as the record just removed and delete
  // the new install's record.
  it('leaves the record alone when the same name is reinstalled at the same path', async () => {
    const installPath = path.join(skillsDir, 'claimed-skill')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    await track('claimed-skill', installPath)
    claimOnRename.path = installPath
    claimOnRename.manifestPath = manifestPath
    claimOnRename.key = 'claimed-skill'
    claimOnRename.newInstallPath = installPath
    claimOnRename.reinstalledAt = '2030-01-01T00:00:00.000Z'

    const result = await createService().uninstall('claimed-skill', { force: true })

    expect(result.success).toBe(true)
    expect(result.warning).toContain('Another install claimed this name')
    expect(await manifestEntry('claimed-skill')).toMatchObject({
      installPath,
      installedAt: '2030-01-01T00:00:00.000Z',
    })
  })

  it('names what is parked even when the record could not be updated', async () => {
    const installPath = path.join(skillsDir, 'stuck-parked')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    const parked = path.join(
      skillsDir,
      '.stuck-parked.skillsmith-removing-0123456789abcdef0123456789abcdef'
    )
    await fs.mkdir(parked)
    await fs.writeFile(path.join(parked, 'part.md'), 'partial')
    await track('stuck-parked', installPath)
    failRenameTo.path = manifestPath

    const result = await createService().uninstall('stuck-parked', { force: true })

    expect(result.success).toBe(false)
    expect(result.warning).toContain(parked)
  })

  it('says what to do when the folder is gone but its record could not be updated', async () => {
    const installPath = path.join(skillsDir, 'stuck-skill')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    await track('stuck-skill', installPath)
    failRenameTo.path = manifestPath

    const result = await createService().uninstall('stuck-skill', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('could not be updated')
    expect(result.message).toContain(manifestPath)
    expect(result.message).toContain('run the same remove again once that file is writable')
    await expect(fs.lstat(installPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await manifestEntry('stuck-skill')).toBeDefined()
  })

  // Round 18 (cross-model review): timestamps are not a unique generation
  // token — two installs can share a millisecond, and an older writer omits
  // them — so the whole record is compared.
  it('leaves the record alone when a reinstall shares both timestamps', async () => {
    const installPath = path.join(skillsDir, 'collide-skill')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    await track('collide-skill', installPath)
    claimOnRename.path = installPath
    claimOnRename.manifestPath = manifestPath
    claimOnRename.key = 'collide-skill'
    claimOnRename.newVersion = '9.9.9'

    const result = await createService().uninstall('collide-skill', { force: true })

    expect(result.success).toBe(true)
    expect(result.warning).toContain('Another install claimed this name')
    expect(await manifestEntry('collide-skill')).toMatchObject({ version: '9.9.9' })
  })

  it('leaves the record alone when a record with no timestamps is replaced', async () => {
    const installPath = path.join(skillsDir, 'legacy-skill')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    await trackLegacy('legacy-skill', installPath)
    const claimedPath = path.join(tmpDir, 'elsewhere', 'legacy-skill')
    claimOnRename.path = installPath
    claimOnRename.manifestPath = manifestPath
    claimOnRename.key = 'legacy-skill'
    claimOnRename.newInstallPath = claimedPath

    const result = await createService().uninstall('legacy-skill', { force: true })

    expect(result.success).toBe(true)
    expect(result.warning).toContain('Another install claimed this name')
    expect(await manifestEntry('legacy-skill')).toMatchObject({ installPath: claimedPath })
  })

  // Round 19 (Opus): comparing field by field with `!==` was correct only
  // while every field is a string. One array field, and the record would be
  // kept forever with a warning saying an install claimed the name.
  it('drops a record that carries a non-string field', async () => {
    const installPath = path.join(skillsDir, 'tagged-skill')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    await trackWithExtra('tagged-skill', installPath, ['one', 'two'])

    const result = await createService().uninstall('tagged-skill', { force: true })

    expect(result.success).toBe(true)
    expect(result.warning ?? '').not.toContain('Another install claimed this name')
    expect(await manifestEntry('tagged-skill')).toBeUndefined()
  })

  it('still reports what is parked when a progress listener throws', async () => {
    const installPath = path.join(skillsDir, 'noisy-skill')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    const parked = path.join(
      skillsDir,
      '.noisy-skill.skillsmith-removing-0123456789abcdef0123456789abcdef'
    )
    await fs.mkdir(parked)
    await fs.writeFile(path.join(parked, 'part.md'), 'partial')
    await track('noisy-skill', installPath)

    const result = await createService(() => {
      throw new Error('listener exploded')
    }).uninstall('noisy-skill', { force: true })

    expect(result.success).toBe(true)
    expect(result.warning).toContain(parked)
    await expect(fs.lstat(installPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('uninstall removes only the folder it checked (SMI-6529 round 15)', () => {
  it('leaves a folder another program swapped in, and keeps the manifest entry', async () => {
    const installPath = path.join(skillsDir, 'swapped-skill')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    await track('swapped-skill', installPath)
    swapBeforeRename.path = installPath

    const result = await createService().uninstall('swapped-skill', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(
      /was not removed: .* was replaced by something else, and that entry is now at /
    )
    // Round 17 (cross-model review): their folder is never renamed back over
    // whatever is at the path now. It is moved aside, and the exact path is
    // reported, so nothing of theirs is destroyed.
    const parkedName = (await fs.readdir(skillsDir)).find((n) =>
      n.startsWith('.swapped-skill.skillsmith-removing-')
    )
    expect(parkedName).toBeDefined()
    expect(await fs.readFile(path.join(skillsDir, parkedName ?? '', 'KEEP.md'), 'utf-8')).toBe(
      'not ours'
    )
    expect(result.warning).toContain(parkedName ?? 'no parked entry')
    // Our own copy is where their swap moved it, untouched.
    expect(await fs.readFile(path.join(`${installPath}-moved`, 'SKILL.md'), 'utf-8')).toBe(
      '# Installed\n'
    )
    expect(await manifestEntry('swapped-skill')).toBeDefined()
  })
})

describe('uninstall only deletes inside the skills directory (SMI-6732)', () => {
  // The manifest is not a trusted input. Its workspace-scoped form lives at
  // `<workspaceRoot>/.skillsmith/manifest.json` -- inside the project tree and
  // not gitignored -- so a cloned repository can carry an entry naming any path
  // on the machine. Measured before the fix, all with `force: true`, all
  // returning `success: true, "uninstalled successfully"`.
  //
  // THESE CASES GO THROUGH `uninstall()`, NOT `checkRemovalTarget()` DIRECTLY,
  // on purpose. The defect being fixed was not a missing predicate -- absoluteness
  // and containment already existed in `skill-installation.target-guard.ts` -- it
  // was that the destructive path never CALLED one. A unit test of the guard
  // alone would pass against the unfixed code and prove nothing.

  it('refuses an installPath outside the skills directory, and leaves it on disk', async () => {
    const victim = path.join(tmpDir, 'not-a-skill')
    await fs.mkdir(victim, { recursive: true })
    await fs.writeFile(path.join(victim, 'important.txt'), 'user data\n')
    await track('escaped', victim)

    const result = await createService().uninstall('escaped', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('not directly inside')
    expect(await fs.readFile(path.join(victim, 'important.txt'), 'utf-8')).toBe('user data\n')
    expect(await manifestEntry('escaped')).toBeDefined()
  })

  it('refuses a RELATIVE installPath rather than resolving it against the cwd', async () => {
    // The pre-fix behaviour deleted `<process.cwd()>/rel-target` and reported
    // `removedPath: "rel-target"`, which names a path the user cannot locate.
    await track('relative', 'rel-target')

    const result = await createService().uninstall('relative', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('not absolute')
    expect(await manifestEntry('relative')).toBeDefined()
  })

  it('refuses the skills directory itself, which would delete every skill', async () => {
    // F5: the by-value S3 check is ordered FIRST so the message explains the
    // real problem rather than saying a path that IS the skills directory is
    // "not directly inside" it. A mutant replacing the by-value compare with
    // `installPath === skillsDir` survived, because the parent rule refuses this
    // spelling anyway -- only the MESSAGE differs. The assertion below is
    // therefore on the wording, and the aliased-root case that follows covers
    // the spelling where the two rules genuinely diverge.
    const bystander = path.join(skillsDir, 'other-skill')
    await fs.mkdir(bystander, { recursive: true })
    await fs.writeFile(path.join(bystander, 'SKILL.md'), '# Other\n')
    await track('theroot', skillsDir)

    const result = await createService().uninstall('theroot', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('every installed skill')
    expect(await fs.readFile(path.join(bystander, 'SKILL.md'), 'utf-8')).toBe('# Other\n')
  })

  it('refuses a traversal that climbs back out of the skills directory', async () => {
    const victim = path.join(tmpDir, 'loot')
    await fs.mkdir(victim, { recursive: true })
    await fs.writeFile(path.join(victim, 'keep.txt'), 'keep\n')
    // The literal string matters. An earlier version of this case built the
    // path with `path.join(skillsDir, '..', 'loot')`, which COLLAPSES to
    // `<tmp>/loot` before it is ever written to the manifest -- so the guard
    // never received a `..` at all and the case passed through the "outside"
    // branch while claiming to test traversal. String concatenation keeps the
    // `..` intact all the way into the guard.
    await track('climber', `${skillsDir}/../loot`)

    const result = await createService().uninstall('climber', { force: true })

    expect(result.success).toBe(false)
    expect(await fs.readFile(path.join(victim, 'keep.txt'), 'utf-8')).toBe('keep\n')
  })

  it('refuses an entry whose PARENT is a symlink pointing outside', async () => {
    // Lexical containment alone would accept this: the string sits under
    // skillsDir. The delete would land in `outside/child`.
    const outside = path.join(tmpDir, 'outside')
    await fs.mkdir(path.join(outside, 'child'), { recursive: true })
    await fs.writeFile(path.join(outside, 'child', 'data.txt'), 'data\n')
    await fs.symlink(outside, path.join(skillsDir, 'hop'))
    await track('hopper', path.join(skillsDir, 'hop', 'child'))

    const result = await createService().uninstall('hopper', { force: true })

    expect(result.success).toBe(false)
    expect(await fs.readFile(path.join(outside, 'child', 'data.txt'), 'utf-8')).toBe('data\n')
  })

  it('refuses an entry with no installPath at all, naming the repair', async () => {
    const manifest = {
      version: '1.0.0',
      installedSkills: {
        broken: { id: 'author/broken', name: 'broken', version: '1.0.0', source: 'x' },
      },
    }
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))

    const result = await createService().uninstall('broken', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('no usable installPath')
  })

  // POSITIVE CONTROLS. Without these the guard could pass by refusing every
  // uninstall, which is the failure mode a red test alone does not catch.

  it('still uninstalls a normal skill inside the skills directory', async () => {
    const good = path.join(skillsDir, 'good-skill')
    await fs.mkdir(good, { recursive: true })
    await fs.writeFile(path.join(good, 'SKILL.md'), '# Good\n')
    await track('good-skill', good)

    const result = await createService().uninstall('good-skill', { force: true })

    expect(result.success).toBe(true)
    await expect(fs.lstat(good)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('still uninstalls a SYMLINKED skill and leaves its target alone', async () => {
    // The guard checks the entry's PARENT, not the entry, precisely so this
    // keeps working: removing a symlink removes the link, never its target.
    // Realpathing the entry instead would refuse this and break a normal
    // develop-in-place workflow.
    const checkout = path.join(tmpDir, 'dev', 'my-skill')
    await fs.mkdir(checkout, { recursive: true })
    await fs.writeFile(path.join(checkout, 'SKILL.md'), '# Local work\n')
    const link = path.join(skillsDir, 'my-skill')
    await fs.symlink(checkout, link)
    await track('my-skill', link)

    const result = await createService().uninstall('my-skill', { force: true })

    expect(result.success).toBe(true)
    await expect(fs.lstat(link)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(checkout, 'SKILL.md'), 'utf-8')).toBe('# Local work\n')
  })
})

describe('uninstall refuses nested and mis-spelled targets (SMI-6732 round 2)', () => {
  // Round 1's guard accepted any depth under the skills root. Depth is exactly
  // what defeats the git-worktree refusal, because `checkGitAtRoot` looks for
  // `.git` at the TARGET only, never at an ancestor.

  it('refuses a path nested inside a cloned skill, leaving uncommitted work', async () => {
    const clone = path.join(skillsDir, 'clone-skill')
    await makeClone(clone)
    const src = path.join(clone, 'src')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'work.txt'), 'uncommitted\n')
    await track('nested', src)

    const result = await createService().uninstall('nested', { force: true })

    expect(result.success).toBe(false)
    expect(await fs.readFile(path.join(src, 'work.txt'), 'utf-8')).toBe('uncommitted\n')
  })

  it("refuses a path naming a cloned skill's .git, leaving the history", async () => {
    const clone = path.join(skillsDir, 'hist-skill')
    await makeClone(clone)
    await track('thegit', path.join(clone, '.git'))

    const result = await createService().uninstall('thegit', { force: true })

    expect(result.success).toBe(false)
    expect(await fs.readFile(path.join(clone, '.git', 'HEAD'), 'utf-8')).toContain('main')
  })

  // A caller-supplied NAME, not a manifest value. `path.join` normalizes it
  // while `manifestKeyFor` keys on the raw string, so a mis-spelling reaches a
  // tracked skill's directory without finding its entry -- which skipped the
  // force gate entirely.
  for (const spelling of [
    './other-skill',
    'other-skill/.',
    'x/../other-skill',
    '..',
    '.',
    'a\\b',
  ]) {
    it(`refuses the skill name ${JSON.stringify(spelling)} and writes nothing`, async () => {
      const real = path.join(skillsDir, 'other-skill')
      await fs.mkdir(real, { recursive: true })
      await fs.writeFile(path.join(real, 'SKILL.md'), '# Other\n')
      // Tracked, and edited after install, so the honest spelling is refused
      // without force. The mis-spelling must not get further than that.
      await track('other-skill', real)
      await fs.writeFile(path.join(real, 'SKILL.md'), '# Edited\n')

      const result = await createService().uninstall(spelling)

      expect(result.success).toBe(false)
      // Assert the NAME RULE's own message. A bare `success: false` passes
      // without the rule: `a\\b` is simply "not installed" on POSIX, and the
      // path spellings are refused by the modification gate. Measured -- the
      // backslash clause survived mutation until this assertion existed. That is
      // the same wrong-reason failure as the traversal and parent-escape cases
      // above; on a path with several refusers, only the message identifies which
      // one fired.
      expect(result.message).toContain('single directory name')
      expect(await fs.readFile(path.join(real, 'SKILL.md'), 'utf-8')).toBe('# Edited\n')
      // M1: a refusal must write nothing. Round 1's guard ran after adoption,
      // so a refused uninstall left a bogus manifest entry behind.
      expect(await manifestEntry(spelling)).toBeUndefined()
    })
  }

  it('refuses an installPath that resolves to the skills directory PARENT', async () => {
    // Found by chasing a surviving mutant, not by imagination. Without the
    // `path.resolve` before dirname/basename, `<skillsDir>/./..` yields parent
    // `<skillsDir>/.` -- which realpaths to the root and PASSES the parent
    // rule -- with base `..`, so `removeIfSame` would be handed the skills
    // directory's own parent. Resolving first refuses it.
    const bystander = path.join(skillsDir, 'survivor')
    await fs.mkdir(bystander, { recursive: true })
    await fs.writeFile(path.join(bystander, 'SKILL.md'), '# Survivor\n')
    await track('parentesc', `${skillsDir}/./..`)

    const result = await createService().uninstall('parentesc', { force: true })

    expect(result.success).toBe(false)
    // Assert the GUARD's own wording, not merely `success: false` -- several
    // things downstream also refuse this path, so a bare outcome assertion pins
    // nothing. Round 3 moved WHICH clause catches it: `<skillsDir>/./..` is
    // non-canonical, so the canonical-form rule now refuses it earlier and more
    // precisely than the parent rule did.
    expect(result.message).toContain('not in canonical form')
    expect(await fs.readFile(path.join(bystander, 'SKILL.md'), 'utf-8')).toBe('# Survivor\n')
    await expect(fs.lstat(skillsDir)).resolves.toBeDefined()
  })

  it('refuses a directory whose name merely starts with the skills dir name', async () => {
    // Prefix collision. `startsWith(root)` without the separator would accept
    // this; `startsWith(root + sep)` does not. The code was already correct --
    // nothing tested it, so a mutation to the looser form survived.
    const sibling = `${skillsDir}-evil`
    await fs.mkdir(sibling, { recursive: true })
    await fs.writeFile(path.join(sibling, 'keep.txt'), 'keep\n')
    await track('prefix', path.join(sibling, 'foo'))

    const result = await createService().uninstall('prefix', { force: true })

    expect(result.success).toBe(false)
    expect(await fs.readFile(path.join(sibling, 'keep.txt'), 'utf-8')).toBe('keep\n')
  })

  it('refuses an empty installPath with a message that says so', async () => {
    const manifest = {
      version: '1.0.0',
      installedSkills: {
        blank: { id: 'a/blank', name: 'blank', version: '1.0.0', source: 'x', installPath: '' },
      },
    }
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))

    const result = await createService().uninstall('blank', { force: true })

    expect(result.success).toBe(false)
    // Not "got string", which is true and useless; and it must name a tool that
    // exists -- `skillsmith doctor` does not.
    expect(result.message).toContain('an empty string')
    expect(result.message).toContain('apply_manifest_reconcile')
  })

  it('still uninstalls when the skills directory is reached through a symlink', async () => {
    // Positive control for resolving the ROOT through realpath: without it the
    // root and the parent are compared on different methodologies and a
    // legitimate uninstall is refused.
    const realRoot = path.join(tmpDir, 'real-skills')
    await fs.mkdir(path.join(realRoot, 'linked-root-skill'), { recursive: true })
    await fs.writeFile(path.join(realRoot, 'linked-root-skill', 'SKILL.md'), '# S\n')
    const aliasRoot = path.join(tmpDir, 'alias-skills')
    await fs.symlink(realRoot, aliasRoot)

    const svc = new SkillInstallationService({
      db,
      skillRepo: new SkillRepository(db),
      skillDependencyRepo: new SkillDependencyRepository(db),
      skillsDir: aliasRoot,
      manifestPath,
    })
    await track('linked-root-skill', path.join(aliasRoot, 'linked-root-skill'))

    const result = await svc.uninstall('linked-root-skill', { force: true })

    expect(result.success).toBe(true)
    await expect(fs.lstat(path.join(realRoot, 'linked-root-skill'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('uninstall requires a canonical installPath (SMI-6732 round 3, pre-merge gate)', () => {
  // The guard used to VALIDATE `path.resolve(installPath)` while `performUninstall`
  // went on to DELETE the raw string. `path.resolve` is lexical -- it collapses
  // `seg/..` before resolving a symlink in `seg`, and strips trailing slashes.
  // The kernel does neither. Two deterministic escapes followed, both measured
  // on macOS with force:true and both reporting "uninstalled successfully".
  //
  // These are the mutations the author did not pick: round 2 tested a symlink as
  // the immediate PARENT and never a symlink followed by `..`, nor a trailing
  // slash on one.

  it('refuses `..` after a symlinked segment, which escapes lexical resolution', async () => {
    const elsewhere = path.join(tmpDir, 'elsewhere')
    await fs.mkdir(elsewhere, { recursive: true })
    const victim = path.join(tmpDir, 'victim')
    await fs.mkdir(victim, { recursive: true })
    await fs.writeFile(path.join(victim, 'data.txt'), 'USER DATA\n')
    await fs.symlink(elsewhere, path.join(skillsDir, 'hop'))
    // path.resolve collapses `hop/..` to skillsDir BEFORE the symlink is
    // followed, so the old guard validated `<skillsDir>/victim` while the kernel
    // deleted `<tmpDir>/victim`.
    await track('escape', `${skillsDir}/hop/../victim`)

    const result = await createService().uninstall('escape', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('not in canonical form')
    expect(await fs.readFile(path.join(victim, 'data.txt'), 'utf-8')).toBe('USER DATA\n')
  })

  it('refuses a trailing slash on a symlinked skill, which would delete the target', async () => {
    // This is the case that falsified the previous design claim. With a trailing
    // slash, `lstat(...).isSymbolicLink()` is FALSE on macOS -- the slash follows
    // the link -- so removal took the checkout, not the link.
    //
    // F4: the DATA assertion below cannot fail on Linux, where `rename("link/")`
    // returns ENOTDIR and the checkout survives even against the unfixed guard.
    // CI is Linux-only, so the `'not in canonical form'` assertion is the only
    // thing pinning this bypass there. Do not weaken it to a bare
    // `success: false`.
    const checkout = path.join(tmpDir, 'devcheckout')
    await fs.mkdir(checkout, { recursive: true })
    await fs.writeFile(path.join(checkout, 'SKILL.md'), '# Local work\n')
    await fs.symlink(checkout, path.join(skillsDir, 'slashlink'))
    await track('slashed', `${skillsDir}/slashlink/`)

    const result = await createService().uninstall('slashed', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('not in canonical form')
    expect(await fs.readFile(path.join(checkout, 'SKILL.md'), 'utf-8')).toBe('# Local work\n')
  })

  it('refuses a doubled separator, the same normalization gap', async () => {
    // F3: this case used to place its victim at `<tmpDir>/dbl` and assert the
    // victim survived. `<skillsDir>//dbl` cannot address `<tmpDir>/dbl` under
    // ANY resolution, so that assertion could never fail and the case pinned
    // nothing. It pins the RULE, not an escape -- so the victim is inside the
    // skills dir and the assertion is on the guard's own wording.
    const inside = path.join(skillsDir, 'dbl')
    await fs.mkdir(inside, { recursive: true })
    await fs.writeFile(path.join(inside, 'SKILL.md'), '# Dbl\n')
    await track('doubled', `${skillsDir}//dbl`)

    const result = await createService().uninstall('doubled', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('not in canonical form')
    expect(await fs.readFile(path.join(inside, 'SKILL.md'), 'utf-8')).toBe('# Dbl\n')
  })

  // POSITIVE CONTROL, and the one that matters most: requiring canonical form
  // must not break the develop-in-place workflow the parent-check exists for.
  it('still uninstalls a symlinked skill spelled canonically, target intact', async () => {
    const checkout = path.join(tmpDir, 'dev2', 'canon-skill')
    await fs.mkdir(checkout, { recursive: true })
    await fs.writeFile(path.join(checkout, 'SKILL.md'), '# Keep me\n')
    const link = path.join(skillsDir, 'canon-skill')
    await fs.symlink(checkout, link)
    await track('canon-skill', link)

    const result = await createService().uninstall('canon-skill', { force: true })

    expect(result.success).toBe(true)
    await expect(fs.lstat(link)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(checkout, 'SKILL.md'), 'utf-8')).toBe('# Keep me\n')
  })
})

describe('uninstall refuses dot-prefixed names (SMI-6732 round 4, pre-merge gate F1)', () => {
  it("refuses uninstall('.git') and leaves the skills directory's history", async () => {
    // Measured before the fix, with force NOT set: success:true,
    // "uninstalled successfully", and the skills directory's entire git history
    // deleted. This file already refuses a target that HAS `.git` at its root
    // (ADR-155) and accepted a target that IS `.git` -- the same principle, one
    // level off. Reachable from MCP `uninstall_skill` (`z.string().min(1)`).
    await fs.mkdir(path.join(skillsDir, '.git'), { recursive: true })
    await fs.writeFile(path.join(skillsDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')

    const result = await createService().uninstall('.git')

    expect(result.success).toBe(false)
    expect(result.message).toContain('dot-prefixed')
    expect(await fs.readFile(path.join(skillsDir, '.git', 'HEAD'), 'utf-8')).toContain('main')
  })

  it('refuses a dot-prefixed name even with force, and even when tracked', async () => {
    const parked = path.join(skillsDir, '.hidden-thing')
    await fs.mkdir(parked, { recursive: true })
    await fs.writeFile(path.join(parked, 'data.txt'), 'keep\n')
    await track('.hidden-thing', parked)

    const result = await createService().uninstall('.hidden-thing', { force: true })

    expect(result.success).toBe(false)
    expect(await fs.readFile(path.join(parked, 'data.txt'), 'utf-8')).toBe('keep\n')
  })

  // POSITIVE CONTROL: a name merely CONTAINING a dot is a normal skill.
  it('still uninstalls a skill whose name contains a dot', async () => {
    const dotted = path.join(skillsDir, 'my.skill.v2')
    await fs.mkdir(dotted, { recursive: true })
    await fs.writeFile(path.join(dotted, 'SKILL.md'), '# Dotted\n')
    await track('my.skill.v2', dotted)

    const result = await createService().uninstall('my.skill.v2', { force: true })

    expect(result.success).toBe(true)
    await expect(fs.lstat(dotted)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('uninstall reads installPath exactly once (SMI-6732 round 5, F1)', () => {
  // `skillEntry.installPath` used to be read TWICE -- once by the guard, once
  // by the delete -- so a getter that answers differently on each read let
  // the guard validate one path while the delete acted on another. Neither
  // shipped caller can produce this (both parse plain manifest JSON), so this
  // spies `ManifestManager.prototype.load` to hand `performUninstall` an
  // entry whose `installPath` really is a getter -- the only way to observe
  // HOW MANY TIMES the property is read, not merely what value it eventually
  // holds.

  it('does not let a benign-then-hostile getter delete outside the skills directory', async () => {
    const good = path.join(skillsDir, 'getter-good-1')
    await fs.mkdir(good, { recursive: true })
    await fs.writeFile(path.join(good, 'SKILL.md'), '# Good\n')
    const victim = path.join(tmpDir, 'getter-victim-1')
    await fs.mkdir(victim, { recursive: true })
    await fs.writeFile(path.join(victim, 'important.txt'), 'victim data\n')

    let reads = 0
    const trackedEntry = {
      id: 'author/getter-skill-1',
      name: 'getter-skill-1',
      version: '1.0.0',
      source: 'github:author/getter-skill-1',
      installedAt: new Date(Date.now() + 60_000).toISOString(),
      lastUpdated: new Date(Date.now() + 60_000).toISOString(),
      get installPath() {
        reads += 1
        // Read 1 -- the fixed code's ONE hoisted read -- answers benignly;
        // any further read, which only a regression would trigger, answers
        // with a path outside the skills directory entirely.
        return reads === 1 ? good : victim
      },
    }
    manifestLoadSpy = vi.spyOn(ManifestManager.prototype, 'load').mockResolvedValue({
      version: '1.0.0',
      installedSkills: { 'getter-skill-1': trackedEntry },
    })

    const result = await createService().uninstall('getter-skill-1', { force: true })

    expect(result.success).toBe(true)
    expect(result.removedPath).toBe(good)
    // The in-tree target is what was acted on...
    await expect(fs.lstat(good)).rejects.toMatchObject({ code: 'ENOENT' })
    // ...and the out-of-tree victim a second read would have named survives.
    expect(await fs.readFile(path.join(victim, 'important.txt'), 'utf-8')).toBe('victim data\n')
  })

  it('does not let a benign-then-root getter delete every installed skill', async () => {
    const good = path.join(skillsDir, 'getter-good-2')
    await fs.mkdir(good, { recursive: true })
    await fs.writeFile(path.join(good, 'SKILL.md'), '# Good\n')
    const bystander = path.join(skillsDir, 'getter-bystander-2')
    await fs.mkdir(bystander, { recursive: true })
    await fs.writeFile(path.join(bystander, 'SKILL.md'), '# Bystander\n')

    let reads = 0
    const trackedEntry = {
      id: 'author/getter-skill-2',
      name: 'getter-skill-2',
      version: '1.0.0',
      source: 'github:author/getter-skill-2',
      installedAt: new Date(Date.now() + 60_000).toISOString(),
      lastUpdated: new Date(Date.now() + 60_000).toISOString(),
      get installPath() {
        reads += 1
        // Read 1 answers benignly; any further read answers with the skills
        // root itself -- the shape that deleted every installed skill.
        return reads === 1 ? good : skillsDir
      },
    }
    manifestLoadSpy = vi.spyOn(ManifestManager.prototype, 'load').mockResolvedValue({
      version: '1.0.0',
      installedSkills: { 'getter-skill-2': trackedEntry },
    })

    const result = await createService().uninstall('getter-skill-2', { force: true })

    expect(result.success).toBe(true)
    expect(result.removedPath).toBe(good)
    await expect(fs.lstat(good)).rejects.toMatchObject({ code: 'ENOENT' })
    // The bystander, and the skills directory itself, survive.
    expect(await fs.readFile(path.join(bystander, 'SKILL.md'), 'utf-8')).toBe('# Bystander\n')
    await expect(fs.lstat(skillsDir)).resolves.toBeDefined()
  })
})

describe('uninstall refuses a second spelling of a tracked skill (SMI-6732 round 5, F2)', () => {
  // CI is Linux-only, and ext4 already fails `fs.access` with ENOENT for an
  // NFD or wrong-case alias -- a naive test would never reach
  // `checkExactEntryName` there at all. `accessSucceedFor` forces `fs.access`
  // of the alias to succeed, standing in for what APFS/HFS+ does natively, so
  // the refusal below is produced by `checkExactEntryName`'s own (real,
  // unmocked) `readdir` comparison on every platform CI runs.

  it('refuses the NFD spelling of an NFC-tracked, modified skill', async () => {
    const nfc = 'café-skill' // e + U+00E9 (precomposed)
    const nfd = nfc.normalize('NFD') // e + U+0065 U+0301 (decomposed)
    expect(nfd).not.toBe(nfc)

    const real = path.join(skillsDir, nfc)
    await fs.mkdir(real, { recursive: true })
    await fs.writeFile(path.join(real, 'SKILL.md'), '# Original\n')
    await track(nfc, real)
    // Modified after install, so the HONEST spelling would also be refused --
    // proving the assertion below is the exact-name rule, not a side effect
    // of the modification gate. `track()` sets `installedAt` 60s into the
    // future (so a routine rewrite right after tracking does NOT register as
    // a modification -- that is the whole point of that offset for every
    // OTHER test in this file); genuinely tripping the modification gate
    // needs the file's mtime pushed past that.
    await fs.writeFile(path.join(real, 'SKILL.md'), '# Edited\n')
    await fs.utimes(path.join(real, 'SKILL.md'), farFuture(), farFuture())
    accessSucceedFor.path = path.join(skillsDir, nfd)

    const result = await createService().uninstall(nfd)

    expect(result.success).toBe(false)
    expect(result.message).toContain('no entry in')
    expect(result.message).toContain('is spelled exactly')
    expect(await fs.readFile(path.join(real, 'SKILL.md'), 'utf-8')).toBe('# Edited\n')
    expect(await manifestEntry(nfc)).toMatchObject({ installPath: real })
    // F-C (round 6): a refusal must write NOTHING -- including under the
    // ALIAS key. The original assertion above pins only that the tracked
    // key survives; a mutant that adopts under the alias and still returns
    // this refusal would survive every test in this file without this line.
    expect(await manifestEntry(nfd)).toBeUndefined()
  })

  it('refuses the wrong-case spelling of a tracked, modified skill', async () => {
    const real = path.join(skillsDir, 'myskill')
    await fs.mkdir(real, { recursive: true })
    await fs.writeFile(path.join(real, 'SKILL.md'), '# Original\n')
    await track('myskill', real)
    await fs.writeFile(path.join(real, 'SKILL.md'), '# Edited\n')
    await fs.utimes(path.join(real, 'SKILL.md'), farFuture(), farFuture())
    accessSucceedFor.path = path.join(skillsDir, 'MySkill')

    const result = await createService().uninstall('MySkill')

    expect(result.success).toBe(false)
    expect(result.message).toContain('no entry in')
    expect(result.message).toContain('is spelled exactly')
    expect(await fs.readFile(path.join(real, 'SKILL.md'), 'utf-8')).toBe('# Edited\n')
    expect(await manifestEntry('myskill')).toMatchObject({ installPath: real })
    // F-C (round 6): same gap, same fix -- see the NFD test above.
    expect(await manifestEntry('MySkill')).toBeUndefined()
  })

  // POSITIVE CONTROLS. Without these, `checkExactEntryName` could pass by
  // refusing every adoption, which the two mis-spelling tests above would not
  // catch on their own.

  it('still gates the HONEST spelling on modification (F2 positive control)', async () => {
    const real = path.join(skillsDir, 'honest-mod-skill')
    await fs.mkdir(real, { recursive: true })
    await fs.writeFile(path.join(real, 'SKILL.md'), '# Original\n')
    await track('honest-mod-skill', real)
    await fs.writeFile(path.join(real, 'SKILL.md'), '# Edited\n')
    await fs.utimes(path.join(real, 'SKILL.md'), farFuture(), farFuture())

    const result = await createService().uninstall('honest-mod-skill')

    expect(result.success).toBe(false)
    expect(result.message).toContain('has been modified since installation')
    expect(await fs.readFile(path.join(real, 'SKILL.md'), 'utf-8')).toBe('# Edited\n')
  })

  it('still uninstalls the HONEST spelling when unmodified (F2 positive control)', async () => {
    const real = path.join(skillsDir, 'honest-clean-skill')
    await fs.mkdir(real, { recursive: true })
    await fs.writeFile(path.join(real, 'SKILL.md'), '# Original\n')
    await track('honest-clean-skill', real)

    const result = await createService().uninstall('honest-clean-skill')

    expect(result.success).toBe(true)
    await expect(fs.lstat(real)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('still adopts and uninstalls an untracked ASCII skill (F2 positive control)', async () => {
    const real = path.join(skillsDir, 'untracked-ascii-skill')
    await fs.mkdir(real, { recursive: true })
    await fs.writeFile(path.join(real, 'SKILL.md'), '# Untracked\n')

    const result = await createService().uninstall('untracked-ascii-skill', { force: true })

    expect(result.success).toBe(true)
    await expect(fs.lstat(real)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('still adopts and uninstalls an untracked SYMLINKED skill, target intact (F2 positive control)', async () => {
    const checkout = path.join(tmpDir, 'dev-f2', 'untracked-symlink-skill')
    await fs.mkdir(checkout, { recursive: true })
    await fs.writeFile(path.join(checkout, 'SKILL.md'), '# Local work\n')
    const link = path.join(skillsDir, 'untracked-symlink-skill')
    await fs.symlink(checkout, link)

    const result = await createService().uninstall('untracked-symlink-skill', { force: true })

    expect(result.success).toBe(true)
    await expect(fs.lstat(link)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(checkout, 'SKILL.md'), 'utf-8')).toBe('# Local work\n')
  })
})

describe("checkExactEntryName's own failure modes (SMI-6732, rounds 25/26 convention)", () => {
  // Untracked in every case, so the adoption path is what reaches
  // `checkExactEntryName`: `fs.access` succeeds for real (the directory
  // really is there under its own name), and only the LISTING fails.

  it('says "not installed" when the listing itself is absent (ENOENT)', async () => {
    const untracked = path.join(skillsDir, 'enoent-listing-skill')
    await fs.mkdir(untracked, { recursive: true })
    await fs.writeFile(path.join(untracked, 'SKILL.md'), '# Untracked\n')
    readdirFailFor.path = skillsDir
    readdirFailFor.throws = {
      value: Object.assign(new Error("ENOENT: no such file or directory, scandir '...'"), {
        code: 'ENOENT',
      }),
    }

    const result = await createService().uninstall('enoent-listing-skill', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toBe('Skill "enoent-listing-skill" is not installed.')
    expect(await fs.readFile(path.join(untracked, 'SKILL.md'), 'utf-8')).toBe('# Untracked\n')
    expect(await manifestEntry('enoent-listing-skill')).toBeUndefined()
  })

  it('says it could not tell when the listing fails with EACCES', async () => {
    const untracked = path.join(skillsDir, 'eacces-listing-skill')
    await fs.mkdir(untracked, { recursive: true })
    await fs.writeFile(path.join(untracked, 'SKILL.md'), '# Untracked\n')
    readdirFailFor.path = skillsDir

    const result = await createService().uninstall('eacces-listing-skill', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('Could not tell whether')
    expect(result.message).toContain('could not be listed (EACCES)')
    expect(await fs.readFile(path.join(untracked, 'SKILL.md'), 'utf-8')).toBe('# Untracked\n')
    expect(await manifestEntry('eacces-listing-skill')).toBeUndefined()
  })

  it('says it could not tell when the listing fails with an error carrying no code', async () => {
    const untracked = path.join(skillsDir, 'uncoded-listing-skill')
    await fs.mkdir(untracked, { recursive: true })
    await fs.writeFile(path.join(untracked, 'SKILL.md'), '# Untracked\n')
    readdirFailFor.path = skillsDir
    readdirFailFor.throws = { value: new Error('filesystem went away') }

    const result = await createService().uninstall('uncoded-listing-skill', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('Could not tell whether')
    expect(result.message).toContain('could not be listed (filesystem went away)')
    expect(await fs.readFile(path.join(untracked, 'SKILL.md'), 'utf-8')).toBe('# Untracked\n')
    expect(await manifestEntry('uncoded-listing-skill')).toBeUndefined()
  })

  it('survives a thrown value that is not an Error at all', async () => {
    const untracked = path.join(skillsDir, 'nonerror-listing-skill')
    await fs.mkdir(untracked, { recursive: true })
    await fs.writeFile(path.join(untracked, 'SKILL.md'), '# Untracked\n')
    readdirFailFor.path = skillsDir
    readdirFailFor.throws = { value: null }

    const result = await createService().uninstall('nonerror-listing-skill', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('Could not tell whether')
    expect(await fs.readFile(path.join(untracked, 'SKILL.md'), 'utf-8')).toBe('# Untracked\n')
    expect(await manifestEntry('nonerror-listing-skill')).toBeUndefined()
  })
})

describe('uninstall refuses an unpaired surrogate (SMI-6732 round 5, F3)', () => {
  it("refuses uninstall('\\uD800') by the name rule", async () => {
    const result = await createService().uninstall('\uD800')

    expect(result.success).toBe(false)
    expect(result.message).toContain('unpaired surrogate')
    expect(await manifestEntry('\uD800')).toBeUndefined()
  })

  it("refuses a manifest installPath containing a lone surrogate, in checkRemovalTarget's own wording", async () => {
    const surrogatePath = path.join(skillsDir, '\uD800')
    await track('surrogate-path-skill', surrogatePath)

    const result = await createService().uninstall('surrogate-path-skill', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('unpaired surrogate')
    expect(result.message).toContain('the path checked and the path removed')
    expect(await manifestEntry('surrogate-path-skill')).toBeDefined()
  })
})

describe('uninstall refuses a directory already tracked under another name (SMI-6732 round 6, F-A)', () => {
  // Round 6 (pre-merge gate, F-A): `checkExactEntryName` anchors on the DISK
  // spelling, so it is satisfied whenever the caller types what the
  // filesystem stores. It says nothing about the MANIFEST holding the
  // alias instead. Measured on APFS, force NOT set: disk `myskill`
  // (modified now) / manifest key `MySkill` (installedAt 2020) --
  // uninstall("MySkill") refused, "modified since installation", dir
  // survives; uninstall("myskill") "uninstalled successfully", DIR DELETED,
  // edits gone. Identical outcome for disk NFD `café` / manifest key NFC
  // `café`.
  //
  // CI is Linux-only, where two on-disk directories never share a dev/ino,
  // so the alias is forced via `lstatAliasFor` exactly as
  // `accessSucceedFor` forces the F2 alias tests above -- the refusal
  // itself is still produced by `checkNotTrackedElsewhere`'s own (real,
  // unmocked) dev/ino comparison.

  it('refuses the disk spelling when the manifest holds a different case', async () => {
    const real = path.join(skillsDir, 'myskill')
    await fs.mkdir(real, { recursive: true })
    await fs.writeFile(path.join(real, 'SKILL.md'), '# Original\n')
    const trackedPath = path.join(skillsDir, 'MySkill')
    await track('MySkill', trackedPath)
    lstatAliasFor.aliasPath = trackedPath
    lstatAliasFor.targetPath = real

    const result = await createService().uninstall('myskill')

    expect(result.success).toBe(false)
    expect(result.message).toContain('already tracked under the name "MySkill"')
    await expect(fs.lstat(real)).resolves.toBeDefined()
    expect(await fs.readFile(path.join(real, 'SKILL.md'), 'utf-8')).toBe('# Original\n')
    expect(await manifestEntry('MySkill')).toMatchObject({ installPath: trackedPath })
    // F-C: nothing is written under the alias key either.
    expect(await manifestEntry('myskill')).toBeUndefined()
  })

  it('refuses the disk NFD spelling when the manifest holds the NFC spelling', async () => {
    const nfc = 'café-tracked-skill' // e + U+00E9 (precomposed)
    const nfd = nfc.normalize('NFD') // e + U+0065 U+0301 (decomposed)
    expect(nfd).not.toBe(nfc)
    const real = path.join(skillsDir, nfd)
    await fs.mkdir(real, { recursive: true })
    await fs.writeFile(path.join(real, 'SKILL.md'), '# Original\n')
    const trackedPath = path.join(skillsDir, nfc)
    await track(nfc, trackedPath)
    lstatAliasFor.aliasPath = trackedPath
    lstatAliasFor.targetPath = real

    const result = await createService().uninstall(nfd)

    expect(result.success).toBe(false)
    expect(result.message).toContain(`already tracked under the name "${nfc}"`)
    await expect(fs.lstat(real)).resolves.toBeDefined()
    expect(await fs.readFile(path.join(real, 'SKILL.md'), 'utf-8')).toBe('# Original\n')
    expect(await manifestEntry(nfc)).toMatchObject({ installPath: trackedPath })
    expect(await manifestEntry(nfd)).toBeUndefined()
  })
})

describe('checkNotTrackedElsewhere does not refuse everything (SMI-6732 round 6, F-A positive controls)', () => {
  // Without these, the guard could pass every F-A test above by refusing
  // every removal -- the failure mode a red test alone does not catch.

  it('still adopts and uninstalls an untracked skill when an unrelated tracked skill exists', async () => {
    const other = path.join(skillsDir, 'other-tracked-skill')
    await fs.mkdir(other, { recursive: true })
    await fs.writeFile(path.join(other, 'SKILL.md'), '# Other\n')
    await track('other-tracked-skill', other)
    const untracked = path.join(skillsDir, 'brand-new-skill')
    await fs.mkdir(untracked, { recursive: true })
    await fs.writeFile(path.join(untracked, 'SKILL.md'), '# New\n')

    const result = await createService().uninstall('brand-new-skill', { force: true })

    expect(result.success).toBe(true)
    await expect(fs.lstat(untracked)).rejects.toMatchObject({ code: 'ENOENT' })
    // The unrelated tracked skill, at its own distinct inode, is untouched.
    expect(await fs.readFile(path.join(other, 'SKILL.md'), 'utf-8')).toBe('# Other\n')
    expect(await manifestEntry('other-tracked-skill')).toBeDefined()
  })

  it('does not let a tracked entry whose installPath no longer resolves block an unrelated adoption', async () => {
    const staleTrackedPath = path.join(skillsDir, 'ghost-skill')
    // Never created on disk, so `lstat(staleTrackedPath)` throws ENOENT for
    // real -- exercising the deliberate "skip records we cannot lstat"
    // branch, not a mock.
    await track('ghost-entry', staleTrackedPath)
    const untracked = path.join(skillsDir, 'fresh-skill')
    await fs.mkdir(untracked, { recursive: true })
    await fs.writeFile(path.join(untracked, 'SKILL.md'), '# Fresh\n')

    const result = await createService().uninstall('fresh-skill', { force: true })

    expect(result.success).toBe(true)
    await expect(fs.lstat(untracked)).rejects.toMatchObject({ code: 'ENOENT' })
    // The stale record itself was never touched by this uninstall.
    expect(await manifestEntry('ghost-entry')).toBeDefined()
  })

  it('leaves two distinct symlinks to one target independently removable', async () => {
    // `lstat` compares the LINKS, not the target they resolve to --
    // realpathing would defeat the develop-in-place workflow the existing
    // symlink tests elsewhere in this file pin. Two links to the same
    // target must stay two distinct, independently-removable entries.
    const checkout = path.join(tmpDir, 'dev-shared', 'shared-checkout')
    await fs.mkdir(checkout, { recursive: true })
    await fs.writeFile(path.join(checkout, 'SKILL.md'), '# Shared checkout\n')
    const linkA = path.join(skillsDir, 'link-a')
    const linkB = path.join(skillsDir, 'link-b')
    await fs.symlink(checkout, linkA)
    await fs.symlink(checkout, linkB)
    await track('link-a', linkA)

    const result = await createService().uninstall('link-b', { force: true })

    expect(result.success).toBe(true)
    await expect(fs.lstat(linkB)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(linkA)).resolves.toBeDefined()
    expect(await fs.readFile(path.join(checkout, 'SKILL.md'), 'utf-8')).toBe('# Shared checkout\n')
    expect(await manifestEntry('link-a')).toBeDefined()
  })

  // The outer `manifestData.installedSkills[manifestKey]` lookup at the
  // uninstall() call site throws BEFORE `checkNotTrackedElsewhere` is ever
  // reached when `installedSkills` is undefined or null -- only a STRING
  // value reaches the guard through `uninstall()` itself (indexing a string
  // by a non-numeric key resolves to `undefined` rather than throwing). So
  // the undefined/null shapes are exercised directly against the exported
  // guard; `potentialPath` is a real directory in both, so execution
  // reaches the guard's own `Object.entries(installedSkills)` line rather
  // than short-circuiting earlier through the (also real) ENOENT branch.

  it('does not throw when installedSkills is undefined', async () => {
    const real = path.join(skillsDir, 'exists-for-undefined-test')
    await fs.mkdir(real, { recursive: true })

    const r = await checkNotTrackedElsewhere(real, 'whatever', undefined)
    // round 7: the guard now also returns the identity it established, so the
    // caller can prove the directory did not change under it. Assert the
    // DECISION, not the whole shape -- a deep-equal here would break on any
    // future field and says nothing about the clause under test.
    expect(r.ok).toBe(true)
    // Round 8 (C2): a scalar `installedSkills` must still establish a REAL
    // identity, not just say "ok" with `identity: null` -- a `null` identity
    // silently disables `identityChanged`'s later swap check end to end (see
    // the C2 headline test below). Compare against a FRESH lstat of the same
    // directory rather than a deep-equal, which would break on any future
    // field and says nothing about the clause under test.
    if (!r.ok) throw new Error('unreachable: already asserted r.ok above')
    expect(r.identity).not.toBeNull()
    const fresh = await fs.lstat(real, { bigint: true })
    expect(r.identity?.ino).toBe(fresh.ino)
    expect(r.identity?.dev).toBe(fresh.dev)
  })

  it('does not throw when installedSkills is null', async () => {
    const real = path.join(skillsDir, 'exists-for-null-test')
    await fs.mkdir(real, { recursive: true })

    const r = await checkNotTrackedElsewhere(real, 'whatever', null)
    // round 7: the guard now also returns the identity it established, so the
    // caller can prove the directory did not change under it. Assert the
    // DECISION, not the whole shape -- a deep-equal here would break on any
    // future field and says nothing about the clause under test.
    expect(r.ok).toBe(true)
    // Round 8 (C2): same as the `undefined` case above -- identity must be
    // established, not skipped.
    if (!r.ok) throw new Error('unreachable: already asserted r.ok above')
    expect(r.identity).not.toBeNull()
    const fresh = await fs.lstat(real, { bigint: true })
    expect(r.identity?.ino).toBe(fresh.ino)
    expect(r.identity?.dev).toBe(fresh.dev)
  })

  it('does not throw end to end when installedSkills is a string', async () => {
    const manifest = { version: '1.0.0', installedSkills: 'not-an-object' }
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    const real = path.join(skillsDir, 'stringy-skill')
    await fs.mkdir(real, { recursive: true })
    await fs.writeFile(path.join(real, 'SKILL.md'), '# Stringy\n')

    // Round 8 (C2): assert the identity the guard itself establishes for
    // this shape, directly, before the end-to-end call below -- read-only,
    // so it cannot perturb the uninstall that follows.
    const direct = await checkNotTrackedElsewhere(real, 'stringy-skill', 'not-an-object')
    if (!direct.ok) throw new Error(`expected ok, got refusal: ${direct.message}`)
    expect(direct.identity).not.toBeNull()
    const fresh = await fs.lstat(real, { bigint: true })
    expect(direct.identity?.ino).toBe(fresh.ino)

    const result = await createService().uninstall('stringy-skill', { force: true })

    expect(result.success).toBe(true)
    await expect(fs.lstat(real)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not let a null tracked-entry value block an unrelated adoption', async () => {
    const manifest = { version: '1.0.0', installedSkills: { 'null-entry': null } }
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    const untracked = path.join(skillsDir, 'clean-skill')
    await fs.mkdir(untracked, { recursive: true })
    await fs.writeFile(path.join(untracked, 'SKILL.md'), '# Clean\n')

    const result = await createService().uninstall('clean-skill', { force: true })

    expect(result.success).toBe(true)
    await expect(fs.lstat(untracked)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not treat a same-ino, different-device pair as the same directory', async () => {
    const real = path.join(skillsDir, 'device-target')
    await fs.mkdir(real, { recursive: true })
    await fs.writeFile(path.join(real, 'SKILL.md'), '# Real\n')
    const trackedPath = path.join(skillsDir, 'device-tracked')
    await track('device-tracked', trackedPath)
    // Same underlying inode as `real` (via the alias), but a fabricated,
    // never-real device number reported on the TRACKED side only.
    lstatAliasFor.aliasPath = trackedPath
    lstatAliasFor.targetPath = real
    lstatFakeDeviceFor.path = trackedPath

    const result = await createService().uninstall('device-target', { force: true })

    expect(result.success).toBe(true)
  })
})

describe('the identity guard scans every record and fails closed (SMI-6732 round 7)', () => {
  // F3: the guard's central property. A one-entry manifest cannot distinguish
  // "scans all records" from "checks the first one", so two data-loss mutants
  // survived the whole suite. The alias record is placed LAST, behind a stale
  // record and a live non-matching one, so both mutants must fail.
  it('finds an alias record that sits behind a stale record and a live one', async () => {
    const disk = path.join(skillsDir, 'myskill')
    await fs.mkdir(disk, { recursive: true })
    await fs.writeFile(path.join(disk, 'SKILL.md'), '# myskill')
    const other = path.join(skillsDir, 'other')
    await fs.mkdir(other, { recursive: true })

    await trackMany([
      ['ghost', path.join(skillsDir, 'never-existed')], // stale: lstat ENOENT
      ['other', other], // live, different inode
      ['MySkill', path.join(skillsDir, 'MySkill')], // the alias, LAST
    ])
    lstatAliasFor.aliasPath = path.join(skillsDir, 'MySkill')
    lstatAliasFor.targetPath = disk

    const result = await createService().uninstall('myskill', { force: false })

    expect(result.success).toBe(false)
    expect(result.message).toContain('already tracked under the name "MySkill"')
    expect(await fs.readdir(disk)).toContain('SKILL.md')
    expect(await manifestEntry('myskill')).toBeUndefined()
  })

  // F1: a transient non-ENOENT fault must refuse, not wave the removal through.
  // "inspectForRemoval catches it downstream" held only for a PERSISTENT fault.
  it('refuses when the target cannot be checked, rather than assuming absence', async () => {
    const disk = path.join(skillsDir, 'myskill')
    await fs.mkdir(disk, { recursive: true })
    await fs.writeFile(path.join(disk, 'SKILL.md'), '# myskill')
    await trackMany([['other', path.join(skillsDir, 'other')]])

    lstatFailFor.path = disk
    lstatFailFor.throws = { value: Object.assign(new Error('denied'), { code: 'EACCES' }) }

    const result = await createService().uninstall('myskill', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('could not be checked (EACCES)')
    expect(await fs.readdir(disk)).toContain('SKILL.md')
  })

  it('refuses when a tracked record cannot be checked, rather than skipping it', async () => {
    const disk = path.join(skillsDir, 'myskill')
    await fs.mkdir(disk, { recursive: true })
    await fs.writeFile(path.join(disk, 'SKILL.md'), '# myskill')
    const unreadable = path.join(skillsDir, 'unreadable')
    await trackMany([['unreadable', unreadable]])

    lstatFailFor.path = unreadable
    lstatFailFor.throws = { value: Object.assign(new Error('io'), { code: 'EIO' }) }

    const result = await createService().uninstall('myskill', { force: true })

    expect(result.success).toBe(false)
    // Round 8 (C6): the message used to name only the record's KEY, omitting
    // the path and the errno -- decorative coverage, since a `toContain
    // ('could not be checked')` assertion alone would have passed against
    // wording that dropped both. Assert the recorded path and the errno the
    // message now carries.
    expect(result.message).toContain('could not be checked')
    expect(result.message).toContain(unreadable)
    expect(result.message).toContain('EIO')
    expect(await fs.readdir(disk)).toContain('SKILL.md')
  })

  // F2: the round-6 commit claimed a mid-window swap "yields a refusal because
  // removeIfSame compares identity at delete time". It compares `seen.stat`,
  // read AFTER adoption -- the guard's own reading was compared to nothing.
  it('refuses when the directory is replaced between the guard and the removal', async () => {
    const disk = path.join(skillsDir, 'myskill')
    await fs.mkdir(disk, { recursive: true })
    await fs.writeFile(path.join(disk, 'SKILL.md'), '# myskill')
    const swappedIn = path.join(skillsDir, 'swapped-in')
    await fs.mkdir(swappedIn, { recursive: true })
    await fs.writeFile(path.join(swappedIn, 'SKILL.md'), '# precious')
    await trackMany([['other', path.join(skillsDir, 'other')]])

    // the guard's own lstat is the first; every later one sees a different dir
    lstatFlipFor.path = disk
    lstatFlipFor.targetPath = swappedIn
    lstatFlipFor.after = 1

    const result = await createService().uninstall('myskill', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('replaced by a different directory')
    expect(await fs.readdir(swappedIn)).toContain('SKILL.md')
  })

  // F4: the target side must use lstat, not stat. Under `stat` an untracked
  // symlink resolves into its tracked target's inode and becomes unremovable.
  it('still removes an untracked symlink that points at a tracked skill', async () => {
    const real = path.join(skillsDir, 'real')
    await fs.mkdir(real, { recursive: true })
    await fs.writeFile(path.join(real, 'SKILL.md'), '# real')
    await track('real', real)
    const link = path.join(skillsDir, 'link')
    await fs.symlink(real, link)

    const result = await createService().uninstall('link', { force: true })

    expect(result.success).toBe(true)
    expect(await fs.readdir(real)).toContain('SKILL.md')
    await expect(fs.lstat(link)).rejects.toThrow()
  })
})

describe('uninstall compares identity in bigint, not Number (SMI-6732 round 8, C1)', () => {
  // Node's non-bigint `fs.Stats` reports `st_ino` as a `double`
  // (`static_cast<double>` in `FillStatsArray`), which has already lost
  // precision above 2^53. These two inos are DISTINCT as `bigint`, but
  // IDENTICAL once narrowed to `Number` -- exactly what a `number`-typed
  // comparison would have made of them.
  const inoA = (35n << 48n) | 90356n
  const inoB = (35n << 48n) | 90357n

  it('the precondition this whole describe block probes', () => {
    expect(inoA).not.toBe(inoB)
    expect(Number(inoA)).toBe(Number(inoB))
  })

  it('does not treat two distinct inodes as the same directory merely because Number() collapses them', async () => {
    const tracked = path.join(skillsDir, 'tracked-big-ino')
    await fs.mkdir(tracked, { recursive: true })
    await track('tracked-big-ino', tracked)
    const untracked = path.join(skillsDir, 'untracked-big-ino')
    await fs.mkdir(untracked, { recursive: true })
    await fs.writeFile(path.join(untracked, 'SKILL.md'), '# untracked\n')

    const trackedRealIno = (await fs.lstat(tracked, { bigint: true })).ino
    const untrackedRealIno = (await fs.lstat(untracked, { bigint: true })).ino
    lstatFakeInoFor.entries.set(trackedRealIno, inoA)
    lstatFakeInoFor.entries.set(untrackedRealIno, inoB)

    const result = await createService().uninstall('untracked-big-ino', { force: true })

    // A `number`-typed comparison would have read both as the SAME ino and
    // refused this as "already tracked under the name tracked-big-ino" --
    // wrongly, since these are two distinct real directories.
    // Round 10 (R6): this assertion failed 1 of 4 runs under load with
    // nothing captured -- carry the message so a future flake is diagnosable.
    expect(result.success, result.message).toBe(true)
    await expect(fs.lstat(untracked)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await manifestEntry('tracked-big-ino')).toBeDefined()
  })

  it('identityChanged treats those same two inodes as different', () => {
    const before = { dev: 7n, ino: inoA, birthtimeNs: 500n }
    const after = { dev: 7n, ino: inoB, birthtimeNs: 500n }

    const message = identityChanged(before, after, 'probe-skill')

    expect(message).not.toBeNull()
    expect(message).toContain('replaced by a different directory')
  })
})

describe('removeIfSame still compares number-typed identities exactly as before (SMI-6732 round 8, C1 regression)', () => {
  // The six OTHER callers of `removeIfSame` (fan-out cleanup, fan-out
  // overwrite, install rollback) still pass a plain `fs.Stats`-derived
  // (`number`-typed) identity, never `{bigint: true}`. These pin that they
  // are unaffected by the uninstall path's switch to `bigint`.

  it('still matches a number-typed identity and removes it (positive control)', async () => {
    const dir = await fs.mkdtemp(path.join(tmpDir, 'removeifsame-pos-'))
    const stat = await fs.lstat(dir) // number-typed: no {bigint: true}

    const result = await removeIfSame(dir, { dev: stat.dev, ino: stat.ino })

    expect(result.removed).toBe(true)
    await expect(fs.lstat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('still refuses a number-typed identity that no longer matches (negative control)', async () => {
    const dir = await fs.mkdtemp(path.join(tmpDir, 'removeifsame-neg-'))
    const other = await fs.mkdtemp(path.join(tmpDir, 'removeifsame-other-'))
    const otherStat = await fs.lstat(other) // number-typed

    const result = await removeIfSame(dir, { dev: otherStat.dev, ino: otherStat.ino })

    expect(result.removed).toBe(false)
    if (!result.removed) expect(result.reason).toContain('replaced by something else')
    await expect(fs.lstat(dir)).resolves.toBeDefined()
  })
})

describe('checkNotTrackedElsewhere establishes identity even for a malformed installedSkills value (SMI-6732 round 8, C2)', () => {
  // Before round 8, a scalar `installedSkills` short-circuited with
  // `identity: null` BEFORE `potentialPath` was ever lstat'd -- which made
  // `identityChanged`'s later swap check a permanent no-op (`before ===
  // null` always returns "unchanged"), silently disabling the exact
  // protection round 7's F2 fix added. F2's own coverage never caught this,
  // since every F2 test used a well-formed manifest object.

  it("a scalar installedSkills does not disable the swap check (direct sequence, matching performUninstall's own call order)", async () => {
    const disk = path.join(skillsDir, 'myskill')
    await fs.mkdir(disk, { recursive: true })
    await fs.writeFile(path.join(disk, 'SKILL.md'), '# original\n')

    // Step 1: the guard's own read, with a corrupt (string) installedSkills.
    const guard = await checkNotTrackedElsewhere(disk, 'myskill', 'CORRUPT')
    if (!guard.ok) throw new Error(`expected ok, got refusal: ${guard.message}`)
    const adoptedIdentity = guard.identity

    // Step 2: a REAL concurrent replacement, in the exact window
    // `performUninstall`'s own comments describe -- between adoption and the
    // delete.
    await fs.rename(disk, `${disk}-original`)
    await fs.mkdir(disk, { recursive: true })
    await fs.writeFile(path.join(disk, 'SKILL.md'), '# a different, modified skill\n')

    // Step 3: the second read performUninstall anchors the delete on.
    const seen = await inspectForRemoval(disk)
    if ('refusal' in seen) throw new Error(`expected a stat, got refusal: ${seen.refusal}`)

    const swapped = identityChanged(adoptedIdentity, seen.stat, 'myskill')

    expect(swapped).not.toBeNull()
    expect(swapped).toContain('replaced by a different directory')
  })

  it('end to end: refuses a directory genuinely swapped in mid-window, without force, even with a corrupt string installedSkills', async () => {
    const disk = path.join(skillsDir, 'myskill')
    await fs.mkdir(disk, { recursive: true })
    await fs.writeFile(path.join(disk, 'SKILL.md'), '# original\n')
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ version: '1.0.0', installedSkills: 'CORRUPT' }, null, 2)
    )

    // A REAL swap (rename the original aside, write different content at the
    // same path) the one time `ManifestManager.save` renames its temp file
    // onto `manifestPath` -- i.e. exactly when adoption commits, between the
    // guard's own read and the second `inspectForRemoval` that anchors the
    // delete.
    swapDiskOnManifestWrite.manifestPath = manifestPath
    swapDiskOnManifestWrite.diskPath = disk
    swapDiskOnManifestWrite.victimContent = '# a different, modified skill\n'

    const result = await createService().uninstall('myskill', { force: false })

    expect(result.success).toBe(false)
    expect(result.message).toContain('replaced by a different directory')
    // Neither directory was deleted: the genuinely swapped-in one still at
    // `disk`, and the true original, parked at `${disk}-original` by the
    // swap itself.
    expect(await fs.readFile(path.join(disk, 'SKILL.md'), 'utf-8')).toBe(
      '# a different, modified skill\n'
    )
    expect(await fs.readFile(path.join(`${disk}-original`, 'SKILL.md'), 'utf-8')).toBe(
      '# original\n'
    )
  })
})

describe('checkNotTrackedElsewhere refuses when identity cannot be established (SMI-6732 round 8, C3)', () => {
  it('refuses on a zero ino rather than silently proceeding or naming an unrelated record', async () => {
    const untracked = path.join(skillsDir, 'zero-ino-skill')
    await fs.mkdir(untracked, { recursive: true })
    await fs.writeFile(path.join(untracked, 'SKILL.md'), '# zero ino\n')
    const untrackedRealIno = (await fs.lstat(untracked, { bigint: true })).ino
    lstatFakeInoFor.entries.set(untrackedRealIno, 0n)

    const result = await createService().uninstall('zero-ino-skill', { force: true })

    expect(result.success).toBe(false)
    expect(result.message).toContain('identity could not be established')
    // Not the (wrong) "already tracked" refusal -- there is nothing to
    // compare against, and naming a record here would misattribute the
    // cause.
    expect(result.message).not.toContain('already tracked under the name')
    await expect(fs.lstat(untracked)).resolves.toBeDefined()
  })
})

describe('identityChanged catches an inode reused by a delete-and-recreate (SMI-6732 round 8, C4)', () => {
  it('birthtimeNs discriminates a recreated directory that reuses the same inode (real filesystem, no mock)', async () => {
    const disk = path.join(skillsDir, 'recreated-skill')
    await fs.mkdir(disk, { recursive: true })
    await fs.writeFile(path.join(disk, 'SKILL.md'), '# original\n')

    // The race this identity guard exists to catch, reproduced directly
    // rather than concurrently: something deletes and recreates the SAME
    // name between the guard's read and the removal's own read.
    //
    // Measured directly (standalone probe, this container's /tmp, 20
    // cycles): inode reuse across a delete/recreate cycle is deterministic
    // (20/20), matching CLAUDE.md's own 400/400 measurement -- but
    // `birthtimeNs`'s reported resolution is coarser than one cycle takes,
    // so two back-to-back cycles can share an IDENTICAL birthtime (measured:
    // 4/20 did). Retry, bounded, rolling `before` forward each time, until a
    // cycle both reuses the inode AND crosses that resolution boundary --
    // asserted by the loop's own exit condition, not assumed from the first
    // attempt.
    let before = await fs.lstat(disk, { bigint: true })
    let after: typeof before | undefined
    for (let attempt = 0; attempt < 200 && after === undefined; attempt++) {
      await fs.rm(disk, { recursive: true, force: true })
      await fs.mkdir(disk, { recursive: true })
      await fs.writeFile(path.join(disk, 'SKILL.md'), `# recreated ${attempt}\n`)
      const candidate = await fs.lstat(disk, { bigint: true })
      if (
        candidate.dev === before.dev &&
        candidate.ino === before.ino &&
        candidate.birthtimeNs !== before.birthtimeNs
      ) {
        after = candidate
      } else {
        before = candidate
      }
    }
    if (after === undefined) {
      throw new Error(
        'could not reproduce a same-inode, different-birthtime delete/recreate cycle in 200 ' +
          'attempts on this filesystem -- the precondition this test probes did not hold here'
      )
    }

    // The property this test exists to probe: dev/ino ALONE cannot tell the
    // recreated directory apart from the original (guaranteed by the loop's
    // own exit condition above, restated here as the test's real assertion).
    expect(after.dev).toBe(before.dev)
    expect(after.ino).toBe(before.ino)
    expect(after.birthtimeNs).not.toBe(before.birthtimeNs)

    const message = identityChanged(
      { dev: before.dev, ino: before.ino, birthtimeNs: before.birthtimeNs },
      { dev: after.dev, ino: after.ino, birthtimeNs: after.birthtimeNs },
      'recreated-skill'
    )

    expect(message).not.toBeNull()
    expect(message).toContain('replaced by a different directory')
  })
})

describe('checkNotTrackedElsewhere refuses instead of adopting through its own ENOENT window (SMI-6732 round 10, R1)', () => {
  it('refuses directly when the target has never existed, rather than reporting ok with no identity', async () => {
    const neverExisted = path.join(skillsDir, 'never-existed-at-all')

    const result = await checkNotTrackedElsewhere(neverExisted, 'never-existed-at-all', {})

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: already asserted !result.ok above')
    expect(result.message).toContain('disappeared while it was being checked')
    expect(result.message).toContain(neverExisted)
  })

  it('refuses end to end rather than adopting and deleting whatever a tracked, modified skill got renamed into the gap (round 9 finding)', async () => {
    const victimName = 'victim-skill'
    const potentialPath = path.join(skillsDir, victimName)
    await fs.mkdir(potentialPath, { recursive: true })
    await fs.writeFile(path.join(potentialPath, 'SKILL.md'), '# original untracked\n')

    // A DIFFERENT skill, tracked, and modified since its OWN installedAt --
    // the entry that must survive this uninstall untouched.
    const trackedName = 'other-tracked-skill'
    const trackedPath = path.join(skillsDir, trackedName)
    await fs.mkdir(trackedPath, { recursive: true })
    await fs.writeFile(path.join(trackedPath, 'SKILL.md'), '# tracked, about to be modified\n')
    await track(trackedName, trackedPath)
    await fs.writeFile(path.join(trackedPath, 'SKILL.md'), '# tracked, MODIFIED\n')

    // checkNotTrackedElsewhere's OWN lstat of `potentialPath` sees ENOENT, and
    // -- as that same call's side effect -- the tracked+modified directory
    // lands at `potentialPath` immediately after, matching what round 9
    // measured: `fs.access` still sees the original, then the guard's own
    // read lands in the vanish-then-replace gap.
    vanishThenSwapFor.path = potentialPath
    vanishThenSwapFor.swapFromPath = trackedPath

    const result = await createService().uninstall(victimName, { force: false })

    expect(result.success, result.message).toBe(false)
    expect(result.message).toContain('disappeared while it was being checked')
    // The swapped-in tracked+modified skill is still there, untouched --
    // never adopted, never deleted.
    expect(await fs.readFile(path.join(potentialPath, 'SKILL.md'), 'utf-8')).toBe(
      '# tracked, MODIFIED\n'
    )
    // No adoption entry was ever written for the victim name.
    expect(await manifestEntry(victimName)).toBeUndefined()
    // The tracked skill's own record is untouched by this uninstall (its
    // installPath now names the vacated original location -- an artifact of
    // this test's own swap, not something this fix is responsible for
    // repairing).
    expect(await manifestEntry(trackedName)).toBeDefined()
  })
})

describe('sameIdentity is pinned exactly, not merely equivalent (SMI-6732 round 10, R2)', () => {
  // Round 9 measured both branches of `sameIdentity` (remove-if-same.ts)
  // revertible to a wrong-but-plausible rule with the entire suite green.
  // These three cases, run through the real `removeIfSame`, are the ones
  // round 9 found that discriminate.
  const inoA = (35n << 48n) | 90356n
  const inoB = (35n << 48n) | 90357n

  it('the precondition these cases probe', () => {
    expect(inoA).not.toBe(inoB)
    expect(Number(inoA)).toBe(Number(inoB))
    expect(BigInt(Number(inoB))).not.toBe(inoB)
  })

  it('CASE U: refuses when the bigint expected and actual inodes differ but collapse to the same Number (kills the bigint-branch Number() mutant)', async () => {
    const dir = await fs.mkdtemp(path.join(tmpDir, 'sameidentity-caseu-'))
    const real = await fs.lstat(dir, { bigint: true })
    lstatFakeInoFor.entries.set(real.ino, inoB)

    const result = await removeIfSame(dir, { dev: real.dev, ino: inoA })

    expect(result.removed).toBe(false)
    if (!result.removed) expect(result.reason).toContain('replaced by something else')
    await expect(fs.lstat(dir)).resolves.toBeDefined()
  })

  it('CASE L2: still matches when expected is a lossy Number() capture of the same real (large) inode (kills the number-branch BigInt() mutant)', async () => {
    const dir = await fs.mkdtemp(path.join(tmpDir, 'sameidentity-casel2-'))
    const real = await fs.lstat(dir, { bigint: true })
    lstatFakeInoFor.entries.set(real.ino, inoB)

    const result = await removeIfSame(dir, { dev: Number(real.dev), ino: Number(inoB) })

    expect(result.removed).toBe(true)
    await expect(fs.lstat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('CASE U2 (positive control): matches when the bigint expected and actual inodes genuinely agree', async () => {
    const dir = await fs.mkdtemp(path.join(tmpDir, 'sameidentity-caseu2-'))
    const real = await fs.lstat(dir, { bigint: true })
    lstatFakeInoFor.entries.set(real.ino, inoB)

    const result = await removeIfSame(dir, { dev: real.dev, ino: inoB })

    expect(result.removed).toBe(true)
    await expect(fs.lstat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('removeIfSame catches an inode reused by a delete-and-recreate inside its OWN window (SMI-6732 round 10, R3)', () => {
  it('birthtimeNs discriminates a recreated directory that reuses the same inode, inside removeIfSame itself (real filesystem, no mock)', async () => {
    const dir = path.join(tmpDir, 'recreated-before-removeifsame')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'SKILL.md'), '# original\n')

    // Same retry technique as the C4 test above: inode reuse across a
    // delete/recreate cycle is measured deterministic on this filesystem, but
    // `birthtimeNs`'s resolution is coarser than one cycle takes, so several
    // back-to-back cycles can share an identical birthtime. Retry, bounded,
    // rolling `expected` forward each time, until a cycle both reuses the
    // inode AND crosses that resolution boundary.
    let expected = await fs.lstat(dir, { bigint: true })
    let recreated: typeof expected | undefined
    for (let attempt = 0; attempt < 200 && recreated === undefined; attempt++) {
      await fs.rm(dir, { recursive: true, force: true })
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'SKILL.md'), `# recreated ${attempt}\n`)
      const candidate = await fs.lstat(dir, { bigint: true })
      if (
        candidate.dev === expected.dev &&
        candidate.ino === expected.ino &&
        candidate.birthtimeNs !== expected.birthtimeNs
      ) {
        recreated = candidate
      } else {
        expected = candidate
      }
    }
    if (recreated === undefined) {
      throw new Error(
        'could not reproduce a same-inode, different-birthtime delete/recreate cycle in 200 ' +
          'attempts on this filesystem -- the precondition this test probes did not hold here'
      )
    }

    // The property this test exists to probe, restated as an assertion:
    // dev/ino ALONE cannot tell the directory `removeIfSame` is about to
    // touch apart from the STALE identity `expected` describes.
    expect(recreated.dev).toBe(expected.dev)
    expect(recreated.ino).toBe(expected.ino)
    expect(recreated.birthtimeNs).not.toBe(expected.birthtimeNs)

    // `expected` is the STALE identity, as if captured by a caller earlier;
    // `removeIfSame`'s own internal `before` lstat will see the directory
    // currently on disk -- the recreated one.
    const result = await removeIfSame(dir, {
      dev: expected.dev,
      ino: expected.ino,
      birthtimeNs: expected.birthtimeNs,
    })

    expect(result.removed).toBe(false)
    if (!result.removed) expect(result.reason).toContain('replaced by something else')
    expect(await fs.readdir(dir)).toContain('SKILL.md')
  })
})

describe('identityChanged only compares birthtimeNs when BOTH sides report one (SMI-6732 round 10, R5)', () => {
  it('does not refuse when the BEFORE identity has no birthtime (0n) even though AFTER genuinely differs', () => {
    const before = { dev: 7n, ino: 9n, birthtimeNs: 0n }
    const after = { dev: 7n, ino: 9n, birthtimeNs: 500n }

    expect(identityChanged(before, after, 'probe-skill')).toBeNull()
  })

  it('does not refuse when the AFTER identity has no birthtime (0n) even though BEFORE genuinely differs', () => {
    const before = { dev: 7n, ino: 9n, birthtimeNs: 500n }
    const after = { dev: 7n, ino: 9n, birthtimeNs: 0n }

    expect(identityChanged(before, after, 'probe-skill')).toBeNull()
  })

  it("proceeds normally end to end when the removal guard's own read reports a zero birthtimeNs but dev/ino genuinely match", async () => {
    const untracked = path.join(skillsDir, 'zero-birthtime-skill')
    await fs.mkdir(untracked, { recursive: true })
    await fs.writeFile(path.join(untracked, 'SKILL.md'), '# zero birthtime\n')

    lstatZeroBirthtimeOnceFor.path = untracked

    const result = await createService().uninstall('zero-birthtime-skill', { force: true })

    expect(result.success, result.message).toBe(true)
    expect(result.message).not.toContain('replaced by a different directory')
    await expect(fs.lstat(untracked)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
