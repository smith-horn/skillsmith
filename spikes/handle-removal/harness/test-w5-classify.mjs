#!/usr/bin/env node
// SMI-7123 Wave 5 (design §1 P1-P2, §7 T4): the class matrix, and clean only by
// elimination. Plus the listing's structure (orphan sidecars, staging leftovers,
// index merge) and the trash-root refusal.
//
//   node test-w5-classify.mjs                         real code
//   node test-w5-classify.mjs --against classify-default-clean
//
// DECLARED FAILURE (T4 against classify-default-clean): the orphan copy (no
// sidecar) is classified `clean`; likewise the U, schema-invalid and unreadable copies.
//
// DECLARED FAILURE (SMI-7128 unreadable-subtree cases, real code only): with prune.mjs's old
// unguarded sizeOf, "unreadable: a dry-run does not throw" fails with an EACCES readdir error;
// with formatTrashReport's old unguarded lstat, "an unreadable copy root still lists" fails
// with an ENOENT exception.

import fs from 'node:fs'
import path from 'node:path'
import { makeCheck, rmFixture, againstArg } from './w5-test-util.mjs'
import { makeParent, park } from './w5-fixtures.mjs'
import { canMount, mountAt, detachUnder, noImageAttachedUnder, MOUNT_KINDS } from './w5-mounts.mjs'
import * as mutants from './w5-mutants.mjs'

const TAG = '[w5-classify]'
const { check, done, notRun } = makeCheck(TAG)
const against = againstArg()
if (against !== null && against !== 'classify-default-clean') {
  console.error(`${TAG} no case targets ${against}`)
  process.exit(2)
}
const real = against === null ? await import('../prune.classify.mjs') : null
const classify = against === null ? real.classifyCopy : mutants.classifyDefaultClean

// --- T4: the matrix ------------------------------------------------------------
const MATRIX = [
  ['Q', 'clean', null],
  ['U', 'unverified', 'treehash-null'],
  ['H', 'held', 'hold'],
  ['changed', 'changed', 'hash-differs'],
  ['orphan', 'held', 'sidecar-absent'],
  ['unreadable', 'unverified', 'tree-unreadable'],
  ['schema-invalid', 'unverified', 'schema-invalid'],
]
const { root, parent } = makeParent('w5-t4-')
try {
  for (const [shape, klass, reason] of MATRIX) {
    const c = classify(park(parent, `t-${shape}`, shape))
    check(`T4 ${shape} -> ${klass}`, c.klass, klass)
    if (against === null) check(`T4 ${shape} reason`, c.reason, reason)
  }
  // An unparseable sidecar is held, never clean.
  const up = park(parent, 't-unparseable', 'Q')
  fs.writeFileSync(up.sidecarPath, '{not json')
  check('T4 unparseable sidecar -> held', classify(up).klass, 'held')
} finally {
  rmFixture(root)
}

// --- T4 mounted: a mount inside a parked copy is mounted, whatever its sidecar says
if (canMount()) {
  for (const kind of MOUNT_KINDS) {
    const f = makeParent('w5-t4m-')
    try {
      const c = park(f.parent, 'm', 'Q')
      mountAt(kind, path.join(c.copyPath, 'target'), f)
      const k = classify(c)
      check(`T4 ${kind} mount inside the copy -> mounted`, k.klass, 'mounted')
    } finally {
      const left = detachUnder(fs.realpathSync(f.root), f)
      check(`T4 ${kind} cleanup detached every mount`, left.join(','), '')
      check(`T4 ${kind} cleanup detached the image`, noImageAttachedUnder(f.root), true)
      if (left.length === 0) rmFixture(f.root)
    }
  }
} else {
  console.log(
    `${TAG} mounted case skipped: no mounts on ${process.platform} as uid ${process.getuid?.()}`
  )
}

