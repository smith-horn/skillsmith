// SMI-7123 Wave 5 (design §6): the walker rows P7-P9, split out of w5-rows-p.mjs for
// the file-length limit and moved verbatim. w5-rows-p.mjs loads the implementations
// once and hands its lookup in through bindImpls() before any row runs.
import fs from 'node:fs'
import path from 'node:path'
import { makeParent, park } from './w5-fixtures.mjs'
import { PLATFORM, makeImage } from './w5-mounts.mjs'
import { matchPruneTrace } from './prune-trace-match.mjs'
import {
  raw,
  neverRan,
  finishFixture,
  prunePass,
  fired,
  sourcesAccounted,
  read,
  readJson,
} from './w5-rows-common.mjs'

let I = null
/** Receives w5-rows-p.mjs's implementation lookup (name -> {prune, stub?, walkerPath?}). */
export function bindImpls(lookup) {
  I = lookup
}

// --- P7: an outward symlink | a dir swapped for a symlink after P4e ------------------
function p7(arm, variant) {
  const f = makeParent('w5-p7-')
  const fails = []
  try {
    const outside = path.join(f.root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'sentinel-bytes')
    park(f.parent, 't', 'Q', variant === 'outward' ? { outLink: outside } : {})
    const hooks =
      variant === 'swap' && arm === 'candidate'
        ? [
            {
              when: 'before',
              fn: 'chdir',
              a0Re: '^\\.d-',
              nth: 1,
              action: { kind: 'symlinkSwap', outside, awayDir: f.root },
            },
          ]
        : []
    if (variant === 'swap' && arm !== 'candidate')
      return neverRan(
        variant,
        'prune-follow has no chdir to time the swap against; the outward case is its control'
      )
    const { item, t } = prunePass(I(arm === 'candidate' ? 'candidate' : 'prune-follow'), f, {
      hooks,
    })
    if (hooks.length && !fired(t, 'symlinkSwap'))
      return raw({ hookFired: false, variant, extra: { neverRan: 'the swap did not land' } })
    const intact = read(path.join(outside, 'sentinel.txt')) === 'sentinel-bytes'
    if (!intact) fails.push('the outside sentinel was deleted')
    return raw({ variant, item, checked: 1, lost: intact ? 0 : 1, failures: fails })
  } finally {
    finishFixture(f)
  }
}

// --- P8: the sidecar rewritten in place, same size (i) before P4d' (ii) after P4e ----
function p8(arm, variant) {
  const f = makeParent('w5-p8-')
  const fails = []
  try {
    park(f.parent, 't', 'Q')
    const hook =
      variant === 'i'
        ? {
            when: 'before',
            fn: 'renameSync',
            a1Re: '/sidecar\\.json$',
            action: { kind: 'rewriteInPlace', path: '$a0' },
          }
        : {
            when: 'before',
            fn: 'writeFileSync',
            a0Re: '^deleting$',
            action: { kind: 'rewriteInPlace', path: '$cwd/sidecar.json' },
          }
    const { item, t } = prunePass(
      I(arm === 'candidate' ? 'candidate' : 'sidecar-same-inode-rewrite'),
      f,
      { hooks: [hook] }
    )
    if (!fired(t, 'rewriteInPlace'))
      return raw({ hookFired: false, variant, extra: { neverRan: 'the rewrite did not land' } })
    const S =
      item.stagingPath ??
      fs
        .readdirSync(path.join(f.parent, '.skillsmith-trash'))
        .filter((n) => n.startsWith('.prune-'))
        .map((n) => path.join(f.parent, '.skillsmith-trash', n))[0]
    const intact = S ? /^Z+$/.test(read(path.join(S, 'sidecar.json'))) : false
    if (!intact) fails.push('the rewritten sidecar was deleted')
    const want =
      variant === 'i' ? 'held/sidecar-changed-in-staging' : 'stopped/changed-during-delete'
    if (arm === 'candidate' && `${item.status}/${item.reason}` !== want)
      fails.push(`status ${item.status}/${item.reason}, want ${want}`)
    return raw({ variant, item, checked: 1, lost: intact ? 0 : 1, failures: fails })
  } finally {
    finishFixture(f)
  }
}

