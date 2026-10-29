/**
 * SMI-7201 Wave 1 -- Tier-B pair check.
 *
 * For every Tier-B (linux-only optional) native package the LIVE lockfile
 * expects, verify the INSTALLED copy satisfies the version spec that each of
 * its INSTALLED JS parents declares in optionalDependencies. The seed is not
 * consulted for the verdict: the question is "does the installed native half
 * match what the installed JS half expects", not "does it match the seed".
 *
 * See docs/internal/implementation/smi-7201-tier-b-seed-pair-drift.md
 * (What Changes 1, Wave 1).
 *
 * Usage: node check-tier-b-pairs.mjs [--app-root <dir>] [--seed-root <dir>] [--worktree]
 *
 * Exit: 1 MISMATCH (a version outside a parent's spec, or an expected
 *       package missing); else 2 NOT-EVALUATED; else 0 CLEAN.
 * All output goes to stderr, each line prefixed "[tier-b-pairs] ". Only
 * names, versions and specs are printed, never file contents.
 *
 * The expected-path set is derived by importing
 * deriveLinuxOptionalPackagePaths from linux-optional-packages.mjs, the same
 * producer the mounts and the image seed use.
 */

import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deriveLinuxOptionalPackagePaths } from './linux-optional-packages.mjs'

const PREFIX = '[tier-b-pairs] '
const NM = 'node_modules/'
const DEFAULT_APP_ROOT = '/app'
const DEFAULT_SEED_ROOT = '/opt/native-seed/tier-b'
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

/**
 * @param {string} p
 * @returns {{state:'ok', value:any} | {state:'missing'} | {state:'unreadable', why:string}}
 */
function readJson(p) {
  let raw
  try {
    raw = readFileSync(p, 'utf8')
  } catch (e) {
    const code = e && /** @type {any} */ (e).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'missing' }
    return { state: 'unreadable', why: code || 'read error' }
  }
  try {
    return { state: 'ok', value: JSON.parse(raw) }
  } catch {
    return { state: 'unreadable', why: 'not valid JSON' }
  }
}

/** @param {string} appRoot */
function loadSemver(appRoot) {
  try {
    const req = createRequire(join(appRoot, 'package.json'))
    const mod = req(join(appRoot, 'node_modules', 'semver'))
    return mod && typeof mod.satisfies === 'function' ? mod : null
  } catch {
    return null
  }
}

/**
 * Node resolution of `name` as seen from lockfile entry `fromKey`: nested
 * node_modules under the entry first, then each ancestor, then the root.
 * @param {Record<string, unknown>} packages
 * @param {string} fromKey
 * @param {string} name
 * @returns {string | null}
 */
function resolveFrom(packages, fromKey, name) {
  let dir = fromKey
  for (;;) {
    const key = (dir ? dir + '/' : '') + NM + name
    if (packages[key]) return key
    if (!dir) return null
    const i = dir.lastIndexOf('/' + NM)
    dir = i === -1 ? '' : dir.slice(0, i)
  }
}

/**
 * Lockfile entries whose optionalDependencies name `name` and whose Node
 * resolution lands on `pkgPath`. Includes the root entry "" if it qualifies.
 * @param {Record<string, any>} packages
 * @param {string} name
 * @param {string} pkgPath
 * @returns {string[]}
 */
function findParents(packages, name, pkgPath) {
  const parents = []
  for (const [key, entry] of Object.entries(packages)) {
    const od = entry && entry.optionalDependencies
    if (!od || typeof od !== 'object' || !(name in od)) continue
    if (resolveFrom(packages, key, name) === pkgPath) parents.push(key)
  }
  return parents
}

/**
 * Seed entries are the paths that have a sibling `<path>.version` file.
 * @param {string} seedRoot
 * @returns {string[]}
 */
function listSeedEntries(seedRoot) {
  const out = []
  /** @param {string} dir */
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const names = new Set(entries.map((e) => e.name))
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isFile() && e.name.endsWith('.version')) {
        out.push(relative(seedRoot, full).slice(0, -'.version'.length))
      } else if (e.isDirectory() && !names.has(e.name + '.version')) {
        walk(full)
      }
    }
  }
  walk(seedRoot)
  return out.sort()
}

/**
 * npm's installability rule for one os/cpu/libc list: a "!x" entry blocks x;
 * if any non-negated entry exists, the value must match one of them.
 * @param {unknown} list
 * @param {string} value
 * @returns {boolean}
 */
