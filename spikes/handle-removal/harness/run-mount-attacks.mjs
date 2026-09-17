#!/usr/bin/env node
// SMI-6676 checkpoint 2: A1 (mount before the walk) and A2 (mount made
// mid-walk) against C0 and VR V0/V1/V2. Linux only -- real `mount`/`umount`,
// requires --privileged. Never run outside a throwaway container.
//
// Usage: node harness/run-mount-attacks.mjs [--target <n>] [--out <path>]

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeC0 } from '../c0-walk.mjs'
import { removeVR } from '../walk.mjs'
import { makeFixtureRoot, resolveHarnessRoot } from './fixture-root.mjs'
import { appendJsonl, makeRecord, aggregateCell, formatVerdict } from './result-schema.mjs'
import { resolveControl, controlFailedFlag, controlTag } from './control-spec.mjs'
import {
  bindMount,
  tmpfsMount,
  umountQuiet,
  isMounted,
  buildMountFixture,
  verifyMountedFileIntact,
} from './attacks/mount-shared.mjs'

if (process.platform !== 'linux') {
  console.error(
    '[run-mount-attacks] Linux only (real mount/umount) -- refusing on',
    process.platform
  )
  process.exit(2)
}

function parseArgs(argv) {
  const opts = { target: 10, out: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--target') opts.target = Number.parseInt(argv[++i], 10)
    else if (argv[i] === '--out') opts.out = argv[++i]
  }
  return opts
}

const CANDIDATES = {
  c0: {
    label: 'C0',
    remove: (tree, hooks) =>
      removeC0(tree, { identityCheck: true, gate: true, gateTiming: 'before-bind', hooks }),
  },
  v0: { label: 'V0', remove: (tree, hooks) => removeVR(tree, { variant: 'V0', hooks }) },
  v1: { label: 'V1', remove: (tree, hooks) => removeVR(tree, { variant: 'V1', hooks }) },
  v2: { label: 'V2', remove: (tree, hooks) => removeVR(tree, { variant: 'V2', hooks }) },
}

// --- A1: mount already present before the walk starts at all --------------

function runA1(candidateKey, mountKind, harnessRoot) {
  const candidate = CANDIDATES[candidateKey]
  const fx = makeFixtureRoot({ harnessRoot })
  const mountTag = `s6676mnt${process.pid}${Date.now()}`
  let mounted = false
  try {
    const { treeRoot, targetAbs, mountSourceDir } = buildMountFixture(fx.root)
    const userFile = 'mounted-user.txt'
    const userContent = `user-${mountTag}`

    if (mountKind === 'bind') {
      writeFileSync(path.join(mountSourceDir, userFile), userContent)
      bindMount(mountSourceDir, targetAbs)
    } else {
      tmpfsMount(targetAbs, 4)
      writeFileSync(path.join(targetAbs, userFile), userContent)
    }
    mounted = isMounted(targetAbs)

    const start = performance.now()
    const outcome = candidate.remove(treeRoot, {})
    const durationMs = performance.now() - start

    const userFiles = verifyMountedFileIntact(targetAbs, userFile, userContent)
    const stillMounted = isMounted(targetAbs)

    return {
      precondition: {
        hookFired: true,
        mutationApplied: mounted,
        mountActiveAtWalk: mounted,
        controlExpected: true,
      },
      outcome: {
        status: outcome.status,
        reason: outcome.reason ?? null,
        path: outcome.path ?? null,
        errno: outcome.errno ?? null,
      },
      userFiles,
      durationMs,
      extra: {
        mountKind,
        stillMounted,
        unlinkedMountPointName: !stillMounted && outcome.status === 'removed',
      },
    }
  } finally {
    if (isMounted(path.join(fx.root, 'tree', 'target')))
      umountQuiet(path.join(fx.root, 'tree', 'target'))
    fx.cleanup()
  }
}

// --- A2: mount made mid-walk, after the root has been listed but before --
// descending into 'target' -------------------------------------------------

