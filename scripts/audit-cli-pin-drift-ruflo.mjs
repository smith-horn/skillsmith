/**
 * Ruflo pin invariants for audit-standards.mjs Check 59 (SMI-5746,
 * SMI-6744): sub-checks 3, 5 and 6. Moved out of
 * audit-cli-pin-drift-helpers.mjs to keep that file under the 500-line
 * limit (SMI-7241); it re-exports them, so every importer is unchanged. See
 * docs/internal/implementation/cli-tool-version-drift-remediation.md. These
 * helpers only detect; they never modify a pin.
 */

import { readFileSync, existsSync } from 'fs'

/**
 * The single place the launcher's RUFLO_CLI_PIN literal is read (M-F,
 * SMI-6744 A1.8 retro). Sub-checks 3 and 5 below both consume it, so
 * tightening or changing the pattern happens once. `scripts/cli-pin-drift-
 * check.sh` carries the ONLY other independent reader of this literal (a
 * shell grep against the same one-line assignment) — its own pattern must
 * be changed together with this one, since sub-check 3's own drift-
 * detection purpose extends to "the shell mirror still agrees with the JS
 * reader" as much as it does to "the pin itself is well-formed".
 */
function readRufloLauncherPin(launcherPath) {
  if (!existsSync(launcherPath)) {
    return { reason: `RUFLO_CLI_PIN launcher not found at ${launcherPath}` }
  }
  const m = readFileSync(launcherPath, 'utf8').match(/^RUFLO_CLI_PIN=(\S+)$/m)
  if (!m) return { reason: `RUFLO_CLI_PIN not found in ${launcherPath}` }
  return { pin: m[1] }
}

/**
 * Sub-check 3: `scripts/mcp-ruflo-launcher.sh` must define `RUFLO_CLI_PIN`
 * as a plain, anchored, exact-semver assignment (SMI-6744 ADR-170 § 7).
 *
 * The pin moved here from `.mcp.json`'s `ruflo` npx entry (SMI-5746's
 * original scope) once ADR-170 replaced that entry with a launcher script
 * that `docker exec`s into a lockfile-pinned, image-baked `@claude-flow/cli`
 * tree — there is no `npx` entry left to read a version out of. This check
 * reads the launcher's pin via the shared readRufloLauncherPin() above,
 * rather than skipping when a pin can't be found: an absent or malformed
 * pin is exactly the drift this check exists to catch, not a "nothing to
 * check" case.
 */
export function findUnpinnedRufloLauncherPin(launcherPath) {
  const { pin, reason } = readRufloLauncherPin(launcherPath)
  if (reason) {
    return { reason, launcherPath }
  }
  if (!/^\d+\.\d+\.\d+$/.test(pin)) {
    return {
      reason: `RUFLO_CLI_PIN '${pin}' in ${launcherPath} is not an exact semver`,
      launcherPath,
      pin,
    }
  }
  return null
}

/**
 * Sub-check 5 (SMI-6744 M-3, post-merge governance retro on PR #2931): the
 * @claude-flow/cli pin lives in TWO committed places that must never drift
 * apart -- scripts/mcp-ruflo-launcher.sh's RUFLO_CLI_PIN (what the launcher
 * authenticates the SERVED container's version against, ADR-170 § 7) and
 * scripts/ruflo-seed/package.json's dependencies["@claude-flow/cli"] (the
 * exact version actually baked into the `ruflo` image stage's seed tree by
 * `npm ci` against its committed lockfile). Sub-check 3 above validates only
 * that the launcher's OWN pin is a well-formed exact semver; this is a
 * DIFFERENT invariant -- that the two committed pins agree with each other
 * -- and needs both files to exist and parse before it can say anything, so
 * it is a separate function rather than folded into
 * findUnpinnedRufloLauncherPin's existing single-file contract. Returns
 * `null` only when both files exist, both pins parse, and the two values
 * are identical.
 */
