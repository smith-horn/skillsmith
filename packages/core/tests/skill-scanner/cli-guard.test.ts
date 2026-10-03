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

/**
 * Pin process.argv so a regression is detected DETERMINISTICALLY, not by
 * timing: if the module-load guard were removed, the unguarded `main()`
 * would run parseArgs synchronously during the dynamic import (an async
 * function body executes synchronously up to its first await), see
 * `--help`, and call `process.exit(0)` — tripping the spy before the
 * import even resolves. Without this pin, a broken build could scan the
 * real `data/imported-skills.json` from the vitest cwd and complete
 * WITHOUT ever calling process.exit, leaving the assertion green while
 * the side effect silently ran (silence-as-success, governance SMI-6433
 * check 2). argv[1] is also pinned to a path that matches neither
 * module's own file URL, so the guard itself must evaluate false.
 */
async function importPinned<T>(importer: () => Promise<T>): Promise<T> {
  const originalArgv = process.argv
  process.argv = [process.argv[0] ?? 'node', '/nonexistent-test-entry.js', '--help']
  try {
    return await importer()
  } finally {
    process.argv = originalArgv
  }
}

describe('SMI-6464: skill-scanner CLI import guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('importing skill-scanner/index.js does not invoke the CLI (no process.exit) and exports main + known symbols', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit should not be called on import')
    })

    const mod = await importPinned(() => import('../../src/scripts/skill-scanner/index.js'))

    expect(exitSpy).not.toHaveBeenCalled()
    expect(typeof mod.main).toBe('function')
    expect(typeof mod.DEFAULT_CONFIG).toBe('object')
    expect(typeof mod.scanImportedSkills).toBe('function')
  })

  it('importing scan-imported-skills.js does not invoke the CLI (no process.exit) and re-exports main + known symbols', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit should not be called on import')
    })

    const mod = await importPinned(() => import('../../src/scripts/scan-imported-skills.js'))

    expect(exitSpy).not.toHaveBeenCalled()
    expect(typeof mod.main).toBe('function')
    expect(typeof mod.DEFAULT_CONFIG).toBe('object')
    expect(typeof mod.scanImportedSkills).toBe('function')
  })
})
