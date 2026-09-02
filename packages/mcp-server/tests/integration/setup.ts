/**
 * SMI-616: Integration Test Setup
 * SMI-903: Expanded to 56 test skills across all categories and trust tiers
 * Provides test utilities for integration testing with real database and filesystem
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  createDatabase,
  closeDatabase,
  SkillRepository,
  CoInstallRepository,
  SkillDependencyRepository,
  SearchService,
  SkillsmithApiClient,
  type DatabaseType,
} from '@skillsmith/core'
import { seedTestSkills } from './fixtures/test-skills.js'

// Re-export for test access
export { TEST_SKILLS, TEST_SKILLS_STATS } from './fixtures/test-skills.js'

/**
 * Test database context
 * SMI-1183: Added apiClient for API integration tests
 */
export interface TestDatabaseContext {
  db: DatabaseType
  skillRepository: SkillRepository
  coInstallRepository: CoInstallRepository
  skillDependencyRepository: SkillDependencyRepository
  sessionInstalledSkillIds: string[]
  searchService: SearchService
  apiClient: SkillsmithApiClient
  cleanup: () => Promise<void>
}

/**
 * Create an in-memory test database with sample data
 * Seeds 56 skills across all categories and trust tiers for realistic testing
 * SMI-1183: Creates apiClient in offline mode for local-only testing
 */
export async function createTestDatabase(): Promise<TestDatabaseContext> {
  const db = createDatabase(':memory:')
  const skillRepository = new SkillRepository(db)
  const coInstallRepository = new CoInstallRepository(db)
  const skillDependencyRepository = new SkillDependencyRepository(db)
  const searchService = new SearchService(db)

  // SMI-1183: Create API client in offline mode for tests
  // Tests use local database, not live API
  const apiClient = new SkillsmithApiClient({
    offlineMode: true,
  })

  // Seed with comprehensive test data (56 skills)
  seedTestSkills(skillRepository)

  return {
    db,
    skillRepository,
    coInstallRepository,
    skillDependencyRepository,
    sessionInstalledSkillIds: [],
    searchService,
    apiClient,
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
  /**
   * SMI-6343 Wave 1: the isolated `manifest.json` path inside `manifestDir`.
   * Pass THIS to anything that would otherwise default its manifest path to
   * `os.homedir()` (SkillInstallationService, ManifestManager, the
   * `resolveScopedSkillsDir` mock). `manifestDir` is kept for the existing
   * callers that build the same path by hand; new tests should use
   * `manifestPath` so the isolated path is the path of least resistance.
   */
  manifestPath: string
  cleanup: () => Promise<void>
}

/**
 * SMI-6343 Wave 1: allocate an isolated manifest path for a test.
 *
 * The manifest-writing surfaces (`SkillInstallationService`, `installSkill`,
 * `backfillManifest`, `new ManifestManager`) all fall back to
 * `path.join(os.homedir(), '.skillsmith', 'manifest.json')` when no explicit
 * path is supplied — which, on a host (non-Docker) vitest run, is the
 * developer's real manifest. `vitest.setup.ts` sandboxes `$HOME` so that
 * fallback is no longer destructive, and `ManifestManager` refuses real-home
 * paths under `VITEST` — but a test should still name its own path rather than
 * rely on either backstop.
 *
 * @param baseDir Directory to place `manifest.json` in. Defaults to a fresh
 *   `os.tmpdir()` directory, created for the caller.
 */
export async function createIsolatedManifestPath(baseDir?: string): Promise<string> {
  const dir = baseDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-manifest-')))
  await fs.mkdir(dir, { recursive: true })
  return path.join(dir, 'manifest.json')
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
    manifestPath: await createIsolatedManifestPath(manifestDir),
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
