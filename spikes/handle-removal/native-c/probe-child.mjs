#!/usr/bin/env node
// SMI-6676 C5: the child-process probe hybrid.mjs spawns for every native
// load attempt. Loading and self-testing here, not in the caller's own
// process, is the load-bearing design decision from checkpoint 3's P9
// finding: a genuinely tampered signed binary SIGKILLs the process that
// requires it, with zero catchable output -- so that require() must never
// happen in a process the caller cannot afford to lose. This script prints
// exactly one JSON line to stdout and exits; if IT gets killed instead, the
// PARENT (which only ever spawned it) observes that via signal, not a crash
// of its own.

import { createRequire } from 'node:module'
import { loadNative, prebuildPath } from './load-packaged.mjs'
import { shimPath } from './load.mjs'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)

function result(ok, trigger, detail) {
  process.stdout.write(
    JSON.stringify({ ok, trigger: trigger ?? null, detail: detail ?? null }) + '\n'
  )
  process.exit(0)
}

const loaded = loadNative()
if (!loaded.ok) {
  // Node's own error carries enough to distinguish "no prebuild for this
  // platform/arch at all" and "the file is missing" (both MODULE_NOT_FOUND)
  // from a wrong-format/wrong-arch/too-old-glibc binary (ERR_DLOPEN_FAILED,
  // message names the specific reason).
  const trigger =
    loaded.error.code === 'MODULE_NOT_FOUND' ? 'no-prebuild-or-missing-file' : 'dlopen-failed'
  result(false, trigger, loaded.error.message)
}

// A GATE MUST DESCRIBE THE BINARY IT GATES. The probe above loads the PREBUILD
// (`load-packaged.mjs`), which models a real install and is what criterion 4's
// six triggers perturb -- but `walk.mjs` loads `shimPath()` (`load.mjs`), and
// under SMI6676_SHIM_PATH those are different files. Probing only the prebuild
// let a readable-but-unloadable override pass the gate and then throw
// ERR_DLOPEN_FAILED out of removeTree(), leaving the tree neither removed nor
// quarantined -- the opposite of criterion 4's "no crash, one message".
//
// So probe BOTH, and do it HERE rather than in the parent: that is the whole
// point of the child. A tampered signed binary SIGKILLs whatever process
// require()s it, and the parent must not be that process.
const walkPath = shimPath()
if (path.resolve(walkPath) !== path.resolve(prebuildPath())) {
  try {
    require(walkPath)
  } catch (err) {
    const trigger =
      err.code === 'MODULE_NOT_FOUND' ? 'no-prebuild-or-missing-file' : 'dlopen-failed'
    result(false, trigger, `native walk binary ${walkPath}: ${err.message}`)
  }
}

const shim = loaded.shim

// Self-test (§4.5): capabilities(), O_NOFOLLOW -> ELOOP, renameAtNoReplace -> EEXIST,
// and on Linux, openat2 or mntId must be usable.
let probeDir
try {
  probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi6676-nativeselftest-'))
  const linkTarget = path.join(probeDir, 'outside')
  fs.mkdirSync(linkTarget)
  fs.symlinkSync(linkTarget, path.join(probeDir, 'link'))
  const d = shim.openDir(probeDir)
  if (d.errno !== 0) result(false, 'self-test-failed', `openDir: errno ${d.errno}`)
  const throughLink = shim.openAt(d.fd, 'link', true)
  const elLoopOk = throughLink.errno !== 0 // must refuse -- no-follow is load-bearing (UD18)
  fs.mkdirSync(path.join(probeDir, 'a'))
  fs.mkdirSync(path.join(probeDir, 'b'))
  const rn = shim.renameAtNoReplace(d.fd, 'a', d.fd, 'b')
  const noReplaceOk = rn.errno !== 0 // must refuse -- 'b' already exists
  shim.closeFd(d.fd)

  const caps = shim.capabilities()
  const linuxOk = process.platform !== 'linux' || caps.openat2 || caps.mntId

  if (!elLoopOk || !noReplaceOk || !linuxOk) {
    result(false, 'self-test-failed', JSON.stringify({ elLoopOk, noReplaceOk, linuxOk, caps }))
  }
} catch (err) {
  result(false, 'self-test-failed', err.message)
} finally {
  if (probeDir) fs.rmSync(probeDir, { recursive: true, force: true })
}

result(true, null, null)
