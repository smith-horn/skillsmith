#!/usr/bin/env node
/**
 * Supply-chain pin drift guard (SMI-3985).
 *
 * Enforces exact pinning for the three Wave 1 hardening surfaces that are NOT
 * covered by `Standards Compliance` (audit-standards Check 12, which only
 * covers packages/*\/package.json) or `Security Audit` (npm audit):
 *
 *   1. `.mcp.json` — no `@latest` in any command/args string.
 *   2. `supabase/functions/**\/*.ts` — esm.sh imports must be full semver (x.y.z).
 *      Git-crypt encrypted files (fork PRs without GIT_CRYPT_KEY) are counted
 *      and reported as a skipped-coverage warning to $GITHUB_STEP_SUMMARY but
 *      do NOT fail the check.
 *   3. `.github/workflows/**\/*.yml` — third-party actions (owner not in the
 *      first-party allowlist) must be pinned to a 40-char SHA.
 *
 * Deterministic: no network, no LLM, zero dependencies. Runs in < 500ms.
 *
 * @see docs/internal/implementation/supply-chain-hardening.md (Wave 1.5)
 * @see .github/workflows/ci.yml (`dependency-guard` job)
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const CI = !!process.env.GITHUB_ACTIONS
const SUMMARY = process.env.GITHUB_STEP_SUMMARY || ''

// ---------------------------------------------------------------------------
// First-party action owners that are allowed to use tag refs (`@v4`, `@main`).
// GitHub/Actions-owned actions are accepted as-is because they are signed by
// GitHub itself. Everything else MUST be SHA-pinned.
// ---------------------------------------------------------------------------
const FIRST_PARTY_OWNERS = new Set(['actions', 'github'])

const SHA_REGEX = /^[a-f0-9]{40}$/
const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const GITCRYPT_MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54])

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------
const findings = []
const warnings = []

function fail(file, rule, message, remediation) {
  findings.push({ file, rule, message, remediation })
}

function warn(file, rule, message) {
  warnings.push({ file, rule, message })
}

async function writeSummary(text) {
  if (!SUMMARY) return
  try {
    const { appendFileSync } = await import('fs')
    appendFileSync(SUMMARY, text + '\n')
  } catch {
    /* non-fatal in local runs */
  }
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
export function walk(dir, matcher, results = []) {
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const full = join(dir, entry)
    let s
    try {
      s = statSync(full)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      walk(full, matcher, results)
    } else if (s.isFile() && matcher(full)) {
      results.push(full)
    }
  }
  return results
}

