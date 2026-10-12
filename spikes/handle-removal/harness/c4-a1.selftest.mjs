#!/usr/bin/env node
// SMI-6715: selftest for a1-c4 (mount attack) cleanup handling and its backing-bytes
// fields. Plain node; PASS/FAIL per case; non-zero exit on any FAIL. The real
// mount/umount cannot run off Linux, so the platform is spoofed and the mount,
// umount and /proc/mounts steps are replaced through the `_test` seam; only the
// control flow and scoring around them are under test.
//
//   node harness/c4-a1.selftest.mjs

import path from 'node:path'
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolveHarnessRoot } from './fixture-root.mjs'
import { runMountCase } from './attacks/a1-c4.mjs'

const harnessRoot = resolveHarnessRoot()
let failures = 0
const report = (name, why) => {
  if (why === true || why === undefined) console.log(`PASS  ${name}`)
  else {
    failures += 1
    console.log(`FAIL  ${name}: ${why}`)
  }
}
const check = (name, fn) => {
  try {
    report(name, fn())
  } catch (err) {
    report(name, `threw ${err?.message ?? err}`)
  }
}

// ---- G4: a1-c4 cleanup error handling --------------------------------------
// runMountCase refuses off Linux, and the real mount/umount is out of reach
// here, so the platform is spoofed for the call and the mount, umount and
// cleanup steps are replaced through the `_test` seam. Only the control flow
// around `finally` is under test.
const withLinux = (fn) => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', orig)
  }
}
const noDetach = () => ({ found: 0, umounted: 0, failed: [], lazyUsed: 0, remaining: 0 })
const callCase = (seam) =>
  withLinux(() =>
    runMountCase({
      harnessRoot,
      candidate: 'C4',
      subcase: 'bind',
      window: 'pre-call',
      _test: { detachAll: noDetach, ...seam },
    })
  )
const cleanupThenThrow = (fx) => {
  fx.cleanup()
  throw new Error('CLEANUP-BOOM')
}
const capture = (fn) => {
  try {
    return { value: fn() }
  } catch (err) {
    return { err }
  }
}

check('a1 cleanup: positive control, no failures -> returns a record', () => {
  const r = capture(() => callCase({ doMount: () => {} }))
  return r.value?.precondition?.mutationApplied === false
    ? true
    : `got ${r.err?.message ?? JSON.stringify(r.value)}`
})
check(
  'a1 cleanup: body fails + cleanup throws -> body error is the cause, cleanup message kept',
  () => {
    const body = new Error('BODY-BOOM')
    const r = capture(() =>
      callCase({
        doMount: () => {
          throw body
        },
        cleanup: cleanupThenThrow,
      })
    )
    if (!r.err) return 'did not throw'
    if (r.err.cause !== body)
      return `cause=${r.err.cause?.message ?? r.err.cause} message=${r.err.message}`
    return /CLEANUP-BOOM/.test(r.err.message)
      ? true
      : `message lost the cleanup error: ${r.err.message}`
  }
)
check('a1 cleanup: body ok + cleanup throws -> run fails loudly with the cleanup error', () => {
  const r = capture(() => callCase({ doMount: () => {}, cleanup: cleanupThenThrow }))
  return r.err && /CLEANUP-BOOM/.test(r.err.message) ? true : `got ${r.err?.message ?? 'no throw'}`
})
check('a1 cleanup: body fails, cleanup fine -> the body error itself is thrown', () => {
  const body = new Error('BODY-BOOM')
  const r = capture(() =>
    callCase({
      doMount: () => {
        throw body
      },
    })
  )
  return r.err === body ? true : `got ${r.err?.message ?? 'no throw'}`
})

// ---- F2: A1 records backing-bytes state beside the displacement ------------------
// (the real mount/umount cannot run here; mount, umount and /proc/mounts reads are
// replaced through the seam, only the scoring around them is under test)
const callMount = (subcase, seam) =>
  withLinux(() =>
    runMountCase({
      harnessRoot,
      candidate: 'C4',
      subcase,
      window: 'pre-call',
      _test: { detachAll: noDetach, ...seam },
    })
  )
