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
 *   - scanRunBlockForGlobalRootDepInstalls(body, rootDeps, npmCiSeen) — flag a
 *     global / ad-hoc install of a package this repo already depends on
 *     (SMI-6944): root `overrides` never reach such a binary.
 *   - jobBoundaries / jobOf / jobNameOf — job-boundary helpers, shared with the
 *     tests so there is one implementation.
 *   - vercelInvocations(body) — every `vercel pull|build|deploy|dev` command word.
 *   - scanWorkflowSource(source, file, rootDeps) — Check 4 over one YAML source.
 *   - loadDirectDependencyNames(rootDir) — direct deps of root + every workspace.
 *   - NPM_CI_REGEX — predicate for "this block runs npm ci or npm install".
 *
 * Pure functions apart from `loadDirectDependencyNames`, the one file reader.
 *
 * @see scripts/ci/check-supply-chain-pins.mjs (calls these from auditWorkflowInstalls)
 * @see docs/internal/implementation/smi-4874-ci-pin-audit.md (Wave D rationale)
 * @see docs/internal/implementation/smi-6944-vercel-cli-from-lockfile.md
 */
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

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

// `npm i|install|add <args>` up to the next shell separator. The args are then
// tokenised by `scanNpmGlobalInstalls`, so quoting, flag order, a trailing `-g`,
// `--location=global` and the `add` verb are all handled in one place, and the
// pin rule and the root-dependency rule cannot diverge (SMI-6944).
// Anchored to start-of-token so `pnpm install` does not match.
const NPM_INSTALL_CMD_REGEX = /(?:^|[\s;&|(])npm\s+(?:i|install|add)(?=\s|$)([^|&;<>\n)]*)/g
// Flags that consume the NEXT token as a value, so it is not mistaken for a spec.
const VALUE_FLAGS = new Set(['--prefix', '--registry', '--userconfig', '--cache', '--workspace'])
// `npx [--yes|--no-install|-y|-p <pkg>] <pkg>[@<ver>]` — capture the first
// non-flag arg. Flags `-y`, `--yes`, `--no-install`, `--quiet` are skipped. An
// optional leading quote is allowed before the spec (SMI-6944): `npx "foo@latest"`.
const NPX_REGEX =
  /(?:^|[\s;&|])npx(?:\s+(?:-[a-zA-Z]+|--[a-z-]+(?:=\S+)?))*\s+["']?([^|&;<>\s'"]+)/g

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
 * Job boundaries of a workflow source: `[{ line, name }]`, 1-indexed, one entry
 * per `  <job-id>:` header under the top-level `jobs:` key. A composite
 * `action.yml` has no `jobs:`, so it yields `[]` and every line maps to job 0.
 */
export function jobBoundaries(source) {
  const boundaries = []
  const allLines = source.split('\n')
  let inJobs = false
  for (let i = 0; i < allLines.length; i++) {
    if (/^jobs:\s*$/.test(allLines[i])) {
      inJobs = true
      continue
    }
    if (!inJobs) continue
    // New top-level key at column 0 ends the jobs block.
    if (/^[a-zA-Z_][a-zA-Z0-9_-]*:/.test(allLines[i])) {
      inJobs = false
      continue
    }
    const m = allLines[i].match(/^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*$/)
    if (m) boundaries.push({ line: i + 1, name: m[1] })
  }
  return boundaries
}

/** Header line of the job containing `line` (0 when before any job). */
export function jobOf(boundaries, line) {
  let last = 0
  for (const b of boundaries) {
    if (b.line <= line) last = b.line
    else break
  }
  return last
}

/** Name of the job containing `line` ('' when before any job). */
export function jobNameOf(boundaries, line) {
  let name = ''
  for (const b of boundaries) {
    if (b.line <= line) name = b.name
    else break
  }
  return name
}

/**
 * Tokenise every `npm i|install|add` in a run block. Returns one entry per
 * command: `{ global, specs }`, where `specs` are the unquoted non-flag args.
 * `global` is true for `-g`, `--global`, a short-flag cluster containing `g`,
 * `--location=global` and `--location global`, in ANY position (SMI-6944).
 */
