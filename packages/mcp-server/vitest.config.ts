/**
 * Vitest Configuration for Unit Tests
 */

import { defineConfig } from 'vitest/config'
import {
  sharedTestConfig,
  coverageDefaults,
  coverageThresholds,
  coverageExcludeDefaults,
} from '../../vitest.preset'

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['tests/integration/**/*.integration.test.ts', 'tests/e2e/**'],
    coverage: {
      ...coverageDefaults,
      exclude: [...coverageExcludeDefaults],
      thresholds: {
        ...coverageThresholds,
      },
    },
  },
})