// --- P9: misplacement (i) swap-after-precheck (ii) darwin-cover-before-rename --------
function p9(arm, variant) {
  if (variant === 'ii' && PLATFORM !== 'darwin')
    return neverRan(variant, 'darwin-only: Linux has no cwd-capturing cover')
  const f = makeParent('w5-p9-')
  const fails = []
  try {
    const c = park(f.parent, 't', 'Q')
    const rec = path.join(f.root, 'hook.json')
    const sources = {}
    let hook
    if (variant === 'i') {
      hook = {
        when: 'before',
        fn: 'renameSync',
        a0Re: '^top\\.txt$',
        a1Re: '^\\.d-',
        action: { kind: 'swap', awayDir: f.root, data: 'replacement-bytes', recordFile: rec },
      }
    } else {
      const files = { 'orig-f1': 'volume-bytes', 'other.txt': 'other-volume-bytes' }
      hook = {
        when: 'before',
        fn: 'renameSync',
        a0Re: '^orig-f1$',
        a1Re: '^\\.d-',
        action: { kind: 'cover', image: makeImage(f.root, files, f), recordFile: rec },
      }
      Object.assign(sources, files)
    }
    const { item, t } = prunePass(I(arm), f, { hooks: [hook] })
    const h = readJson(rec)
    if (h === null)
      return raw({
        hookFired: false,
        variant,
        extra: { neverRan: `the ${variant === 'i' ? 'swap' : 'cover'} did not land in its window` },
      })
    const m = Array.isArray(item.misplaced) ? item.misplaced : []
    if (`${item.status}/${item.reason}` !== 'stopped/entry-misplaced')
      fails.push(`status ${item.status}/${item.reason}`)
    if (variant === 'i') {
      const st = m[0]
        ? (() => {
            try {
              return fs.lstatSync(m[0].path, { bigint: true })
            } catch {
              return null
            }
          })()
        : null
      if (!m[0]) fails.push('the replacement is not named in misplaced[]')
      else {
        if (
          !st ||
          `${st.dev}/${st.ino}` !== `${h.dev}/${h.ino}` ||
          read(m[0].path) !== 'replacement-bytes'
        )
          fails.push('misplaced[0] is not the replacement')
        if (m[0].originalRel !== 'top.txt' || m[0].cause !== 'swapped')
          fails.push(`originalRel/cause ${m[0].originalRel}/${m[0].cause}`)
        const file = readJson(path.join(item.stagingPath ?? '/nonexistent', 'misplaced.json'))
        if (!file || file.path !== m[0].path) fails.push('S/misplaced.json does not match')
      }
    } else {
      const vol = h.mountpoint
      const map = Object.fromEntries(
        Object.entries(sources).map(([n, b]) => [path.join(vol, n), b])
      )
      fails.push(...sourcesAccounted(map, m))
      if (m[0] && m[0].cause !== 'cwd-covered') fails.push(`cause ${m[0].cause}`)
    }
    const victim = variant === 'i' ? 'top.txt' : 'orig-f1'
    const at = (t?.trace ?? []).findIndex((e) => e.fn === 'renameSync' && e.a0 === victim)
    if (
      at >= 0 &&
      t.trace.slice(at + 1).some((e) => e.fn === 'unlinkSync' && /^\.d-/.test(e.a0 ?? ''))
    )
      fails.push('an unlink followed the misplacement')
    const tm = matchPruneTrace(t, {
      root: f.root,
      S: item.stagingPath ?? null,
      copyPath: c.copyPath,
      opDir: c.opDir,
    })
    if (!tm.ok) fails.push(`trace invariant: ${tm.violations[0]}`)
    return raw({ variant, item, checked: 1, failures: fails, extra: { misplaced: m } })
  } finally {
    finishFixture(f)
  }
}