export function findRufloSeedPinDrift(launcherPath, seedPackageJsonPath) {
  const { pin: launcherPin, reason } = readRufloLauncherPin(launcherPath)
  if (reason) {
    return { reason, launcherPath, seedPackageJsonPath }
  }

  if (!existsSync(seedPackageJsonPath)) {
    return {
      reason: `seed package.json not found at ${seedPackageJsonPath}`,
      launcherPath,
      seedPackageJsonPath,
      launcherPin,
    }
  }
  let seedPkg
  try {
    seedPkg = JSON.parse(readFileSync(seedPackageJsonPath, 'utf8'))
  } catch (err) {
    return {
      reason: `${seedPackageJsonPath} is not valid JSON (${err.message})`,
      launcherPath,
      seedPackageJsonPath,
      launcherPin,
    }
  }
  const seedPin = seedPkg && seedPkg.dependencies && seedPkg.dependencies['@claude-flow/cli']
  if (!seedPin) {
    return {
      reason: `${seedPackageJsonPath} has no dependencies["@claude-flow/cli"] entry`,
      launcherPath,
      seedPackageJsonPath,
      launcherPin,
    }
  }
  if (seedPin !== launcherPin) {
    return {
      reason: `RUFLO_CLI_PIN=${launcherPin} in ${launcherPath} does not match dependencies["@claude-flow/cli"]=${seedPin} in ${seedPackageJsonPath}`,
      launcherPath,
      seedPackageJsonPath,
      launcherPin,
      seedPin,
    }
  }
  return null
}

/**
 * Decodes a single-quoted JS string literal BODY (the text between, but not
 * including, the surrounding quotes) without eval/Function -- this file
 * only ever needs to resolve simple backslash escapes (\\, \', \n, ...)
 * out of a literal this repo itself wrote, so a full JS string grammar is
 * unnecessary. `\X` for any X not in the switch below decodes to X itself
 * (matches JS's own "unrecognized escape passes the character through"
 * behavior for the handful of escapes this constant actually uses, `\'`
 * and `\\`).
 */
function decodeSingleQuotedJsStringBody(raw) {
  return raw.replace(/\\(.)/g, (_, ch) => {
    switch (ch) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return '\r'
      default:
        return ch
    }
  })
}

/**
 * Sub-check 6 (rec 2, SMI-6744 A1.8 retro): scripts/ruflo-launch-guard.mjs's
 * PROC_SCAN_CMD_HINT constant is duplicated verbatim as prose in
 * .claude/development/claude-flow-guide.md (L-1, post-merge governance
 * retro on PR #2931) -- a comment-only convention that this check turns
 * into a gate, the same shape M-3/sub-check 5 above already applies to the
 * RUFLO_CLI_PIN pair. Extracts the guard's own single-quoted string literal
 * (handling its escapes with decodeSingleQuotedJsStringBody, never
 * eval/Function against file content) and asserts it appears verbatim
 * inside the guide's prose. Returns `null` only when both files exist, the
 * constant parses, and the exact literal is found in the guide.
 */
export function findProcScanCmdHintDrift(guardPath, guideMdPath) {
  if (!existsSync(guardPath)) {
    return { reason: `guard not found at ${guardPath}`, guardPath, guideMdPath }
  }
  const guardSrc = readFileSync(guardPath, 'utf8')
  const m = guardSrc.match(/const PROC_SCAN_CMD_HINT\s*=\s*\n?\s*'((?:\\.|[^'\\])*)'/)
  if (!m) {
    return {
      reason: `PROC_SCAN_CMD_HINT constant not found (or not a plain single-quoted string) in ${guardPath}`,
      guardPath,
      guideMdPath,
    }
  }
  const hintLiteral = decodeSingleQuotedJsStringBody(m[1])

  if (!existsSync(guideMdPath)) {
    return { reason: `guide not found at ${guideMdPath}`, guardPath, guideMdPath, hintLiteral }
  }
  const guideSrc = readFileSync(guideMdPath, 'utf8')
  if (!guideSrc.includes(hintLiteral)) {
    return {
      reason: `PROC_SCAN_CMD_HINT literal from ${guardPath} does not appear verbatim in ${guideMdPath} -- the two have drifted`,
      guardPath,
      guideMdPath,
      hintLiteral,
    }
  }
  return null
}
