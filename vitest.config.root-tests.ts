// SMI-3502: Config for tests that aren't in any workspace's vitest.config.ts.
// Used by pre-push hook to run root-level tests and colocated src/ tests
// without re-running workspace tests/ directories.
// Colocated src/ tests are here (not in package configs) because adding them
// to core's config caused CI OOM (147 files vs 120 with memory benchmarks).
import { defineConfig } from 'vitest/config'
import { sharedTestConfig } from './vitest.preset'

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: [
      // Root-level tests
      'scripts/tests/**/*.test.ts',
      'supabase/functions/**/*.test.ts',
      // Colocated package tests (src/**/*.test.ts, src/**/*.spec.ts)
      // These are in root config but not in per-package configs
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.spec.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'supabase/functions/indexer/**',
      // Website tests require Astro tsconfig
      'packages/website/**',
    ],
  },
})
