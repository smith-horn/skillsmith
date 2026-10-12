/**
 * Check 76 for seed lockfiles (SMI-6954, ADR-176 section 6). A seed is a tracked
 * package-lock.json other than the root one, built into a local-only service image (today
 * the MCP service seed under scripts/), so neither the root overrides nor the production
 * audit gate reach it. The registry records it under `seeds["<lockfile path>"]`, with the
 * same `overrides` / `acceptances` shapes as the root, and this module checks:
 *
 * - completeness: every tracked lockfile but the root has a `seeds` entry, so deleting the
 *   section fails. The set comes from `git ls-files`. When git cannot list it (a worktree dev
 *   container's .git names an unmounted host path), a filesystem walk from the root finds every
 *   file named exactly package-lock.json instead (owner decision), skipping only node_modules,
 *   .git and .worktrees, never following symlinks, so it finds a superset of what git would list
 *   apart from those three directories, where git mode (the mode CI runs in) FAILS any tracked
 *   lockfile as "not a permitted lockfile location", so the skip only hides paths already rejected
 *   (a tracked lockfile under dist/, coverage/ or tests/fixtures/ is not missed; the tracked
 *   fixture lockfiles are named *.package-lock.json, which the exact-name match excludes); the
 *   output then says "tracked lockfiles from a file scan: git unavailable". The walk also counts
 *   UNTRACKED lockfiles (a stray one in a scratch directory needs a seeds entry or deleting
 *   before the check passes there); that is accepted, since it can only add failures. If both
 *   git and the walk fail, the check is NOT EVALUATED, never a pass;
 * - each key is a repo-relative, tracked `.../package-lock.json`;
 * - the section's overrides match that seed's package.json, and its acceptances pass the
 *   root acceptance checks with the seed scope rule: `scope: "seed"`, tier R3 or R4, a
 *   seed R4 must carry `pinnedBy`, and the package need only be in the seed lockfile;
 * - an advisory is accepted at most once per section (the root and a seed may share one).
 *
 * The checkers are injected by audit-dependency-registry-helpers.mjs so the two modules
 * do not import each other. Import closure: node builtins and repo files only.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hasOwn, lockProblem } from './audit-dependency-registry-fields.mjs'
import { gitDiscoveryScrubbedEnv } from './lib/git-discovery-env.mjs'

const REGISTRY = '.github/dependency-registry.json'
const SEED_TIERS = Object.freeze(['R3', 'R4'])
const f = (message, fix) => ({ severity: 'fail', message, fix })
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const FORBIDDEN_LOCATION =
  'is not a permitted lockfile location (under node_modules/ or .worktrees/)'
const inForbiddenDir = (p) => p.split('/').some((s) => s === 'node_modules' || s === '.worktrees')

/** Why `key` cannot name a seed lockfile, or null. */
export function seedKeyProblem(key) {
  if (key === 'package-lock.json') return 'is the root lockfile, which the top-level sections cover'
  if (!key.endsWith('/package-lock.json')) return 'does not end in "/package-lock.json"'
  if (/[\x00-\x1f\x7f]/.test(key)) return 'contains a control character (newline, tab, ...)'
  if (key.startsWith('/') || /^[A-Za-z]:/.test(key) || key.includes('\\')) {
    return 'is not a repo-relative POSIX path'
  }
  if (key.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return 'has an empty, "." or ".." segment'
  }
  if (inForbiddenDir(key)) return FORBIDDEN_LOCATION
  return null
}

/** Tracked package-lock.json paths, repo-relative; null (never []) when git cannot list them. */
export function listTrackedLockfiles(root) {
  // The scrubbed env stops an inherited GIT_DIR (git hooks in a linked worktree export it) from
  // answering about another repository; `core.fsmonitor=false` stops a repo-configured fsmonitor
  // hook from executing during this read (SMI-6994).
  const r = spawnSync(
    'git',
    ['-c', 'core.fsmonitor=false', 'ls-files', '-z', '--', ':(glob)**/package-lock.json'],
    { cwd: root, encoding: 'utf8', env: gitDiscoveryScrubbedEnv() }
  )
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null
  return r.stdout.split('\0').filter(Boolean)
}

const SCAN_SKIP = new Set(['node_modules', '.git', '.worktrees'])
export const SCAN_NOTE = ' (tracked lockfiles from a file scan: git unavailable)'

