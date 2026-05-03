// SMI-4652 Step 4b fallback: colocated `packages/*/src/**/*.test.ts` ONLY.
// Sibling to `vitest.config.root-tests.ts` — that config also includes
// `scripts/tests` + `supabase/functions`, which the original `Test (root)`
// PR-matrix job already runs via positional globs. Running both via the
// combined config in PR-matrix surfaces a process-level interaction
// (MaxListenersExceededWarning, post-test exit 1) that the local pre-push
// path doesn't hit. Splitting colocated into its own job sidesteps the
// interaction without re-introducing the SMI-3502 OOM failure mode.
//
// Used by `.github/workflows/ci.yml` `Test (root colocated)` step (gated
// to tier == 'code'). Pre-push and post-merge-verify continue to use
// `vitest.config.root-tests.ts` (combined).
import { defineConfig } from 'vitest/config'
import { sharedTestConfig } from './vitest.preset'

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.spec.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Website tests require Astro tsconfig
      'packages/website/**',
      // VS Code integration tests require the `vscode` module — run via @vscode/test-electron
      'packages/vscode-extension/src/__tests__/integration/**',
    ],
  },
})
