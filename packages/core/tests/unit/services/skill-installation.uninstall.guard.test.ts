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

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const rename = async (from: string, to: string): Promise<void> => {
    if (String(from) === swapBeforeRename.path) {
      swapBeforeRename.path = null
      await actual.rename(from, `${String(from)}-moved`)
      await actual.mkdir(from)
      await actual.writeFile(`${String(from)}/KEEP.md`, 'not ours', 'utf-8')
    }
    return actual.rename(from, to)
  }
  return { ...actual, default: { ...actual, rename }, rename }
})

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
