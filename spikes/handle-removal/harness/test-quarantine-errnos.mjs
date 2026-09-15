#!/usr/bin/env node
// SMI-6676 checkpoint 4: forces each real errno the D1 "sibling rename
// fails" path names (EXDEV, EACCES, EROFS, EBUSY, ENOSPC) against
// quarantineTree(), and asserts the invariant that matters most: nothing
// moves and nothing is deleted. Linux only (real mount/chmod/loopback);
// refuses elsewhere. Must run --privileged.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { quarantineTree } from '../quarantine.mjs'

// Resolved from this file's own location, never process.cwd() -- the
// harness tool's cwd resets between shell calls.
const QUARANTINE_MODULE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'quarantine.mjs'
)

if (process.platform !== 'linux') {
  console.error('[test-quarantine-errnos] Linux only -- refusing on', process.platform)
  process.exit(2)
}

const HARNESS_ROOT = process.env.SMI6676_HARNESS_ROOT ?? '/work'
fs.mkdirSync(HARNESS_ROOT, { recursive: true })

let failures = 0
function check(label, cond, detail) {
  const ok = !!cond
  if (!ok) failures += 1
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' -- ' + detail : ''}`)
  return ok
}

function buildTarget(base) {
  const parent = path.join(base, 'parent')
  const target = path.join(parent, 'target')
  fs.mkdirSync(path.join(target, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(target, 'f1'), 'user-data-f1')
  fs.writeFileSync(path.join(target, 'sub', 'f2'), 'user-data-f2')
  return { parent, target }
}

/** Never throws -- a read failure IS the finding here, not a script crash. */
function assertUntouched(label, target) {
  let stillThere = false
  let f1 = false
  let f2 = false
  try {
    stillThere = fs.existsSync(target)
    f1 = stillThere && fs.readFileSync(path.join(target, 'f1'), 'utf8') === 'user-data-f1'
    f2 = stillThere && fs.readFileSync(path.join(target, 'sub', 'f2'), 'utf8') === 'user-data-f2'
  } catch (err) {
    check(
      `${label}: tree untouched (still at original path, content intact)`,
      false,
      `threw: ${err.code ?? err.message}`
    )
    return
  }
  check(`${label}: tree untouched (still at original path, content intact)`, stillThere && f1 && f2)
}

function umountQuiet(target) {
  try {
    execFileSync('umount', [target])
  } catch {
    /* best-effort */
  }
}

/**
 * @param {string} label
 * @param {(base:string, parent:string, target:string) => void} setup
 * @param {(base:string, parent:string, target:string) => void} teardown -
 *   must fully undo `setup` (unmount, etc) so the content check afterward
 *   sees the real, underlying tree -- not whatever is currently mounted
 *   over it.
 */
function run(label, setup, teardown, { allowSidecarFailureAsSafe = false } = {}) {
  const base = fs.mkdtempSync(path.join(HARNESS_ROOT, 'qerrno-'))
  const { parent, target } = buildTarget(base)
  let result = null
  try {
    setup?.(base, parent, target)
    result = quarantineTree(parent, 'target', { opId: 'errnotest' })
    console.log(`  result: ${JSON.stringify(result)}`)
    const cleanStop = result.status === 'stopped' && result.reason === 'quarantine-failed'
    // ENOSPC specifically can strike AFTER a successful rename (writing the
    // sidecar), which is a different but equally safe outcome: the tree is
    // already quarantined, nothing lost, just missing rich metadata. Both
    // shapes count as "did not lose or corrupt the tree" for this test.
    const safeSidecarFailure =
      allowSidecarFailureAsSafe && result.status === 'quarantined' && !!result.sidecarError
    check(
      `${label}: no data-loss outcome (stopped-before-move, or quarantined-with-sidecar-failure)`,
      cleanStop || safeSidecarFailure,
      `status=${result.status} reason=${result.reason} errno=${result.errno} sidecarError=${result.sidecarError}`
    )
  } catch (err) {
    check(`${label}: no data-loss outcome`, false, `threw instead: ${err.code ?? err.message}`)
  } finally {
    // If quarantine actually succeeded (the sidecar-failure case), the tree
    // now lives INSIDE whatever setup() mounted -- verify it BEFORE
    // teardown unmounts that filesystem out from under it (tmpfs content
    // doesn't survive its own unmount; caught live by this test on ENOSPC,
    // where the quarantined tree and the full tmpfs are the same
    // filesystem). Only the untouched-original case needs teardown to run
    // FIRST, since that's what restores access to it (unmount a read-only
    // bind, restore permissions).
    if (result && result.status === 'quarantined') {
      try {
        const f1 = fs.readFileSync(path.join(result.path, 'f1'), 'utf8') === 'user-data-f1'
        const f2 = fs.readFileSync(path.join(result.path, 'sub', 'f2'), 'utf8') === 'user-data-f2'
        check(`${label}: quarantined tree content intact at its new path`, f1 && f2)
      } catch (err) {
        check(
          `${label}: quarantined tree content intact at its new path`,
          false,
          `threw: ${err.code ?? err.message}`
        )
      }
      teardown?.(base, parent, target)
    } else {
      teardown?.(base, parent, target)
      assertUntouched(label, target)
    }
    try {
      fs.rmSync(base, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}

console.log(
  '=== EACCES: parent directory not writable (run as a non-root user -- root bypasses DAC bits, so running this as root would prove nothing) ==='
)
{
  const base = fs.mkdtempSync(path.join(HARNESS_ROOT, 'qerrno-eacces-'))
  const { parent, target } = buildTarget(base)
  execFileSync('chmod', ['-R', 'a+rwX', base]) // qtestuser can traverse everything...
  fs.chmodSync(parent, 0o555) // ...except write into parent itself
  try {
    execFileSync('id', ['-u', 'qtestuser'], { stdio: 'ignore' })
  } catch {
    execFileSync('useradd', ['-M', '-s', '/bin/sh', 'qtestuser'])
  }
  // The child's own script reads the parent path from an env var, not an
  // interpolated string -- passing it through a shell -c string invited a
  // real quoting collision (JSON.stringify's own double quotes vs the -e
  // argument's double quotes), caught on the first run of this test.
  const childScript = [
    'import(process.env.QUARANTINE_MODULE_PATH).then(m => {',
    "  const r = m.quarantineTree(process.env.QTEST_PARENT, 'target', {opId:'eaccestest'});",
    '  console.log(JSON.stringify(r));',
    '});',
  ].join(' ')
  let out
  try {
    out = execFileSync(
      'su',
      [
        'qtestuser',
        '-s',
        '/bin/sh',
        '-c',
        `node --input-type=module -e "${childScript.replace(/"/g, '\\"')}"`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, QUARANTINE_MODULE_PATH, QTEST_PARENT: parent },
      }
    )
  } catch (err) {
    out = (err.stdout || '') + (err.stderr || '')
  }
  console.log('  su qtestuser output:', out.trim())
  let result = null
  try {
    result = JSON.parse(
      out
        .trim()
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .pop()
    )
  } catch {
    result = null
  }
  check(
    'EACCES: stopped, not quarantined',
    !!result && result.status === 'stopped' && result.reason === 'quarantine-failed',
    JSON.stringify(result)
  )
  fs.chmodSync(parent, 0o755)
  assertUntouched('EACCES', target)
  fs.rmSync(base, { recursive: true, force: true })
}

