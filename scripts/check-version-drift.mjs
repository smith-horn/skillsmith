#!/usr/bin/env node
/**
 * SMI-4205: Weekly version drift backstop.
 *
 * Compares local packages/\*\/package.json versions on main against
 * npm view <pkg> version for each publishable package. Emits a JSON
 * report to stdout with the shape:
 *   { drifted: [...], clean: [...], errors: [...] }
 *
 * Exits 0 iff drifted.length === 0 AND errors.length === 0.
 * A 404 from npm is treated as "unpublished" (clean, not an error).
 * Network/auth errors are fail-closed (errors[], exit 1).
 *
 * Intended for invocation from .github/workflows/version-drift-check.yml
 * and manual dispatch via `docker exec ... node scripts/check-version-drift.mjs`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGES_DIR = 'packages'

/**
 * Compare two 3-segment semver strings. Returns true iff a < b.
 * Accepts X.Y.Z only; pre-release suffixes are stripped before compare.
 * Invalid inputs return false (treated as equal) to avoid false drift.
 */
export function semverLt(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const parse = (s) => {
    const core = s.split(/[-+]/, 1)[0]
    const parts = core.split('.').map((n) => Number.parseInt(n, 10))
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null
    return parts
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] < pb[i]) return true
    if (pa[i] > pb[i]) return false
  }
  return false
}

/**
 * Load publishable packages from packages/*\/package.json.
 * Filters out entries with private === true.
 */
export function loadPackages(packagesDir = PACKAGES_DIR) {
  let entries = []
  try {
    entries = readdirSync(packagesDir)
  } catch {
    return []
  }
  const pkgs = []
  for (const name of entries) {
    const pjPath = join(packagesDir, name, 'package.json')
    try {
      if (!statSync(pjPath).isFile()) continue
    } catch {
      continue
    }
    try {
      const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
      if (
        pj &&
        pj.private !== true &&
        typeof pj.name === 'string' &&
        typeof pj.version === 'string'
      ) {
        pkgs.push({ name: pj.name, version: pj.version, dir: name })
      }
    } catch {
      // Malformed package.json — skip.
    }
  }
  return pkgs
}

/**
 * Run drift check against a set of packages. Pure-ish: the only side effect
 * is the `execFileSync` call, which the test file mocks via vi.mock.
 */
export function runDriftCheck(pkgs) {
  const report = { drifted: [], clean: [], errors: [] }
  for (const p of pkgs) {
    try {
      const latest = execFileSync('npm', ['view', p.name, 'version'], { encoding: 'utf8' }).trim()
      if (!latest) {
        report.clean.push({ pkg: p.name, local: p.version, note: 'unpublished' })
        continue
      }
      if (semverLt(p.version, latest)) {
        report.drifted.push({ pkg: p.name, local: p.version, npmLatest: latest })
      } else {
        report.clean.push({ pkg: p.name, local: p.version, npmLatest: latest })
      }
    } catch (e) {
      const stderr = (e.stderr || '').toString()
      if (
        /E404|404 Not Found/.test(stderr) ||
        (e.status === 1 && /not in this registry/i.test(stderr))
      ) {
        report.clean.push({ pkg: p.name, local: p.version, note: 'unpublished' })
      } else {
        report.errors.push({ pkg: p.name, error: String(e.message || e), stderr })
      }
    }
  }
  return report
}

async function main() {
  const pkgs = loadPackages()
  const report = runDriftCheck(pkgs)
  console.log(JSON.stringify(report, null, 2))
  const ok = report.drifted.length === 0 && report.errors.length === 0
  process.exit(ok ? 0 : 1)
}

// Only execute when run directly, not when imported by tests.
import { fileURLToPath } from 'node:url'
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
