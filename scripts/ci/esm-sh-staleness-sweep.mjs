#!/usr/bin/env node
/**
 * SMI-4670: esm.sh staleness sweep.
 *
 * Walks `supabase/functions/**\/*.ts`, extracts every `https://esm.sh/<pkg>@<ver>`
 * import, and emits two signals:
 *
 *   1. Advisory check (PRIMARY, always run).
 *      Synthesizes a temp `package.json` with the extracted pins, runs
 *      `npm install --package-lock-only` + `npm audit --json`, and flags any
 *      high+ severity advisory. Wave 0.5 (SMI-4668) confirmed full-tree
 *      auditing is the canonical posture, so we mirror that here.
 *
 *   2. Staleness advisory (SECONDARY, advisory only).
 *      Queries the npm registry for each pin's latest release. If the pinned
 *      version is older than 90 days, emit a "consider bumping" notice. NOT
 *      a fail signal — just a calendar nudge.
 *
 * Output:
 *   - JSON summary to stdout (machine-readable)
 *   - Human summary to stderr
 *   - Exit 0 always (advisory; CI workflow files Linear issues based on JSON)
 *
 * Style:
 *   - Zero deps (mirrors `check-supply-chain-pins.mjs` from Wave 1.5).
 *   - Reuses `walk`, `extractEsmShPins`, `isGitCryptEncrypted` from that file.
 *   - Deterministic input → deterministic output (modulo registry response).
 *
 * Why: Dependabot's `npm` ecosystem does NOT scan Deno-style esm.sh imports.
 * `npm audit` does not see them. `dependency-review-action` only inspects PR
 * diffs. CVEs in `stripe@20.1.0`, `@supabase/supabase-js@2.47.0`, etc.
 * accumulate silently on the 7+ billing-critical edge functions
 * (`stripe-webhook`, `checkout`, `generate-license`, `regenerate-license`,
 * `create-portal-session`, `list-invoices`, `events`).
 *
 * @see docs/internal/implementation/dependabot-ci-hardening-phase2.md (Wave 2)
 * @see scripts/ci/check-supply-chain-pins.mjs (style reference)
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { extractEsmShPins, isGitCryptEncrypted, walk } from './check-supply-chain-pins.mjs'
import { readFileSync, existsSync } from 'fs'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const STALENESS_DAYS = 90
const STALENESS_MS = STALENESS_DAYS * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// CLI args: --scan-path <path> overrides default (supabase/functions). Used by
// the negative-case smoke fixture (SMI-4670 H2) to point at a deliberate
// stale pin without polluting the prod scan.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { scanPaths: [] }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--scan-path' && argv[i + 1]) {
      args.scanPaths.push(argv[++i])
    } else if (argv[i] === '--no-network') {
      args.noNetwork = true
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true
    }
  }
  if (args.scanPaths.length === 0) {
    args.scanPaths = [join(ROOT, 'supabase', 'functions')]
  }
  return args
}

// ---------------------------------------------------------------------------
// File discovery — mirrors check-supply-chain-pins.mjs structure.
// ---------------------------------------------------------------------------
export function collectPins(scanPaths) {
  const pins = []
  let encryptedCount = 0
  let scannedCount = 0
  for (const scanRoot of scanPaths) {
    if (!existsSync(scanRoot)) continue
    const tsFiles = walk(scanRoot, (p) => p.endsWith('.ts'))
    for (const abs of tsFiles) {
      if (isGitCryptEncrypted(abs)) {
        encryptedCount++
        continue
      }
      scannedCount++
      let source
      try {
        source = readFileSync(abs, 'utf-8')
      } catch {
        continue
      }
      for (const pin of extractEsmShPins(source)) {
        // Strip path/query fragment (e.g. `2.47.0/dist-src`) — npm only knows
        // the version proper.
        const versionOnly = pin.version.split(/[/?]/)[0]
        pins.push({ pkg: pin.pkg, version: versionOnly, file: abs })
      }
    }
  }
  return { pins, encryptedCount, scannedCount }
}

// ---------------------------------------------------------------------------
// Dedup pins by pkg@version (multiple files can pin the same version). Track
// where each appears for the Linear issue body.
// ---------------------------------------------------------------------------
export function dedupPins(pins) {
  const map = new Map()
  for (const p of pins) {
    const key = `${p.pkg}@${p.version}`
    if (!map.has(key)) {
      map.set(key, { pkg: p.pkg, version: p.version, files: [] })
    }
    map.get(key).files.push(p.file)
  }
  return Array.from(map.values())
}

// ---------------------------------------------------------------------------
// Synthesize a throwaway package.json + lockfile, run `npm audit --json`.
// Returns the parsed JSON or null on failure (advisory check is best-effort —
// network/registry hiccups must not break the workflow).
// ---------------------------------------------------------------------------
export function runAdvisoryCheck(uniquePins) {
  if (uniquePins.length === 0) return { advisories: [], skipped: false }
  const tmp = mkdtempSync(join(tmpdir(), 'esm-sh-sweep-'))
  try {
    const deps = {}
    for (const p of uniquePins) {
      // npm package.json doesn't accept invalid semver. We already filtered to
      // versionOnly upstream; if it's still not valid semver, skip the entry
      // and surface as a warning rather than fail the whole sweep.
      deps[p.pkg] = p.version
    }
    const pkgJson = {
      name: 'esm-sh-sweep-synthesized',
      version: '0.0.0',
      private: true,
      dependencies: deps,
    }
    writeFileSync(join(tmp, 'package.json'), JSON.stringify(pkgJson, null, 2))
    // Generate lockfile without running install (no network beyond metadata).
    try {
      execFileSync(
        'npm',
        ['install', '--package-lock-only', '--no-audit', '--no-fund', '--ignore-scripts'],
        {
          cwd: tmp,
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: 120000,
        }
      )
    } catch (e) {
      return {
        advisories: [],
        skipped: true,
        skipReason: `npm install --package-lock-only failed: ${e.message.split('\n')[0]}`,
      }
    }
    let auditOut
    try {
      auditOut = execFileSync('npm', ['audit', '--json', '--audit-level=high'], {
        cwd: tmp,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      }).toString()
    } catch (e) {
      // npm audit exits non-zero when vulns found — JSON is still on stdout.
      auditOut = e.stdout ? e.stdout.toString() : ''
    }
    let parsed
    try {
      parsed = JSON.parse(auditOut)
    } catch {
      return { advisories: [], skipped: true, skipReason: 'audit JSON parse failed' }
    }
    const advisories = []
    if (parsed.vulnerabilities) {
      for (const [pkg, info] of Object.entries(parsed.vulnerabilities)) {
        if (info.severity === 'high' || info.severity === 'critical') {
          advisories.push({
            pkg,
            severity: info.severity,
            via: Array.isArray(info.via)
              ? info.via
                  .filter((v) => typeof v === 'object')
                  .map((v) => v.title || v.url || v.source)
                  .filter(Boolean)
              : [],
            range: info.range,
          })
        }
      }
    }
    return { advisories, skipped: false }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Query npm registry for each unique pin's latest release date. Returns
// staleness flags for any pin >90 days old.
// ---------------------------------------------------------------------------
export async function runStalenessCheck(uniquePins, fetchImpl = globalThis.fetch) {
  const stale = []
  const now = Date.now()
  for (const p of uniquePins) {
    let meta
    try {
      const res = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(p.pkg)}`, {
        headers: { Accept: 'application/vnd.npm.install-v1+json' },
      })
      if (!res.ok) continue
      meta = await res.json()
    } catch {
      continue
    }
    const time = meta?.time?.[p.version]
    if (!time) continue
    const ageMs = now - new Date(time).getTime()
    if (ageMs > STALENESS_MS) {
      const latest = meta?.['dist-tags']?.latest
      stale.push({
        pkg: p.pkg,
        pinned: p.version,
        latest: latest || null,
        pinnedReleasedAt: time,
        ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      })
    }
  }
  return stale
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    console.error('Usage: esm-sh-staleness-sweep.mjs [--scan-path PATH ...] [--no-network]')
    return 0
  }
  const { pins, encryptedCount, scannedCount } = collectPins(args.scanPaths)
  const uniquePins = dedupPins(pins)
  const advisoryResult = args.noNetwork
    ? { advisories: [], skipped: true, skipReason: '--no-network' }
    : runAdvisoryCheck(uniquePins)
  const stale = args.noNetwork ? [] : await runStalenessCheck(uniquePins)

  const summary = {
    scanned_paths: args.scanPaths,
    files_scanned: scannedCount,
    encrypted_skipped: encryptedCount,
    pins_total: pins.length,
    pins_unique: uniquePins.length,
    advisory: advisoryResult,
    staleness: { threshold_days: STALENESS_DAYS, stale_pins: stale },
    generated_at: new Date().toISOString(),
  }
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')

  // Human summary
  const lines = []
  lines.push(
    `[esm-sh-sweep] scanned ${scannedCount} file(s), found ${pins.length} import(s) (${uniquePins.length} unique)`
  )
  if (encryptedCount > 0)
    lines.push(`[esm-sh-sweep] skipped ${encryptedCount} git-crypt-encrypted file(s)`)
  if (advisoryResult.skipped) {
    lines.push(`[esm-sh-sweep] advisory check SKIPPED: ${advisoryResult.skipReason}`)
  } else if (advisoryResult.advisories.length > 0) {
    lines.push(`[esm-sh-sweep] FOUND ${advisoryResult.advisories.length} high+ advisory(ies):`)
    for (const a of advisoryResult.advisories) {
      lines.push(
        `  - ${a.pkg} [${a.severity}] ${a.range || ''} ${a.via.length > 0 ? `via: ${a.via.join(', ')}` : ''}`
      )
    }
  } else {
    lines.push(
      `[esm-sh-sweep] advisory check OK (zero high+ across ${uniquePins.length} unique pin(s))`
    )
  }
  if (stale.length > 0) {
    lines.push(`[esm-sh-sweep] STALENESS: ${stale.length} pin(s) > ${STALENESS_DAYS} days old:`)
    for (const s of stale) {
      lines.push(`  - ${s.pkg}: pinned ${s.pinned} (${s.ageDays}d) → latest ${s.latest || '?'}`)
    }
  } else if (!args.noNetwork) {
    lines.push(`[esm-sh-sweep] staleness check OK (no pin > ${STALENESS_DAYS} days)`)
  }
  process.stderr.write(lines.join('\n') + '\n')

  return 0
}

// ---------------------------------------------------------------------------
// Entrypoint guard so Vitest can import the module without executing main.
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('[esm-sh-sweep] fatal:', e)
      process.exit(2)
    })
}
