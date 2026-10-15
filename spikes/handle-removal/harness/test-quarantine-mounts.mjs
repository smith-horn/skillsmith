#!/usr/bin/env node
// SMI-6715 Step 1b, C4 repair: mounts inside the tree (design §1 S2/S2b/S9b-c,
// §6, §8 R9, R10, R11, R13, L-1).
//
// Real mounts, so each platform runs its own cases:
//   darwin: an hdiutil volume (no root needed). darwin has no bind mount.
//   linux:  tmpfs and a SAME-FILESYSTEM bind mount. Needs root (a throwaway
//           --privileged container only, never a dev container or a host).
//           Not root on Linux -> exit 2, like test-quarantine-errnos.
//
// A Linux same-filesystem bind mount reports the SAME st_dev as its parent, so
// only the mountinfo check (S2b/S9c) can see it; tmpfs differs and is the
// known-different control for the st_dev check (S2/S9b).
//
// DECLARED FAILURE ON TODAY'S CODE: R9/R11 return 'quarantined' and the mount
// moves into the trash with the tree (Probe 3, D-10); R10 returns 'quarantined'
// where 'held' is expected. R13 passes today (computePathTreeHash has no mount
// check); its check is the mutation that defaults mountCheck to true.
// L-1 records outcomes only.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { quarantineTree, computePathTreeHash } from '../quarantine.mjs'
import { runC4Candidate } from './attacks/c4-shared.mjs'
import {
  buildFixture,
  cleanup,
  readText,
  runWithHooks,
  waitUntil,
  sleepMs,
} from './postmove-seam.mjs'

const TAG = '[quarantine-mounts]'
const PLATFORM = process.platform
if (PLATFORM === 'linux' && process.getuid() !== 0) {
  console.log(`${TAG} Linux cases need root in a throwaway --privileged container -- refusing`)
  process.exit(2)
}
if (PLATFORM !== 'linux' && PLATFORM !== 'darwin') {
  console.log(`${TAG} no mount cases for ${PLATFORM} -- refusing`)
  process.exit(2)
}

