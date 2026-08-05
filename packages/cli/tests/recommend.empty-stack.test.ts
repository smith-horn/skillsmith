/**
 * SMI-5896 Wave 3 Step 2: CLI `recommend` empty-derived-stack guard.
 *
 * Before this fix, an empty derived stack (non-Node project, all-devDeps,
 * or an unsupported language) reached the `skills-recommend` edge function,
 * which hard-rejects an empty `stack` with a 400 — that 400 propagated
 * straight through the outer catch into a hard `process.exit(1)` crash on a
 * workspace shape that isn't actually invalid, just under-detected. The fix
 * detects the empty-stack case client-side and returns a structured
 * degraded result instead (mirrors MCP `skill_recommend`'s identical guard).
 *
 * Separate file (not recommend.errors.test.ts) so its own `vi.mock('@skillsmith/core', ...)`
 * can include `buildEmptyStackGuidance` without touching the other split files'
 * mock blocks — each split file owns its own hoisted mocks per the sibling
 * files' convention (see recommend.test-helpers.ts header).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockCodebaseContext } from './recommend.test-helpers.js'

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  getRecommendations: vi.fn(),
  spinner: {
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    text: '',
  },
}))

// SMI-5896: partial mock (spread of the REAL module, per the
// search-helpers.test.ts precedent) rather than a hand-written stub object.
// `buildEmptyStackGuidance` must be the genuine core implementation here —
// the whole point of the shared helper is that CLI and MCP can't drift, and a
// hand-copied literal in the mock would keep passing even if core's wording
// changed, i.e. it would test the fixture instead of the contract.
vi.mock('@skillsmith/core', async () => {
  const actual = await vi.importActual<typeof import('@skillsmith/core')>('@skillsmith/core')
  return {
    ...actual,
    CodebaseAnalyzer: class MockCodebaseAnalyzer {
      analyze(...args: unknown[]) {
        return mocks.analyze(...args)
      }
    },
    createApiClient: () => ({
      getRecommendations: (...args: unknown[]) => mocks.getRecommendations(...args),
    }),
    loadStoredAccessToken: () => Promise.resolve(null),
  }
})
vi.mock('ora', () => ({ default: () => mocks.spinner }))

// Resolves through the mock above, which spreads the real module — so this is
// core's actual exported guidance string, not a test-local copy of it.
const { buildEmptyStackGuidance } = await import('@skillsmith/core')

const mockAnalyze = mocks.analyze
const mockGetRecommendations = mocks.getRecommendations
const mockSpinner = mocks.spinner

const originalConsoleLog = console.log
const mockConsoleLog = vi.fn()

const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

/** A codebase analysis result that legitimately derives an empty stack. */
function emptyStackContext() {
  return createMockCodebaseContext({
    frameworks: [],
    dependencies: [],
  })
}

describe('SMI-5896: CLI recommend — empty derived stack guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    console.log = mockConsoleLog
    mockAnalyze.mockResolvedValue(emptyStackContext())
  })

  afterEach(() => {
    console.log = originalConsoleLog
  })

  it('does not crash with process.exit(1) when the derived stack is empty', async () => {
    const { createRecommendCommand } = await import('../src/commands/recommend.js')
    const cmd = createRecommendCommand()

    await cmd.parseAsync(['node', 'test', '.'])

    expect(mockExit).not.toHaveBeenCalled()
    expect(mockSpinner.fail).not.toHaveBeenCalled()
  })

  it('never calls the recommendation API when the derived stack is empty', async () => {
    const { createRecommendCommand } = await import('../src/commands/recommend.js')
    const cmd = createRecommendCommand()

    await cmd.parseAsync(['node', 'test', '.'])

    expect(mockGetRecommendations).not.toHaveBeenCalled()
  })

  it('warns via the spinner instead of failing', async () => {
    const { createRecommendCommand } = await import('../src/commands/recommend.js')
    const cmd = createRecommendCommand()

    await cmd.parseAsync(['node', 'test', '.'])

    expect(mockSpinner.warn).toHaveBeenCalledWith(
      expect.stringContaining('No technology stack detected')
    )
  })

  it('prints the shared empty-stack guidance in human-readable output', async () => {
    const { createRecommendCommand } = await import('../src/commands/recommend.js')
    const cmd = createRecommendCommand()

    await cmd.parseAsync(['node', 'test', '.'])

    const output = mockConsoleLog.mock.calls.map((c) => c[0]).join('\n')
    // Asserted against core's real exported string so a wording change in
    // recommend-guard.ts that the CLI stopped surfacing would fail here.
    expect(output).toContain(buildEmptyStackGuidance())
  })

  it('includes the guidance under `meta.suggestion` in --json output', async () => {
    const { createRecommendCommand } = await import('../src/commands/recommend.js')
    const cmd = createRecommendCommand()

    await cmd.parseAsync(['node', 'test', '.', '--json'])

    const output = mockConsoleLog.mock.calls[0]![0] as string
    const parsed = JSON.parse(output)
    expect(parsed.meta.suggestion).toBe(buildEmptyStackGuidance())
    expect(parsed.recommendations).toEqual([])
  })

  it('--installed on an otherwise-empty derived stack bypasses the guard entirely (SMI-5896 review)', async () => {
    // The guidance text this guard returns explicitly tells the caller to
    // "supply project context or an installed-skills list" to escape it --
    // an explicit --installed IS that list, so it must actually prevent the
    // guard from firing, not just get reported inside the guard's own
    // response after the fact. Previously --installed never fed into
    // `stack`, so this scenario still hit the guard unconditionally.
    mockGetRecommendations.mockResolvedValue({
      data: [
        {
          id: 'anthropic/pdf',
          name: 'pdf',
          quality_score: 0.8,
          trust_tier: 'verified',
          tags: [],
        },
      ],
    })
    const { createRecommendCommand } = await import('../src/commands/recommend.js')
    const cmd = createRecommendCommand()

    await cmd.parseAsync(['node', 'test', '.', '--installed', 'anthropic/commit', '--json'])

    expect(mockGetRecommendations).toHaveBeenCalledTimes(1)
    expect(mockGetRecommendations.mock.calls[0]![0]).toMatchObject({ stack: ['commit'] })

    const output = mockConsoleLog.mock.calls[0]![0] as string
    const parsed = JSON.parse(output)
    expect(parsed.meta.installed_count).toBe(1)
    expect(parsed.meta.auto_detected).toBe(false)
    // suggestion is only populated by the guard branch / an empty result set
    // -- its absence here is itself evidence the guard did not fire.
    expect(parsed.meta.suggestion).toBeNull()
  })
})
