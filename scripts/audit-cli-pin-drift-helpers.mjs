/**
 * Helpers for audit-standards.mjs Check 59 (CLI-tool pin invariants, SMI-5746).
 *
 * Four static invariants that keep CLI-tool version pins from silently
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
 * Sub-check 3: `.mcp.json`'s `ruflo` npx entry must pin an exact semver.
 * Deliberately scoped to `ruflo` only, not "every npx entry" — a git
 * worktree's `.mcp.json` gets auto-patched (skip-worktree, never committed)
 * to a bare unversioned `npx` command for `skillsmith`; that worktree-local
 * artifact is not a real invariant violation. See the plan doc's Review
 * Summary (Codex plan-review finding #2) for the full explanation.
 */
export function findUnpinnedRufloMcpEntry(mcpJsonPath) {
  if (!existsSync(mcpJsonPath)) return null
  let mcp
  try {
    mcp = JSON.parse(readFileSync(mcpJsonPath, 'utf8'))
  } catch {
    return null
  }
  const ruflo = mcp.mcpServers && mcp.mcpServers.ruflo
  if (!ruflo || ruflo.command !== 'npx') return null
  const args = ruflo.args || []
  const pkgArg = args[0] || ''
  const m = pkgArg.match(/^ruflo@(.+)$/)
  if (!m) return { reason: 'ruflo npx entry missing an @version suffix', pkgArg }
  const version = m[1]
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return { reason: `ruflo npx entry pinned to a non-exact-semver tag '${version}'`, pkgArg }
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
