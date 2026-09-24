/**
 * Helpers for audit-standards.mjs Check 59 (CLI-tool pin invariants, SMI-5746).
 *
 * Five static invariants that keep CLI-tool version pins from silently
 * drifting back to an unmonitored state — see
 * docs/internal/implementation/cli-tool-version-drift-remediation.md for the
 * full incident history and design rationale. This file only detects; it
 * never modifies a pin.
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * Sub-check 1: every `supabase/setup-cli` GitHub Action step must pin an
 * exact version (or a step-output expression resolving to one) — never
 * `version: latest` and never an omitted `version:` input.
 */
export function findFloatingSupabaseCliInstalls(workflowsDir) {
  const findings = []
  if (!existsSync(workflowsDir)) return findings

  for (const file of readdirSync(workflowsDir)) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue
    const filePath = join(workflowsDir, file)
    const lines = readFileSync(filePath, 'utf8').split('\n')

    lines.forEach((line, idx) => {
      if (!/uses:\s*supabase\/setup-cli@/.test(line)) return

      let versionLine = null
      for (let i = idx + 1; i < Math.min(idx + 8, lines.length); i++) {
        if (i !== idx + 1 && /^\s*-\s*(name|uses):/.test(lines[i])) break
        const m = lines[i].match(/^\s*version:\s*(.+?)\s*$/)
        if (m) {
          versionLine = m[1].trim().replace(/^['"]|['"]$/g, '')
          break
        }
      }

      if (versionLine === null || versionLine === 'latest') {
        findings.push({ file, line: idx + 1, versionLine })
      }
    })
  }
  return findings
}

/**
 * Sub-check 2: a bare `npx wrangler`/`npx supabase` invocation in a
 * package.json script is only safe when that tool is an exact-pinned
 * devDependency somewhere the invoking package's npm resolution would find
 * it (its own package.json, or the workspace root — npm hoists).
 */
export function findUnpinnedBareNpxCliInPackageJson(repoRoot) {
  const findings = []
  const WATCHED = ['wrangler', 'supabase']

  const rootPkgPath = join(repoRoot, 'package.json')
  const rootPkg = existsSync(rootPkgPath) ? JSON.parse(readFileSync(rootPkgPath, 'utf8')) : {}
  const rootDeps = { ...(rootPkg.devDependencies || {}), ...(rootPkg.dependencies || {}) }

  const packagesDir = join(repoRoot, 'packages')
  const pkgDirs = existsSync(packagesDir)
    ? readdirSync(packagesDir).filter((d) => existsSync(join(packagesDir, d, 'package.json')))
    : []

  const candidates = [{ label: 'package.json', path: rootPkgPath }]
  for (const d of pkgDirs) {
    candidates.push({
      label: `packages/${d}/package.json`,
      path: join(packagesDir, d, 'package.json'),
    })
  }

  for (const { label, path } of candidates) {
    let pkg
    try {
      pkg = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    const localDeps = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) }
    const scripts = pkg.scripts || {}

    for (const [scriptName, scriptBody] of Object.entries(scripts)) {
      for (const tool of WATCHED) {
        const bareRe = new RegExp(`(?:^|[\\s&|;])npx\\s+${tool}(?:@|\\s|$)`)
        const pinnedRe = new RegExp(`npx\\s+${tool}@`)
        if (bareRe.test(scriptBody) && !pinnedRe.test(scriptBody)) {
          const pinned = Boolean(localDeps[tool]) || Boolean(rootDeps[tool])
          if (!pinned) {
            findings.push({ file: label, script: scriptName, tool })
          }
        }
      }
    }
  }
  return findings
}

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

/**
 * Sub-check 4: no tracked file within the defined live-executable/config
 * surface reintroduces the pre-rename `npx claude-flow` invocation.
 * Explicitly excludes the vendored Ruflo reference-template library
 * (.claude/commands/**, .claude/agents/**) and historical planning docs
 * (scripts/prompts/**) — see Gap D in the plan doc for the full rationale.
 * Also excludes comment lines matching `@see SMI-\d+`, which describe past
 * migrations rather than live invocations.
 */
export function findClaudeFlowReintroductions(repoRoot) {
  const findings = []
  // Matches both shell-invocation form ("npx claude-flow") and YAML/JSON
  // array-element form ('npx', 'claude-flow', as in a docker-compose.yml
  // CMD healthcheck array) — a plain "npx claude-flow" substring match
  // would silently miss the exact array-syntax regression this check exists
  // to catch (found while writing this check's own test coverage).
  const pattern = /npx['",\s]+claude-flow/

  const scanFile = (relPath) => {
    const fullPath = join(repoRoot, relPath)
    if (!existsSync(fullPath)) return
    const lines = readFileSync(fullPath, 'utf8').split('\n')
    lines.forEach((line, idx) => {
      if (!pattern.test(line)) return
      if (/@see\s+SMI-\d+/.test(line)) return
      findings.push({ file: relPath, line: idx + 1 })
    })
  }

  const walkShellScripts = (dir, exclude) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = join(dir, entry.name)
      if (exclude && exclude(rel)) continue
      if (entry.isDirectory()) {
        walkShellScripts(rel, exclude)
      } else if (entry.name.endsWith('.sh')) {
        scanFile(rel.slice(repoRoot.length + 1))
      }
    }
  }

  walkShellScripts(join(repoRoot, 'scripts'), (p) => p.includes(`${join('scripts', 'prompts')}`))
  walkShellScripts(join(repoRoot, '.claude', 'helpers'), null)

  scanFile('.claude/settings.json')
  scanFile('docker-compose.yml')

  const packagesDir = join(repoRoot, 'packages')
  if (existsSync(packagesDir)) {
    for (const d of readdirSync(packagesDir)) {
      const srcDir = join(packagesDir, d, 'src')
      if (existsSync(srcDir)) {
        walkSrc(repoRoot, srcDir, scanFile)
      }
    }
  }

  return findings

  function walkSrc(root, dir, scan) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = join(dir, entry.name)
      if (entry.isDirectory()) {
        walkSrc(root, rel, scan)
      } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
        scan(rel.slice(root.length + 1))
      }
    }
  }
}
