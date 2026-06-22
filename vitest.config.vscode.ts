// SMI-5344 #2: standalone vscode-extension test config — the worktree-local path.
//
// Invoked ONLY by the root `test:vscode` script via `vitest run -c
// vitest.config.vscode.ts`. It is intentionally NOT named `vitest.config.ts`
// inside the package, so it never becomes the config that
// `npm test --workspace=packages/vscode-extension` (CI matrix job) resolves —
// that invocation keeps discovering 0 files (`--passWithNoTests`), and the
// real vscode unit run stays in the `Test (root colocated)` job via
// `vitest.config.colocated.ts`. CI discovery is therefore byte-identical to
// `main`; this config only adds a host-runnable, worktree-correct convenience.
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
