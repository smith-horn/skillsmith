/**
 * @fileoverview SMI-6733 Phase 2 F5 — diff against a manifest whose
 * `installedSkills` classifies `ok` but is `null` (ADR-171 § 5's nullish
 * carve-out: byte-identical to absent in CAS canonical form). Before the
 * fix, `fetchLatestContent()`'s bare `manifest.installedSkills[skillName]`
 * subscript threw `TypeError: Cannot read properties of null (reading
 * '<skillName>')` — but unlike pin.ts/unpin.ts, that function's own
 * try/catch silently swallows the throw and returns `sourceTracked: true`,
 * so the user-visible symptom here is NOT a raw TypeError reaching the
 * terminal; it is a misleading "Check your network connection" message
 * instead of the accurate "Source not tracked ... run \`sklx audit
 * sources\`" hint. diff must now read through `installedSkillsOf()` so the
 * entry genuinely resolves to `undefined` and the accurate hint fires.
 * @see SMI-6733, docs/internal/adr/171-manifest-read-state-contract.md §5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ============================================================================
// Module mocks — must be declared before imports that use them
// ============================================================================

vi.mock('../utils/require-tier.js', () => ({
  requireTier: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../utils/sanitize.js', () => ({
  sanitizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

const mockLoadManifest = vi.fn()
vi.mock('../utils/manifest.js', () => ({
  loadManifest: () => mockLoadManifest(),
}))

// readFile resolves --old-content; real classifyChange/installedSkillsOf
// from @skillsmith/core are used unmocked (both are pure and side-effect-free).
// importOriginal + spread: @skillsmith/core's module graph (pulled in via
// diff.ts's `installedSkillsOf` import) reaches fs/promises' own `constants`
// export at load time (packages/core/src/utils/safe-fs.ts), so a mock that
// only defines `readFile` breaks module loading entirely.
const mockReadFile = vi.fn()
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readFile: (...args: unknown[]) => mockReadFile(...args),
  }
})

// ============================================================================
// Import after mocks
// ============================================================================

import { createDiffCommand } from './diff.js'

// ============================================================================
// Fixtures
// ============================================================================

const OLD_CONTENT = `---
name: test-skill
version: 1.0.0
---

## Overview

A test skill.
`

async function runCommand(
  cmd: Command,
  argv: string[]
): Promise<{ exitCode: number | null; consoleOutput: string[] }> {
  const output: string[] = []
  const exitCode: { value: number | null } = { value: null }

  const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    output.push(args.join(' '))
  })
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    output.push(args.join(' '))
  })
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    exitCode.value = typeof code === 'number' ? code : null
    throw new Error(`process.exit(${code})`)
  })

  try {
    await cmd.parseAsync(['node', 'test', ...argv])
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.startsWith('process.exit')) throw e
  } finally {
    consoleSpy.mockRestore()
    errorSpy.mockRestore()
    exitSpy.mockRestore()
  }

  return { exitCode: exitCode.value, consoleOutput: output }
}

// ============================================================================
// Tests
// ============================================================================

describe('diff against a manifest with installedSkills: null (SMI-6733 Phase 2 F5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('reports the accurate "source not tracked" error, not the generic network-failure fallback', async () => {
    mockLoadManifest.mockResolvedValue({ version: '1.0.0', installedSkills: null })
    mockReadFile.mockResolvedValue(OLD_CONTENT)

    const cmd = createDiffCommand()
    const { exitCode, consoleOutput } = await runCommand(cmd, [
      'test-skill',
      '--old-content',
      '/tmp/old-skill.md',
    ])

    // Positive assertion on the actual "no source tracked" output a real
    // entry with no `source` field already produces — not merely "did not
    // throw" (fetchLatestContent's own try/catch would make that pass even
    // unfixed, since it swallows the TypeError into the generic fallback
    // message below rather than letting it escape).
    expect(exitCode).toBe(1)
    const joined = consoleOutput.join(' ')
    expect(joined).toContain('Could not fetch latest version')
    expect(joined).toContain('Source not tracked')
    expect(joined).toContain('skill_recover_source')
  })
})
