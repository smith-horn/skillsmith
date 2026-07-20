import { defineConfig } from 'vitest/config'
import { sharedTestConfig, coverageDefaults } from '../../vitest.preset'

export default defineConfig({
  test: {
    ...sharedTestConfig,
    // SMI-5708 Item #8: this package has ~13 src/**/*.test.ts files
    // (rerank.test.ts, adapters/*.test.ts, retrieval-log/*.test.ts, etc.)
    // that the prior tests-only include silently skipped -- full CI wasn't
    // blind to them (the root `Test (root colocated)` job's
    // `packages/*/src/**/*.test.ts` glob already covers every package), but
    // this package's own matrix job's test-EXECUTION step and local
    // `npm test` here both missed them, breaking dev-loop parity. (Opus
    // review finding: this package has no `test:coverage` script, so its
    // per-package Codecov upload already silently no-ops via `|| true`
    // regardless of this fix -- a separate, pre-existing gap, out of this
    // item's scope, not something this change addresses or claims to.)
    // Matches packages/website/vitest.config.ts's existing src+tests
    // pattern.
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      ...coverageDefaults,
    },
  },
})
