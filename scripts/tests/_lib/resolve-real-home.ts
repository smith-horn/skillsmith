/**
 * SMI-6514 finding 2 — resolves the "real $HOME captured before
 * vitest.setup.ts's SMI-6343 $HOME sandbox rewrite" value, guarding against
 * a DEFINED-BUT-EMPTY (or whitespace-only) env var being silently accepted.
 *
 * `process.env.X ?? fallback` only catches `undefined`. An empty string is a
 * defined, non-nullish value, so `??` passes it straight through unchanged.
 * For `SKILLSMITH_TEST_REAL_HOME` specifically, an empty string makes
 * `join('', '.claude/skills/plan-review-skill/agent-prompt.md')` resolve to
 * a RELATIVE path, which then resolves against `process.cwd()` — the repo
 * root under a normal vitest invocation — landing on the exact same file as
 * the PROJECT copy (`.claude/skills/plan-review-skill/agent-prompt.md`
 * relative to repo root). Both `existsSync()` checks then pass and a parity
 * test comparing "project copy" vs "global copy" silently compares the
 * project copy to itself. Confirmed live (`node -e`): `''` -> `''`, and
 * `join('', '.claude/skills/...')` is not absolute; `undefined` correctly
 * falls through to the real fallback.
 *
 * Unset (`undefined`) is the legitimate "no override, use the real home" case
 * and must keep working exactly as before — this only rejects a
 * DEFINED-but-empty/whitespace value, normalizing it to the same fallback
 * rather than silently trusting it.
 */
export function resolveRealHome(
  envValue: string | undefined,
  fallbackHomedir: () => string
): string {
  if (envValue !== undefined && envValue.trim().length > 0) {
    return envValue
  }
  return fallbackHomedir()
}
