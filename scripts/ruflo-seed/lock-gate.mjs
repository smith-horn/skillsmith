#!/usr/bin/env node
/**
 * SMI-6744 -- ruflo seed lockfile gate (plan: docs/internal/implementation/
 * smi-6744-ruflo-pin-bump.md, section 1 "Lockfile gate").
 *
 * Compares the `.packages` maps of two npm lockfiles (lockfileVersion 3) BY
 * INSTALL PATH, because a lock can hold several copies of one package name at
 * different paths. Every added / removed / changed path is listed. A path whose
 * package name is on WATCHED_NAMES must be accepted explicitly, by exact path
 * and new version (`@removed` for a removal); unused accept specs also fail.
 *
 * Usage:
 *   node scripts/ruflo-seed/lock-gate.mjs <before-lock.json> <after-lock.json> \
 *     [--accept <path>@<version>]...
 * Exit: 0 clean, 1 unaccepted watched line or unused accept, 2 usage/IO/parse
 * error (fail closed: an unparseable lock is never "no changes").
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const WATCHED_NAMES = [
  'agentdb',
  'better-sqlite3',
  'sql.js',
  '@huggingface/transformers',
  '@xenova/transformers',
  'onnxruntime-node',
  'ruvector',
  '@claude-flow/memory',
  '@claude-flow/neural',
  'agentic-flow',
  'hnswlib-node',
  '@ruvector/core',
]

const MARK = 'node_modules/'

/** Package name = text after the LAST `node_modules/` in the install path. */
export function packageName(path) {
  const i = path.lastIndexOf(MARK)
  return i === -1 ? path : path.slice(i + MARK.length)
}

/**
 * Pure comparison. Returns { added, removed, changed, watched, unaccepted,
 * unusedAccepts }. Each line: { kind, path, name, before, after }.
 */
export function compareLocks(beforePackages, afterPackages, acceptSpecs = []) {
  const keys = (p) => Object.keys(p).filter((k) => k !== '')
  const ver = (p, k) => (p[k] && p[k].version !== undefined ? String(p[k].version) : '?')
  const added = []
  const removed = []
  const changed = []
  for (const path of keys(afterPackages)) {
    if (!Object.prototype.hasOwnProperty.call(beforePackages, path)) {
      added.push({
        kind: 'added',
        path,
        name: packageName(path),
        before: null,
        after: ver(afterPackages, path),
      })
    } else if (ver(beforePackages, path) !== ver(afterPackages, path)) {
      changed.push({
        kind: 'changed',
        path,
        name: packageName(path),
        before: ver(beforePackages, path),
        after: ver(afterPackages, path),
      })
    }
  }
  for (const path of keys(beforePackages)) {
    if (!Object.prototype.hasOwnProperty.call(afterPackages, path)) {
      removed.push({
        kind: 'removed',
        path,
        name: packageName(path),
        before: ver(beforePackages, path),
        after: null,
      })
    }
  }
  const all = [...added, ...removed, ...changed]
  const watched = all.filter((l) => WATCHED_NAMES.includes(l.name))
  const used = new Set()
  const unaccepted = []
  for (const line of watched) {
    const spec = `${line.path}@${line.kind === 'removed' ? 'removed' : line.after}`
    if (acceptSpecs.includes(spec)) used.add(spec)
    else unaccepted.push(line)
  }
  // A spec is used only if it matched a watched line exactly.
  const unusedAccepts = acceptSpecs.filter((s) => !used.has(s))
  return { added, removed, changed, watched, unaccepted, unusedAccepts }
}

function loadPackages(file) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`cannot read/parse ${file}: ${err.message}`)
  }
  const pk = parsed && parsed.packages
  if (!pk || typeof pk !== 'object' || Array.isArray(pk)) {
    throw new Error(`${file}: missing or non-object "packages" map`)
  }
  return pk
}

export function main(argv, out = console.log, err = console.error) {
  const files = []
  const accepts = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--accept') {
      if (i + 1 >= argv.length) {
        err('usage error: --accept needs a value')
        return 2
      }
      accepts.push(argv[++i])
    } else if (argv[i].startsWith('--')) {
      err(`usage error: unknown flag ${argv[i]}`)
      return 2
    } else files.push(argv[i])
  }
  if (files.length !== 2) {
    err('usage: lock-gate.mjs <before-lock.json> <after-lock.json> [--accept <path>@<version>]...')
    return 2
  }
  let r
  try {
    r = compareLocks(loadPackages(files[0]), loadPackages(files[1]), accepts)
  } catch (e) {
    err(`lock-gate: ${e.message}`)
    return 2
  }
  const show = (title, lines) => {
    out(`${title} (${lines.length}):`)
    for (const l of lines) out(`  ${l.path} ${l.before ?? '-'} -> ${l.after ?? '-'}`)
  }
  show('added', r.added)
  show('removed', r.removed)
  show('changed', r.changed)
  out(`added ${r.added.length}, removed ${r.removed.length}, changed ${r.changed.length}`)
  for (const l of r.unaccepted)
    out(`UNACCEPTED ${l.kind} ${l.path} ${l.before ?? '-'} -> ${l.after ?? '-'}`)
  for (const s of r.unusedAccepts) out(`UNUSED-ACCEPT ${s}`)
  return r.unaccepted.length || r.unusedAccepts.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
