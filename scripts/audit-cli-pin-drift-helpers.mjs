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

import { scanShellText } from './audit-shell-npx-cli-helpers.mjs'

// Sub-checks 3, 5 and 6 (the ruflo pins) live in audit-cli-pin-drift-ruflo.mjs.
export {
  findUnpinnedRufloLauncherPin,
  findRufloSeedPinDrift,
  findProcScanCmdHintDrift,
} from './audit-cli-pin-drift-ruflo.mjs'

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
 * Sub-check 2: an unpinned `npx wrangler`/`npx supabase` invocation in a
 * package.json script. A bare `npx tool` (no version) is safe only when the
 * tool is a dependency somewhere the invoking package's npm resolution would
 * find it (its own package.json, or the workspace root — npm hoists): npx
 * then runs that local copy. A call naming a version that is not exact
 * (`npx tool@latest`, `npx tool@3`, `npx -p tool@latest tool`) is flagged
 * even then, because npx fetches that spec instead of using the local copy
 * (owner decision, SMI-7241). An exact pin (`npx tool@2.107.0`) is never
 * flagged.
 * Calls are found with the shell sub-check's scanner (SMI-7241), so quoting
 * (`bash -c 'np''x supabase'`, `sh -c $'npx …'`) does not hide one, and a
 * comment that mentions npx is not a call. Runners such as concurrently and
 * nodemon execute their string arguments (`concurrently "npm run dev" "npx
 * supabase start"`, `nodemon --exec "tsc && npx wrangler dev"`), so every
 * quoted argument is also scanned as a script (`quotedArgs`); quoted prose
 * that mentions a call (`echo "run npx supabase start"`) is flagged as well,
 * since a miss costs more than a false positive here. Each tool is scanned
 * on its own, so a script calling both reports both.
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
      if (typeof scriptBody !== 'string') continue
      for (const tool of WATCHED) {
        const scan = (versioned) =>
          scanShellText(scriptBody, { tools: [tool], quotedArgs: true, versioned }).length > 0
        if (!scan(false)) continue
        const local = Boolean(localDeps[tool]) || Boolean(rootDeps[tool])
        if (!local || scan(true)) {
          findings.push({ file: label, script: scriptName, tool })
        }
      }
    }
  }
  return findings
}

/**
 * Finds the `permissions.deny` array's exact CHARACTER-OFFSET span
 * (inclusive of both the opening `[` and its matching `]`) within the
 * FULL raw file text `fileText` -- not a per-line scan (M-3 fix, SMI-6744
 * Wave 4 governance round, superseding the prior line-based
 * `findJsonArrayLineSpan`). Two defects the line-based version could not
 * fix without this rewrite:
 *
 *   1. A single-line array (`"deny": ["Bash(npx claude-flow)"]`) collapses
 *      `startLine === endLine` under line-number tracking, so the
 *      exemption below's `idx > startLine && idx < endLine` check can
 *      never be true for anything on that one line -- a legitimate deny
 *      entry written single-line was a FALSE POSITIVE. Character offsets
 *      have a real, comparable interior even within one line.
 *   2. Depth was only ever checked AFTER a full line finished scanning, so
 *      a same-line `], "allow": [` (deny's own close immediately followed
 *      by allow's own open) let allow's `[` re-increment depth back past
 *      zero before the end-of-line check ran, corrupting `endLine` into a
 *      FALSE NEGATIVE that swallowed allow's own content into deny's
 *      span. Depth is now checked immediately after every `]`,
 *      character-by-character, so the span always ends at the FIRST point
 *      depth returns to zero.
 *
 * The search for `"deny"` starts from the `"permissions"` key's own
 * offset (not the first bare `"deny":` text anywhere in the file) so an
 * UNRELATED earlier `"deny":` occurrence elsewhere in the file — a
 * different nested structure entirely — cannot be mistaken for
 * `permissions.deny`. String-literal contents are skipped while tracking
 * bracket depth, so a deny entry like "Bash(rg '[a-z]')" containing its
 * own literal brackets can never perturb the count. Returns null if
 * `"permissions"`/`"deny"` is never found, or the array never closes.
 * @param {string} fileText the FULL raw file text (not split into lines)
 * @returns {{startOffset: number, endOffset: number} | null} the `[` and
 *   matching `]` character offsets (inclusive)
 */