let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `${TAG} ${PLATFORM} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' }).toString()
const unescape = (p) =>
  p.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(Number.parseInt(o, 8)))

/** Every current mount point (real paths as the kernel reports them). */
function mountPoints() {
  if (PLATFORM === 'linux') {
    return fs
      .readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .map((l) => l.split(' ')[1])
      .filter(Boolean)
      .map(unescape)
  }
  return run('mount', [])
    .split('\n')
    .map((l) => {
      const a = l.indexOf(' on ')
      const b = l.lastIndexOf(' (')
      return a !== -1 && b > a ? l.slice(a + 4, b) : null
    })
    .filter(Boolean)
}
const real = (p) => fs.realpathSync(p)
const mountedAt = (p) => mountPoints().includes(p)
const mountsUnder = (realRoot) =>
  mountPoints()
    .filter((m) => m === realRoot || m.startsWith(`${realRoot}/`))
    .sort((a, b) => b.length - a.length)

/** Detaches everything under `realRoot`; returns the mount points still attached. */
function detachUnder(realRoot) {
  for (const mp of mountsUnder(realRoot)) {
    for (const args of PLATFORM === 'linux'
      ? [
          ['umount', [mp]],
          ['umount', ['-l', mp]],
        ]
      : [
          ['umount', ['-f', mp]],
          ['hdiutil', ['detach', '-force', mp]],
        ]) {
      try {
        run(args[0], args[1])
        break
      } catch {
        /* try the next form */
      }
    }
  }
  return mountsUnder(realRoot)
}
/** Never removes a fixture through a live mount (a bind source would be deleted). */
function finish(f) {
  const left = detachUnder(real(f.root))
  check('cleanup detached every mount', left.join(','), '')
  // darwin: `umount -f` removes the mount but leaves the disk image ATTACHED as
  // a device (measured: 42 devices leaked across runs before this). Detach the
  // device itself, then confirm hdiutil no longer lists this fixture's image.
  for (const dev of f.devices ?? []) {
    try {
      run('hdiutil', ['detach', '-force', dev])
    } catch {
      /* reported by the check below */
    }
  }
  if (PLATFORM === 'darwin') {
    check('cleanup detached the disk image', run('hdiutil', ['info']).includes(f.root), false)
  }
  if (left.length === 0) cleanup(f.root)
}

/** Mounts something at `mp` holding mounted-user.txt. kind: 'hdiutil' | 'tmpfs' | 'bind'. */
function mountAt(kind, mp, f) {
  if (kind === 'hdiutil') {
    const img = path.join(f.root, 'vol.dmg')
    if (!fs.existsSync(img))
      run('hdiutil', ['create', '-size', '4m', '-fs', 'HFS+', '-volname', 's6715', img])
    const out = run('hdiutil', ['attach', '-nobrowse', '-mountpoint', mp, img])
    const dev = /^(\/dev\/disk\d+)\s/m.exec(out)
    if (dev) (f.devices ??= []).push(dev[1])
  } else if (kind === 'tmpfs') {
    run('mount', ['-t', 'tmpfs', '-o', 'size=4m', 'none', mp])
  } else {
    const src = path.join(f.root, 'bind-src')
    fs.mkdirSync(src, { recursive: true })
    run('mount', ['--bind', src, mp])
  }
  fs.writeFileSync(path.join(mp, 'mounted-user.txt'), 'mounted-user-bytes')
}

const KINDS = PLATFORM === 'darwin' ? ['hdiutil'] : ['tmpfs', 'bind']

for (const kind of KINDS) {
  // --- R13: computePathTreeHash stays mount-tolerant (the caller hash uses it)
  {
    const f = buildFixture()
    try {
      mountAt(kind, f.target, f)
      check(
        `R13 ${kind} computePathTreeHash walks through a mount`,
        computePathTreeHash(f.origin).ok,
        true
      )
    } finally {
      finish(f)
    }
  }

  // --- R9 / R11: a mount present before the call -> kept, nothing moved ------
  {
    const f = buildFixture()
    try {
      mountAt(kind, f.target, f)
      const mpReal = real(f.target)
      const guardHash = computePathTreeHash(f.origin).treeHash
      const L = `${PLATFORM === 'darwin' ? 'R9' : 'R11'} ${kind}`
      // Premise: without a caller hash the call below would run UNGUARDED and
      // could not exercise S2/S2b at all.
      check(`${L} premise: the caller hash was computed`, typeof guardHash, 'string')
      const r = quarantineTree(f.parent, f.name, { guardHash })
      check(`${L} status`, r.status, 'kept')
      check(`${L} reason`, r.reason, 'mount-inside-tree')
      check(`${L} detail names the mount`, String(r.detail).includes('target'), true)
      check(`${L} the origin is still in place`, fs.existsSync(f.origin), true)
      check(`${L} the mount is still at the origin`, mountedAt(mpReal), true)
      check(
        `${L} the mounted bytes are readable at the origin`,
        readText(path.join(f.target, 'mounted-user.txt')),
        'mounted-user-bytes'
      )
    } finally {
      finish(f)
    }
  }

  // --- R10: a mount made at C4's re-check (after its hash) -> held -------------
  {
    const f = buildFixture()
    try {
      const r = runC4Candidate({
        candidate: 'C4',
        parentAbs: f.parent,
        name: f.name,
        window: 'post-hash',
        onFire: () => mountAt(kind, f.target, f),
      })
      const L = `R10 ${kind}`
      check(`${L} mount landed at the re-check`, r.onFireInvoked && r.mutationError === null, true)
      check(`${L} status`, r.result.status, 'held')
      check(`${L} reason`, r.result.reason, 'mount-appeared-during-move')
      check(`${L} trace matched`, r.traceMatched, true)
      const heldTarget =
        typeof r.result.path === 'string' ? path.join(r.result.path, 'target') : '/nonexistent'
      check(
        `${L} the mounted bytes travelled with the held copy`,
        readText(path.join(heldTarget, 'mounted-user.txt')),
        'mounted-user-bytes'
      )
    } finally {
      finish(f)
    }
  }
}

// --- L-1 (Linux, residual 2): a late mount racing S9 -- records, never asserts
if (PLATFORM === 'linux') {
  const tally = {}
  let liveInTrash = 0
  const TRIALS = 10
  for (let i = 0; i < TRIALS; i += 1) {
    const f = buildFixture()
    const go = path.join(f.root, 'go')
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        'while [ ! -s "$1" ]; do :; done; mount -t tmpfs -o size=1m none "$(cat "$1")"',
        'l1',
        go,
      ],
      { stdio: 'ignore' }
    )
    try {
      let released = false
      const r = runWithHooks({
        quarantine: quarantineTree,
        parentAbs: f.parent,
        name: f.name,
        options: {
          guardHash: computePathTreeHash(f.origin).treeHash,
          opId: `l1-${process.pid}-${i}`,
        },
        onCall: ({ fn, p0, scope, destPath }) => {
          if (released || fn !== 'readdirSync' || scope !== 'dest' || destPath === null) return
          if (path.resolve(p0) === path.join(destPath, 'target')) {
            released = true
            fs.writeFileSync(go, path.join(destPath, 'target'))
          }
        },
      }).result
      waitUntil(() => child.exitCode !== null, 3000)
      const key = `${r.status}/${r.reason ?? '-'}`
      tally[key] = (tally[key] ?? 0) + 1
      if (mountsUnder(real(path.join(f.parent, '.skillsmith-trash'))).length > 0) liveInTrash += 1
    } finally {
      if (child.exitCode === null) child.kill()
      sleepMs(10)
      const left = detachUnder(real(f.root))
      if (left.length === 0) cleanup(f.root)
      else
        console.log(
          `${TAG} L-1 trial ${i}: could not detach ${left.join(',')}; fixture left in place`
        )
    }
  }
  console.log(
    `${TAG} linux L-1 records (n=${TRIALS}): ${JSON.stringify(tally)}; live mount left in trash: ${liveInTrash}/${TRIALS}`
  )
}

if (!allOk) {
  console.log(`${TAG} SOME CASES FAILED`)
  process.exit(1)
}
console.log(`${TAG} all cases passed`)
