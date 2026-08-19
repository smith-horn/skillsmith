// SMI-5344 #2: standalone vscode-extension test config — the worktree-local path.
//
// Invoked by BOTH the root `test:vscode` script (`vitest run -c
// vitest.config.vscode.ts`) AND, as of SMI-6084, the vscode-extension
// package's own `test` script (`vitest run -c ../../vitest.config.vscode.ts`)
// — it is intentionally NOT named `vitest.config.ts` inside the package so
// package-relative `-c` and root-relative `-c` both resolve to this single
// file rather than a second, drifting copy. Before SMI-6084, `npm test
// --workspace=packages/vscode-extension` (the CI matrix job) fell through to
// the root `vitest.config.ts`'s root-relative globs and silently discovered 0
// files (`--passWithNoTests`); the matrix job now genuinely runs this suite
// (78 files / 896 tests), same as `publish-vscode.yml`'s pre-publish
// validation step. This duplicates the `Test (root colocated)` job's
// coverage of the same files — the same matrix+colocated duplication shape
// every other package already has, not new drift.
//
// Worktree correctness: unlike the root `vitest.config.ts`, this config does
// NOT exclude `.worktrees/**`. `root` is pinned to this file's own directory
// so the `include` glob resolves against the checkout that owns the config —
// the main repo when run from main, or the worktree copy when run from a
// worktree (each worktree carries its own copy of this committed file). The
// `**/*.int.test.ts` exclude byte-matches the root config so the 3
// `src/__tests__/integration/*.int.test.ts` suites stay excluded (they require
// @vscode/test-electron, not vitest — SMI-4194 / ADR-113).
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { sharedTestConfig } from './vitest.preset'

const configRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: configRoot,
  test: {
    ...sharedTestConfig,
    include: ['packages/vscode-extension/src/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Integration tests (*.int.test.ts) run via @vscode/test-electron on host
      // (SMI-4194). Byte-match the root vitest.config.ts exclude.
      '**/*.int.test.ts',
    ],
  },
  resolve: {
    alias: {
      // The panel suites import `marked` / `sanitize-html` (views/skill-panel-
      // content.ts). In a worktree these resolve through the per-package
      // node_modules symlink into the main checkout's tree; pin the search root
      // so resolution is deterministic regardless of invocation cwd.
      '@vscode-ext': resolve(configRoot, 'packages/vscode-extension/src'),
    },
  },
})
