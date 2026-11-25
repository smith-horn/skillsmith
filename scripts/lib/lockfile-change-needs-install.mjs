/**
 * SMI-7238 (ADR-158 amendment) -- does a lockfile change need an install?
 *
 * Called by `check-node-modules-fresh.sh`'s `_classify()` only in the branch
 * that would otherwise print `real` (raw and shadow hashes both differ from
 * the install-time sentinels). Answers one question: is the current lockfile
 * (L1) different from the lockfile the last install used (L0, saved by
 * `--write-sentinel` as node_modules/.skillsmith-deps-lock.json) ONLY in ways
 * that need no install?
 *
 * Usage:
 *   node lockfile-change-needs-install.mjs <current-lockfile> <saved-copy> <raw-sentinel>
 *
 * Output contract: exactly one token on stdout -- `no-install-needed` or
 * `install-needed` -- plus a one-line reason on stderr. Always exits 0. Any
 * thrown error is caught and reported as `install-needed` (fail toward visible
 * drift, never toward "nothing to install"). Read-only: never writes.
 *
 * Exempt (no install needed), and nothing else:
 *   - `dev`, `devOptional`, `peer` flag changes on `node_modules/` entries;
 *   - a dependency moving between `dependencies` and `devDependencies` of the
 *     root or a workspace entry with an unchanged spec.
 * Every other field of every entry, the key set, and the top-level lockfile
 * fields must be JSON-identical (object key order is ignored; array order is
 * not). Valid only when npm's effective omit set is empty, since the flags
 * matter only to what an omit would prune.
 *
 * Test seam: SKILLSMITH_DEPS_OMIT_PROBE_OUTPUT, when set (even to the empty
 * string), replaces the stdout of `npm config get omit` and skips running npm.
 * Measured on npm 10.9.8: the default prints an empty line, NODE_ENV=production
 * prints `dev`, and npm ignores `--json` for this key.
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'

const NODE_FLAG_FIELDS = new Set(['dev', 'devOptional', 'peer'])
const SECTION_FIELDS = new Set(['dependencies', 'devDependencies'])
const OMIT_PROBE_TIMEOUT_MS = 10_000

class NeedsInstall extends Error {}

function fail(reason) {
  throw new NeedsInstall(reason)
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

/** Deep JSON equality; object key order ignored, array order significant. */
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a !== 'object') return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => hasOwn(b, k) && deepEqual(a[k], b[k]))
}

/** Every field identical except those in `exempt`; presence must match too. */
function fieldsEqual(a, b, exempt) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (exempt.has(k)) continue
    if (hasOwn(a, k) !== hasOwn(b, k)) return false
    if (!deepEqual(a[k], b[k])) return false
  }
  return true
}

function parseLock(text, label) {
  const lock = JSON.parse(text)
  if (!isPlainObject(lock) || !isPlainObject(lock.packages)) {
    fail(`${label} has no "packages" object`)
  }
  return lock
}

/** Sorted (name, spec) pairs across both sections; overlap within a side is install-needed. */
function sectionPairs(entry, key, label) {
  const deps = entry.dependencies
  const dev = entry.devDependencies
  for (const section of [deps, dev]) {
    if (section !== undefined && !isPlainObject(section)) {
      fail(`${label} entry "${key}" has a non-object dependency section`)
    }
  }
  const pairs = []
  const seen = new Set()
  for (const section of [deps ?? {}, dev ?? {}]) {
    for (const name of Object.keys(section)) {
      if (seen.has(name)) fail(`${label} entry "${key}" lists "${name}" in both sections`)
      seen.add(name)
      pairs.push(`${name}\u0000${JSON.stringify(section[name])}`)
    }
  }
  return pairs.sort()
}

function checkOmitEmpty(repoRoot) {
  const override = process.env.SKILLSMITH_DEPS_OMIT_PROBE_OUTPUT
  let out
  if (override !== undefined) {
    out = override
  } else {
    const r = spawnSync('npm', ['config', 'get', 'omit'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: OMIT_PROBE_TIMEOUT_MS,
    })
    if (r.error || r.status !== 0) fail('could not read npm omit configuration')
    out = r.stdout ?? ''
  }
  if (out.trim() !== '') fail(`npm omit set is not empty ("${out.trim()}")`)
}

function compareLocks(l0, l1) {
  const { packages: p0, ...rest0 } = l0
  const { packages: p1, ...rest1 } = l1
  if (!deepEqual(rest0, rest1)) fail('top-level lockfile fields differ')

  const k0 = Object.keys(p0).sort()
  const k1 = Object.keys(p1).sort()
  if (!deepEqual(k0, k1)) fail('package key sets differ')

  for (const key of k0) {
    const e0 = p0[key]
    const e1 = p1[key]
    if (!isPlainObject(e0) || !isPlainObject(e1)) fail(`entry "${key}" is not an object`)
    if (key.includes('node_modules/')) {
      if (!fieldsEqual(e0, e1, NODE_FLAG_FIELDS)) fail(`entry "${key}" differs beyond flags`)
    } else {
      if (!fieldsEqual(e0, e1, SECTION_FIELDS)) fail(`entry "${key}" differs beyond sections`)
      const s0 = sectionPairs(e0, key, 'saved')
      const s1 = sectionPairs(e1, key, 'current')
      if (!deepEqual(s0, s1)) fail(`entry "${key}" dependency names or specs differ`)
    }
  }
}

function decide(curPath, savedPath, sentinelPath) {
  if (!curPath || !savedPath || !sentinelPath) fail('usage: <current> <saved-copy> <raw-sentinel>')
  const sentinel = readFileSync(sentinelPath, 'utf8').trim()
  let savedBytes
  try {
    savedBytes = readFileSync(savedPath)
  } catch {
    fail('saved lockfile copy missing; reinstall to write it')
  }
  const savedHash = createHash('sha256').update(savedBytes).digest('hex')
  if (savedHash !== sentinel) fail('incomplete sentinel publication; reinstall to refresh it')

  const l0 = parseLock(savedBytes.toString('utf8'), 'saved lockfile')
  const l1 = parseLock(readFileSync(curPath, 'utf8'), 'current lockfile')
  // Compare first: a real difference never needs the (slower) npm probe.
  compareLocks(l0, l1)
  checkOmitEmpty(dirname(resolve(curPath)))
}

const [, , curPath, savedPath, sentinelPath] = process.argv
try {
  decide(curPath, savedPath, sentinelPath)
  process.stdout.write('no-install-needed\n')
  process.stderr.write(
    '[lockfile-change-needs-install] only dev/devOptional/peer flags or same-spec section moves changed\n'
  )
} catch (err) {
  process.stdout.write('install-needed\n')
  process.stderr.write(
    `[lockfile-change-needs-install] ${err instanceof Error ? err.message : String(err)}\n`
  )
}