function listAdmits(list, value) {
  if (list === undefined || list === null) return true
  const items = Array.isArray(list) ? list : [list]
  if (items.length === 0) return true
  let allow = false
  let hasAllow = false
  for (const item of items) {
    if (typeof item !== 'string') continue
    if (item.startsWith('!')) {
      if (item.slice(1) === value) return false
    } else {
      hasAllow = true
      if (item === value) allow = true
    }
  }
  return hasAllow ? allow : true
}

/**
 * Does an installed package satisfy one parent's spec? Only a version or range
 * (with semver), or an exact version (without it), is judged. Every other spec form
 * (npm: alias, dist-tag, git, file, url, workspace) is not evaluated rather than
 * called a mismatch or a pass.
 *
 * npm: aliases are deliberately not judged (owner decision, SMI-7201): none of the
 * lockfile's 253 optionalDependencies specs is an alias (measured 2026-10-29), and a
 * hand-written alias parser
 * drew two silent-pass findings in review. If one ever appears, the check names it
 * and stops at exit 2, and support is added then.
 * @param {string} spec
 * @param {any} installed the installed package.json
 * @param {any} semver the semver module, or null
 * @returns {{result: 'ok'|'mismatch'} | {result: 'unevaluated', why: string}}
 */
function judgeSpec(spec, installed, semver) {
  if (spec.startsWith('npm:')) {
    return { result: 'unevaluated', why: 'is an npm alias, which this check does not judge' }
  }
  if (semver) {
    if (!semver.validRange(spec)) return { result: 'unevaluated', why: 'is not a version or range' }
    return { result: semver.satisfies(installed.version, spec) ? 'ok' : 'mismatch' }
  }
  if (EXACT_VERSION.test(spec)) {
    return { result: installed.version === spec ? 'ok' : 'mismatch' }
  }
  return { result: 'unevaluated', why: 'is not an exact version and semver is unavailable' }
}

/**
 * glibc when the runtime reports a glibc version, musl when the report exists
 * without one, null when no report could be produced (unknown, not guessed).
 * @returns {string | null}
 */
function detectLibc() {
  try {
    const report = /** @type {any} */ (process.report)?.getReport()
    if (!report || !report.header) return null
    return report.header.glibcVersionRuntime ? 'glibc' : 'musl'
  } catch {
    return null
  }
}

/**
 * @param {{appRoot?: string, seedRoot?: string, worktree?: boolean, platform?: {os: string, cpu: string, libc: string | null}}} [opts]
 * @returns {{exit: 0|1|2, lines: string[]}}
 */
