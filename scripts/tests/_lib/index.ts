/**
 * SMI-4693 — barrel export for `scripts/tests/_lib/*`.
 *
 * Tests should import from the specific module (`./git-fixture-env`) rather
 * than the barrel; the barrel exists so `_lib/` is a recognised entrypoint
 * directory and so future helpers can be re-exported without breaking
 * existing imports.
 */
export { makeFixtureEnv, makeFixtureTempDir } from './git-fixture-env.js'
