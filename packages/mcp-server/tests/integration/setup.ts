/**
 * SMI-616: Integration Test Setup
 * SMI-903: Expanded to 56 test skills across all categories and trust tiers
 * Provides test utilities for integration testing with real database and filesystem
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createDatabase, closeDatabase, SkillRepository, SearchService } from '@skillsmith/core'
import { seedTestSkills } from './fixtures/test-skills.js'

// Re-export for test access
export { TEST_SKILLS, TEST_SKILLS_STATS } from './fixtures/test-skills.js'

/**
 * Test database context
 */
export interface TestDatabaseContext {
  db: DatabaseType
  skillRepository: SkillRepository
  searchService: SearchService
  cleanup: () => Promise<void>
}

/**
 * Create an in-memory test database with sample data
 * Seeds 56 skills across all categories and trust tiers for realistic testing
 */
export async function createTestDatabase(): Promise<TestDatabaseContext> {
  const db = createDatabase(':memory:')
  const skillRepository = new SkillRepository(db)
  const searchService = new SearchService(db)

  // Seed with comprehensive test data (56 skills)
  seedTestSkills(skillRepository)

  return {
    db,
    skillRepository,
    searchService,
    cleanup: async () => {
      closeDatabase(db)
    },
  }
}

/**
 * Test filesystem context
 */
export interface TestFilesystemContext {
  tempDir: string
  skillsDir: string
  manifestDir: string
  cleanup: () => Promise<void>
}

/**
 * Create temporary directories for filesystem tests
 */
export async function createTestFilesystem(): Promise<TestFilesystemContext> {
  const tempDir = path.join(
    os.tmpdir(),
    `skillsmith-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  const skillsDir = path.join(tempDir, '.claude', 'skills')
  const manifestDir = path.join(tempDir, '.skillsmith')

  await fs.mkdir(skillsDir, { recursive: true })
  await fs.mkdir(manifestDir, { recursive: true })

  return {
    tempDir,
    skillsDir,
    manifestDir,
    cleanup: async () => {
      try {
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
    },
  }
}

/**
 * Create a mock skill manifest
 */
export async function createMockManifest(
  manifestDir: string,
  skills: Record<
    string,
    {
      id: string
      name: string
      version: string
      source: string
      installPath: string
      installedAt: string
      lastUpdated: string
    }
  > = {}
): Promise<void> {
  const manifest = {
    version: '1.0.0',
    installedSkills: skills,
  }
  await fs.writeFile(path.join(manifestDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

/**
 * Create a mock installed skill
 */
export async function createMockInstalledSkill(
  skillsDir: string,
  skillName: string,
  content: string = '# Mock Skill\n\nThis is a mock skill for testing purposes with enough content to pass validation.'
): Promise<string> {
  const skillPath = path.join(skillsDir, skillName)
  await fs.mkdir(skillPath, { recursive: true })
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), content)
  return skillPath
}

/**
 * Mock GitHub fetch for install tests
 */
export function createMockGitHubFetch(
  mockResponses: Record<string, { status: number; body?: string }>
): typeof globalThis.fetch {
  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()

    for (const [pattern, response] of Object.entries(mockResponses)) {
      if (url.includes(pattern)) {
        return new Response(response.body ?? '', {
          status: response.status,
          headers: { 'Content-Type': 'text/plain' },
        })
      }
    }

    // Default 404 response
    return new Response('Not Found', { status: 404 })
  }
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('Timeout waiting for condition')
}

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Read JSON file
 */
export async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(content) as T
}
