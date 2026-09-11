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
}))
// Every rename onto this path fails, so the manifest write fails after the
// skill folder is already gone.
const failRenameTo = vi.hoisted(() => ({ path: null as string | null }))

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
      const raw = JSON.parse(await actual.readFile(manifestFile, 'utf-8')) as {
        installedSkills: Record<string, { installPath: string }>
      }
      if (raw.installedSkills[key]) raw.installedSkills[key].installPath = claimed
      await actual.writeFile(manifestFile, JSON.stringify(raw, null, 2))
    }
    if (String(to) === failRenameTo.path) {
      throw Object.assign(new Error(`EACCES: permission denied, rename '${String(to)}'`), {
        code: 'EACCES',
      })
    }
    return actual.rename(from, to)
  }
  return { ...actual, default: { ...actual, rename }, rename }
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

function createService(): SkillInstallationService {
  return new SkillInstallationService({
    db,
    skillRepo: new SkillRepository(db),
    skillDependencyRepo: new SkillDependencyRepository(db),
    skillsDir,
    manifestPath,
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
  failRenameTo.path = null
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

describe('uninstall keeps the manifest honest (SMI-6529 round 16)', () => {
  it('reports what an earlier removal left parked next to the skill', async () => {
    const installPath = path.join(skillsDir, 'leftover-skill')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    const parked = path.join(skillsDir, '.leftover-skill.skillsmith-removing-0123456789ab')
    await fs.mkdir(parked)
    await fs.writeFile(path.join(parked, 'part.md'), 'partial')
    await track('leftover-skill', installPath)

    const result = await createService().uninstall('leftover-skill', { force: true })

    expect(result.success).toBe(true)
    expect(result.warning).toContain(parked)
    expect(result.warning).toContain('an interrupted removal')
    expect(await fs.readFile(path.join(parked, 'part.md'), 'utf-8')).toBe('partial')
  })

  it('leaves the record alone when another install claimed the name meanwhile', async () => {
    const installPath = path.join(skillsDir, 'claimed-skill')
    await fs.mkdir(installPath)
    await fs.writeFile(path.join(installPath, 'SKILL.md'), '# Installed\n')
    await track('claimed-skill', installPath)
    const claimedPath = path.join(tmpDir, 'elsewhere', 'claimed-skill')
    claimOnRename.path = installPath
    claimOnRename.manifestPath = manifestPath
    claimOnRename.key = 'claimed-skill'
    claimOnRename.newInstallPath = claimedPath

    const result = await createService().uninstall('claimed-skill', { force: true })

    expect(result.success).toBe(true)
    expect(result.warning).toContain('Another install claimed this name')
    expect(await manifestEntry('claimed-skill')).toMatchObject({ installPath: claimedPath })
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
    expect(result.message).toContain('Run the same remove again')
    await expect(fs.lstat(installPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await manifestEntry('stuck-skill')).toBeDefined()
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
    expect(result.message).toMatch(/was not removed: .* was replaced by something else/)
    expect(await fs.readFile(path.join(installPath, 'KEEP.md'), 'utf-8')).toBe('not ours')
    expect(await manifestEntry('swapped-skill')).toBeDefined()
  })
})