console.log('')
console.log('=== EROFS: parent on a read-only bind mount ===')
run(
  'EROFS',
  (base, parent) => {
    execFileSync('mount', ['--bind', parent, parent])
    execFileSync('mount', ['-o', 'remount,ro,bind', parent])
  },
  (base, parent) => umountQuiet(parent)
)

console.log('')
console.log('=== EBUSY: the source tree itself is a mount point ===')
run(
  'EBUSY',
  (base, parent, target) => {
    const mountSrc = path.join(base, 'mount-src')
    fs.mkdirSync(mountSrc, { recursive: true })
    execFileSync('mount', ['--bind', mountSrc, target])
  },
  (base, parent, target) => umountQuiet(target) // unmount FIRST so the post-check sees the real f1/sub/f2, not the empty mount source
)

console.log('')
console.log('=== ENOSPC: parent on a tiny, already-full tmpfs ===')
run(
  'ENOSPC',
  (base, parent) => {
    // parent itself must be ON the tiny fs so mkdir(.skillsmith-trash) inside it fails.
    fs.rmSync(parent, { recursive: true, force: true })
    fs.mkdirSync(parent, { recursive: true })
    execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=16k', 'none', parent])
    fs.mkdirSync(path.join(parent, 'target', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(parent, 'target', 'f1'), 'user-data-f1')
    fs.writeFileSync(path.join(parent, 'target', 'sub', 'f2'), 'user-data-f2')
    try {
      fs.writeFileSync(path.join(parent, 'filler'), Buffer.alloc(64 * 1024, 1))
    } catch {
      /* expected once space runs out mid-write; the fs is now full either way */
    }
  },
  (base, parent) => umountQuiet(parent),
  { allowSidecarFailureAsSafe: true }
)

console.log('')
console.log('=== EXDEV: .skillsmith-trash pre-exists as its own mount point (other device) ===')
run(
  'EXDEV',
  (base, parent) => {
    const trashRoot = path.join(parent, '.skillsmith-trash')
    fs.mkdirSync(trashRoot, { recursive: true })
    execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=4m', 'none', trashRoot])
  },
  (base, parent) => umountQuiet(path.join(parent, '.skillsmith-trash'))
)

console.log('')
console.log(
  '=== control: happy path still works (proves these are real failures, not a broken function) ==='
)
{
  const base = fs.mkdtempSync(path.join(HARNESS_ROOT, 'qerrno-happy-'))
  const { parent, target } = buildTarget(base)
  const result = quarantineTree(parent, 'target', { opId: 'happytest' })
  check(
    'happy path quarantines successfully',
    result.status === 'quarantined',
    JSON.stringify(result)
  )
  check('happy path: original gone', !fs.existsSync(target))
  fs.rmSync(base, { recursive: true, force: true })
}

console.log('')
if (failures > 0) {
  console.error(`[test-quarantine-errnos] FAIL -- ${failures} check(s) failed`)
  process.exit(1)
}
console.log('[test-quarantine-errnos] all checks passed')
process.exit(0)