// --- Pswap (Sol c1 finding 1): RECORD-ONLY, out-of-model residual R-swap ------------
// After the walker's post-rename lstat(r) of target/orig-f1 (its last check) and
// before unlinkSync(r), a racer moves the approved file at the hidden name r aside
// and puts an unapproved victim at r. Owner decision 2026-10-14: an adversary
// targeting the random names in the 0700 staging dir is out of model (ADR-166
// D-0); this row records what happens and asserts nothing.
function pswap() {
  const f = makeParent('w5-pswap-')
  try {
    park(f.parent, 't', 'Q')
    const rec = path.join(f.root, 'swap.json')
    // .d-* regular files after their post-rename lstat: #1 the sidecar, #2 target/orig-f1.
    const hook = {
      when: 'after',
      fn: 'lstatSync',
      a0Re: '^\\.d-',
      a0IsFile: true,
      nth: 2,
      action: { kind: 'swap', awayDir: f.root, data: 'victim-bytes', recordFile: rec },
    }
    const { item, t } = prunePass(I('candidate'), f, { hooks: [hook] })
    const sw = readJson(rec)
    if (sw === null || !fired(t, 'swap'))
      return raw({
        hookFired: false,
        extra: { neverRan: 'the swap did not land after the post-check' },
      })
    const victimSurvived = read(sw.replacement) === 'victim-bytes'
    const approvedAway = read(sw.away)
    const extra = {
      status: `${item.status}/${item.reason}`,
      victimSurvived,
      approvedBytesIntactAside: approvedAway === 'original-content-f1',
      approvedAt: sw.away,
      reported: Array.isArray(item.misplaced) ? item.misplaced : null,
      detail: item.detail ?? null,
    }
    return raw({
      item,
      checked: 1,
      lost: victimSurvived ? 0 : 1,
      failures: victimSurvived
        ? []
        : ['the unapproved victim at the hidden name was unlinked (R-swap)'],
      extra,
    })
  } finally {
    finishFixture(f)
  }
}

// --- Pmswap (Sol c2 finding 2): RECORD-ONLY, the R-swap class for metadata -----------
// Post-walk metadata removal now renames `deleting` / `intent.json` to a random
// `.m-<16 hex>` name, re-checks, and unlinks THAT name. A racer that learns the
// random name between the final lstat and the unlink can still swap a victim
// in: the same out-of-model one-syscall window as R-swap. Recorded, not scored.
function pmswap() {
  const f = makeParent('w5-pmswap-')
  try {
    park(f.parent, 't', 'Q')
    const rec = path.join(f.root, 'mswap.json')
    const hook = {
      when: 'before',
      fn: 'unlinkSync',
      a0Re: '/\\.m-[0-9a-f]{16}$',
      nth: 1,
      action: { kind: 'swap', awayDir: f.root, data: 'victim-bytes', recordFile: rec },
    }
    const { item, t } = prunePass(I('candidate'), f, { hooks: [hook] })
    const sw = readJson(rec)
    if (sw === null || !fired(t, 'swap'))
      return raw({
        hookFired: false,
        extra: { neverRan: 'the swap did not land at the random name' },
      })
    const victimSurvived = read(sw.replacement) === 'victim-bytes'
    const extra = {
      status: `${item.status}/${item.reason}`,
      victimSurvived,
      metadataAside: sw.away,
      reported: item.metadataKept ?? null,
    }
    return raw({
      item,
      checked: 1,
      lost: victimSurvived ? 0 : 1,
      failures: victimSurvived
        ? []
        : ['the victim at the random metadata name was unlinked (R-swap class)'],
      extra,
    })
  } finally {
    finishFixture(f)
  }
}

export { p7, p8, p9, pswap, pmswap }
