#!/usr/bin/env node
// SMI-7128: harness/cleanup.mjs must not report "clean" when `mount` itself failed.
//
// The old check was `mount | grep -c <tag> || true`: a failing `mount` printed nothing, the
// count parsed as 0, and the result was `clean: true` -- an instrument that never looked,
// reading as one that looked and found nothing.
//
// A `mount` stub on PATH stands in for the real one (a failing stub, a stub that lists a
// leftover, a stub that lists only unrelated mounts), so each outcome is driven rather than
// hoped for.
//
// DECLARED FAILURE (pre-fix cleanup.mjs): "a failing mount is not clean" gets clean: true
// (count 0), and the CLI case exits 0 printing "CLEAN" instead of exit 1 / "COULD NOT CHECK".

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeCheck, rmFixture, w5Root } from './w5-test-util.mjs'
import { assertNoLeftoverMounts } from './cleanup.mjs'

const TAG = '[cleanup-selftest]'
const { check, done } = makeCheck(TAG)
const CLI = fileURLToPath(new URL('./cleanup.mjs', import.meta.url))

/** A directory holding an executable `mount` stub with the given body. */
function stubDir(body) {
  const dir = fs.mkdtempSync(path.join(w5Root(), 'cleanup-stub-'))
  fs.writeFileSync(path.join(dir, 'mount'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return dir
}

function withPath(dir, fn) {
  const saved = process.env.PATH
  process.env.PATH = `${dir}:${saved}`
  try {
    return fn()
  } finally {
    process.env.PATH = saved
  }
}

const cases = []
try {
  const failing = stubDir('echo "mount: boom" >&2\nexit 1')
  cases.push(failing)
  const leftover = stubDir(
    'echo "/dev/disk9s1 on /x/s6676-selftest-run/mp (apfs)"\necho "/dev/disk1 on / (apfs)"'
  )
  cases.push(leftover)
  const unrelated = stubDir('echo "/dev/disk1 on / (apfs)"\necho "devfs on /dev (devfs)"')
  cases.push(unrelated)

  // known-negative: a working mount that lists nothing of ours is clean, count 0
  const clean = withPath(unrelated, () => assertNoLeftoverMounts('s6676-selftest-run'))
  check('a working mount with no match is clean', `${clean.clean}/${clean.count}`, 'true/0')

  // known-positive: a leftover is counted and not clean
  const left = withPath(leftover, () => assertNoLeftoverMounts('s6676-selftest-run'))
  check('a working mount listing a leftover is not clean', `${left.clean}/${left.count}`, 'false/1')

  // the fix: a failing mount is not clean, and not a clean-looking zero
  const bad = withPath(failing, () => assertNoLeftoverMounts('s6676-selftest-run'))
  check('a failing mount is not clean', bad.clean, false)
  check('a failing mount reports could-not-look (count -1)', bad.count, -1)
  check('and says why', /mount failed/.test(bad.raw), true)

  // CLI: exit status and wording
  const run = (dir) =>
    spawnSync(process.execPath, [CLI, '--tag', 's6676-selftest-run'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8',
    })
  const cliBad = run(failing)
  check('CLI with a failing mount exits 1', cliBad.status, 1)
  check(
    'CLI with a failing mount says COULD NOT CHECK',
    /mounts\s+: COULD NOT CHECK/.test(cliBad.stdout),
    true
  )
  check(
    'CLI with a failing mount does not print CLEAN',
    /\[cleanup\] CLEAN/.test(cliBad.stdout),
    false
  )
  const cliOk = run(unrelated)
  check(
    'CLI control: a working mount with no match prints mounts clean',
    /mounts\s+: clean \(matched 0\)/.test(cliOk.stdout),
    true
  )
} finally {
  for (const d of cases) rmFixture(d)
}
done()