check('a1 extra: bind backingIntact true when the source file still has its content', () => {
  const r = capture(() =>
    callMount('bind', {
      doMount: ({ mountSourceDir, userContent }) =>
        writeFileSync(path.join(mountSourceDir, 'mounted-user.txt'), userContent),
    })
  )
  return r.value?.extra?.backingIntact === true
    ? true
    : `got ${r.err?.message ?? r.value?.extra?.backingIntact}`
})
check('a1 extra: bind backingIntact false when the source file content is gone/changed', () => {
  const r = capture(() =>
    callMount('bind', {
      doMount: ({ mountSourceDir }) =>
        writeFileSync(path.join(mountSourceDir, 'mounted-user.txt'), 'something else'),
    })
  )
  return r.value?.extra?.backingIntact === false
    ? true
    : `got ${r.err?.message ?? r.value?.extra?.backingIntact}`
})
check(
  'a1 extra: tmpfs backing is read through the mountpoint; mountpointNow is relative to the fixture root',
  () => {
    const r = capture(() =>
      callMount('tmpfs', {
        doMount: ({ targetAbs, userContent }) =>
          writeFileSync(path.join(targetAbs, 'mounted-user.txt'), userContent),
        // a mount follows the renamed tree: report wherever the file now lives
        mountsUnder: (root) => {
          const hit = []
          const walk = (d) => {
            for (const n of readdirSync(d, { withFileTypes: true })) {
              if (n.isDirectory()) walk(path.join(d, n.name))
              else if (n.name === 'mounted-user.txt') hit.push(d)
            }
          }
          walk(root)
          return hit
        },
      })
    )
    const e = r.value?.extra
    return e?.backingIntact === true &&
      /^\.skillsmith-trash[\\/].*target$/.test(e?.mountpointNow ?? '')
      ? true
      : `got ${r.err?.message ?? JSON.stringify([e?.backingIntact, e?.mountpointNow])}`
  }
)
check(
  'a1 extra: no mount found -> mountpointNow null, tmpfs backingIntact null (not false)',
  () => {
    const r = capture(() => callMount('tmpfs', { doMount: () => {}, mountsUnder: () => [] }))
    const e = r.value?.extra
    return e?.mountpointNow === null && e?.backingIntact === null
      ? true
      : `got ${r.err?.message ?? JSON.stringify([e?.backingIntact, e?.mountpointNow])}`
  }
)

// ---- R2-5b: a1-c4 pins the body error as `cause` on every throw-after-finally ----------
const stuckMounts = () => ({ found: 1, umounted: 0, failed: [], lazyUsed: 0, remaining: 1 })
const cleanLeftover = (err) => {
  const m = /mounts remain under (\S+) after/.exec(err?.message ?? '')
  if (m) rmSync(m[1], { recursive: true, force: true })
}
check('a1 mounts-remain: body fails -> thrown error has cause = the body error', () => {
  const body = new Error('BODY-BOOM')
  const r = capture(() =>
    callCase({
      detachAll: stuckMounts,
      doMount: () => {
        throw body
      },
    })
  )
  cleanLeftover(r.err)
  return /mounts remain/.test(r.err?.message ?? '') && r.err.cause === body
    ? true
    : `got message=${r.err?.message} cause=${r.err?.cause?.message}`
})
check('a1 mounts-remain: body ok -> mounts-remain error with no cause', () => {
  const r = capture(() => callCase({ detachAll: stuckMounts, doMount: () => {} }))
  cleanLeftover(r.err)
  return /mounts remain/.test(r.err?.message ?? '') && r.err.cause === undefined
    ? true
    : `got message=${r.err?.message} cause=${r.err?.cause}`
})
check('a1 cleanup-fails: body ok -> the cleanup error is the cause', () => {
  const r = capture(() => callCase({ doMount: () => {}, cleanup: cleanupThenThrow }))
  return /CLEANUP-BOOM/.test(r.err?.message ?? '') && r.err.cause?.message === 'CLEANUP-BOOM'
    ? true
    : `got cause=${r.err?.cause?.message}`
})

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
