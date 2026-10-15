// SMI-7123 Wave 5: fixtures for the prune suites and rows. Every copy is parked
// by the REAL quarantineTree, so the sidecar shapes are the ones C4 writes; the
// non-Q shapes are then derived from a real copy by the documented edit.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { quarantineTree, computePathTreeHash } from '../quarantine.mjs'
import { populate } from './postmove-seam.mjs'
import { w5Root } from './w5-test-util.mjs'

/** A throwaway root with an empty skills parent. */
export function makeParent(prefix = 'w5-', base = w5Root()) {
  const root = fs.mkdtempSync(path.join(base, prefix))
  const parent = path.join(root, 'parent')
  fs.mkdirSync(parent)
  return { root, parent }
}

/** Builds a tree at parent/name: the postmove fixture content plus `extraFiles` files. */
export function buildTree(parent, name, { extraFiles = 0, extraDirs = 0, outLink = null } = {}) {
  const dir = path.join(parent, name)
  populate(dir)
  if (outLink !== null) fs.symlinkSync(outLink, path.join(dir, 'out-link'))
  for (let d = 0; d < extraDirs; d += 1) {
    const sub = path.join(dir, `d${String(d).padStart(3, '0')}`)
    fs.mkdirSync(sub)
    for (let i = 0; i < 4; i += 1) fs.writeFileSync(path.join(sub, `f${i}.txt`), `d${d}-f${i}`)
  }
  for (let i = 0; i < extraFiles; i += 1) {
    fs.writeFileSync(path.join(dir, `x${String(i).padStart(4, '0')}.txt`), `x-${i}`)
  }
  return dir
}

/** The listing-shaped copy descriptor for a quarantine result. */
export function copyOf(parent, result) {
  const copyPath = result.path
  const opDir = path.dirname(copyPath)
  return {
    root: parent,
    trashRoot: path.join(parent, '.skillsmith-trash'),
    opId: path.basename(opDir),
    opDir,
    name: path.basename(copyPath),
    copyPath,
    sidecarPath: `${copyPath}.json`,
  }
}

const SHAPES = new Set(['Q', 'U', 'H', 'changed', 'orphan', 'unreadable', 'schema-invalid'])

/**
 * Parks parent/name with the real quarantineTree and derives `shape`:
 *   Q        guarded quarantine (postMoveVerified)          -> clean
 *   U        unguarded quarantine (treeHash null)           -> unverified
 *   H        Q, sidecar rewritten to the held shape         -> held
 *   changed  Q, then a file inside the copy is rewritten    -> changed
 *   orphan   Q, then the sidecar is removed                 -> held (absent)
 *   unreadable  Q, then a FIFO is created inside the copy   -> unverified/tree-unreadable
 *   schema-invalid  Q, sidecar given an extra key           -> unverified/schema-invalid
 */
export function park(parent, name, shape = 'Q', treeOpts = {}) {
  if (!SHAPES.has(shape)) throw new TypeError(`park: unknown shape ${shape}`)
  const origin = buildTree(parent, name, treeOpts)
  const opts = { opId: `op-${name}-${process.pid}`, indexPath: treeOpts.indexPath }
  if (opts.indexPath === undefined) delete opts.indexPath
  if (shape !== 'U') opts.guardHash = computePathTreeHash(origin).treeHash
  const r = quarantineTree(parent, name, opts)
  if (r.status !== 'quarantined') {
    throw new Error(`park: quarantine returned ${r.status}/${r.reason} (${r.detail ?? ''})`)
  }
  const copy = copyOf(parent, r)
  const sc = () => JSON.parse(fs.readFileSync(copy.sidecarPath, 'utf8'))
  if (shape === 'H') {
    const s = sc()
    const { postMoveVerified, ...rest } = s
    void postMoveVerified
    fs.writeFileSync(
      copy.sidecarPath,
      JSON.stringify(
        {
          ...rest,
          hold: true,
          reason: 'changed-during-move',
          heldPath: copy.copyPath,
          guardHash: s.treeHash,
          postMoveTreeHash: s.postMoveTreeHash,
        },
        null,
        2
      )
    )
  } else if (shape === 'changed') {
    fs.writeFileSync(path.join(copy.copyPath, 'top.txt'), 'top-bytes-CHANGED-after-park')
  } else if (shape === 'orphan') {
    fs.unlinkSync(copy.sidecarPath)
  } else if (shape === 'unreadable') {
    execFileSync('mkfifo', [path.join(copy.copyPath, 'a-fifo')])
  } else if (shape === 'schema-invalid') {
    fs.writeFileSync(copy.sidecarPath, JSON.stringify({ ...sc(), extra: true }, null, 2))
  }
  return copy
}

/** One parent holding one parked copy of `shape`. */
export function parkCopy({ shape = 'Q', name = 'tree', treeOpts = {} } = {}) {
  const { root, parent } = makeParent()
  const copy = park(parent, name, shape, treeOpts)
  return { root, parent, copy }
}

/**
 * Snapshot of every entry under `abs`: rel -> {ino, type, bytes|link}. Used to
 * assert a copy is byte-exact at the same inodes after a refused prune.
 */
export function snapshotTree(abs) {
  const out = {}
  const visit = (rel, p) => {
    const st = fs.lstatSync(p, { bigint: true })
    const e = { ino: String(st.ino) }
    if (st.isDirectory()) {
      e.type = 'dir'
      out[rel] = e
      for (const n of fs.readdirSync(p).sort()) visit(rel ? `${rel}/${n}` : n, path.join(p, n))
      return
    }
    if (st.isSymbolicLink()) Object.assign(e, { type: 'symlink', link: fs.readlinkSync(p) })
    else if (st.isFile()) Object.assign(e, { type: 'file', bytes: fs.readFileSync(p, 'base64') })
    else e.type = 'other'
    out[rel] = e
  }
  visit('', abs)
  return JSON.stringify(out)
}