function runA2(candidateKey, mountKind, harnessRoot) {
  const candidate = CANDIDATES[candidateKey]
  const fx = makeFixtureRoot({ harnessRoot })
  const mountTag = `s6676mnt${process.pid}${Date.now()}`
  let hookFired = false
  let mounted = false

  try {
    const { treeRoot, targetAbs, mountSourceDir } = buildMountFixture(fx.root)
    const userFile = 'mounted-user.txt'
    const userContent = `user-${mountTag}`

    const doMount = () => {
      if (hookFired) return
      hookFired = true
      if (mountKind === 'bind') {
        writeFileSync(path.join(mountSourceDir, userFile), userContent)
        bindMount(mountSourceDir, targetAbs)
      } else {
        tmpfsMount(targetAbs, 4)
        writeFileSync(path.join(targetAbs, userFile), userContent)
      }
      mounted = isMounted(targetAbs)
    }

    // Fire right after the root's own listing -- before 'target' is opened
    // or descended into, for both candidate shapes.
    const hooks = {
      afterListing(relPath) {
        if (relPath === '') doMount()
      },
    }

    const start = performance.now()
    const outcome = candidate.remove(treeRoot, hooks)
    const durationMs = performance.now() - start

    const userFiles = verifyMountedFileIntact(targetAbs, userFile, userContent)
    const stillMounted = isMounted(targetAbs)

    return {
      precondition: {
        hookFired,
        mutationApplied: mounted,
        mountActiveAtWalk: mounted,
        controlExpected: true,
      },
      outcome: {
        status: outcome.status,
        reason: outcome.reason ?? null,
        path: outcome.path ?? null,
        errno: outcome.errno ?? null,
      },
      userFiles,
      durationMs,
      extra: { mountKind, stillMounted },
    }
  } finally {
    if (isMounted(path.join(fx.root, 'tree', 'target')))
      umountQuiet(path.join(fx.root, 'tree', 'target'))
    fx.cleanup()
  }
}

function run(label, fn, candidateKey, mountKind, target, out) {
  const records = []
  for (let i = 0; i < target; i += 1) {
    let raw
    try {
      raw = fn(candidateKey, mountKind, resolveHarnessRoot())
    } catch (err) {
      raw = {
        precondition: { hookFired: null },
        outcome: { status: 'harness-error', reason: err.message },
        userFiles: { checked: 0, lost: 0, changed: 0 },
        durationMs: null,
      }
    }
    const record = makeRecord({
      cell: {
        attack: label.split('/')[0],
        variant: mountKind,
        candidate: candidateKey,
        fs: 'overlayfs',
        runner: 'run-mount-attacks.mjs',
      },
      run: i,
      precondition: raw.precondition,
      outcome: raw.outcome,
      userFiles: raw.userFiles,
      durationMs: raw.durationMs,
    })
    records.push(record)
    if (out) appendJsonl(out, { ...record, extra: raw.extra ?? null })
  }
  // `controlFailed: true` was hardcoded here, the same defect control-spec.mjs's
  // header records for run-vr-attacks.mjs and claims to have retired -- it
  // survived in two other files. It asserts that a paired control demonstrated
  // the loss, without this process having observed any control at all, so it
  // could only ever be right by luck. A1's control is `external` (it resolves to
  // `undefined`, and the cell reports PASS (control unverified) rather than a
  // clean PASS); A2's is an in-data C0 cell, which resolves to `absent` when this
  // run does not contain it, reporting NEVER-RAN (control).
  const cell = {
    attack: label.split('/')[0],
    variant: mountKind,
    candidate: candidateKey,
    fs: 'overlayfs',
  }
  const control = resolveControl(cell, [cell])
  const agg = aggregateCell(records, () => false, {
    target,
    controlFailed: controlFailedFlag(control.state),
    controlState: control.state,
  })
  console.log(`${formatVerdict(label, agg)}\tcontrol=${controlTag(control.state)}`)
  return { records, agg }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const outDefault = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'results',
    'raw',
    'mount-attacks-overlayfs.jsonl'
  )
  const out = opts.out ?? outDefault
  console.log(`[run-mount-attacks] target=${opts.target} out=${out}`)
  console.log('')

  for (const mountKind of ['bind', 'tmpfs']) {
    for (const candidateKey of ['c0', 'v0', 'v1', 'v2']) {
      run(
        `A1/${mountKind}/${CANDIDATES[candidateKey].label}`,
        runA1,
        candidateKey,
        mountKind,
        opts.target,
        out
      )
    }
  }
  console.log('')
  for (const mountKind of ['bind', 'tmpfs']) {
    for (const candidateKey of ['c0', 'v0', 'v1', 'v2']) {
      run(
        `A2/${mountKind}/${CANDIDATES[candidateKey].label}`,
        runA2,
        candidateKey,
        mountKind,
        opts.target,
        out
      )
    }
  }
  console.log('')
  console.log('[run-mount-attacks] done')
}

main()