/**
 * Fallback for listTrackedLockfiles: every file named exactly package-lock.json under `root`,
 * repo-relative and sorted. Directory entries are read without following symlinks (a symlink
 * is neither isDirectory() nor isFile() here). Any unreadable directory makes the whole scan
 * null: a partial listing could hide a lockfile, so it never stands in for a complete one.
 */
export function scanLockfiles(root) {
  const found = []
  const walk = (rel) => {
    const entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true })
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SCAN_SKIP.has(e.name)) continue
        walk(child)
      } else if (e.isFile() && e.name === 'package-lock.json') {
        found.push(child)
      }
    }
  }
  try {
    walk('')
  } catch {
    return null
  }
  return found.sort()
}

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** The parsed `seeds` object of the registry text, or undefined when absent or unusable. */
function seedsOf(registryText) {
  try {
    const seeds = JSON.parse(registryText).seeds
    return isPlainObject(seeds) ? seeds : undefined
  } catch {
    return undefined
  }
}

/** Seed inputs for readDependencyRegistryInputs: the tracked lockfiles and each seed's files. */
export function readSeedRegistryInputs(root, registryText) {
  const seedInputs = {}
  for (const key of Object.keys(seedsOf(registryText) ?? {})) {
    if (seedKeyProblem(key)) continue // never read a path the key check rejects
    seedInputs[key] = {
      pkg: readJson(join(root, dirname(key), 'package.json')),
      lock: readJson(join(root, key)),
    }
  }
  const fromGit = listTrackedLockfiles(root)
  if (fromGit !== null) return { trackedLockfiles: fromGit, lockfileSource: 'git', seedInputs }
  const scanned = scanLockfiles(root)
  return { trackedLockfiles: scanned, lockfileSource: scanned ? 'scan' : null, seedInputs }
}

/** `--list-seeds`: the registry's seed keys, or an error string. */
export function listSeedKeys(root = '.') {
  let registry
  try {
    registry = JSON.parse(readFileSync(join(root, REGISTRY), 'utf8'))
  } catch (err) {
    return { error: `cannot read ${REGISTRY} (${err.message})` }
  }
  if (registry?.seeds === undefined) return { keys: [] }
  if (!isPlainObject(registry.seeds)) return { error: `"seeds" in ${REGISTRY} is not an object` }
  return { keys: Object.keys(registry.seeds) }
}

/** Re-labels a root-shaped finding for seed `key`: `Check 76:` becomes `Check 76 [key]:`. */
const relabel = (key) => (x) => ({
  ...x,
  message: x.message.replace(/^Check 76:/, `Check 76 [${key}]:`),
  fix: x.fix ? `${x.fix} (in ${REGISTRY} seeds["${key}"])` : x.fix,
})

function checkSection(key, section, inp, input, checkers, windowEntries) {
  const out = []
  const counts = { overrides: 0, acceptances: 0 }
  const notEvaluated = (why) => [f(`Check 76: NOT EVALUATED - ${why}`)]
  if (
    !isPlainObject(section) ||
    !isPlainObject(section.overrides) ||
    !Array.isArray(section.acceptances)
  ) {
    return {
      out: [f('Check 76: the seed section lacks an "overrides" object and an "acceptances" array')],
      counts,
    }
  }
  const dir = dirname(key)
  if (!inp || !inp.pkg || typeof inp.pkg !== 'object') {
    return { out: notEvaluated(`${dir}/package.json is missing or unparseable`), counts }
  }
  if (!inp.lock || typeof inp.lock !== 'object') {
    return { out: notEvaluated(`${key} is missing or unparseable`), counts }
  }
  const lockWhy = lockProblem(inp.lock)
  if (lockWhy) return { out: notEvaluated(`${key}: ${lockWhy}`), counts }
  checkers.checkOverrides({ pkg: inp.pkg, registry: section }, out)
  counts.overrides = Object.keys(section.overrides).length
  counts.acceptances = section.acceptances.length
  const ctx = { ...input, lock: inp.lock, scopeRule: 'seed', label: key }
  const seen = new Set()
  for (const a of section.acceptances) {
    checkers.checkAcceptance(a, ctx, out, windowEntries)
    if (!a || typeof a !== 'object') continue
    // An unknown tier is already a failure in checkAcceptance; R1 and R2 are valid root tiers
    // that the seed rule (owner decision 1) rejects.
    if (['R1', 'R2'].includes(a.tier)) {
      out.push(
        f(
          `Check 76: seed acceptance ${a.advisory} (${a.package}) tier ${a.tier} is not allowed; a seed acceptance must be ${SEED_TIERS.join(' or ')} (ADR-176 section 6: the seed serves locally with no network and no secrets)`,
          'Use R3 (local-only, 90 days) or R4 (code never executes, 180 days, with pinnedBy)'
        )
      )
    }
    if (typeof a.advisory === 'string') {
      if (seen.has(a.advisory)) {
        out.push(
          f(
            `Check 76: advisory ${a.advisory} is accepted twice`,
            'Keep one acceptance per advisory'
          )
        )
      }
      seen.add(a.advisory)
    }
  }
  return { out, counts }
}

