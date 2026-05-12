/**
 * Helpers for the SMI-4874 Wave D workflow-install audit (Check 4) extracted
 * from `check-supply-chain-pins.mjs` to keep that file under the 500-line
 * audit:standards ceiling.
 *
 * Exports:
 *   - WORKFLOW_INSTALL_ALLOWLIST — Set of pkg names that may appear unpinned
 *     in `npx <pkg>` invocations (self-tests of our own published packages
 *     + workspace-resolved devDeps).
 *   - parsePkgSpec(spec) — parse `foo@1.2.3` / `@scope/foo@1.2.3` / `foo`
 *   - extractRunBlocks(source) — pull every `run:` body (single + multi-line)
 *     from a workflow YAML in document order.
 *   - scanRunBlockForInstalls(body, npmCiSeen) — flag unpinned `npm i -g` /
 *     `npx` invocations within a single run block.
 *   - NPM_CI_REGEX — predicate for "this block runs npm ci or npm install".
 *
 * Pure functions, zero side effects, no I/O.
 *
 * @see scripts/ci/check-supply-chain-pins.mjs (calls these from auditWorkflowInstalls)
 * @see docs/internal/implementation/smi-4874-ci-pin-audit.md (Wave D rationale)
 */

const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

// Self-tests of our own published packages — intentionally floating to validate
// what end users see when they run `npx skillsmith` or `npx sklx`.
// Workspace-resolved devDeps — verified at plan time against root package.json
// (turbo, vitest, playwright, prettier, eslint, supabase) and packages/*
// (tsx). These resolve from node_modules/.bin once `npm ci` has run; the
// post-`npm ci` rule covers them in steps where `npm ci` precedes the
// `npx`. The allow-list catches the case where they appear in jobs that
// don't run `npm ci` (e.g. a fresh-install smoke test that bypasses workspace
// resolution). `jest` is intentionally NOT in this list — not a devDep
// anywhere in this repo.
export const WORKFLOW_INSTALL_ALLOWLIST = new Set([
  'skillsmith',
  'sklx',
  '@skillsmith/cli',
  '@skillsmith/mcp-server',
  'tsx',
  'turbo',
  'vitest',
  'playwright',
  'prettier',
  'eslint',
  'supabase',
])