export function checkTierBPairs(opts = {}) {
  const appRoot = opts.appRoot ?? DEFAULT_APP_ROOT
  const seedRoot = opts.seedRoot ?? DEFAULT_SEED_ROOT
  const lines = []
  // One record per line: control characters from package.json values cannot forge a line.
  const say = (/** @type {string} */ s) =>
    lines.push(PREFIX + s.replace(/[\u0000-\u001f\u007f]/g, '?'))
  const lockPath = join(appRoot, 'package-lock.json')

  let expected
  let packages
  try {
    expected = deriveLinuxOptionalPackagePaths(lockPath)
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'))
    packages = parsed && parsed.packages ? parsed.packages : {}
  } catch (e) {
    const why = (e && /** @type {any} */ (e).code) || 'unreadable or unparseable'
    say(`NOT-EVALUATED lockfile ${lockPath}: ${why}`)
    return { exit: 2, lines }
  }

  const semver = loadSemver(appRoot)
  let pairs = 0
  let mismatches = 0
  let notEvaluated = 0
  const mismatch = (/** @type {string} */ s) => {
    mismatches++
    say('MISMATCH ' + s)
  }
  const unevaluated = (/** @type {string} */ s) => {
    notEvaluated++
    say('NOT-EVALUATED ' + s)
  }

  const platform = opts.platform ?? {
    os: process.platform,
    cpu: process.arch,
    libc: detectLibc(),
  }
  if (platform.libc === null) {
    say(
      `NOT-EVALUATED libc could not be determined, so platform applicability is unknown; ${expected.length} packages expected, none checked`
    )
    return { exit: 2, lines }
  }

  const applicable = expected.filter((p) => {
    const e = packages[p] || {}
    return (
      listAdmits(e.os, platform.os) &&
      listAdmits(e.cpu, platform.cpu) &&
      listAdmits(e.libc, platform.libc)
    )
  })
  const skipped = expected.length - applicable.length

  if (applicable.length === 0) {
    unevaluated(
      `zero applicable packages (${expected.length} expected, ${skipped} skipped for another platform) in ${lockPath} (zero denominator)`
    )
  }

  for (const pkgPath of applicable) {
    const name = pkgPath.slice(pkgPath.lastIndexOf(NM) + NM.length)
    const installed = readJson(join(appRoot, pkgPath, 'package.json'))
    if (installed.state === 'missing') {
      mismatch(`path=${pkgPath} missing (expected package is not installed)`)
      continue
    }
    if (installed.state === 'unreadable') {
      unevaluated(`path=${pkgPath} installed package.json unreadable (${installed.why})`)
      continue
    }
    const version = installed.value && installed.value.version
    if (typeof version !== 'string') {
      unevaluated(`path=${pkgPath} installed package.json has no version`)
      continue
    }

    const parents = findParents(packages, name, pkgPath)
    let evaluated = 0
    for (const parent of parents) {
      const parentFile =
        parent === '' ? join(appRoot, 'package.json') : join(appRoot, parent, 'package.json')
      const pj = readJson(parentFile)
      const label = parent === '' ? '<root>' : parent
      if (pj.state !== 'ok') {
        unevaluated(
          `path=${pkgPath} parent=${label} package.json ${pj.state === 'missing' ? 'missing' : 'unreadable'}`
        )
        continue
      }
      const od = pj.value && pj.value.optionalDependencies
      const spec = od && typeof od === 'object' ? od[name] : undefined
      if (typeof spec !== 'string') {
        unevaluated(`path=${pkgPath} parent=${label} installed package.json does not list it`)
        continue
      }
      const verdict = judgeSpec(spec, installed.value, semver)
      if (verdict.result === 'unevaluated') {
        unevaluated(`path=${pkgPath} parent=${label} spec=${spec} ${verdict.why}`)
        continue
      }
      evaluated++
      pairs++
      if (verdict.result === 'mismatch') {
        mismatch(`path=${pkgPath} installed=${version} parent=${label} spec=${spec}`)
      }
    }
    if (evaluated === 0) {
      unevaluated(`path=${pkgPath} has no evaluated parent (${parents.length} found)`)
    }
  }

  if (opts.worktree) {
    const live = new Set(expected)
    const obsolete = listSeedEntries(seedRoot).filter((p) => !live.has(p))
    if (obsolete.length > 0) {
      say(`INFO seed entries not in the live lockfile (not checked): ${obsolete.join(', ')}`)
    }
  }

  const summary = `${expected.length} packages expected (${applicable.length} applicable, ${skipped} skipped for another platform), ${pairs} pairs checked`
  if (mismatches > 0) {
    say(`MISMATCH: ${summary}; ${mismatches} mismatch(es), ${notEvaluated} not evaluated`)
    return { exit: 1, lines }
  }
  if (notEvaluated > 0) {
    say(`NOT-EVALUATED: ${summary}; ${notEvaluated} not evaluated`)
    return { exit: 2, lines }
  }
  say(`CLEAN ${summary}`)
  return { exit: 0, lines }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = { appRoot: DEFAULT_APP_ROOT, seedRoot: DEFAULT_SEED_ROOT, worktree: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--worktree') opts.worktree = true
    else if (a === '--app-root' || a === '--seed-root') {
      const v = argv[++i]
      if (!v) return null
      if (a === '--app-root') opts.appRoot = v
      else opts.seedRoot = v
    } else if (a.startsWith('--app-root=')) opts.appRoot = a.slice('--app-root='.length)
    else if (a.startsWith('--seed-root=')) opts.seedRoot = a.slice('--seed-root='.length)
    else return null
  }
  return opts
}

function isMain() {
  try {
    return (
      !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    )
  } catch {
    return false
  }
}

if (isMain()) {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts) {
    process.stderr.write(
      PREFIX +
        'NOT-EVALUATED bad arguments; usage: [--app-root <dir>] [--seed-root <dir>] [--worktree]\n'
    )
    process.exit(2)
  }
  const { exit, lines } = checkTierBPairs(opts)
  for (const l of lines) process.stderr.write(l + '\n')
  process.exit(exit)
}