export function isGitCryptEncrypted(absPath) {
  try {
    const fd = readFileSync(absPath)
    if (fd.length < GITCRYPT_MAGIC.length) return false
    return fd.subarray(0, GITCRYPT_MAGIC.length).equals(GITCRYPT_MAGIC)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Check 1: `.mcp.json` — no `@latest`
// ---------------------------------------------------------------------------
export function checkMcpJson(mcpPath) {
  const localFindings = []
  if (!existsSync(mcpPath)) return localFindings

  let raw
  try {
    raw = readFileSync(mcpPath, 'utf-8')
  } catch (err) {
    localFindings.push({
      file: '.mcp.json',
      rule: 'mcp-latest',
      message: `Failed to read .mcp.json: ${err.message}`,
      remediation: 'Check file permissions.',
    })
    return localFindings
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    localFindings.push({
      file: '.mcp.json',
      rule: 'mcp-latest',
      message: `Invalid JSON in .mcp.json: ${err.message}`,
      remediation: 'Run `jq . .mcp.json` to diagnose.',
    })
    return localFindings
  }

  // Recursively walk every string and flag `@latest`.
  const visit = (node, path) => {
    if (node == null) return
    if (typeof node === 'string') {
      if (node.includes('@latest')) {
        localFindings.push({
          file: '.mcp.json',
          rule: 'mcp-latest',
          message: `Found "${node}" at ${path} — @latest is banned (supply-chain drift).`,
          remediation: `Run \`npm view ${node.split('@latest')[0]} version\` to get the current version, then pin it explicitly.`,
        })
      }
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`))
      return
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        visit(v, path ? `${path}.${k}` : k)
      }
    }
  }
  visit(parsed, '')
  return localFindings
}

// ---------------------------------------------------------------------------
// Check 2: esm.sh imports in Supabase edge functions must be full semver.
// ---------------------------------------------------------------------------
const ESM_SH_IMPORT_REGEX = /from\s+['"]https:\/\/esm\.sh\/(@?[A-Za-z0-9][\w./-]*?)@([^'"]+)['"]/g

export function extractEsmShPins(source) {
  const pins = []
  let match
  // Reset regex state between calls (exec with /g is stateful).
  ESM_SH_IMPORT_REGEX.lastIndex = 0
  while ((match = ESM_SH_IMPORT_REGEX.exec(source)) !== null) {
    pins.push({ pkg: match[1], version: match[2] })
  }
  return pins
}

export function checkEsmShPin(pin) {
  // Strip any trailing path or query fragment (e.g. `2.47.0/dist-src`).
  const versionOnly = pin.version.split(/[/?]/)[0]
  if (!SEMVER_REGEX.test(versionOnly)) {
    return {
      ok: false,
      message: `esm.sh import "${pin.pkg}@${pin.version}" is not full semver (expected x.y.z).`,
      remediation: `Run \`npm view ${pin.pkg} version\` to get the latest x.y.z and pin it explicitly.`,
    }
  }
  return { ok: true }
}

export function checkSupabaseFunctions(rootDir) {
  const localFindings = []
  let encryptedCount = 0
  let scannedCount = 0

  const fnRoot = join(rootDir, 'supabase', 'functions')
  if (!existsSync(fnRoot)) return { findings: localFindings, encryptedCount, scannedCount }

  const tsFiles = walk(fnRoot, (p) => p.endsWith('.ts'))
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
    const pins = extractEsmShPins(source)
    for (const pin of pins) {
      const result = checkEsmShPin(pin)
      if (!result.ok) {
        localFindings.push({
          file: relative(rootDir, abs),
          rule: 'esm-sh-semver',
          message: result.message,
          remediation: result.remediation,
        })
      }
    }
  }
  return { findings: localFindings, encryptedCount, scannedCount }
}

// ---------------------------------------------------------------------------
// Check 3: Third-party GitHub Actions must be SHA-pinned.
// ---------------------------------------------------------------------------
// Matches `uses: owner/repo@ref` or `uses: owner/repo/path@ref`.
// Ignores local action refs (`uses: ./foo`) and Docker refs (`uses: docker://...`).
const USES_REGEX = /^\s*(?:-\s*)?uses:\s*['"]?([^\s'"#]+)['"]?/gm

export function parseUsesRef(line) {
  // Expected: `owner/repo[/path]@ref`
  const atIdx = line.lastIndexOf('@')
  if (atIdx < 0) return null
  const ownerRepo = line.slice(0, atIdx)
  const ref = line.slice(atIdx + 1)
  const slashIdx = ownerRepo.indexOf('/')
  if (slashIdx < 0) return null
  const owner = ownerRepo.slice(0, slashIdx)
  if (owner === '.' || owner === '..' || owner.startsWith('docker:')) return null
  return { owner, repo: ownerRepo.slice(slashIdx + 1), ref, raw: line }
}

export function checkWorkflowUses(ref) {
  if (FIRST_PARTY_OWNERS.has(ref.owner)) return { ok: true }
  if (SHA_REGEX.test(ref.ref)) return { ok: true }
  return {
    ok: false,
    message: `Third-party action "${ref.owner}/${ref.repo}@${ref.ref}" is not SHA-pinned.`,
    remediation: `Run \`gh api repos/${ref.owner}/${ref.repo}/git/refs/tags/${ref.ref} --jq '.object.sha'\` to resolve the SHA.`,
  }
}

export function checkWorkflows(rootDir) {
  const localFindings = []
  const wfRoot = join(rootDir, '.github', 'workflows')
  if (!existsSync(wfRoot)) return localFindings

  const ymlFiles = walk(wfRoot, (p) => p.endsWith('.yml') || p.endsWith('.yaml'))
  for (const abs of ymlFiles) {
    let source
    try {
      source = readFileSync(abs, 'utf-8')
    } catch {
      continue
    }
    // Strip full-line YAML comments before scanning so commented-out
    // examples don't trigger false positives.
    const cleaned = source
      .split('\n')
      .map((l) => (l.trimStart().startsWith('#') ? '' : l))
      .join('\n')

    USES_REGEX.lastIndex = 0
    let match
    while ((match = USES_REGEX.exec(cleaned)) !== null) {
      const ref = parseUsesRef(match[1])
      if (!ref) continue
      const result = checkWorkflowUses(ref)
      if (!result.ok) {
        localFindings.push({
          file: relative(rootDir, abs),
          rule: 'workflow-sha-pin',
          message: result.message,
          remediation: result.remediation,
        })
      }
    }
  }
  return localFindings
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------
export function formatFindingsMarkdown(all, esmStats) {
  const lines = []
  lines.push('## Supply-chain drift guard')
  lines.push('')
  if (all.length === 0) {
    lines.push('All three drift checks passed.')
  } else {
    lines.push(`Found **${all.length}** drift violation(s):`)
    lines.push('')
    lines.push('| File | Rule | Issue | Fix |')
    lines.push('|---|---|---|---|')
    for (const f of all) {
      // Escape backslashes first, then pipes, then newlines. Order matters:
      // if we escape `|` before `\`, a literal `\` in input would be re-escaped
      // into `\\` which could then be interpreted as an escape for the pipe we
      // just added. CodeQL js/incomplete-sanitization enforces this ordering.
      const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ')
      lines.push(
        `| \`${esc(f.file)}\` | ${esc(f.rule)} | ${esc(f.message)} | ${esc(f.remediation)} |`
      )
    }
  }
  if (esmStats && esmStats.encryptedCount > 0) {
    lines.push('')
    lines.push(
      `> esm.sh drift coverage skipped for ${esmStats.encryptedCount} encrypted file(s) — fork PR, \`GIT_CRYPT_KEY\` unavailable. Re-validated on post-merge push.`
    )
  }
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main (only when invoked directly, not during tests).
// ---------------------------------------------------------------------------
export async function main(rootDir = ROOT) {
  const mcpFindings = checkMcpJson(join(rootDir, '.mcp.json'))
  const esmResult = checkSupabaseFunctions(rootDir)
  const wfFindings = checkWorkflows(rootDir)
  const all = [...mcpFindings, ...esmResult.findings, ...wfFindings]

  const summary = formatFindingsMarkdown(all, {
    encryptedCount: esmResult.encryptedCount,
    scannedCount: esmResult.scannedCount,
  })
  await writeSummary(summary)

  if (esmResult.encryptedCount > 0) {
    console.warn(
      `[supply-chain] esm.sh drift coverage skipped for ${esmResult.encryptedCount} encrypted file(s) — fork PR, GIT_CRYPT_KEY unavailable.`
    )
  }

  if (all.length === 0) {
    console.log(
      `[supply-chain] OK — scanned ${esmResult.scannedCount} edge function .ts files, .mcp.json, and all workflow YAMLs.`
    )
    return 0
  }

  for (const f of all) {
    const annotation = `::error file=${f.file}::${f.message} ${f.remediation}`
    if (CI) console.log(annotation)
    else console.error(`  FAIL: ${f.file}: ${f.message}\n         ${f.remediation}`)
  }
  console.error(`[supply-chain] FAILED — ${all.length} drift violation(s).`)
  return 1
}

// Only run main() when this file is the entry point.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  main().then((code) => process.exit(code))
}
