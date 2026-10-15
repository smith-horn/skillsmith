#!/usr/bin/env node
// SMI-6711 HIGH 5: a content hash must describe only bytes that were read.
//
// Both hash sites (hash.mjs's guard pass, walk.mjs's V2 re-verify) called
// `fs.readSync(fd, buf, 0, size, 0)` once and ignored the byte count. A short
// read left buf's suffix zero-filled and the digest described bytes nobody
// read. Both now go through `readExactly`, and an incomplete read stops the
// operation as `entry-changed`.
//
//   R1-R4  readExactly itself: exact, shrunk, grown, and chunked reads.
//   G1     the guard pass STOPS on a truncating read rather than returning a
//          hash. G0 is its positive control: the same tree, no stub, is `ok`.
//   V1     V2's re-verify STOPS on a truncating read of a file whose real
//          trailing bytes are zeros. That is the case where a zero-filled
//          buffer hashes equal to the guard's full read, so the old code
//          removed the file having read half of it. V0 is the control: no
//          stub, the same call removes it.
//
// readSync is stubbed on the shared `node:fs` default export, which is the
// object hash.mjs and walk.mjs call through.
//
// Usage: node harness/test-read-exactly.mjs
// Exit 0 = every case passed. Exit 1 = at least one failed; each line says so.

import fs from 'node:fs'
import path from 'node:path'
import { readExactly, guardPass } from '../hash.mjs'
import { removeVR } from '../walk.mjs'
import { loadShim } from '../native-c/load.mjs'
import { makeFixtureRoot } from './fixture-root.mjs'

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}\t${name}\t${detail}`)
  if (!ok) failures += 1
}

const realReadSync = fs.readSync

/** Make every read behave as if the file ended at `eof` bytes. */
function truncatingReadSync(eof) {
  return (fd, buf, off, len, pos) => {
    if (pos >= eof) return 0
    return realReadSync(fd, buf, off, Math.min(len, eof - pos), pos)
  }
}

/** Return at most `chunk` bytes per call, otherwise reading normally. */
function chunkedReadSync(chunk) {
  return (fd, buf, off, len, pos) => realReadSync(fd, buf, off, Math.min(len, chunk), pos)
}

function withStub(stub, fn) {
  fs.readSync = stub
  try {
    return fn()
  } finally {
    fs.readSync = realReadSync
  }
}

function tree(content) {
  const fx = makeFixtureRoot()
  const target = path.join(fx.root, 'tree')
  fs.mkdirSync(target)
  const file = path.join(target, 'f.bin')
  fs.writeFileSync(file, content)
  return { fx, target, file }
}

function guardOf(target) {
  const shim = loadShim()
  const P = shim.openDir(path.dirname(target))
  const T = shim.openAt(P.fd, path.basename(target), true)
  try {
    return guardPass(shim, T.fd)
  } finally {
    fs.closeSync(P.fd)
  }
}

function main() {
  const bytes = Buffer.from('ABCDEFGH')

  // R1-R4: readExactly on a real fd.
  {
    const { fx, file } = tree(bytes)
    const fd = fs.openSync(file, 'r')
    try {
      const r1 = readExactly(fd, 8)
      check(
        'R1 exact size reads every byte',
        r1.complete && r1.buf.equals(bytes),
        `complete=${r1.complete}`
      )
      const r2 = readExactly(fd, 12)
      check(
        'R2 file shorter than size is incomplete',
        r2.complete === false,
        `complete=${r2.complete}`
      )
      const r3 = readExactly(fd, 5)
      check(
        'R3 file longer than size is incomplete',
        r3.complete === false,
        `complete=${r3.complete}`
      )
      const r4 = withStub(chunkedReadSync(3), () => readExactly(fd, 8))
      check(
        'R4 chunked short reads still assemble the whole file',
        r4.complete && r4.buf.equals(bytes),
        `complete=${r4.complete} buf=${r4.buf.toString()}`
      )
    } finally {
      fs.closeSync(fd)
      fx.cleanup()
    }
  }

  // G0/G1: the guard pass.
  {
    const { fx, target } = tree(bytes)
    try {
      const g0 = guardOf(target)
      check(
        'G0 control: guard pass on the unstubbed tree is ok',
        g0.status === 'ok',
        `status=${g0.status}`
      )
      if (g0.status === 'ok') for (const fd of g0.heldFds.values()) fs.closeSync(fd)
      const g1 = withStub(truncatingReadSync(4), () => guardOf(target))
      check(
        'G1 a truncating read stops the guard pass instead of hashing',
        g1.status === 'stopped' && g1.reason === 'entry-changed' && g1.path === 'f.bin',
        `status=${g1.status} reason=${g1.reason} path=${g1.path}`
      )
      if (g1.status === 'ok') for (const fd of g1.heldFds.values()) fs.closeSync(fd)
    } finally {
      fx.cleanup()
    }
  }

  // V0/V1: V2's re-verify, with real trailing zeros so a zero-filled buffer
  // collides with the guard's honest hash.
  const zeros = Buffer.from([0x41, 0x42, 0x43, 0x44, 0, 0, 0, 0])
  {
    const { fx, target } = tree(zeros)
    try {
      const v0 = removeVR(target, { variant: 'V2' })
      check(
        'V0 control: unstubbed V2 removal removes the tree',
        v0.status === 'removed' && !fs.existsSync(target),
        `status=${v0.status}`
      )
    } finally {
      fx.cleanup()
    }
  }
  {
    const { fx, target, file } = tree(zeros)
    let stubbed = false
    try {
      const v1 = removeVR(target, {
        variant: 'V2',
        hooks: {
          betweenGuardAndRemoval() {
            fs.readSync = truncatingReadSync(4)
            stubbed = true
          },
        },
      })
      fs.readSync = realReadSync
      check(
        'V1 a truncating re-verify read stops V2 before removal',
        stubbed && v1.status === 'stopped' && v1.reason === 'entry-changed' && fs.existsSync(file),
        `stubbed=${stubbed} status=${v1.status} reason=${v1.reason} fileSurvives=${fs.existsSync(file)}`
      )
    } finally {
      fs.readSync = realReadSync
      fx.cleanup()
    }
  }

  console.log('')
  console.log(failures === 0 ? 'ALL CASES PASSED' : `${failures} CASE(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
