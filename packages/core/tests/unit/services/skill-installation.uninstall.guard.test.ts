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
