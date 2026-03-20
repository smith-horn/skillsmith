/**
 * Vitest Configuration for Website Package
 *
 * SMI-1832: Test configuration for middleware tests
 *
 * Note: This is a separate config because the website uses Astro's TypeScript
 * configuration which isn't compatible with the root vitest config.
 * Tests here focus on pure utility functions extracted from Astro components.
 * No coverage thresholds — website is excluded from root coverage.
 */

import { defineConfig } from 'vitest/config'
import { sharedTestConfig } from '../../vitest.preset'

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Skip files that import Astro virtual modules
    alias: {
      // Prevent vitest from trying to resolve Astro virtual modules
      // The middleware.ts file is not tested directly - only middleware.utils.ts
    },
  },
})
