// A13-C4 scoring from OBSERVED FILESYSTEM EFFECTS (review R1-F1), as pure
// functions: the filesystem is reached only through injected probes, so the
// selftest drives every branch with synthetic states.
//
// expectationsFromSteps replays the racer's COMPLETED steps (a13-c4.racer.mjs)
// into the state the racer's own actions left behind, relative to the tree
// root. Every user-owned path those steps produced or moved becomes an
// expectation: a file with its exact content, an empty directory, a symlink
// with its link text. That includes a renamed-aside original (the rename step
// carries the content it moved). Unlinks and rmdirs of fixture content remove
// entries from the model; they are the racer's own deletions, not losses.
//
// Leaves only: a directory that holds an expected file is implied by it, so it
// is not counted separately (one user file = one check).
//
// A run whose completed steps produced NO user-owned path (an unlink+rmdir
// that then failed at mkdir, or an a7 unlink that failed at write) gets one
// `absent` expectation: the racer's deletion stands, i.e. nothing is at the
// destructive path. It is marked `vacuous`, because nothing C4 does can fail
// it, and runs carrying it are counted in extra so a summary can see how much
// of the landed denominator rests on a check that cannot fail.
//
// scoreExpectations evaluates each expectation at its ORIGINAL location
// (probeOrigin), and for anything lost, at the same tree-relative path under
// THIS run's moved tree (probeDest, null when nothing was moved). Exact type
// and content must agree at both: a file found elsewhere, or under another
// operation's trash, is not "displaced". lost = displaced + deleted by
// construction.

import path from 'node:path'

/** Normalises a racer path to a tree-relative POSIX path, or throws. */
function rel(treeRoot, p) {
  const r = path.relative(treeRoot, p)
  if (r === '' || r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)) {
    throw new Error(`a13-c4.score: racer path ${p} is not inside the tree ${treeRoot}`)
  }
  return r.split(path.sep).join('/')
}

/**
 * @param {object[]} steps - completed steps, in order
 * @param {string} treeRoot - absolute
 * @returns {object[]} [{kind:'file'|'dir'|'symlink'|'absent', rel, content?, linkText?, vacuous}]
 */
export function expectationsFromSteps(steps, treeRoot) {
  if (!Array.isArray(steps)) throw new TypeError('expectationsFromSteps: steps must be an array')
  const model = new Map() // rel -> {kind, content?, linkText?}
  const dropUnder = (r) => {
    for (const k of [...model.keys()]) if (k === r || k.startsWith(`${r}/`)) model.delete(k)
  }
  for (const s of steps) {
    const r = rel(treeRoot, s.path)
    switch (s.op) {
      case 'unlink':
      case 'rmdir':
        dropUnder(r)
        break
      case 'rename': {
        const d = rel(treeRoot, s.dest)
        const carried = [...model.entries()].filter(([k]) => k === r || k.startsWith(`${r}/`))
        dropUnder(r)
        for (const [k, v] of carried) model.set(d + k.slice(r.length), v)
        if (!model.has(d)) model.set(d, { kind: 'dir' })
        if (s.moved == null || typeof s.moved !== 'object') {
          throw new Error(`a13-c4.score: rename step without the pre-state it moved (${s.path})`)
        }
        for (const [name, content] of Object.entries(s.moved)) {
          model.set(`${d}/${name}`, { kind: 'file', content })
        }
        break
      }
      case 'mkdir':
        model.set(r, { kind: 'dir' })
        break
      case 'write':
        model.set(r, { kind: 'file', content: s.content })
        break
      case 'symlink':
        model.set(r, { kind: 'symlink', linkText: s.linkText })
        break
      default:
        throw new Error(`a13-c4.score: unknown step op ${s.op}`)
    }
  }
  const out = []
  for (const [r, v] of model) {
    if (v.kind === 'dir' && [...model.keys()].some((k) => k.startsWith(`${r}/`))) continue
    out.push({ rel: r, ...v, vacuous: false })
  }
  if (out.length === 0 && steps.length > 0) {
    // The SHALLOWEST path the racer deleted: after unlink target/orig-f1 +
    // rmdir target, the racer's resulting state is "no target", and checking
    // only the first unlinked file would miss a target that reappeared.
    const deletedRels = steps
      .filter((s) => s.op === 'unlink' || s.op === 'rmdir')
      .map((s) => rel(treeRoot, s.path))
    const pool = deletedRels.length > 0 ? deletedRels : [rel(treeRoot, steps[0].path)]
    const top = pool.reduce((a, b) => (b.split('/').length < a.split('/').length ? b : a))
    out.push({ kind: 'absent', rel: top, vacuous: true })
  }
  return out
}

function matches(e, seen) {
  if (!seen) return false
  if (seen.kind !== e.kind) return false
  if (e.kind === 'file') return seen.content === e.content
  if (e.kind === 'symlink') return seen.linkText === e.linkText
  return true
}

/**
 * @param {object} a
 * @param {object[]} a.expectations
 * @param {(rel:string) => (null|{kind:string, content?:string, linkText?:string})} a.probeOrigin
 * @param {null|((rel:string) => (null|{kind:string, content?:string, linkText?:string}))} a.probeDest
 */
export function scoreExpectations({ expectations, probeOrigin, probeDest }) {
  let lost = 0
  let changed = 0
  let displaced = 0
  let deleted = 0
  const details = []
  for (const e of expectations) {
    const o = probeOrigin(e.rel)
    if (e.kind === 'absent') {
      const ok = o === null
      if (!ok) changed += 1
      details.push({ rel: e.rel, kind: e.kind, state: ok ? 'intact' : 'changed' })
      continue
    }
    if (matches(e, o)) {
      details.push({ rel: e.rel, kind: e.kind, state: 'intact' })
    } else if (o !== null) {
      changed += 1
      details.push({ rel: e.rel, kind: e.kind, state: 'changed' })
    } else {
      lost += 1
      const d = probeDest ? probeDest(e.rel) : null
      if (matches(e, d)) {
        displaced += 1
        details.push({ rel: e.rel, kind: e.kind, state: 'displaced' })
      } else {
        deleted += 1
        details.push({ rel: e.rel, kind: e.kind, state: 'deleted' })
      }
    }
  }
  return {
    checked: expectations.length,
    lost,
    changed,
    displaced,
    deleted,
    vacuous: expectations.length > 0 && expectations.every((e) => e.vacuous === true),
    details,
  }
}