function findPermissionsDenySpan(fileText) {
  const permIdx = fileText.search(/"permissions"\s*:/)
  if (permIdx === -1) return null

  const denyKeyRe = /"deny"\s*:\s*\[/g
  denyKeyRe.lastIndex = permIdx
  const denyMatch = denyKeyRe.exec(fileText)
  if (!denyMatch) return null

  const openIdx = fileText.indexOf('[', denyMatch.index)
  if (openIdx === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = openIdx; i < fileText.length; i++) {
    const ch = fileText[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '[') {
      depth++
    } else if (ch === ']') {
      depth--
      if (depth === 0) return { startOffset: openIdx, endOffset: i }
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

  const scanFile = (relPath, denyLiterals) => {
    const fullPath = join(repoRoot, relPath)
    if (!existsSync(fullPath)) return
    const fileText = readFileSync(fullPath, 'utf8')
    const lines = fileText.split('\n')
    // M-3 fix (SMI-6744 Wave 4 governance round): the exemption below must
    // be POSITIONAL, computed once per file from the raw text via
    // CHARACTER OFFSETS (not line numbers -- see findPermissionsDenySpan's
    // own doc comment for why a line-based span was wrong for both a
    // single-line array and a same-line `], "allow": [`), never from the
    // already-parsed `permissions.deny` array's VALUES alone (SMI-6744
    // Wave 4 H-1: a value-only check wrongly exempted the identical
    // literal sitting in `allow` too).
    const denySpan =
      denyLiterals && denyLiterals.size > 0 ? findPermissionsDenySpan(fileText) : null

    let lineStartOffset = 0
    lines.forEach((line, idx) => {
      const matchIdx = line.search(pattern)
      if (matchIdx === -1 || /@see\s+SMI-\d+/.test(line)) {
        lineStartOffset += line.length + 1
        return
      }
      // A `.claude/settings.json` `permissions.deny` entry must literally
      // spell the banned command it blocks (e.g. "Bash(npx claude-flow)")
      // -- that is the opposite of "reintroduces npx claude-flow", so it
      // must not be flagged. Once `denySpan` is a real character-offset
      // range, ANYTHING positioned strictly between the array's own `[`
      // and `]` is necessarily part of one of its own JSON string
      // elements (nothing else can legally occupy that span), so the
      // offset check alone is sufficient -- no separate per-line
      // JSON.parse-and-compare-to-denyLiterals step is needed (that step
      // could never exempt a single-line array's own entry anyway, since
      // the whole `"deny": [...]` text on one line never parses as a bare
      // JSON string on its own).
      const absoluteMatchOffset = lineStartOffset + matchIdx
      const insideDeny =
        denySpan &&
        absoluteMatchOffset > denySpan.startOffset &&
        absoluteMatchOffset < denySpan.endOffset
      if (!insideDeny) {
        findings.push({ file: relPath, line: idx + 1 })
      }
      lineStartOffset += line.length + 1
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

  const settingsJsonPath = join(repoRoot, '.claude', 'settings.json')
  let denyLiterals = new Set()
  if (existsSync(settingsJsonPath)) {
    try {
      const parsedSettings = JSON.parse(readFileSync(settingsJsonPath, 'utf8'))
      const denyArr =
        parsedSettings && parsedSettings.permissions && parsedSettings.permissions.deny
      if (Array.isArray(denyArr)) denyLiterals = new Set(denyArr)
    } catch {
      // Malformed settings.json: fall through with an empty exemption set,
      // matching this check's pre-existing behavior of flagging every match
      // when the file cannot be parsed as JSON.
    }
  }
  scanFile('.claude/settings.json', denyLiterals)
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
