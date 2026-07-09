/**
 * SMI-1630: Search both global and local skill directories.
 *
 * Split out of manage.test.ts (a pre-existing over-500-line file, unrelated
 * to SMI-5593) to satisfy the pre-commit file-length gate while manage.test.ts
 * is being touched anyway.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'
import { homedir } from 'os'

// Mock file system
vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}))

// Mock core - use class implementations to avoid vitest warning
vi.mock('@skillsmith/core', () => ({
  createDatabase: vi.fn(() => ({ close: vi.fn() })),
  createDatabaseAsync: vi.fn(),
  initializeSchema: vi.fn(),
  SkillRepository: vi.fn().mockImplementation(function () {
    return {
      findAll: vi.fn(() => ({ items: [], total: 0, limit: 1000, offset: 0, hasMore: false })),
    }
  }),
  SkillDependencyRepository: vi.fn().mockImplementation(function () {
    return { clearAll: vi.fn() }
  }),
  SkillInstallationService: vi.fn().mockImplementation(function () {
    return { uninstall: vi.fn() }
  }),
  SkillParser: vi.fn().mockImplementation(function () {
    return {
      parse: vi.fn(),
      inferTrustTier: vi.fn(() => 'unknown'),
    }
  }),
}))

describe('SMI-1630: Search both global and local skill directories', () => {
  const GLOBAL_SKILLS_DIR = join(homedir(), '.claude', 'skills')
  const LOCAL_SKILLS_DIR = join(process.cwd(), '.claude', 'skills')

  const mockSkillMd = (name: string, version: string) => `---
name: ${name}
version: ${version}
---
# ${name}

A test skill.
`

  beforeEach(async () => {
    vi.clearAllMocks()
    // Reset module cache to ensure fresh imports with mocked fs
    vi.resetModules()
  })

  it('should search both global and local skill directories', async () => {
    const { readdir, readFile, stat } = await import('fs/promises')
    const readdirMock = vi.mocked(readdir)
    const readFileMock = vi.mocked(readFile)
    const statMock = vi.mocked(stat)

    // Mock global directory with one skill
    readdirMock.mockImplementation(async (dirPath) => {
      if (dirPath === GLOBAL_SKILLS_DIR) {
        return [{ name: 'global-skill', isDirectory: () => true }] as unknown as ReturnType<
          typeof readdir
        >
      }
      if (dirPath === LOCAL_SKILLS_DIR) {
        return [{ name: 'local-skill', isDirectory: () => true }] as unknown as ReturnType<
          typeof readdir
        >
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    statMock.mockResolvedValue({
      mtime: new Date('2024-01-15'),
    } as unknown as Awaited<ReturnType<typeof stat>>)

    readFileMock.mockImplementation(async (filePath) => {
      if (String(filePath).includes('global-skill')) {
        return mockSkillMd('global-skill', '1.0.0')
      }
      if (String(filePath).includes('local-skill')) {
        return mockSkillMd('local-skill', '2.0.0')
      }
      throw new Error('File not found')
    })

    const { getInstalledSkills } = await import('../src/commands/manage.js')
    const skills = await getInstalledSkills()

    // Should have searched both directories
    expect(readdirMock).toHaveBeenCalledWith(GLOBAL_SKILLS_DIR, { withFileTypes: true })
    expect(readdirMock).toHaveBeenCalledWith(LOCAL_SKILLS_DIR, { withFileTypes: true })

    // Should return skills from both directories
    const skillNames = skills.map((s) => s.name)
    expect(skillNames).toContain('global-skill')
    expect(skillNames).toContain('local-skill')
    expect(skills).toHaveLength(2)
  })

  it('should merge skills from both directories', async () => {
    const { readdir, readFile, stat } = await import('fs/promises')
    const readdirMock = vi.mocked(readdir)
    const readFileMock = vi.mocked(readFile)
    const statMock = vi.mocked(stat)

    // Both directories have different skills
    readdirMock.mockImplementation(async (dirPath) => {
      if (dirPath === GLOBAL_SKILLS_DIR) {
        return [
          { name: 'skill-a', isDirectory: () => true },
          { name: 'skill-b', isDirectory: () => true },
        ] as unknown as ReturnType<typeof readdir>
      }
      if (dirPath === LOCAL_SKILLS_DIR) {
        return [
          { name: 'skill-c', isDirectory: () => true },
          { name: 'skill-d', isDirectory: () => true },
        ] as unknown as ReturnType<typeof readdir>
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    statMock.mockResolvedValue({
      mtime: new Date('2024-01-15'),
    } as unknown as Awaited<ReturnType<typeof stat>>)

    readFileMock.mockImplementation(async (filePath) => {
      const path = String(filePath)
      if (path.includes('skill-a')) return mockSkillMd('skill-a', '1.0.0')
      if (path.includes('skill-b')) return mockSkillMd('skill-b', '1.0.0')
      if (path.includes('skill-c')) return mockSkillMd('skill-c', '1.0.0')
      if (path.includes('skill-d')) return mockSkillMd('skill-d', '1.0.0')
      throw new Error('File not found')
    })

    const { getInstalledSkills } = await import('../src/commands/manage.js')
    const skills = await getInstalledSkills()

    // Should have all 4 skills merged
    expect(skills).toHaveLength(4)
    const skillNames = skills.map((s) => s.name)
    expect(skillNames).toContain('skill-a')
    expect(skillNames).toContain('skill-b')
    expect(skillNames).toContain('skill-c')
    expect(skillNames).toContain('skill-d')
  })

  it('should give local skills precedence over global skills with the same name', async () => {
    const { readdir, readFile, stat } = await import('fs/promises')
    const readdirMock = vi.mocked(readdir)
    const readFileMock = vi.mocked(readFile)
    const statMock = vi.mocked(stat)

    // Both directories have a skill with the same name
    readdirMock.mockImplementation(async (dirPath) => {
      if (dirPath === GLOBAL_SKILLS_DIR) {
        return [{ name: 'shared-skill', isDirectory: () => true }] as unknown as ReturnType<
          typeof readdir
        >
      }
      if (dirPath === LOCAL_SKILLS_DIR) {
        return [{ name: 'shared-skill', isDirectory: () => true }] as unknown as ReturnType<
          typeof readdir
        >
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    statMock.mockResolvedValue({
      mtime: new Date('2024-01-15'),
    } as unknown as Awaited<ReturnType<typeof stat>>)

    readFileMock.mockImplementation(async (filePath) => {
      const path = String(filePath)
      if (path.includes('shared-skill')) {
        return mockSkillMd('shared-skill', '1.0.0')
      }
      throw new Error('File not found')
    })

    const { getInstalledSkills } = await import('../src/commands/manage.js')
    const skills = await getInstalledSkills()

    // Should only have one skill (deduplicated)
    expect(skills).toHaveLength(1)

    // The local skill should take precedence (verified by path)
    const sharedSkill = skills.find((s) => s.name === 'shared-skill')
    expect(sharedSkill).toBeDefined()
    // Key assertion: local path takes precedence over global
    expect(sharedSkill?.path).toContain(LOCAL_SKILLS_DIR)
    expect(sharedSkill?.path).not.toContain(GLOBAL_SKILLS_DIR)
  })

  it('should handle missing local skills directory gracefully', async () => {
    const { readdir, readFile, stat } = await import('fs/promises')
    const readdirMock = vi.mocked(readdir)
    const readFileMock = vi.mocked(readFile)
    const statMock = vi.mocked(stat)

    // Global exists, local does not
    readdirMock.mockImplementation(async (dirPath) => {
      if (dirPath === GLOBAL_SKILLS_DIR) {
        return [{ name: 'global-only', isDirectory: () => true }] as unknown as ReturnType<
          typeof readdir
        >
      }
      // Local directory doesn't exist
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    statMock.mockResolvedValue({
      mtime: new Date('2024-01-15'),
    } as unknown as Awaited<ReturnType<typeof stat>>)

    readFileMock.mockImplementation(async (filePath) => {
      if (String(filePath).includes('global-only')) {
        return mockSkillMd('global-only', '1.0.0')
      }
      throw new Error('File not found')
    })

    const { getInstalledSkills } = await import('../src/commands/manage.js')
    const skills = await getInstalledSkills()

    // Should still return skills from global directory
    expect(skills).toHaveLength(1)
    expect(skills[0]?.name).toBe('global-only')
  })

  it('should handle missing global skills directory gracefully', async () => {
    const { readdir, readFile, stat } = await import('fs/promises')
    const readdirMock = vi.mocked(readdir)
    const readFileMock = vi.mocked(readFile)
    const statMock = vi.mocked(stat)

    // Local exists, global does not
    readdirMock.mockImplementation(async (dirPath) => {
      if (dirPath === LOCAL_SKILLS_DIR) {
        return [{ name: 'local-only', isDirectory: () => true }] as unknown as ReturnType<
          typeof readdir
        >
      }
      // Global directory doesn't exist
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    statMock.mockResolvedValue({
      mtime: new Date('2024-01-15'),
    } as unknown as Awaited<ReturnType<typeof stat>>)

    readFileMock.mockImplementation(async (filePath) => {
      if (String(filePath).includes('local-only')) {
        return mockSkillMd('local-only', '1.0.0')
      }
      throw new Error('File not found')
    })

    const { getInstalledSkills } = await import('../src/commands/manage.js')
    const skills = await getInstalledSkills()

    // Should return skills from local directory only
    expect(skills).toHaveLength(1)
    expect(skills[0]?.name).toBe('local-only')
  })

  it('should include source location indicator for each skill', async () => {
    const { readdir, readFile, stat } = await import('fs/promises')
    const readdirMock = vi.mocked(readdir)
    const readFileMock = vi.mocked(readFile)
    const statMock = vi.mocked(stat)

    readdirMock.mockImplementation(async (dirPath) => {
      if (dirPath === GLOBAL_SKILLS_DIR) {
        return [{ name: 'global-skill', isDirectory: () => true }] as unknown as ReturnType<
          typeof readdir
        >
      }
      if (dirPath === LOCAL_SKILLS_DIR) {
        return [{ name: 'local-skill', isDirectory: () => true }] as unknown as ReturnType<
          typeof readdir
        >
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    statMock.mockResolvedValue({
      mtime: new Date('2024-01-15'),
    } as unknown as Awaited<ReturnType<typeof stat>>)

    readFileMock.mockImplementation(async (filePath) => {
      const path = String(filePath)
      if (path.includes('global-skill')) return mockSkillMd('global-skill', '1.0.0')
      if (path.includes('local-skill')) return mockSkillMd('local-skill', '1.0.0')
      throw new Error('File not found')
    })

    const { getInstalledSkills } = await import('../src/commands/manage.js')
    const skills = await getInstalledSkills()

    // Skills should indicate their source (global vs local)
    const globalSkill = skills.find((s) => s.name === 'global-skill')
    const localSkill = skills.find((s) => s.name === 'local-skill')

    expect(globalSkill?.path).toContain(GLOBAL_SKILLS_DIR)
    expect(localSkill?.path).toContain(LOCAL_SKILLS_DIR)
  })

  it('should return empty array when both directories are missing', async () => {
    const { readdir } = await import('fs/promises')
    const readdirMock = vi.mocked(readdir)

    // Neither directory exists
    readdirMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const { getInstalledSkills } = await import('../src/commands/manage.js')
    const skills = await getInstalledSkills()

    expect(skills).toEqual([])
  })

  it('should throw permission errors instead of silently ignoring them', async () => {
    const { readdir } = await import('fs/promises')
    const readdirMock = vi.mocked(readdir)

    // Simulate permission denied error
    readdirMock.mockRejectedValue(Object.assign(new Error('Permission denied'), { code: 'EACCES' }))

    const { getInstalledSkills } = await import('../src/commands/manage.js')

    await expect(getInstalledSkills()).rejects.toThrow('Permission denied')
  })

  it('should throw when SKILL.md has permission error', async () => {
    const { readdir, readFile, stat } = await import('fs/promises')
    const readdirMock = vi.mocked(readdir)
    const readFileMock = vi.mocked(readFile)
    const statMock = vi.mocked(stat)

    readdirMock.mockImplementation(async (dirPath) => {
      if (dirPath === GLOBAL_SKILLS_DIR) {
        return [{ name: 'protected-skill', isDirectory: () => true }] as unknown as ReturnType<
          typeof readdir
        >
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    // stat succeeds for SKILL.md path
    statMock.mockResolvedValue({
      mtime: new Date('2024-01-15'),
    } as unknown as Awaited<ReturnType<typeof stat>>)

    // But reading the file fails with permission error
    readFileMock.mockRejectedValue(
      Object.assign(new Error('Permission denied'), { code: 'EACCES' })
    )

    const { getInstalledSkills } = await import('../src/commands/manage.js')

    await expect(getInstalledSkills()).rejects.toThrow('Permission denied')
  })
})
