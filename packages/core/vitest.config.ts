import { defineConfig } from 'vitest/config'
import { sharedTestConfig, coverageDefaults } from '../../vitest.preset'

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['tests/**/*.test.ts'],
    coverage: {
      ...coverageDefaults,
    },
  },
})
