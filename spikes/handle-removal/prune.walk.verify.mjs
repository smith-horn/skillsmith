// SMI-7123 Wave 5 (design §3.1): verify at the staging path. Split out of
// prune.walk.mjs for the file-length limit; moved verbatim. CHILD PROCESS ONLY.
// fs is the DEFAULT export, looked up at call time (the harness interposes it).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { computeTreeHash } from './hash.mjs'
import { readStable } from './prune.sidecar.mjs'
import { SIDECAR_KEY, rowOf, mountFinding } from './prune.walk.shared.mjs'

/**
 * §3.1: walk S/leaf with lstat (st_dev checked against the root), stable-read
 * every file, hash, and build the inventory; then stable-read S/sidecar.json
 * and require it to be the very inode and bytes approved at P4a.
 * @returns {{ok:true, inventory:Map, hash:string}|{ok:false, reason:string, detail:string}}
 */
export function verifyAtStaging(S, leaf, { approvedHash, rootIdentity, sidecar }) {
  const no = (reason, detail) => ({ ok: false, reason, detail })
  const leafPath = path.join(S, leaf)
  let top
  try {
    top = fs.lstatSync(leafPath, { bigint: true })
  } catch (err) {
    return no('unreadable-in-staging', `staged copy unreadable (${err.code})`)
  }
  if (
    top.dev !== rootIdentity.dev ||
    top.ino !== rootIdentity.ino ||
    top.birthtimeNs !== rootIdentity.birthtimeNs
  ) {
    return no('changed-in-staging', 'the staged copy is not the inode that was approved')
  }
  const mi = mountFinding(leafPath)
  if (mi !== null) return no('mount-in-staging', mi)
  const record = new Map()
  const inventory = new Map()
  const visit = (rel, abs) => {
    const st = fs.lstatSync(abs, { bigint: true })
    if (st.dev !== top.dev) return no('mount-in-staging', `mount at ${rel || '.'} (st_dev differs)`)
    const mode = Number(st.mode)
    inventory.set(rel, rowOf(st))
    if (st.isDirectory()) {
      record.set(rel, { type: 'dir', mode, size: st.size })
      for (const n of fs.readdirSync(abs).sort()) {
        const r = visit(rel ? `${rel}/${n}` : n, path.join(abs, n))
        if (r) return r
      }
      return null
    }
    if (st.isSymbolicLink()) {
      record.set(rel, { type: 'symlink', mode, size: st.size, linkText: fs.readlinkSync(abs) })
      return null
    }
    if (st.isFile()) {
      const rs = readStable(abs)
      if (!rs.ok)
        return no(
          rs.reason === 'unreadable' ? 'unreadable-in-staging' : 'changed-in-staging',
          `${rel}: ${rs.reason}`
        )
      if (
        rs.ino !== st.ino ||
        rs.size !== st.size ||
        rs.mtimeNs !== st.mtimeNs ||
        rs.ctimeNs !== st.ctimeNs
      ) {
        return no('changed-in-staging', `${rel} changed while it was verified`)
      }
      record.set(rel, {
        type: 'file',
        mode,
        size: st.size,
        contentHash: crypto.createHash('sha256').update(rs.bytes).digest('hex'),
      })
      return null
    }
    return no('unreadable-in-staging', `${rel}: unsupported entry type`)
  }
  let failure
  try {
    failure = visit('', leafPath)
  } catch (err) {
    return no('unreadable-in-staging', `walk failed (${err.code ?? err.message})`)
  }
  if (failure) return failure
  const hash = computeTreeHash(record)
  if (hash !== approvedHash)
    return no('changed-in-staging', 'tree hash at the staging path differs from the approved hash')
  if (sidecar) {
    const rs = readStable(path.join(S, 'sidecar.json'))
    if (!rs.ok) return no('sidecar-changed-in-staging', `staged sidecar: ${rs.reason}`)
    if (rs.ino !== sidecar.ino || !rs.bytes.equals(sidecar.bytes)) {
      return no(
        'sidecar-changed-in-staging',
        'the staged sidecar is not the approved inode and bytes'
      )
    }
    inventory.set(SIDECAR_KEY, {
      dev: rs.dev,
      ino: rs.ino,
      birthtimeNs: null,
      type: 'file',
      mode: rs.mode,
      size: rs.size,
      mtimeNs: rs.mtimeNs,
      ctimeNs: rs.ctimeNs,
    })
  }
  return { ok: true, inventory, hash }
}
