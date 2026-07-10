/**
 * @fileoverview SMI-5639 Wave 2 Step 3 — exact-repro integration test (no subprocess).
 *
 * Reproduces the original bug end-to-end, in-process: install a real skill
 * (via the actual `installSkill()` flow, network mocked per the
 * `install.execution.integration.test.ts` pattern) whose SKILL.md genuinely
 * references `mcp__*` tools, so dependency intelligence is written to
 * `skill_dependencies` through the real `SkillInstallationService` ->
 * `SkillDependencyRepository` path. Then invoke the REAL
 * `createShutdownTrigger`/`closeDbOnShutdown` exports from `shutdown.ts`
 * (not a reimplementation) against a real temp-file WASM (`sql.js`) database,
 * and open a FRESH connection to the same file afterward to prove the write
 * actually survived the close — this is the exact scenario SMI-5639
 * describes: before the fix, nothing in the shutdown path ever called
 * `db.close()`, so this assertion would fail (0 rows) against the
 * unpatched `shutdown.ts`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs/promises'
import { existsSync } from 'fs'
import { createToolContextAsync, closeToolContext } from '../../src/context.js'
import type { ToolContext } from '../../src/context.js'
import { closeDbOnShutdown, flushTelemetryOnShutdown } from '../../src/shutdown.js'
import { createTestFilesystem, type TestFilesystemContext } from './setup.js'

// Same mocking seams as install.execution.integration.test.ts — this is the
// only other integration file exercising the real installSkill() flow in
// this suite, so the rationale below mirrors that file's header comment.
vi.mock('../../src/tools/install.helpers.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/tools/install.helpers.js')>()
  return {
    ...actual,
    lookupSkillFromRegistry: vi.fn(),
    fetchFromGitHub: vi.fn(),
  }
})

vi.mock('@skillsmith/core/services/skill-installation-io', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    fetchFromGitHub: vi.fn(),
    fetchAndScanOptionalFiles: vi.fn(),
  }
})

vi.mock('@skillsmith/core/install', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    resolveClientPath: vi.fn(),
    getInstallPath: vi.fn(),
  }
})

describe('SMI-5639: shutdown persistence — exact repro (integration, no subprocess)', () => {
  const TEST_SKILL_ID = 'a129e127-a82c-47e5-8bc5-09d7ba2e8734'

  // Genuine mcp__<server>__<tool> references, outside any fenced code block,
  // so McpReferenceExtractor treats them as high-confidence (matches the
  // real-world `linear` skill's SKILL.md referenced in the plan doc's
  // Context section).
  const SKILL_MD_WITH_MCP_REFS = [
    '---',
    'name: shutdown-persistence-fixture',
    'description: SMI-5639 integration fixture skill with real mcp tool references',
    '---',
    '# Shutdown Persistence Fixture',
    '',
    'This skill calls mcp__linear__save_issue and mcp__linear__list_issues directly',
    'to manage Linear issues without leaving the assistant session.',
    '',
    'It has enough body text to satisfy SKILL.md content-length validation checks',
    'so the install proceeds all the way through dependency-intelligence persistence.',
  ].join('\n')

  let fsContext: TestFilesystemContext
  let dbPath: string
  let previousForceWasm: string | undefined

  let installSkill: (typeof import('../../src/tools/install.js'))['installSkill']
  let installInputSchema: (typeof import('../../src/tools/install.types.js'))['installInputSchema']
  let lookupSkillFromRegistry: ReturnType<typeof vi.fn>
  let fetchFromGitHub: ReturnType<typeof vi.fn>
  let coreFetchFromGitHub: ReturnType<typeof vi.fn>
  let coreFetchAndScanOptionalFiles: ReturnType<typeof vi.fn>
  let resolveClientPath: ReturnType<typeof vi.fn>
  let getInstallPath: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    // Dynamic import after vi.mock() has been hoisted — mirrors
    // install.execution.integration.test.ts's own beforeAll pattern.
    const installModule = await import('../../src/tools/install.js')
    installSkill = installModule.installSkill

    const typesModule = await import('../../src/tools/install.types.js')
    installInputSchema = typesModule.installInputSchema

    const helpersModule = await import('../../src/tools/install.helpers.js')
    lookupSkillFromRegistry = vi.mocked(helpersModule.lookupSkillFromRegistry)
    fetchFromGitHub = vi.mocked(helpersModule.fetchFromGitHub)

    const coreIoModule = await import('@skillsmith/core/services/skill-installation-io')
    coreFetchFromGitHub = vi.mocked(coreIoModule.fetchFromGitHub as (...args: unknown[]) => unknown)
    coreFetchAndScanOptionalFiles = vi.mocked(
      coreIoModule.fetchAndScanOptionalFiles as (...args: unknown[]) => unknown
    )

    const coreInstallModule = await import('@skillsmith/core/install')
    resolveClientPath = vi.mocked(
      coreInstallModule.resolveClientPath as (...args: unknown[]) => unknown
    )
    getInstallPath = vi.mocked(coreInstallModule.getInstallPath as (...args: unknown[]) => unknown)
  })

  beforeEach(async () => {
    fsContext = await createTestFilesystem()

    // SMI-5639: force the WASM (sql.js) driver — this bug only manifests
    // there, since only sqljsDriver's close() -> persist() ever writes to
    // disk. Restored in afterEach so this test file can't leak the override
    // into other test files sharing the same worker process.
    previousForceWasm = process.env.SKILLSMITH_FORCE_WASM
    process.env.SKILLSMITH_FORCE_WASM = 'true'

    dbPath = path.join(
      os.tmpdir(),
      `skillsmith-shutdown-persistence-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    )

    vi.clearAllMocks()
    resolveClientPath.mockReturnValue(fsContext.skillsDir)
    getInstallPath.mockReturnValue(fsContext.skillsDir)
    coreFetchAndScanOptionalFiles.mockResolvedValue({
      configWarnings: [],
      failedScans: [],
      filesToWrite: [],
    })
  })

  afterEach(async () => {
    await fsContext.cleanup()
    vi.restoreAllMocks()

    if (previousForceWasm === undefined) {
      delete process.env.SKILLSMITH_FORCE_WASM
    } else {
      process.env.SKILLSMITH_FORCE_WASM = previousForceWasm
    }

    try {
      await fs.rm(dbPath, { force: true })
    } catch {
      // Best-effort cleanup — not test-critical.
    }
  })

  it('persists skill_dependencies rows written before shutdown into a fresh connection reopened after close()', async () => {
    // 1. Build a REAL ToolContext against a real temp-file WASM database.
    //    Background sync / LLM failover / telemetry all stay off so this
    //    context has no side effects beyond the db itself.
    const context: ToolContext = await createToolContextAsync({
      dbPath,
      backgroundSyncConfig: { enabled: false },
      apiClientConfig: { offlineMode: true },
    })

    let freshContext: ToolContext | undefined
    try {
      // 2. Install a skill with genuine mcp__* references through the REAL
      //    installSkill() flow (network mocked), so skill_dependencies gets
      //    written via the actual SkillInstallationService ->
      //    SkillDependencyRepository path — the same path the original bug
      //    silently discarded on every WASM-fallback session.
      lookupSkillFromRegistry.mockResolvedValue({
        repoUrl: 'https://github.com/owner/shutdown-persistence-fixture',
        name: 'shutdown-persistence-fixture',
        trustTier: 'community',
        quarantined: false,
      })
      fetchFromGitHub.mockResolvedValue(SKILL_MD_WITH_MCP_REFS)
      coreFetchFromGitHub.mockResolvedValue(SKILL_MD_WITH_MCP_REFS)

      const result = await installSkill(
        installInputSchema.parse({ skillId: TEST_SKILL_ID, skipScan: true, force: true }),
        context
      )

      expect(result.success).toBe(true)
      expect(result.skillId).toBe(TEST_SKILL_ID)

      // Anti-false-green: confirm the dependency rows actually landed in
      // THIS (pre-shutdown) connection before we even test persistence —
      // otherwise a failure below could just mean the install itself never
      // wrote anything, not that shutdown failed to persist it.
      const depsBeforeClose = context.skillDependencyRepository.getDependencies(TEST_SKILL_ID)
      expect(depsBeforeClose.length).toBeGreaterThan(0)

      // 3. Invoke the REAL shutdown path — closeDbOnShutdown (exactly what
      //    createShutdownTrigger calls internally) plus flushTelemetryOnShutdown,
      //    not a reimplementation. closeDbOnShutdown runs synchronously and,
      //    for the WASM driver, IS what calls persist() -> writeFileSync.
      closeDbOnShutdown(() => context.db)
      await flushTelemetryOnShutdown()

      expect(context.db.open).toBe(false)
      expect(existsSync(dbPath)).toBe(true)

      // 4. Open a FRESH connection against the same on-disk file — a
      //    completely separate Database instance/process boundary in spirit
      //    (mirrors sqljs-driver.test.ts's own "persist across open/close
      //    cycles" pattern) — and confirm the dependency rows survived.
      freshContext = await createToolContextAsync({
        dbPath,
        backgroundSyncConfig: { enabled: false },
        apiClientConfig: { offlineMode: true },
      })

      const depsAfterReopen = freshContext.skillDependencyRepository.getDependencies(TEST_SKILL_ID)
      expect(depsAfterReopen.length).toBeGreaterThan(0)
      expect(depsAfterReopen.some((dep) => dep.dep_target.includes('linear'))).toBe(true)
    } finally {
      if (freshContext) {
        await closeToolContext(freshContext)
      }
      // closeToolContext -> db.close() is idempotent (guarded by `_open` in
      // both drivers) even though this context's db was already closed above.
      await closeToolContext(context)
    }
  })
})
