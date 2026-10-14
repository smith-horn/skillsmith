#!/usr/bin/env node
// SMI-7123 Wave 5 (design §7.1, coordinator change): T19 / W1, the trash warning.
//
//   node test-w5-usage.mjs [--against warn-max-not-min | warn-apparent-bytes]
//
// The threshold is min(capBytes, freeFraction x free) per volume, and the total
// is ALLOCATED bytes (st_blocks x 512, de-duplicated by (dev, ino)) -- not the
// sidecar's apparent `bytes`, which undercounts directory- and small-file-heavy
// copies (measured 0.46 MB apparent vs 17.1 MB allocated).
//
// DECLARED FAILURES:
//   warn-max-not-min     over:false at free = 10 GB, total = 0.6 GB
//   warn-apparent-bytes  over:false on the fixture whose allocated size crosses
//                        the threshold while its apparent size does not

import fs from 'node:fs'
import path from 'node:path'
import { makeCheck, rmFixture, againstArg } from './w5-test-util.mjs'
import { makeParent, park } from './w5-fixtures.mjs'
import * as mutants from './w5-mutants.mjs'

const TAG = '[w5-usage]'
const { check, done } = makeCheck(TAG)
const against = againstArg()
if (against !== null && !['warn-max-not-min', 'warn-apparent-bytes'].includes(against)) {
  console.error(`${TAG} no case targets ${against}`)
  process.exit(2)
}
const real = against === null ? await import('../trash-usage.mjs') : null
const trashWarning =
  against === 'warn-max-not-min'
    ? mutants.warnMaxNotMin
    : (real?.trashWarning ?? mutants.warnMinReference)
const trashUsage = against === 'warn-apparent-bytes' ? mutants.usageApparentBytes : real?.trashUsage

const GB = 1e9
const vol = (free, sizes) => ({
  volumes: [
    {
      dev: '1',
      freeBytes: free,
      totalBytes: 500 * GB,
      copies: sizes.map((b, i) => ({
        path: `/t/op-${i}/c${i}-0000000${i}`,
        bytes: b,
        originPath: `/skills/c${i}`,
        opId: `op-${i}`,
      })),
    },
  ],
})

// --- threshold is the MIN of the cap and the free-space fraction ---------------------
if (against === null || against === 'warn-max-not-min') {
  const cases = [
    ['free 10 GB, total 0.6 GB (5% = 0.5 GB < cap)', 10 * GB, [0.6 * GB], true],
    ['free 10 GB, total 0.4 GB', 10 * GB, [0.4 * GB], false],
    ['free 100 GB, total 0.9 GB (cap 1 GB < 5 GB)', 100 * GB, [0.9 * GB], false],
    ['free 100 GB, total 1.1 GB', 100 * GB, [0.6 * GB, 0.5 * GB], true],
  ]
  for (const [label, free, sizes, over] of cases) {
    const w = trashWarning(vol(free, sizes))
    check(`T19 ${label}: over`, w.over, over)
  }
  if (against === null) {
    const w = trashWarning(vol(100 * GB, [0.2 * GB, 0.9 * GB, 0.05 * GB, 0.3 * GB]))
    const largest = w.perVolume[0].largest.map((c) => c.path)
    check(
      'W1 largest: top 3, sorted by size',
      largest.join(','),
      '/t/op-1/c1-00000001,/t/op-3/c3-00000003,/t/op-0/c0-00000000'
    )
    check('W1 the threshold is reported', w.perVolume[0].thresholdBytes, 1 * GB)
    check(
      'W1 the message names each of the largest',
      largest.every((p) => w.message.includes(p)),
      true
    )
    check(
      'W1 the message says nothing is deleted automatically',
      /Nothing is deleted automatically/.test(w.message),
      true
    )
    check(
      'W1 no warning when under: message null',
      trashWarning(vol(100 * GB, [0.1 * GB])).message,
      null
    )
  }
}

// --- allocated, not apparent (coordinator change) -------------------------------------
if (against === null || against === 'warn-apparent-bytes') {
  const f = makeParent('w5-w1-')
  try {
    const c = park(f.parent, 'tiny', 'Q', { extraFiles: 300 })
    let apparent = 0
    let allocated = 0
    const seen = new Set()
    const visit = (p) => {
      const st = fs.lstatSync(p)
      apparent += st.size
      const k = `${st.dev}:${st.ino}`
      if (!seen.has(k)) {
        seen.add(k)
        allocated += st.blocks * 512
      }
      if (st.isDirectory()) for (const n of fs.readdirSync(p)) visit(path.join(p, n))
    }
    visit(c.copyPath)
    const cap = Math.floor((apparent + allocated) / 2)
    check(`W1 premise: allocated ${allocated} crosses the cap ${cap}`, allocated > cap, true)
    check(`W1 premise: apparent ${apparent} does not`, apparent < cap, true)
    const statfs = () => ({ bavail: 1e12 / 4096, bsize: 4096, blocks: 2e12 / 4096 })
    const u = trashUsage({ roots: [f.parent], statfs })
    const w = trashWarning(u, { capBytes: cap })
    check('W1 the warning fires on allocated bytes', w.over, true)
    if (against === null)
      check('W1 the copy total is its allocated size', u.volumes[0].copies[0].bytes, allocated)
  } finally {
    rmFixture(f.root)
  }
}

done()
