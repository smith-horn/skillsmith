/**
 * SMI-5893 (Wave 7 Step 4): wiring for the CLI's root-level `--quiet`
 * option.
 *
 * Extracted from `index.ts`'s `preAction` hook (same pattern as
 * `startup-header-gate.ts`) so this tiny piece of process-level-state logic
 * is directly unit-testable without importing `index.ts` itself — that file
 * has a top-level `program.parse()` side effect that would try to interpret
 * the test runner's own argv as CLI commands.
 *
 * @module @skillsmith/cli/utils/quiet-mode-gate
 */

/**
 * Apply the root program's resolved `--quiet` option to the shared
 * `SKILLSMITH_QUIET` env var (`@skillsmith/core`'s `isQuietModeEnabled()`
 * gate, already honored by `probe.ts`/`createDatabase.ts`/`embeddings/index.ts`
 * and now also `search.action.ts`/`install.ts`/`registry-install.action.ts`/
 * `merge.ts`'s own `--quiet` fallbacks).
 *
 * Only SETS the env var when root's own `--quiet` was passed (`true`) —
 * never clears it — so an externally-set `SKILLSMITH_QUIET` (shell/CI) is
 * never clobbered by an invocation that didn't pass `--quiet` at all, and a
 * root `--quiet` from an earlier command in the same process never gets
 * silently un-set either.
 *
 * @param rootQuiet - `program.opts()['quiet']` at `preAction` time.
 */
export function applyRootQuietOption(rootQuiet: boolean | undefined): void {
  if (rootQuiet) {
    process.env['SKILLSMITH_QUIET'] = 'true'
  }
}
