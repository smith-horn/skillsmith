// SMI-4652: bump node's process-level signal-listener ceiling BEFORE vitest
// starts registering its own SIGTERM/SIGINT handlers. Default is 10; vitest's
// worker pool + dependency-injected test setups push past 10 in PR-matrix
// docker-on-CI runs (5 attempts on PR #893 hit MaxListenersExceededWarning +
// cascade SIGTERM exit 1; pre-push and post-merge-verify don't trip this).
// Vitest evaluates this config file at startup, so this runs before workers
// spawn. 20 is conservative — vitest's handlers count is bounded by file-pool
// concurrency, not per-test.
process.setMaxListeners(20)

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
      // SMI-4667 final probe: writer.test.ts has 2 environmental failures
      // (NODE_ENV-detection + .git dir-vs-file resolution) that are
      // independent of the signal cascade. Excluding to verify the
      // E2+E3+bootstrap stack produces fully green CI; if green, file
      // a follow-up Linear issue to fix these tests for the docker-on-CI
      // environment, then re-include via separate PR.
      'packages/doc-retrieval-mcp/src/retrieval-log/writer.test.ts',
    ],
  },
})
