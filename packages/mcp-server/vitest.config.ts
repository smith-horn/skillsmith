/**
 * Vitest Configuration for Unit Tests
 */

import { defineConfig } from 'vitest/config'
import { sharedTestConfig, coverageDefaults } from '../../vitest.preset'

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**/*.integration.test.ts', 'tests/e2e/**'],
    coverage: {
      ...coverageDefaults,
    },
  },
})
