#!/usr/bin/env node
// SMI-6676: the decision memo's recommendation condition (1), restated as a
// BEHAVIOURAL acceptance test instead of a promise about call sites.
//
// The condition used to read "every call site that invokes removeTree() must
// compute and pass guardHash". That is unfalsifiable from outside the code and
// was, at the time it was written, already tickable with the exposure intact:
// `removeVR` read `options.guardHash`, `quarantineTree` read
// `options.treeHash`, and `removeTree` forwarded options verbatim to both --
// so a caller doing exactly what the condition demanded was UNGUARDED on the
// fallback path and had its hash silently dropped to `null` in the sidecar.
//
// What is checkable, and what this script checks, is behaviour:
//
//   T1  A WRONG guardHash passed to removeTree() leaves the tree in place --
//       on the native path AND on the fallback path.
//   T2  A CORRECT guardHash passed to removeTree() removes the tree -- on
//       both paths. (Without this, T1 passes trivially for an implementation
//       that never removes anything.)
//   T3  The two paths agree on what the hash of a given tree IS. A caller
//       cannot know which path will run, so one value must satisfy both.
//       Measured over several tree shapes, not asserted.
//   T4  A quarantine that DID verify records the hash it verified; one with
//       no guard hash records null. (The old code recorded null either way,
//       so the sidecar could not distinguish "verified" from "never checked".)
//
// Usage: node harness/test-guard-hash-parity.mjs
// Exit 0 = every case passed. Exit 1 = at least one failed; each line says so.

import fs from 'node:fs'
import path from 'node:path'
import { removeTree, resetProbeCache } from '../hybrid.mjs'
import { removeVR } from '../walk.mjs'
import { computePathTreeHash } from '../quarantine.mjs'
import { makeFixtureRoot, resolveHarnessRoot } from './fixture-root.mjs'

