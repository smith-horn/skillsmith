#!/usr/bin/env node
// SMI-7128: c4-selftest-helpers.mjs finish() must fail a self-test that ran zero checks.
//
// The helper counted nothing: a file that never reached a check() (an early return, a
// misplaced import, a loop over an empty table) exited 0 and read as a pass. Each case runs
// a tiny child that imports the helper and calls finish(), so the exit status is observed
// from outside the process that exits.
//
// DECLARED FAILURE (pre-fix helper): "zero checks exits 1" gets status 0.

import { spawnSync } from 'node:child_process'
import { makeCheck } from './w5-test-util.mjs'

const { check, done } = makeCheck('[c4-selftest-helpers]')
const HELPER = new URL('./c4-selftest-helpers.mjs', import.meta.url).href

const child = (body) =>
  spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { check, finish } from '${HELPER}'\n${body}`],
    { encoding: 'utf8' }
  )

const none = child('finish()')
check('zero checks exits 1', none.status, 1)
check('zero checks says NO CASES RAN', /NO CASES RAN/.test(none.stderr), true)

const pass = child("check('a', 1, 1)\nfinish()")
check('control: one passing check exits 0', pass.status, 0)
check('control: it reports the count', /all 1 cases passed/.test(pass.stdout), true)

const fail = child("check('a', 1, 2)\nfinish()")
check('control: one failing check exits 1', fail.status, 1)
done()
