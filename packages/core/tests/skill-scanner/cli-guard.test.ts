/**
 * SMI-6464: skill-scanner/index.ts CLI-invocation-as-import-side-effect guard.
 *
 * Before this fix, `skill-scanner/index.ts` invoked its `main()` CLI entry
 * point unconditionally at module-load time (no `import.meta.url` guard),
 * so any importer pulling in this module purely for its barrel exports
 * (types, categorizer, trust-scorer, file-scanner, logger, reporter,
 * scanner) would also trigger a real CLI run — reading
 * `./data/imported-skills.json` relative to the process cwd and
 * potentially calling `process.exit(1)` out from under the importer.
 * `scan-imported-skills.ts` (the production entry point invoked by
 * `.github/workflows/weekly-security-scan.yml`) re-exported this module
 * via a bare side-effect `import`, relying on exactly that behavior.
 *
 * Both files now guard their CLI invocation with the same
 * `import.meta.url === \`file://${process.argv[1]}\`` check already used by
 * sibling scripts (e.g. merge-skills.ts:337), and both export `main` so a
 * caller can invoke the CLI explicitly. This test proves dynamically
 * importing either module for its exports is now side-effect-free: no
 * `process.exit` call, and the known barrel exports resolve normally.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

describe('SMI-6464: skill-scanner CLI import guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('importing skill-scanner/index.js does not invoke the CLI (no process.exit) and exports main + known symbols', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit should not be called on import')
    })

    const mod = await import('../../src/scripts/skill-scanner/index.js')

    // The old side effect was an async main() call — give it a moment to
    // settle so a regression (unconditional invocation) would surface here
    // rather than in an unrelated later test.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(exitSpy).not.toHaveBeenCalled()
    expect(typeof mod.main).toBe('function')
    expect(typeof mod.DEFAULT_CONFIG).toBe('object')
    expect(typeof mod.scanImportedSkills).toBe('function')
  })

  it('importing scan-imported-skills.js does not invoke the CLI (no process.exit) and re-exports main + known symbols', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit should not be called on import')
    })

    const mod = await import('../../src/scripts/scan-imported-skills.js')

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(exitSpy).not.toHaveBeenCalled()
    expect(typeof mod.main).toBe('function')
    expect(typeof mod.DEFAULT_CONFIG).toBe('object')
    expect(typeof mod.scanImportedSkills).toBe('function')
  })
})
