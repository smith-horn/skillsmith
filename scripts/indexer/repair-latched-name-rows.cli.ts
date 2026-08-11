/**
 * SMI-5930 Wave 2: CLI argument parsing for repair-latched-name-rows.ts.
 *
 * Split out of repair-latched-name-rows.ts to stay under the 500-line CI
 * gate (same rationale as skill-installation.io.symlink.test.ts's own split
 * note) -- these three functions were the newest, most self-contained
 * addition (code-review pass, MEDIUM findings) and have no dependency on
 * anything else in the parent module.
 */

/**
 * A bare, space-separated flag value (`--log-path <value>`) must not itself
 * look like another recognized flag -- code-review finding, MEDIUM:
 * `--log-path --apply` previously silently took the literal string
 * `'--apply'` as the log path, discovering the mistake only after a batch
 * had already committed against prod. `--foo=bar` form is unaffected (the
 * value is unambiguously attached), only the bare-next-token form needs
 * this guard.
 */
export function isFlagLikeToken(token: string | undefined): boolean {
  return token !== undefined && token.startsWith('--')
}

/** Parse `--log-path <path>` / `--log-path=<path>` from argv. Throws on a missing/flag-like value. */
export function parseLogPathArg(argv: string[]): string | undefined {
  const idx = argv.findIndex((a) => a === '--log-path' || a.startsWith('--log-path='))
  if (idx === -1) return undefined
  const eq = argv[idx]?.split('=')[1]
  if (eq !== undefined) return eq
  const next = argv[idx + 1]
  if (next === undefined || isFlagLikeToken(next)) {
    throw new Error(
      `repair-latched-name-rows: --log-path requires a value (got ${
        next === undefined ? 'nothing' : `the flag-like token "${next}"`
      }) — use --log-path=<path> to disambiguate if the path itself starts with --.`
    )
  }
  return next
}

/** Parse `--batch-size <n>` / `--batch-size=<n>` from argv. Throws on a missing/malformed/fractional value. */
export function parseBatchSizeArg(argv: string[]): number | undefined {
  const idx = argv.findIndex((a) => a === '--batch-size' || a.startsWith('--batch-size='))
  if (idx === -1) return undefined
  const eq = argv[idx]?.split('=')[1]
  const raw = eq ?? (isFlagLikeToken(argv[idx + 1]) ? undefined : argv[idx + 1])
  if (raw === undefined) {
    throw new Error('repair-latched-name-rows: --batch-size requires a value')
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(
      `repair-latched-name-rows: --batch-size must be a whole number, got "${raw}" — refusing ` +
        `to silently floor a fractional value or fall back to the default.`
    )
  }
  return n
}
