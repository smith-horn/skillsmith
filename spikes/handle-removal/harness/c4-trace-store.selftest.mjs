// Self-test for attacks/c4-trace-store.mjs: every full C4 trace is kept as a
// content-addressed Brotli side file so any verdict can be re-audited. Plain
// node script: PASS/FAIL lines, non-zero exit on any failure. Host node.
//
// Every store call goes through `attempt()`, which turns a throw into data, so a
// "must throw" case and a "must not throw" case are both observable.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { makeFixtureRoot, resolveHarnessRoot } from './fixture-root.mjs'
import { buildSwapFixture } from './attacks/_shared.mjs'
import { runC4Candidate } from './attacks/c4-shared.mjs'
import { compactTrace } from './attacks/c4-trace-match.mjs'
import {
  writeTraceArtifact,
  readTraceArtifact,
  assertCompactMatchesArtifact,
  TRACE_BROTLI_QUALITY,
} from './attacks/c4-trace-store.mjs'

const DIRS = 1630
const harnessRoot = resolveHarnessRoot()
let allOk = true
function check(label, cond, detail = '') {
  if (!cond) allOk = false
  console.log(
    `[c4-trace-store self-test] ${label}: ${cond ? 'PASS' : 'FAIL'}${detail ? ` (${detail})` : ''}`
  )
}
function attempt(fn) {
  try {
    return { value: fn(), err: null }
  } catch (err) {
    return { value: undefined, err }
  }
}
const errText = (err) =>
  err
    ? `${err.name}${err.code ? `/${err.code}` : ''}: ${String(err.message).replace(/\s+/g, ' ').slice(0, 90)}`
    : 'no throw'
const hashOf = (s) => crypto.createHash('sha256').update(s).digest('hex')

// The real 1630-directory C4 trace (the size Step 1 measured).
let trace
{
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const f = buildSwapFixture(fx.root)
    for (let i = 0; i < DIRS; i++) {
      const d = path.join(f.treeRoot, `bulk-${String(i).padStart(4, '0')}`)
      fs.mkdirSync(d)
      fs.writeFileSync(path.join(d, 'f'), `bulk-${i}`)
    }
    trace = runC4Candidate({
      candidate: 'C4',
      parentAbs: fx.root,
      name: 'tree',
      window: 'at-rename',
      onFire() {},
    }).trace
  } finally {
    fx.cleanup()
  }
}
const json = JSON.stringify(trace)
const wantSha = hashOf(json)