function scanNpmGlobalInstalls(body) {
  const out = []
  const flat = body.replace(/\\\n/g, ' ')
  NPM_INSTALL_CMD_REGEX.lastIndex = 0
  let m
  while ((m = NPM_INSTALL_CMD_REGEX.exec(flat)) !== null) {
    const tokens = m[1].trim().split(/\s+/).filter(Boolean)
    let global = false
    const specs = []
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (t === '--') continue
      if (t === '--global' || t === '--location=global' || /^-[a-zA-Z]*g[a-zA-Z]*$/.test(t)) {
        global = true
        continue
      }
      if (t === '--location') {
        if (tokens[i + 1] === 'global') global = true
        i++
        continue
      }
      if (VALUE_FLAGS.has(t)) {
        i++
        continue
      }
      if (t.startsWith('-')) continue
      const bare = t.replace(/^["']|["']$/g, '')
      if (!bare || /^[/.~]/.test(bare) || bare.includes('://')) continue
      specs.push(bare)
    }
    out.push({ global, specs })
  }
  return out
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

  for (const cmd of scanNpmGlobalInstalls(body)) {
    if (!cmd.global) continue
    for (const raw of cmd.specs) {
      const spec = parsePkgSpec(raw)
      if (!spec) continue
      if (!spec.version || !SEMVER_REGEX.test(spec.version.split(/[/?]/)[0])) {
        violations.push({
          command: 'npm i -g',
          pkg: raw,
          reason: spec.version
            ? `non-exact version "${spec.version}" — require @x.y.z`
            : 'no version pin — require @x.y.z',
        })
      }
    }
  }

  let m
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

/**
 * SMI-6944: flag a global / ad-hoc install of a package the repo already
 * depends on. A global install has no root package.json, so root `overrides`
 * never apply to it; the lockfile copy, run after `npm ci`, is the only copy
 * the overrides, `npm audit` and Dependabot govern.
 *
 * Catches `npm i|install|add -g|--global|--location=global <name>[@...]` (quoted
 * or not, any flag order) where <name> is in `rootDeps`, and `npx <name>@<ver>`
 * when no `npm ci` has run earlier in the job (it fetches outside the lockfile
 * tree the same way).
 *
 * @param {string} body
 * @param {Iterable<string>} rootDeps direct deps of root and every workspace
 * @param {boolean} [npmCiSeen=false]
 * @returns {Array<{ command: string, pkg: string, reason: string }>}
 */
export function scanRunBlockForGlobalRootDepInstalls(body, rootDeps, npmCiSeen = false) {
  const deps = rootDeps instanceof Set ? rootDeps : new Set(rootDeps)
  const out = []
  for (const cmd of scanNpmGlobalInstalls(body)) {
    if (!cmd.global) continue
    for (const raw of cmd.specs) {
      const spec = parsePkgSpec(raw)
      if (spec && deps.has(spec.name)) {
        out.push({ command: 'npm i -g', pkg: raw, reason: `\`${spec.name}\` is a repo dependency` })
      }
    }
  }
  if (!npmCiSeen) {
    let m
    NPX_REGEX.lastIndex = 0
    while ((m = NPX_REGEX.exec(body)) !== null) {
      const spec = parsePkgSpec(m[1])
      if (spec && spec.version && deps.has(spec.name)) {
        out.push({
          command: 'npx',
          pkg: m[1],
          reason: `\`${spec.name}\` is a repo dependency fetched with no \`npm ci\` earlier in the job`,
        })
      }
    }
  }
  return out
}

// `<command-word> pull|build|deploy|dev` where the word ends in `vercel`.
const VERCEL_INVOCATION_REGEX = /(\S*vercel"?)[ \t]+(pull|build|deploy|dev)\b/g

/** Every `vercel pull|build|deploy|dev` in a body: `[{ word, verb }]`. */
export function vercelInvocations(body) {
  const out = []
  VERCEL_INVOCATION_REGEX.lastIndex = 0
  let m
  while ((m = VERCEL_INVOCATION_REGEX.exec(body)) !== null) {
    out.push({ word: m[1].replace(/^.*\(/, ''), verb: m[2] })
  }
  return out
}

const PIN_REMEDIATION =
  'Pin to a literal exact semver (`npm i -g <pkg>@<x.y.z>`); a variable-version spec such as ' +
  '`<pkg>@$VAR` cannot be verified by this guard. If <pkg> is a dependency of this repo, do not ' +
  'install it globally: run the lockfile copy after `npm ci` (see scripts/ci/use-lockfile-vercel.sh).'
const NPX_REMEDIATION =
  'Either pin to exact semver (`npx <pkg>@<x.y.z>`), add to the allow-list in ' +
  'check-supply-chain-pins.helpers.mjs if this is a workspace devDep or self-test, or move the ' +
  'step after an `npm ci` step in the same job.'
const ROOT_DEP_REMEDIATION =
  'A global or ad-hoc install bypasses root `overrides`; run the lockfile copy after `npm ci` ' +
  '(see scripts/ci/use-lockfile-vercel.sh).'

/**
 * Check 4 over one workflow / composite-action source. Strips full-line YAML
 * comments, bins each `run:` block into its job, and tracks `npm ci` per job.
 *
 * @returns {{ findings: Array, runBlocks: number, vercelInvocationBlocks: number }}
 */
export function scanWorkflowSource(source, file, rootDeps) {
  const findings = []
  const cleaned = source
    .split('\n')
    .map((l) => (l.trimStart().startsWith('#') ? '' : l))
    .join('\n')
  const blocks = extractRunBlocks(cleaned)
  const boundaries = jobBoundaries(cleaned)
  const npmCiByJob = new Map()
  let vercelInvocationBlocks = 0
  for (const block of blocks) {
    const jobKey = jobOf(boundaries, block.line)
    const job = jobNameOf(boundaries, block.line)
    const where = `at line ${block.line}${job ? ` (job ${job})` : ''}`
    const npmCiSeen = npmCiByJob.get(jobKey) === true
    if (vercelInvocations(block.body).length > 0) vercelInvocationBlocks++
    for (const v of scanRunBlockForInstalls(block.body, npmCiSeen)) {
      findings.push({
        file,
        rule: 'workflow-install-pin',
        job,
        message: `${v.command} \`${v.pkg}\` ${where}: ${v.reason}`,
        remediation: v.command === 'npm i -g' ? PIN_REMEDIATION : NPX_REMEDIATION,
      })
    }
    for (const v of scanRunBlockForGlobalRootDepInstalls(block.body, rootDeps, npmCiSeen)) {
      findings.push({
        file,
        rule: 'workflow-global-root-dep-install',
        job,
        message: `${v.command} \`${v.pkg}\` ${where}: ${v.reason}`,
        remediation: ROOT_DEP_REMEDIATION,
      })
    }
    if (NPM_CI_REGEX.test(block.body)) npmCiByJob.set(jobKey, true)
  }
  return { findings, runBlocks: blocks.length, vercelInvocationBlocks }
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

/**
 * Names of every direct dependency (`dependencies` ∪ `devDependencies`) of the
 * root `package.json` and of every workspace manifest it lists.
 */
export function loadDirectDependencyNames(rootDir) {
  const names = new Set()
  const add = (pkg) => {
    for (const k of ['dependencies', 'devDependencies']) {
      for (const n of Object.keys(pkg[k] || {})) names.add(n)
    }
  }
  const root = readManifest(join(rootDir, 'package.json'))
  add(root)
  const ws = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages || []
  for (const pattern of ws) {
    const dirs = []
    if (pattern.endsWith('/*')) {
      const base = join(rootDir, pattern.slice(0, -2))
      if (existsSync(base)) {
        for (const e of readdirSync(base, { withFileTypes: true })) {
          if (e.isDirectory()) dirs.push(join(base, e.name))
        }
      }
    } else {
      dirs.push(join(rootDir, pattern))
    }
    for (const d of dirs) add(readManifest(join(d, 'package.json')))
  }
  return names
}