// --- listing structure (real code only) -------------------------------------------
if (against === null) {
  const { listTrash, formatTrashReport } = real
  const f = makeParent('w5-list-')
  const indexPath = path.join(f.root, 'parked-index.jsonl')
  try {
    const a = park(f.parent, 'a', 'Q', { indexPath })
    const b = park(f.parent, 'b', 'Q')
    const gone = park(f.parent, 'gone', 'Q', { indexPath })
    fs.rmSync(gone.copyPath, { recursive: true })
    fs.mkdirSync(path.join(a.trashRoot, '.prune-0123456789abcdef'), { mode: 0o700 })
    const l = listTrash({ roots: [f.parent], indexPath })
    const r = l.roots[0]
    check('list: two copies', r.copies.map((c) => c.name.split('-')[0]).join(','), 'a,b')
    check(
      'list: indexed copy is index present',
      r.copies.find((c) => c.copyPath === a.copyPath).index,
      'present'
    )
    check(
      'list: unindexed copy is index missing',
      r.copies.find((c) => c.copyPath === b.copyPath).index,
      'missing'
    )
    check('list: the gone copy leaves an orphan sidecar', r.orphanSidecars.length, 1)
    check(
      'list: the stale index line is reported, not an error',
      l.index.stale.length === 1 && l.index.errors.length === 0,
      true
    )
    check('list: the staging dir is a leftover', r.leftovers.length, 1)
    const unscanned = listTrash({ roots: [], indexPath })
    check(
      'list: an unscanned root lists nothing',
      unscanned.roots.length + unscanned.index.stale.length,
      0
    )
  } finally {
    rmFixture(f.root)
  }
  // SMI-7128: a copy holding a mode-000 subdirectory must not make prune (dry-run or
  // apply) or the report throw for every copy; it is listed as unverified, size unknown.
  const { prune } = await import('../prune.mjs')
  const u = makeParent('w5-unreadable-')
  let locked = null
  unreadable: try {
    const good = park(u.parent, 'good', 'Q')
    const bad = park(u.parent, 'bad', 'Q')
    locked = path.join(bad.copyPath, 'locked')
    fs.mkdirSync(locked)
    fs.writeFileSync(path.join(locked, 'f.txt'), 'locked-bytes')
    fs.chmodSync(locked, 0o000)
    let listable = true
    try {
      fs.readdirSync(locked)
    } catch {
      listable = false
    }
    if (listable) {
      // A false premise is neither a pass nor a fail: the block did not run.
      notRun('unreadable', 'mode-000 directory is listable here, e.g. running as root')
      break unreadable
    }
    check('unreadable: premise: the mode-000 subdirectory cannot be listed here', !listable, true)
    let dry = null
    let dryErr = null
    try {
      dry = prune({ roots: [u.parent] })
    } catch (err) {
      dryErr = `${err.code ?? ''} ${err.message}`
    }
    check('unreadable: a dry-run does not throw', dryErr, null)
    const rowFor = (p) => dry?.plan.rows.find((x) => x.path === p) ?? null
    check('unreadable: the dry-run lists both copies', dry?.plan.rows.length, 2)
    check('unreadable: the good copy is clean', rowFor(good.copyPath)?.klass, 'clean')
    check('unreadable: the bad copy is unverified', rowFor(bad.copyPath)?.klass, 'unverified')
    check(
      'unreadable: with reason tree-unreadable',
      rowFor(bad.copyPath)?.reason,
      'tree-unreadable'
    )
    check(
      'unreadable: the summary says one copy is of unknown size',
      /plus 1 of unknown size/.test(dry?.plan.summary ?? ''),
      true
    )
    const listing = listTrash({ roots: [u.parent] })
    let text = null
    try {
      text = formatTrashReport(listing)
    } catch (err) {
      text = `THREW ${err.code ?? ''} ${err.message}`
    }
    const badLine =
      String(text)
        .split('\n')
        .find((l) => l.includes(bad.copyPath)) ?? ''
    check(
      'unreadable: the report lists the bad copy as unknown size',
      /unknown size/.test(badLine),
      true
    )
    check('unreadable: the report is not an exception', String(text).startsWith('THREW'), false)
    // formatTrashReport's age fallback: no createdAt in the classification, and the
    // copy cannot be lstat'd -> the row still lists, age unknown.
    const gr = listing.roots[0].copies.find((c) => c.copyPath === good.copyPath)
    gr.cls = { ...real.classifyCopy(gr), sidecar: null }
    const realLstat = fs.lstatSync
    fs.lstatSync = (p, ...a) => {
      if (p === good.copyPath) throw Object.assign(new Error('injected'), { code: 'ENOENT' })
      return realLstat(p, ...a)
    }
    let aged
    try {
      aged = formatTrashReport(listing)
    } catch (err) {
      aged = `THREW ${err.code ?? ''} ${err.message}`
    } finally {
      fs.lstatSync = realLstat
    }
    check(
      'unreadable: the report with an unreadable copy root does not throw',
      String(aged).startsWith('THREW') ? aged : null,
      null
    )
    const goodLine =
      String(aged)
        .split('\n')
        .find((l) => l.includes(good.copyPath)) ?? ''
    check(
      'unreadable: an unreadable copy root still lists, age unknown',
      /age unknown/.test(goodLine),
      true
    )
    // apply: the bad copy is kept as unreadable, the good copy is removed.
    const ap = prune({ roots: [u.parent], apply: true, confirmBatch: () => true })
    const st = (p) => ap.items.find((i) => i.path === p) ?? {}
    check(
      'unreadable: apply keeps the bad copy',
      `${st(bad.copyPath).status}/${st(bad.copyPath).reason}`,
      'kept/unreadable'
    )
    check('unreadable: apply removes the good copy', st(good.copyPath).status, 'removed')
    check('unreadable: the bad copy is still there', fs.existsSync(bad.copyPath), true)
  } finally {
    if (locked !== null) {
      try {
        fs.chmodSync(locked, 0o700)
      } catch {
        /* already gone */
      }
    }
    rmFixture(u.root)
  }
  // trash root that is a symlink -> refused whole, nothing listed
  const g = makeParent('w5-list-sym-')
  try {
    const elsewhere = path.join(g.root, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, path.join(g.parent, '.skillsmith-trash'))
    const r = listTrash({ roots: [g.parent] }).roots[0]
    check('list: a symlinked trash root is refused', r.refused, 'trash-root-unusable')
  } finally {
    rmFixture(g.root)
  }
}

done()
