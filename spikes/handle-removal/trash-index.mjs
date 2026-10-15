// SMI-7123 Wave 5 (design §5): the parked index and the .gitignore suggestion.
//
// The index is a convenience, never an authority: listTrash scans the trash
// directories and only MERGES the index (`index: present|missing`). A copy the
// index omits is still listed; an index line whose copy is gone is not an error.
//
// fs is imported as the DEFAULT export only (looked up at call time).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const FIELDS = ['opId', 'path', 'client', 'rootKey', 'kind', 'bytes', 'createdAt']

/**
 * Appends one entry as a single line with O_APPEND, one write(2), so concurrent
 * appenders never interleave inside a line. Throws on failure; the caller
 * (quarantine) records it as `indexError` and keeps its status.
 */
export function appendParkedIndex(indexPath, entry) {
  const line = {}
  for (const k of FIELDS) line[k] = entry[k] ?? null
  if (typeof line.path !== 'string' || !path.isAbsolute(line.path)) {
    throw new TypeError('appendParkedIndex: path must be absolute')
  }
  const buf = Buffer.from(JSON.stringify(line) + '\n', 'utf8')
  const fd = fs.openSync(
    indexPath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
    0o600
  )
  try {
    const n = fs.writeSync(fd, buf, 0, buf.length)
    if (n !== buf.length) throw new Error(`appendParkedIndex: short write ${n}/${buf.length}`)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * @returns {{present:boolean, entries:object[], errors:{line:number, error:string}[]}}
 *   present is false when the index file does not exist (not an error).
 */
export function readParkedIndex(indexPath) {
  let text
  try {
    text = fs.readFileSync(indexPath, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { present: false, entries: [], errors: [] }
    return { present: true, entries: [], errors: [{ line: 0, error: err.code ?? err.message }] }
  }
  const entries = []
  const errors = []
  text.split('\n').forEach((l, i) => {
    if (l === '') return
    try {
      const e = JSON.parse(l)
      if (typeof e?.path !== 'string') throw new Error('no path')
      entries.push(e)
    } catch (err) {
      errors.push({ line: i + 1, error: err.message })
    }
  })
  return { present: true, entries, errors }
}

/**
 * Drops entries whose path no longer exists, via a temp file and rename(2).
 * @returns {{kept:number, dropped:number}}
 */
export function compactParkedIndex(indexPath) {
  const { present, entries } = readParkedIndex(indexPath)
  if (!present) return { kept: 0, dropped: 0 }
  const keep = entries.filter((e) => {
    try {
      fs.lstatSync(e.path)
      return true
    } catch {
      return false
    }
  })
  const tmp = `${indexPath}.tmp-${crypto.randomBytes(8).toString('hex')}`
  fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e) + '\n').join(''), {
    flag: 'wx',
    mode: 0o600,
  })
  fs.renameSync(tmp, indexPath)
  return { kept: keep.length, dropped: entries.length - keep.length }
}

/** The git work tree containing `dir`, or null. Read-only: lstat of `.git` upward. */
function gitTopOf(dir) {
  for (let p = path.resolve(dir); ; p = path.dirname(p)) {
    try {
      fs.lstatSync(path.join(p, '.git'))
      return p
    } catch {
      /* keep walking */
    }
    if (path.dirname(p) === p) return null
  }
}

/** Whether a .gitignore between `root` and `top` already names `.skillsmith-trash`. */
function alreadyIgnored(root, top) {
  for (let p = path.resolve(root); ; p = path.dirname(p)) {
    try {
      const lines = fs.readFileSync(path.join(p, '.gitignore'), 'utf8').split('\n')
      if (lines.some((l) => /^\/?(\*\*\/)?\.skillsmith-trash\/?$/.test(l.trim()))) return true
    } catch {
      /* none here */
    }
    if (p === top || path.dirname(p) === p) return false
  }
}

/**
 * A one-line suggestion to ignore `.skillsmith-trash/`, at most once per root
 * per run (`seenRoots`). NEVER edits any file: the user owns their .gitignore.
 * @returns {string|null}
 */
export function gitignoreSuggestion(root, seenRoots) {
  const key = path.resolve(root)
  if (seenRoots.has(key)) return null
  seenRoots.add(key)
  const top = gitTopOf(key)
  if (top === null || alreadyIgnored(key, top)) return null
  const rel = path.relative(top, path.join(key, '.skillsmith-trash')) || '.skillsmith-trash'
  return (
    `${key} is inside a git repository (${top}). Skillsmith parks removed copies in ` +
    `${rel}/, which git will show as untracked. To hide it, add this line to ` +
    `${path.join(top, '.gitignore')}: /${rel}/  (Skillsmith does not edit it for you.)`
  )
}
