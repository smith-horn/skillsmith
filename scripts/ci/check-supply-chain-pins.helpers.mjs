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
 *   - vercelInvocations(body) — every `vercel`/`vc` command word with its verb
 *     (the tokenizer lives in check-supply-chain-pins.commands.mjs).
 *   - rules `workflow-vercel-action` and
 *     `workflow-vercel-indirect-dispatch` (check-supply-chain-pins.vercel-dispatch.mjs).
 *   - scanWorkflowSource(source, file, rootDeps, lockVersions) — Check 4 over one YAML source.
 *   - loadDirectDependencyNames(rootDir) — direct deps of root + every workspace.
 *   - loadLockfileVersions(rootDir) — name -> version of the root lockfile's top-level installs.
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
import {
  packageCommands,
  vercelCalls,
  nonLockfileVercelCalls,
} from './check-supply-chain-pins.commands.mjs'
import { vercelAssignments, vercelUses } from './check-supply-chain-pins.vercel-dispatch.mjs'

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
 * Every global install in a run block: `[{ command, specs }]`. Backed by the
 * tokenizer, so flag order (`npm --global install`), the `add` verb, `pnpm add -g`,
 * `yarn global add` and a quoted spec are all handled in one place (SMI-6944).
 */
function scanGlobalInstalls(body) {
  return packageCommands(body)
    .filter((c) => c.kind === 'install' && c.global)
    .map((c) => ({ command: c.pm === 'npm' ? 'npm i -g' : `${c.pm} add -g`, specs: c.specs }))
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

  for (const cmd of scanGlobalInstalls(body)) {
    for (const raw of cmd.specs) {
      const spec = parsePkgSpec(raw)
      if (!spec) continue
      if (!spec.version || !SEMVER_REGEX.test(spec.version.split(/[/?]/)[0])) {
        violations.push({
          command: cmd.command,
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
 * SMI-6944: flag an install or ad-hoc run of a package the repo already depends
 * on that does not come from the lockfile tree. Root `overrides`, `npm audit` and
 * Dependabot govern only the lockfile copy, so each of these escapes them:
 *   - a global install (`npm i -g`, `npm --global install`, `pnpm add -g`,
 *     `yarn global add`, `bun add -g`), a variable spec included (it cannot be
 *     verified, so it is refused);
 *   - a `dlx`-style run (`pnpm dlx`, `yarn dlx`, `bunx`, `bun x`), always;
 *   - `npx` / `npm exec` / `npm x` with a version, when no `npm ci` ran earlier in
 *     the job OR the version is not the lockfile's;
 *   - a non-global install of a version other than the lockfile's after `npm ci`
 *     (`npm i --no-save <dep>@X`).
 *
 * @param {string} body
 * @param {Iterable<string>} rootDeps direct deps of root and every workspace
 * @param {boolean} [npmCiSeen=false]
 * @param {Map<string,string>} [lockVersions] lockfile versions; when omitted a
 *   version cannot be compared and only the no-`npm ci` condition applies
 * @returns {Array<{ command: string, pkg: string, reason: string }>}
 */
export function scanRunBlockForGlobalRootDepInstalls(
  body,
  rootDeps,
  npmCiSeen = false,
  lockVersions = undefined
) {
  const deps = rootDeps instanceof Set ? rootDeps : new Set(rootDeps)
  const out = []
  const differs = (name, version) => (lockVersions ? lockVersions.get(name) !== version : false)
  for (const cmd of packageCommands(body)) {
    const globalLabel = cmd.pm === 'npm' ? 'npm i -g' : `${cmd.pm} add -g`
    const runLabel = cmd.pm === 'npm' ? 'npm exec' : cmd.pm
    const label = cmd.kind === 'run' ? runLabel : cmd.global ? globalLabel : `${cmd.pm} install`
    for (const raw of cmd.specs) {
      const spec = parsePkgSpec(raw)
      const variable = raw.startsWith('$')
      const name = spec ? spec.name : ''
      const isDep = deps.has(name)
      const add = (reason) => out.push({ command: label, pkg: raw, reason })
      if (cmd.kind === 'install' && cmd.global) {
        if (variable) add('a variable package spec in a global install cannot be verified')
        else if (isDep) add(`\`${name}\` is a repo dependency`)
      } else if (cmd.kind === 'run' && cmd.fetchAlways) {
        if (variable) add('a variable package spec in a dlx-style run cannot be verified')
        else if (isDep) add(`\`${name}\` is a repo dependency fetched outside the lockfile tree`)
      } else if (cmd.kind === 'run') {
        if (isDep && spec.version && (!npmCiSeen || differs(name, spec.version))) {
          add(
            npmCiSeen
              ? `\`${name}@${spec.version}\` is not the lockfile version`
              : `\`${name}\` is a repo dependency fetched with no \`npm ci\` earlier in the job`
          )
        }
      } else if (
        npmCiSeen &&
        isDep &&
        spec.version &&
        (!lockVersions || differs(name, spec.version))
      ) {
        add(`\`${name}@${spec.version}\` replaces the lockfile copy installed by \`npm ci\``)
      }
    }
  }
  return out
}

/** Every `vercel`/`vc` command word in a body: `[{ word, verb }]`. */
export function vercelInvocations(body) {
  return vercelCalls(body)
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

const VERCEL_DISPATCH_REMEDIATION =
  'Run the lockfile CLI by its literal absolute path at each call site (no variable holding it, ' +
  "no third-party Vercel action), whatever the job's secrets are named; " +
  'see scripts/ci/use-lockfile-vercel.sh.'
const VERCEL_WORD_REMEDIATION =
  'Run the lockfile copy by its exact absolute path, "$GITHUB_WORKSPACE/node_modules/.bin/vercel", ' +
  'never a bare or aliased `vercel` / `vc` (see scripts/ci/use-lockfile-vercel.sh).'

/**
 * Check 4 over one workflow / composite-action source. Strips full-line YAML
 * comments, bins each `run:` block into its job, and tracks `npm ci` per job.
 *
 * @returns {{ findings: Array, runBlocks: number, vercelInvocationBlocks: number }}
 */
export function scanWorkflowSource(source, file, rootDeps, lockVersions = undefined) {
  const findings = []
  const cleaned = source
    .split('\n')
    .map((l) => (l.trimStart().startsWith('#') ? '' : l))
    .join('\n')
  const blocks = extractRunBlocks(cleaned)
  const boundaries = jobBoundaries(cleaned)
  const npmCiByJob = new Map()
  for (const u of vercelUses(cleaned)) {
    const job = jobNameOf(boundaries, u.line)
    findings.push({
      file,
      rule: 'workflow-vercel-action',
      job,
      message: `\`uses: ${u.ref}\` at line ${u.line}${job ? ` (job ${job})` : ''}: a Vercel action runs a CLI outside the lockfile`,
      remediation: VERCEL_DISPATCH_REMEDIATION,
    })
  }
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
    for (const v of scanRunBlockForGlobalRootDepInstalls(
      block.body,
      rootDeps,
      npmCiSeen,
      lockVersions
    )) {
      findings.push({
        file,
        rule: 'workflow-global-root-dep-install',
        job,
        message: `${v.command} \`${v.pkg}\` ${where}: ${v.reason}`,
        remediation: ROOT_DEP_REMEDIATION,
      })
    }
    for (const v of nonLockfileVercelCalls(block.body)) {
      findings.push({
        file,
        rule: 'workflow-vercel-command-word',
        job,
        message: `\`${v.word} ${v.verb}\` ${where}: the Vercel CLI command word is not the lockfile binary`,
        remediation: VERCEL_WORD_REMEDIATION,
      })
    }
    for (const a of vercelAssignments(block.body)) {
      findings.push({
        file,
        rule: 'workflow-vercel-indirect-dispatch',
        job,
        message: `\`${a.name}=${a.value}\` ${where}: a variable holding the Vercel CLI hides the command word from this check`,
        remediation: VERCEL_DISPATCH_REMEDIATION,
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

/**
 * name -> version for every top-level `node_modules/<name>` entry of the root
 * `package-lock.json` (empty Map when it cannot be read).
 */
export function loadLockfileVersions(rootDir) {
  const versions = new Map()
  const packages = readManifest(join(rootDir, 'package-lock.json')).packages || {}
  for (const [key, entry] of Object.entries(packages)) {
    const m = key.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)$/)
    if (m && entry && typeof entry.version === 'string') versions.set(m[1], entry.version)
  }
  return versions
}
