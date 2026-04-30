import { defineConfig } from 'vitest/config'
import { sharedTestConfig, coverageDefaults } from '../../vitest.preset'

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: [
      'tests/**/*.test.ts',
      // SMI-4557: cover tree-sitter colocated tests in PR matrix to catch
      // dependabot bumps to web-tree-sitter / tree-sitter-* deps before merge.
      // Carve-out from SMI-3502 split — small subtree (~4 files), no CI OOM risk.
      'src/analysis/tree-sitter/**/*.test.ts',
    ],
    coverage: {
      ...coverageDefaults,
    },
  },
})