const store = makeFixtureRoot({ harnessRoot })
try {
  const dir = path.join(store.root, 'out', 'traces')

  // 1. Write: content address, path relative to dir's parent, size, no temp left.
  const t0 = performance.now()
  const w = attempt(() => writeTraceArtifact(trace, { dir }))
  const ms = performance.now() - t0
  const file = path.join(dir, `${wantSha}.json.br`)
  check('write: did not throw', w.err === null, errText(w.err))
  check(
    'write: sha256 is the hash of JSON.stringify(trace)',
    w.value?.sha256 === wantSha,
    `${w.value?.sha256}`
  )
  check(
    'write: path is relative to the parent of dir',
    w.value?.path === `traces/${wantSha}.json.br`,
    `${w.value?.path}`
  )
  check(
    'write: bytes equals the file size on disk (measurement)',
    fs.existsSync(file) && w.value?.bytes === fs.statSync(file).size,
    `artifact=${w.value?.bytes} B, json=${Buffer.byteLength(json)} B, ratio=${(Buffer.byteLength(json) / (w.value?.bytes ?? 1)).toFixed(1)}x, write+verify=${ms.toFixed(0)} ms`
  )
  check(
    'write: no temp file left behind',
    fs.existsSync(dir) && fs.readdirSync(dir).join(',') === `${wantSha}.json.br`,
    fs.existsSync(dir) ? fs.readdirSync(dir).join(',') : 'no dir'
  )
  check(
    'write: sha256 equals compactTrace(trace).sha256',
    compactTrace(trace, { traceMatched: true }).sha256 === w.value?.sha256
  )

  // 1b. The owner-chosen Brotli quality (5) is what is actually applied. Brotli
  //     is deterministic for a given input and params, so the artifact must be
  //     EXACTLY the size of an independent quality-5 compression of the same
  //     bytes -- which also separates q5 from q6/q9 (within ~1% of q5 here) and
  //     from the q11 default (~40% smaller).
  {
    const q = (n) =>
      zlib.brotliCompressSync(Buffer.from(json), {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: n },
      }).length
    const q5 = q(5)
    const q11 = q(11)
    check(
      'quality: exported TRACE_BROTLI_QUALITY is 5',
      TRACE_BROTLI_QUALITY === 5,
      String(TRACE_BROTLI_QUALITY)
    )
    check(
      'quality: artifact size equals an independent quality-5 compression exactly (not q11)',
      w.value?.bytes === q5 && q5 !== q11 && q5 > q11 * 1.3,
      `artifact=${w.value?.bytes} q5=${q5} q11=${q11}`
    )
  }

  // 2. Read: byte-identical round trip.
  const r = attempt(() => readTraceArtifact(wantSha, { dir }))
  check('read: did not throw', r.err === null, errText(r.err))
  check('read: json is byte-identical to JSON.stringify(trace)', r.value?.json === json)
  check(
    'read: parsed trace re-serialises identically',
    r.value?.trace !== undefined && JSON.stringify(r.value.trace) === json
  )
  check('read: reports the same sha256', r.value?.sha256 === wantSha)

  // 3. Reuse: an existing, valid artifact is verified and reused, not rewritten.
  if (!fs.existsSync(file)) {
    check(
      'reuse: second write returns the same ref and leaves the file untouched',
      false,
      'no artifact to reuse'
    )
  } else {
    const before = fs.statSync(file)
    const w2 = attempt(() => writeTraceArtifact(trace, { dir }))
    const after = fs.statSync(file)
    check(
      'reuse: second write returns the same ref and leaves the file untouched',
      w2.err === null &&
        w2.value?.sha256 === wantSha &&
        w2.value?.path === w.value?.path &&
        w2.value?.bytes === w.value?.bytes &&
        before.ino === after.ino &&
        before.mtimeMs === after.mtimeMs,
      errText(w2.err)
    )
  }

  // 4. Compact <-> artifact cross-check.
  {
    const ok = attempt(() =>
      assertCompactMatchesArtifact(compactTrace(trace, { traceMatched: true }), w.value)
    )
    check('cross-check: matching compact and artifact pass', ok.err === null, errText(ok.err))
    const other = trace.slice(0, -1)
    const bad = attempt(() =>
      assertCompactMatchesArtifact(compactTrace(other, { traceMatched: true }), w.value)
    )
    check(
      'cross-check: a compact of a different trace is caught',
      bad.err instanceof Error,
      errText(bad.err)
    )
    const both = attempt(() =>
      assertCompactMatchesArtifact(compactTrace(null, { traceMatched: true }), {})
    )
    check(
      'cross-check: malformed compact and a ref without sha256 are caught (both undefined)',
      both.err instanceof Error,
      errText(both.err)
    )
    const mal = attempt(() =>
      assertCompactMatchesArtifact(compactTrace(null, { traceMatched: true }), w.value)
    )
    check(
      'cross-check: a malformed compact (no sha256) is caught',
      mal.err instanceof Error,
      errText(mal.err)
    )
  }

  // 5. Corruption: flip one byte; reading must throw, and writing the same trace
  //    must refuse to reuse the corrupt file.
  if (!fs.existsSync(file)) {
    check('corrupt: readTraceArtifact throws on a flipped byte', false, 'no artifact to corrupt')
    check(
      'corrupt: writeTraceArtifact refuses to reuse a corrupt existing file',
      false,
      'no artifact to corrupt'
    )
  } else {
    const buf = fs.readFileSync(file)
    buf[Math.floor(buf.length / 2)] ^= 0xff
    fs.writeFileSync(file, buf)
    const rc = attempt(() => readTraceArtifact(wantSha, { dir }))
    check(
      'corrupt: readTraceArtifact throws on a flipped byte',
      rc.err instanceof Error,
      errText(rc.err)
    )
    const wc = attempt(() => writeTraceArtifact(trace, { dir }))
    check(
      'corrupt: writeTraceArtifact refuses to reuse a corrupt existing file',
      wc.err instanceof Error,
      errText(wc.err)
    )
  }

  // 5b. A file that DECOMPRESSES cleanly but holds other content must still be
  //     refused: the hash check, not the decompressor, is what catches it.
  {
    const imposter = zlib.brotliCompressSync(Buffer.from(JSON.stringify([{ fn: 'other' }])))
    fs.writeFileSync(file, imposter)
    const ri = attempt(() => readTraceArtifact(wantSha, { dir }))
    check(
      'imposter: valid Brotli of other bytes at the address -> read throws on the hash',
      ri.err instanceof Error && /hashes to/.test(ri.err.message),
      errText(ri.err)
    )
    const wi = attempt(() => writeTraceArtifact(trace, { dir }))
    check(
      'imposter: write refuses to reuse it',
      wi.err instanceof Error && /hashes to/.test(wi.err.message),
      errText(wi.err)
    )
  }

  // 6. Absence and bad addresses.
  {
    const miss = attempt(() => readTraceArtifact('0'.repeat(64), { dir }))
    check(
      'missing: readTraceArtifact throws ENOENT for an absent artifact',
      miss.err?.code === 'ENOENT',
      errText(miss.err)
    )
    for (const [label, bad] of [
      ['path traversal', '../../etc/passwd'],
      ['uppercase hex', 'A'.repeat(64)],
      ['too short', 'abc'],
      ['not a string', 42],
    ]) {
      const b = attempt(() => readTraceArtifact(bad, { dir }))
      check(`bad address (${label}) -> TypeError`, b.err instanceof TypeError, errText(b.err))
    }
  }

  // 7. Read-back verification inside write: corrupt the file right after the
  //    rename (test seam) -- write must throw rather than return a ref.
  {
    const small = [{ fn: 'lstatSync', scope: 'origin', at: 1, threw: null }]
    const sdir = path.join(store.root, 'out2', 'traces')
    let hookRan = false
    const wf = attempt(() =>
      writeTraceArtifact(small, {
        dir: sdir,
        _faultAfterRename(p) {
          hookRan = true
          const b = fs.readFileSync(p)
          b[b.length - 1] ^= 0xff
          fs.writeFileSync(p, b)
        },
      })
    )
    check(
      'read-back: corruption after the rename makes write throw',
      hookRan && wf.err instanceof Error,
      `${hookRan ? 'hook ran' : 'hook never ran'}; ${errText(wf.err)}`
    )
  }

  // 8. Shape: relative dir and an unserialisable trace are refused, nothing written.
  {
    const rel = attempt(() => writeTraceArtifact([], { dir: 'relative/traces' }))
    check('shape: relative dir -> TypeError', rel.err instanceof TypeError, errText(rel.err))
    const udir = path.join(store.root, 'out4', 'traces')
    const un = attempt(() => writeTraceArtifact(undefined, { dir: udir }))
    check(
      'shape: a trace with no JSON form (undefined) -> TypeError, nothing written',
      un.err instanceof TypeError && !fs.existsSync(udir),
      errText(un.err)
    )
    const cyc = [{ fn: 'x' }]
    cyc[0].self = cyc[0]
    const cdir = path.join(store.root, 'out3', 'traces')
    const cy = attempt(() => writeTraceArtifact(cyc, { dir: cdir }))
    check(
      'shape: unserialisable trace -> TypeError, nothing written',
      cy.err instanceof TypeError && (!fs.existsSync(cdir) || fs.readdirSync(cdir).length === 0),
      errText(cy.err)
    )
  }
} finally {
  store.cleanup()
}

if (!allOk) {
  console.error('[c4-trace-store self-test] FAIL')
  process.exit(1)
}
console.log('[c4-trace-store self-test] all cases passed')
process.exit(0)
