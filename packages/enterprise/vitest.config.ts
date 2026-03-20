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
    coverage: {
      ...coverageDefaults,
      include: ['src/**/*.ts'],
      exclude: [...coverageExcludeDefaults, 'src/**/*.d.ts'],
      thresholds: {
        ...coverageThresholds,
      },
    },
  },
})
