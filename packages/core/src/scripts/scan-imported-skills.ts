/**
 * SMI-864: Security Scanner for Imported Skills
 * SMI-1189: This file is now a thin wrapper for backwards compatibility.
 * SMI-6464: skill-scanner/index.ts's CLI invocation is now guarded by an
 * `import.meta.url` check (matching the convention used across this
 * directory's other CLI scripts), so importing it for its exports no
 * longer runs the CLI as a side effect. This shim now imports `main`
 * explicitly and runs its own equivalent guard below, so running this
 * file directly (e.g. via `npx tsx`) still executes the CLI identically,
 * while importing it for its exports is side-effect-free.
 *
 * The implementation has been refactored into modular files:
 * - packages/core/src/scripts/skill-scanner/
 *
 * Usage: npx tsx packages/core/src/scripts/scan-imported-skills.ts [path-to-imported-skills.json]
 *
 * For direct imports, use:
 * import { scanImportedSkills } from './skill-scanner/index.js'
 */

import { main } from './skill-scanner/index.js'

export * from './skill-scanner/index.js'

// Run if executed directly (mirrors skill-scanner/index.ts's own guard)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
}
