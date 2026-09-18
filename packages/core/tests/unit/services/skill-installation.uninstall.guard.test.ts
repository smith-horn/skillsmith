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
import { SkillRepository } from '../../../src/repositories/SkillRepository.js'
import { SkillDependencyRepository } from '../../../src/repositories/SkillDependencyRepository.js'
import { createTestDatabase } from '../../helpers/database.js'
import type { Database } from '../../../src/db/database-interface.js'

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
// Round 25: `readdir` of this exact folder fails, so the parked-leftover scan
// cannot look.
const readdirFailFor = vi.hoisted(() => ({ path: null as string | null }))

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
    if (String(to) === failRenameTo.path) {
      throw Object.assign(new Error(`EACCES: permission denied, rename '${String(to)}'`), {
        code: 'EACCES',
      })
    }
    return actual.rename(from, to)
  }
  const access = async (p: string, mode?: number): Promise<void> => {
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
      throw Object.assign(new Error(`EACCES: permission denied, scandir '${String(args[0])}'`), {
        code: 'EACCES',
      })
    }
    return actual.readdir(...args)
  }) as typeof actual.readdir
  return {
    ...actual,
    default: { ...actual, rename, access, readdir },
    rename,
    access,
    readdir,
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
  readdirFailFor.path = null
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
