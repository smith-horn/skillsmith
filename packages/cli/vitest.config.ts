// SMI-3502: CLI coverage thresholds intentionally omitted.
// Root config excludes packages/cli/** from aggregate coverage (CLI is integration-tested).
// CLI unit coverage is ~45% — insufficient for thresholds. E2E tests cover CLI behavior.
import { defineConfig } from 'vitest/config'
import { sharedTestConfig, coverageDefaults } from '../../vitest.preset'

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'src/**/*.spec.ts'],
    coverage: {
      ...coverageDefaults,
    },
  },
})
