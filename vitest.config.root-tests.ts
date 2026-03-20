// SMI-3502: Config for root-level tests (scripts, supabase) that aren't in any workspace.
// Used by pre-push hook to run root tests without re-running package tests.
import { defineConfig } from 'vitest/config'
import { sharedTestConfig } from './vitest.preset'

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['scripts/tests/**/*.test.ts', 'supabase/functions/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'supabase/functions/indexer/**'],
  },
})
