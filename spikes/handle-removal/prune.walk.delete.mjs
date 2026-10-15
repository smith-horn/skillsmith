// SMI-7123 Wave 5 (design §3.2, §3.3): the deletion walk and misplacement. Split
// out of prune.walk.mjs for the file-length limit; moved verbatim. CHILD PROCESS
// ONLY: it chdirs. fs is the DEFAULT export, looked up at call time.

import fs from 'node:fs'
import path from 'node:path'
import { recordOf } from './prune.metadata.mjs'
import {
  Stop,
  SIDECAR_KEY,
  rand,
  typeOf,
  sameDirId,
  sameLeafPost,
  sameLeafPre,
} from './prune.walk.shared.mjs'

/**
 * §3.2: the deletion walk. Unlinks only an inode whose row matched one syscall
 * earlier, by a random name in a directory it has entered and re-identified.
 * @returns {{status:'removed', deleted:number}} or throws Stop
 */
export function deleteVerified(S, leaf, inventory, sIdentity, ctx = {}) {
  let deleted = 0
  const segs = []
  const alive = ctx.alive ?? (() => true)
  const stop = (reason, detail) => new Stop('stopped', reason, detail, { deleted })
  const cwdIs = (want, at) => {
    const s = fs.statSync('.', { bigint: true })
    if (!sameDirId(want, s))
      throw stop(
        'mount-appeared-during-delete',
        `the current directory is no longer ${at || 'the staged root'}`
      )
  }
  const errnoStop = (err, at) => {
    if (err instanceof Stop) return err
    if (err.code === 'EBUSY') return stop('mount-appeared-during-delete', `${at}: EBUSY`)
    if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST')
      return stop('entry-added-during-delete', `${at}: ${err.code}`)
    return Object.assign(stop('delete-failed', `${at}: ${err.code ?? err.message}`), {
      errno: err.code ?? null,
    })
  }
  const misplaced = (r, originalRel, curWant) => {
    let cause = 'cwd-covered'
    try {
      if (sameDirId(curWant, fs.statSync('.', { bigint: true }))) cause = 'swapped'
    } catch {
      /* unreadable cwd: covered */
    }
    const abs = originalRel === SIDECAR_KEY ? path.join(S, r) : path.join(S, leaf, ...segs, r)
    let lst = null
    try {
      const s = fs.lstatSync(r, { bigint: true })
      lst = { dev: String(s.dev), ino: String(s.ino), type: typeOf(s), size: String(s.size) }
    } catch {
      /* gone */
    }
    const rec = {
      pruneId: ctx.pruneId ?? null,
      path: abs,
      originalRel,
      cause,
      at: new Date().toISOString(),
      lstat: lst,
    }
    let misplacedRecordError = null
    try {
      fs.writeFileSync(path.join(S, 'misplaced.json'), JSON.stringify(rec, null, 2), { flag: 'wx' })
    } catch (err) {
      misplacedRecordError = err.code ?? err.message
    }
    return new Stop(
      'stopped',
      'entry-misplaced',
      `${originalRel === SIDECAR_KEY ? 'the sidecar' : originalRel} was renamed to ${abs} and left there`,
      {
        deleted,
        misplaced: [{ path: abs, originalRel, cause }],
        ...(misplacedRecordError === null ? {} : { misplacedRecordError }),
      }
    )
  }
  const deleteLeaf = (n, crel, want, curWant) => {
    const s = fs.lstatSync(n, { bigint: true })
    if (!sameLeafPre(want, s))
      throw stop('changed-during-delete', `${crel} changed after it was verified`)
    const r = rand()
    try {
      fs.renameSync(n, r)
    } catch (err) {
      throw errnoStop(err, crel)
    }
    if (!sameLeafPost(want, fs.lstatSync(r, { bigint: true }))) throw misplaced(r, crel, curWant)
    try {
      fs.unlinkSync(r)
    } catch (err) {
      throw errnoStop(err, crel)
    }
    deleted += 1
  }
  const walkDir = (rel) => {
    const curWant = inventory.get(rel)
    for (const n of fs.readdirSync('.').sort()) {
      if (!alive()) throw stop('delete-failed', 'the parent process is gone')
      const crel = rel ? `${rel}/${n}` : n
      const want = inventory.get(crel)
      if (!want)
        throw stop('entry-added-during-delete', `${crel} was not in the verified inventory`)
      cwdIs(curWant, rel)
      const s = fs.lstatSync(n, { bigint: true })
      if (want.type !== 'dir') {
        deleteLeaf(n, crel, want, curWant)
        continue
      }
      if (!s.isDirectory()) throw stop('changed-during-delete', `${crel} is no longer a directory`)
      if (!sameDirId(want, s))
        throw stop(
          'mount-appeared-during-delete',
          `${crel}: directory identity changed (a mount root or a replaced directory)`
        )
      const r = rand()
      try {
        fs.renameSync(n, r)
      } catch (err) {
        throw errnoStop(err, crel)
      }
      if (!sameDirId(want, fs.lstatSync(r, { bigint: true }))) throw misplaced(r, crel, curWant)
      process.chdir(r)
      segs.push(r)
      cwdIs(want, crel)
      walkDir(crel)
      if (fs.readdirSync('.').length !== 0)
        throw stop('entry-added-during-delete', `${crel} gained an entry`)
      process.chdir('..')
      segs.pop()
      cwdIs(curWant, rel)
      try {
        fs.rmdirSync(r)
      } catch (err) {
        throw errnoStop(err, crel)
      }
      deleted += 1
    }
  }
  try {
    process.chdir(S)
    cwdIs(sIdentity, 'S')
    if (!ctx.resume) {
      const marker = JSON.stringify({ pruneId: ctx.pruneId ?? null, pid: process.pid })
      fs.writeFileSync('deleting', marker, { flag: 'wx' })
      // Sol c1 finding 2: P4g removes this marker only if it is still these bytes at this inode.
      if (ctx.wrote) ctx.wrote.deleting = recordOf('deleting', marker)
    }
    const sc = inventory.get(SIDECAR_KEY)
    if (sc) deleteLeaf('sidecar.json', SIDECAR_KEY, sc, sIdentity)
    const s = fs.lstatSync(leaf, { bigint: true })
    if (!sameDirId(inventory.get(''), s)) {
      if (inventory.get('').type !== 'dir') {
        deleteLeaf(leaf, '', inventory.get(''), sIdentity)
        return { status: 'removed', deleted }
      }
      throw stop('mount-appeared-during-delete', 'the staged root changed identity')
    }
    process.chdir(leaf)
    cwdIs(inventory.get(''), '')
    walkDir('')
    if (fs.readdirSync('.').length !== 0)
      throw stop('entry-added-during-delete', 'the staged root gained an entry')
    process.chdir('..')
    cwdIs(sIdentity, 'S')
    try {
      fs.rmdirSync(leaf)
    } catch (err) {
      throw errnoStop(err, '.')
    }
    deleted += 1
    return { status: 'removed', deleted }
  } catch (err) {
    throw errnoStop(err, 'walk')
  }
}