const NATIVE_DISABLE = 'SKILLSMITH_REMOVAL_NATIVE_DISABLE'
let failures = 0

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}\t${name}\t${detail}`)
  if (!ok) failures += 1
}

/** A few shapes, so T3 is a measurement over cases and not one lucky tree. */
const SHAPES = {
  'flat-files': (root) => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'alpha')
    fs.writeFileSync(path.join(root, 'b.txt'), 'beta')
  },
  nested: (root) => {
    fs.mkdirSync(path.join(root, 'd', 'e'), { recursive: true })
    fs.writeFileSync(path.join(root, 'd', 'e', 'deep.txt'), 'deep')
    fs.writeFileSync(path.join(root, 'top.txt'), 'top')
  },
  'empty-dir': (root) => {
    fs.mkdirSync(path.join(root, 'empty'))
  },
  symlink: (root) => {
    fs.writeFileSync(path.join(root, 'real.txt'), 'real')
    fs.symlinkSync('real.txt', path.join(root, 'link'))
  },
  'empty-file': (root) => {
    fs.writeFileSync(path.join(root, 'zero.txt'), '')
  },
  'exec-mode': (root) => {
    fs.writeFileSync(path.join(root, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
  },
}

function build(harnessRoot, shape) {
  const fx = makeFixtureRoot({ harnessRoot })
  const target = path.join(fx.root, 'tree')
  fs.mkdirSync(target)
  SHAPES[shape](target)
  return { fx, target }
}

/** removeVR's own guard-pass hash of a tree, via a dry call that keeps it. */
function nativeTreeHash(target) {
  // A guardHash that cannot match forces `kept` and returns the real hash
  // without removing anything -- removeVR's own documented behaviour.
  const r = removeVR(target, { variant: 'V2', guardHash: 'NEVER-MATCHES' })
  return r.status === 'kept' ? r.treeHash : null
}

function main() {
  const harnessRoot = resolveHarnessRoot()
  console.log(`[test-guard-hash-parity] harnessRoot=${harnessRoot}`)
  console.log('')

  // --- T3: the two paths must agree on the hash of the same tree -----------
  for (const shape of Object.keys(SHAPES)) {
    const { fx, target } = build(harnessRoot, shape)
    try {
      const viaHandles = nativeTreeHash(target)
      const viaPath = computePathTreeHash(target)
      check(
        `T3/${shape}`,
        viaHandles != null && viaPath.ok && viaHandles === viaPath.treeHash,
        viaHandles == null
          ? 'removeVR did not return a hash'
          : !viaPath.ok
            ? `path hash failed: ${viaPath.reason}`
            : viaHandles === viaPath.treeHash
              ? `both = ${viaHandles.slice(0, 16)}...`
              : `handles=${viaHandles.slice(0, 16)}... path=${viaPath.treeHash.slice(0, 16)}...`
      )
    } finally {
      fx.cleanup()
    }
  }
  console.log('')

  // --- T1 / T2 / T4, on each path -----------------------------------------
  for (const pathName of ['native', 'fallback']) {
    const usingFallback = pathName === 'fallback'
    if (usingFallback) process.env[NATIVE_DISABLE] = '1'
    else delete process.env[NATIVE_DISABLE]
    resetProbeCache()

    // T0 -- which path actually ran. Without this, a host where the native
    // probe fails (no prebuild for the platform, a stale binary, a container
    // that never got one) runs the FALLBACK for both arms and still prints a
    // clean sheet -- the native-path cases would be reported as passing when
    // the native path was never exercised. Observed live: the first Linux run
    // of this script did exactly that.
    let ranFallback = null
    {
      const { fx, target } = build(harnessRoot, 'flat-files')
      try {
        const res = removeTree(target, {})
        ranFallback = res.fallbackTrigger != null
        check(
          `T0/${pathName}/path-actually-exercised`,
          ranFallback === usingFallback,
          usingFallback
            ? `expected fallback, got ${ranFallback ? 'fallback' : 'native'}`
            : `expected native, got ${ranFallback ? `fallback (trigger=${res.fallbackTrigger}) -- THE NATIVE CASES BELOW DID NOT EXERCISE THE NATIVE PATH` : 'native'}`
        )
      } finally {
        fx.cleanup()
      }
    }

    // T1 -- a WRONG guardHash must leave the tree in place.
    {
      const { fx, target } = build(harnessRoot, 'nested')
      try {
        const res = removeTree(target, { guardHash: 'DELIBERATELY-WRONG-HASH' })
        const stillThere = fs.existsSync(target)
        const contentStillThere = fs.existsSync(path.join(target, 'd', 'e', 'deep.txt'))
        check(
          `T1/${pathName}/wrong-hash-keeps-tree`,
          stillThere && contentStillThere && res.status === 'kept',
          `status=${res.status} treeExists=${stillThere} contentExists=${contentStillThere}`
        )
      } finally {
        fx.cleanup()
      }
    }

    // T2 -- a CORRECT guardHash must still remove (or quarantine) the tree,
    // so T1 cannot pass by an implementation that simply never acts.
    {
      const { fx, target } = build(harnessRoot, 'nested')
      try {
        const h = computePathTreeHash(target)
        const res = removeTree(target, { guardHash: h.ok ? h.treeHash : 'x' })
        const goneFromOrigin = !fs.existsSync(target)
        const acted = res.status === 'removed' || res.status === 'quarantined'
        check(
          `T2/${pathName}/correct-hash-acts`,
          acted && goneFromOrigin,
          `status=${res.status} originGone=${goneFromOrigin}`
        )
        // T4 -- the sidecar records the hash that was actually verified.
        if (res.status === 'quarantined') {
          const sc = JSON.parse(fs.readFileSync(res.sidecarPath, 'utf8'))
          check(
            `T4/${pathName}/sidecar-records-verified-hash`,
            sc.treeHash === (h.ok ? h.treeHash : null),
            `sidecar.treeHash=${sc.treeHash == null ? 'null' : sc.treeHash.slice(0, 16) + '...'}`
          )
        }
      } finally {
        fx.cleanup()
      }
    }

    // T4b -- no guard hash supplied: the sidecar must say null, not a value
    // it never checked.
    if (usingFallback) {
      const { fx, target } = build(harnessRoot, 'flat-files')
      try {
        const res = removeTree(target, {})
        if (res.status === 'quarantined') {
          const sc = JSON.parse(fs.readFileSync(res.sidecarPath, 'utf8'))
          check(
            `T4b/${pathName}/no-guard-hash-records-null`,
            sc.treeHash === null,
            `sidecar.treeHash=${String(sc.treeHash)}`
          )
        } else {
          check(`T4b/${pathName}/no-guard-hash-records-null`, false, `status=${res.status}`)
        }
      } finally {
        fx.cleanup()
      }
    }
  }

  delete process.env[NATIVE_DISABLE]
  resetProbeCache()

  console.log('')
  console.log(failures === 0 ? 'ALL CASES PASSED' : `${failures} CASE(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