/**
 * Evaluates `registry.seeds` and the tracked-lockfile completeness rule.
 * @param {object} registry parsed registry
 * @param {object} input the evaluator input (`trackedLockfiles`, `seedInputs`, `today`, `root`, `exists`)
 * @param {{checkOverrides: Function, checkAcceptance: Function}} checkers the root checkers
 * @returns {{findings: Array, windowEntries: Array, examined: {seedSections: number, seedOverrides: number, seedAcceptances: number}}}
 */
export function evaluateSeedSections(registry, input, checkers) {
  const findings = []
  const windowEntries = []
  const tracked = Array.isArray(input.trackedLockfiles) ? input.trackedLockfiles : null
  const note = tracked !== null && input.lockfileSource === 'scan' ? SCAN_NOTE : ''
  const examined = { seedSections: 0, seedOverrides: 0, seedAcceptances: 0, lockfileNote: note }
  let seeds = registry.seeds ?? {}
  if (!isPlainObject(seeds)) {
    findings.push(
      f(
        `Check 76: "seeds" must be an object keyed by seed lockfile path in ${REGISTRY}`,
        'Make "seeds" an object: { "<dir>/package-lock.json": { "overrides": {}, "acceptances": [] } }'
      )
    )
    seeds = {}
  }
  if (tracked === null) {
    findings.push(
      f(
        'Check 76: NOT EVALUATED - cannot list tracked lockfiles (git ls-files failed, and so did the file scan), so seed completeness is unchecked',
        'Run where git can read the repository (CI, the host checkout, or a container with a real .git)'
      )
    )
  } else {
    for (const lf of tracked) {
      if (note === '' && inForbiddenDir(lf)) {
        findings.push(
          f(
            `Check 76: ${lf} ${FORBIDDEN_LOCATION}`,
            'Remove it from git (git rm --cached); the file-scan fallback skips these directories, so git mode is where they are rejected'
          )
        )
        continue
      }
      if (lf === 'package-lock.json' || hasOwn(seeds, lf)) continue
      findings.push(
        f(
          `Check 76: ${lf} has no "seeds" entry in ${REGISTRY}; every tracked lockfile other than the root must be covered${note}`,
          `Add seeds["${lf}"] with its overrides and acceptances (see .claude/development/ci-reference.md, npm Overrides)`
        )
      )
    }
  }
  const seedInputs = isPlainObject(input.seedInputs) ? input.seedInputs : {}
  for (const [key, section] of Object.entries(seeds)) {
    const why = seedKeyProblem(key)
    if (why) {
      findings.push(f(`Check 76: seeds key ${JSON.stringify(key)} ${why}`))
      continue
    }
    if (tracked !== null && !tracked.includes(key)) {
      findings.push(
        f(
          `Check 76: seeds key ${JSON.stringify(key)} is not a tracked lockfile (${note ? 'not found by the file scan' : 'git ls-files'})`,
          'Delete the section, or correct the key to the tracked lockfile path'
        )
      )
      continue
    }
    const inp = hasOwn(seedInputs, key) ? seedInputs[key] : null
    const { out, counts } = checkSection(key, section, inp, input, checkers, windowEntries)
    findings.push(...out.map(relabel(key)))
    examined.seedSections++
    examined.seedOverrides += counts.overrides
    examined.seedAcceptances += counts.acceptances
  }
  return { findings, windowEntries, examined }
}