// `npm i[nstall] [-g|--global] <pkg>[@<ver>]` — capture the full pkg spec.
// Anchored to start-of-token (whitespace or shell separator) to avoid false
// positives on substrings like `pnpm install`. `[^|&;<>\s'"]+` excludes shell
// metacharacters and quote boundaries so we don't drag trailing args into the
// pkg spec.
const NPM_INSTALL_GLOBAL_REGEX =
  /(?:^|[\s;&|])npm\s+i(?:nstall)?\s+(?:(?:-g|--global)\s+)([^|&;<>\s'"]+)/g
// `npx [--yes|--no-install|-y|-p <pkg>] <pkg>[@<ver>]` — capture the first
// non-flag arg. Flags `-y`, `--yes`, `--no-install`, `--quiet` are skipped.
const NPX_REGEX = /(?:^|[\s;&|])npx(?:\s+(?:-[a-zA-Z]+|--[a-z-]+(?:=\S+)?))*\s+([^|&;<>\s'"]+)/g

export const NPM_CI_REGEX = /(?:^|[\s;&|])npm\s+(?:ci|install)(?:\s|$)/

/**
 * Parse a package spec (`foo`, `foo@1.2.3`, `@scope/foo@1.2.3`, `@scope/foo`)
 * into { name, version }. Returns null for shell-like inputs.
 */
export function parsePkgSpec(spec) {
  if (!spec || spec.startsWith('-') || spec.startsWith('$') || spec.startsWith('"')) return null
  // Strip surrounding quotes the regex may have allowed in edge cases.
  const trimmed = spec.replace(/^["']|["']$/g, '')
  // Scoped: `@scope/name[@ver]`. Non-scoped: `name[@ver]`.
  if (trimmed.startsWith('@')) {
    const slashIdx = trimmed.indexOf('/')
    if (slashIdx < 0) return null
    const rest = trimmed.slice(slashIdx + 1)
    const atIdx = rest.indexOf('@')
    if (atIdx < 0) return { name: trimmed, version: null }
    return {
      name: trimmed.slice(0, slashIdx + 1 + atIdx),
      version: rest.slice(atIdx + 1),
    }
  }
  const atIdx = trimmed.indexOf('@')
  if (atIdx < 0) return { name: trimmed, version: null }
  return { name: trimmed.slice(0, atIdx), version: trimmed.slice(atIdx + 1) }
}

/**
 * Extract `run:` block bodies in order from a workflow YAML source.
 * Handles three forms:
 *   - `run: <single-line>`
 *   - `run: |` then indented block
 *   - `run: >-` then indented block
 *
 * Returns `[{ line, body }]` in document order. Line is 1-indexed and points
 * at the `run:` line.
 */
export function extractRunBlocks(source) {
  const lines = source.split('\n')
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/)
    if (!m) continue
    const indent = m[1].length
    const after = m[2]
    // Single-line form: `run: npm ci`
    if (after && after !== '|' && after !== '>-' && after !== '>' && after !== '|-') {
      blocks.push({ line: i + 1, body: after })
      continue
    }
    // Multi-line form: collect indented lines until indent drops to <= indent.
    const bodyLines = []
    let j = i + 1
    let blockIndent = -1
    while (j < lines.length) {
      const l = lines[j]
      if (l.trim() === '') {
        bodyLines.push('')
        j++
        continue
      }
      const lIndent = l.match(/^(\s*)/)[1].length
      if (lIndent <= indent) break
      if (blockIndent === -1) blockIndent = lIndent
      bodyLines.push(l.slice(Math.min(blockIndent, lIndent)))
      j++
    }
    blocks.push({ line: i + 1, body: bodyLines.join('\n') })
    i = j - 1
  }
  return blocks
}

/**
 * Scan a single run-block body for unpinned `npm i -g` / `npx` invocations.
 * `npmCiSeen` tells us whether a previous step in the same job has run
 * `npm ci` or `npm install` — if true, `npx <devdep>` resolves from the
 * workspace lockfile and is considered pinned.
 *
 * @returns {Array<{ command: string, pkg: string, reason: string }>}
 */
export function scanRunBlockForInstalls(body, npmCiSeen) {
  const violations = []

  NPM_INSTALL_GLOBAL_REGEX.lastIndex = 0
  let m
  while ((m = NPM_INSTALL_GLOBAL_REGEX.exec(body)) !== null) {
    const spec = parsePkgSpec(m[1])
    if (!spec) continue
    if (!spec.version || !SEMVER_REGEX.test(spec.version.split(/[/?]/)[0])) {
      violations.push({
        command: 'npm i -g',
        pkg: m[1],
        reason: spec.version
          ? `non-exact version "${spec.version}" — require @x.y.z`
          : 'no version pin — require @x.y.z',
      })
    }
  }

  NPX_REGEX.lastIndex = 0
  while ((m = NPX_REGEX.exec(body)) !== null) {
    const spec = parsePkgSpec(m[1])
    if (!spec) continue
    // Self-tests + workspace-resolved devDeps allow-list.
    if (WORKFLOW_INSTALL_ALLOWLIST.has(spec.name)) continue
    // Post-`npm ci`: resolves from lockfile, treat as pinned.
    if (npmCiSeen) continue
    if (!spec.version || !SEMVER_REGEX.test(spec.version.split(/[/?]/)[0])) {
      violations.push({
        command: 'npx',
        pkg: m[1],
        reason: spec.version
          ? `non-exact version "${spec.version}" — require @x.y.z, allow-list, or post-\`npm ci\``
          : 'no version pin — require @x.y.z, allow-list, or post-`npm ci`',
      })
    }
  }

  return violations
}
