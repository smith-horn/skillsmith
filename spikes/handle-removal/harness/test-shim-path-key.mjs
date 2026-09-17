#!/usr/bin/env node
// SMI-6676: regression test for the binary-identity chain between load.mjs,
// hybrid.mjs and probe-child.mjs.
//
// WHY THIS FILE EXISTS. Two adversarial rounds found the same defect in this
// chain, and the second found it INSIDE the first one's fix:
//
//   round 4  hybrid.mjs hardcoded `build/Release/shim.node` while load.mjs had
//            gained SMI6676_SHIM_PATH, so the probe cache keyed and gated on a
//            file walk.mjs would not open.
//   round 5  the fix (`devBuildPath = () => shimPath()`) still failed, because
//            shimPath() returned the RAW env string and its two consumers
//            resolve a relative path differently -- readFileSync against
//            process.cwd(), require() against native-c/. Two different real
//            binaries at one relative path: the key hashed one, require()
//            loaded the other.
//
// Both fixes were committed with their red-tests described in the commit body
// and NOT committed, so neither was repeatable and the second defect had to be
// found by a human-directed review rather than by running anything. That is the
// gap this file closes. Every case below FAILS against the code as it stood
// before its corresponding fix.
//
// Each case runs in its own child process, because the thing under test is read
// from process.env at module scope and Node's require cache is per-process.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SPIKE = path.resolve(HERE, '..')
const NATIVE_C = path.join(SPIKE, 'native-c')

let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `[shim-path-key] ${label}: expected ${expected}, got ${actual} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}

/** Runs a snippet in a child with the given env, returns its last stdout line. */
function inChild(src, env, cwd) {
  try {
    return execFileSync(process.execPath, ['--input-type=module', '-e', src], {
      encoding: 'utf8',
      cwd: cwd ?? SPIKE,
      env: { ...process.env, ...env },
    })
      .trim()
      .split('\n')
      .pop()
  } catch (err) {
    return `THREW:${err.status}:${(err.stderr || '').split('\n')[0].slice(0, 80)}`
  }
}

const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's6676-shimkey-'))
const DEV = path.join(NATIVE_C, 'build', 'Release', 'shim.node')
const PREBUILD = path.join(
  NATIVE_C,
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'shim.node'
)

// --- 1. the default path is unchanged -------------------------------------
check(
  'default shimPath is the dev build',
  inChild(
    `const {shimPath}=await import(${JSON.stringify(path.join(NATIVE_C, 'load.mjs'))});` +
      `console.log(shimPath())`,
    { SMI6676_SHIM_PATH: '' }
  ),
  DEV
)

// --- 2. RELATIVE override resolves against native-c, not cwd --------------
// The round-5 BLOCKING defect. Run from a cwd that is NOT native-c and assert
// the returned path is anchored at native-c. Before the fix this returned the
// raw './x.node', which readFileSync then resolved against cwd while require()
// resolved it against native-c -- two different files, silently.
check(
  'relative override resolves against native-c (not cwd)',
  inChild(
    `const {shimPath}=await import(${JSON.stringify(path.join(NATIVE_C, 'load.mjs'))});` +
      `console.log(shimPath())`,
    { SMI6676_SHIM_PATH: './prebuilds/x.node' },
    tmp
  ),
  path.join(NATIVE_C, 'prebuilds', 'x.node')
)

// --- 3. the cache key's dev half tracks the binary that will be LOADED -----
// The round-4 BLOCKING defect. Copy a real binary, point the override at it,
// and assert the key's second half is that copy's digest -- not the dev build's.
const copy = path.join(tmp, 'override.node')
fs.copyFileSync(PREBUILD, copy)
check(
  'cache key tracks the overridden binary',
  inChild(
    `const h=await import(${JSON.stringify(path.join(SPIKE, 'hybrid.mjs'))});` +
      `console.log(h.probeCacheKeyForTest().split('|')[1])`,
    { SMI6676_SHIM_PATH: copy }
  ),
  sha(copy)
)

// --- 4. ...and MOVES when that binary changes -----------------------------
// A key that never moves is the defect; a key that moves on an unrelated file
// is the same defect wearing a different hat. Flip one byte of the OVERRIDDEN
// file and require the key to follow it.
const before = inChild(
  `const h=await import(${JSON.stringify(path.join(SPIKE, 'hybrid.mjs'))});` +
    `console.log(h.probeCacheKeyForTest().split('|')[1])`,
  { SMI6676_SHIM_PATH: copy }
)
const buf = fs.readFileSync(copy)
buf[buf.length - 1] ^= 0xff
fs.writeFileSync(copy, buf)
const after = inChild(
  `const h=await import(${JSON.stringify(path.join(SPIKE, 'hybrid.mjs'))});` +
    `console.log(h.probeCacheKeyForTest().split('|')[1])`,
  { SMI6676_SHIM_PATH: copy }
)
check('key moves when the loaded binary changes', before !== after, true)
check('key matches the changed binary', after, sha(copy))

// --- 5. an unloadable override QUARANTINES, it does not throw -------------
// The round-5 MAJOR: the key was fixed but the GATE still probed the prebuild,
// so a readable-but-unloadable override passed the gate and then threw
// ERR_DLOPEN_FAILED out of removeTree(), leaving the tree neither removed nor
// quarantined -- the opposite of §10 criterion 4's "no crash, one message".
const junk = path.join(tmp, 'junk.node')
fs.writeFileSync(junk, 'this is not a mach-o or elf binary')
const fx = path.join(tmp, 'fx')
fs.mkdirSync(path.join(fx, 'tree', 'sub'), { recursive: true })
fs.writeFileSync(path.join(fx, 'tree', 'sub', 'f.txt'), 'user bytes')
check(
  'unloadable override quarantines rather than throwing',
  inChild(
    `const h=await import(${JSON.stringify(path.join(SPIKE, 'hybrid.mjs'))});` +
      `h.resetProbeCache();` +
      `try{const r=h.removeTree(${JSON.stringify(path.join(fx, 'tree'))},{});console.log(r.status)}` +
      `catch(e){console.log('THREW-'+(e.code||e.name))}`,
    { SMI6676_SHIM_PATH: junk }
  ),
  'quarantined'
)
check(
  'the user bytes survived that',
  fs.existsSync(path.join(fx, 'tree', 'sub', 'f.txt')) ||
    fs.readdirSync(fx).some((n) => n.startsWith('.skillsmith-')),
  true
)

fs.rmSync(tmp, { recursive: true, force: true })

if (!allOk) {
  console.error('[shim-path-key] FAIL')
  process.exit(1)
}
console.log('[shim-path-key] all cases passed')
process.exit(0)
