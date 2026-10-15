#!/usr/bin/env node
// SMI-7123 Wave 5 (design §7): T1 (reserved opId prefix), T2 (strict sidecar
// schema), T3 (readStable detects a same-size write between its reads).
//
//   node test-w5-sidecar.mjs                  real code; every case must pass
//   node test-w5-sidecar.mjs --against <stub> run the cases a stub targets;
//                                             each must FAIL for its declared reason
//
// DECLARED FAILURES (design §7):
//   T1 against TODAY'S code (before the result-shape edit): `.prune-x` accepted.
//   T2 against `classify-lenient`: each invalid sidecar variant classified `clean`.
//   T3 against `read-once`: an equal (ok:true) result returned across the write.

import fs from 'node:fs'
import path from 'node:path'
import { resolveRemovalOptions } from '../result-shape.mjs'
import { makeCheck, w5Root, rmFixture, againstArg } from './w5-test-util.mjs'

const TAG = '[w5-sidecar]'
const { check, done } = makeCheck(TAG)
const against = againstArg()
const want = (ids) => against === null || ids.includes(against)

// --- T1: a dot-prefixed opId is refused; skill names are unaffected ---------
if (against === null || against === 'today') {
  for (const v of ['.prune-x', '..foo', '.hidden']) {
    let threw = false
    try {
      resolveRemovalOptions({ opId: v })
    } catch {
      threw = true
    }
    check(`T1 opId ${JSON.stringify(v)} is refused`, threw, true)
  }
  let plainOk = true
  try {
    resolveRemovalOptions({ opId: 'op-3f9a' })
  } catch {
    plainOk = false
  }
  check('T1 control: a plain opId is still accepted', plainOk, true)
}

if (against === 'today') done()

// The real modules load only for a real run, so a red run against a stub does
// not depend on them existing.
const mutants = await import('./w5-mutants.mjs')
const { parkCopy } = await import('./w5-fixtures.mjs')
const real = against === null ? await import('../prune.sidecar.mjs') : null
const { readStable, parseSidecarStrict } = real ?? {}

// --- T2: four invalid sidecar variants are unverified, never clean ----------
if (want(['classify-lenient'])) {
  const classify =
    against === 'classify-lenient'
      ? mutants.classifyLenient
      : (await import('../prune.classify.mjs')).classifyCopy
  const variants = {
    'extra key': (s) => ({ ...s, extra: 1 }),
    'missing createdAt': (s) => {
      const { createdAt, ...rest } = s
      void createdAt
      return rest
    },
    'opId differs from the op dir': (s) => ({ ...s, opId: 'op-other' }),
    'negative bytes': (s) => ({ ...s, bytes: -1 }),
  }
  for (const [label, edit] of Object.entries(variants)) {
    const f = parkCopy({ shape: 'Q' })
    try {
      const sc = JSON.parse(fs.readFileSync(f.copy.sidecarPath, 'utf8'))
      // Premise: the valid sidecar's hash equals the fresh hash, so only the
      // schema can make this anything but clean.
      check(
        `T2 ${label}: premise, the unedited sidecar classifies clean`,
        classify(f.copy).klass,
        'clean'
      )
      fs.writeFileSync(f.copy.sidecarPath, JSON.stringify(edit(sc), null, 2))
      const c = classify(f.copy)
      check(`T2 ${label}: classified unverified`, c.klass, 'unverified')
      check(`T2 ${label}: reason schema-invalid`, c.reason, 'schema-invalid')
    } finally {
      rmFixture(f.root)
    }
  }
  if (against === null) {
    const f = parkCopy({ shape: 'Q' })
    try {
      const bytes = fs.readFileSync(f.copy.sidecarPath)
      const p = parseSidecarStrict(bytes, {
        copyPath: f.copy.copyPath,
        opDirName: path.basename(f.copy.opDir),
      })
      check('T2 control: the real sidecar parses as shape Q', p.ok && p.shape, 'Q')
    } finally {
      rmFixture(f.root)
    }
  }
}

// --- T3: readStable detects a same-size write between its two reads ---------
if (want(['read-once'])) {
  const rs = against === 'read-once' ? mutants.readOnce : readStable
  const root = fs.mkdtempSync(path.join(w5Root(), 'w5-t3-'))
  try {
    const p = path.join(root, 's.json')
    fs.writeFileSync(p, 'AAAAAAAA')
    // The file is AT REST for longer than one timestamp tick before the read, as a
    // parked sidecar is. Linux 6.12 overlayfs/tmpfs/ext4 keep ctime at 1 ms
    // granularity (measured, scratchpad w5-tick-probe), so a write landing in the
    // SAME tick as the previous change is invisible to any metadata check: that is
    // the design's accepted residual R-open (b)(iii), recorded below, not asserted.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    let fired = false
    const r = rs(p, {
      afterRead: () => {
        fired = true
        const fd = fs.openSync(p, 'r+')
        fs.writeSync(fd, 'BBBBBBBB', 0)
        fs.closeSync(fd)
      },
    })
    check('T3 premise: the write fired between the reads', fired, true)
    check('T3 a same-size write between the reads is detected (ok:false)', r.ok, false)
    if (against === null) {
      const clean = readStable(p)
      check('T3 control: an undisturbed read is ok', clean.ok, true)
      check('T3 control: and returns the bytes', clean.ok && clean.bytes.toString(), 'BBBBBBBB')
      // R-open (b)(iii), recorded only: the same write with NO rest before the read.
      fs.writeFileSync(p, 'AAAAAAAA')
      const sameTick = readStable(p, {
        afterRead: () => {
          const fd = fs.openSync(p, 'r+')
          fs.writeSync(fd, 'CCCCCCCC', 0)
          fs.closeSync(fd)
        },
      })
      console.log(
        `[w5-sidecar] T3 residual R-open (b)(iii) record: a same-tick write was ${sameTick.ok ? 'NOT detected' : 'detected'} on this filesystem`
      )
    }
  } finally {
    rmFixture(root)
  }
}

done()
