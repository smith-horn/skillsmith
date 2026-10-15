#!/usr/bin/env node
// SMI-6676 checkpoint 4: forces each real fallback trigger through the
// FULL removeTree() dispatcher (hybrid.mjs) -- never by flipping an
// internal boolean. Each case builds a real tree with real user content,
// removes it via removeTree(), and asserts: (a) the named trigger matches
// the real cause, (b) the tree survives, safely quarantined (never lost,
// never corrupted), (c) removeTree() itself never throws or crashes even
// when the native probe's own child process gets SIGKILLed.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SPIKE_ROOT = path.join(HERE, '..')
const PREBUILDS = path.join(SPIKE_ROOT, 'native-c', 'prebuilds')
const HARNESS_ROOT =
  process.env.SMI6676_HARNESS_ROOT ?? (process.platform === 'darwin' ? require_os_tmp() : '/work')

function require_os_tmp() {
  return process.env.TMPDIR ?? '/tmp'
}
fs.mkdirSync(HARNESS_ROOT, { recursive: true })

let failures = 0
function check(label, cond, detail) {
  const ok = !!cond
  if (!ok) failures += 1
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' -- ' + detail : ''}`)
  return ok
}

function buildTree(base) {
  const tree = path.join(base, 'tree')
  fs.mkdirSync(path.join(tree, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(tree, 'f1'), 'user-data-f1')
  fs.writeFileSync(path.join(tree, 'sub', 'f2'), 'user-data-f2')
  return tree
}

async function freshRemoveTree() {
  // Bypass Node's ESM module cache so hybrid.mjs's cachedProbe starts clean
  // for every case -- each case mutates native-c/prebuilds/ differently and
  // must not reuse a prior case's probe result.
  const mod = await import(
    `${path.join(SPIKE_ROOT, 'hybrid.mjs')}?t=${Date.now()}-${Math.random()}`
  )
  return mod.removeTree
}

async function runCase(label, expectTriggerSubstring, setup, teardown) {
  const base = fs.mkdtempSync(path.join(HARNESS_ROOT, 'hybtrig-'))
  const tree = buildTree(base)
  let stderrCapture = ''
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk, ...rest) => {
    stderrCapture += chunk.toString()
    return origWrite(chunk, ...rest)
  }
  try {
    setup?.()
    const removeTree = await freshRemoveTree()
    const result = removeTree(tree)
    console.log(`  result: ${JSON.stringify(result)}`)
    check(
      `${label}: result carries a fallbackTrigger`,
      !!result.fallbackTrigger,
      JSON.stringify(result.fallbackTrigger)
    )
    check(
      `${label}: trigger matches the real cause (${expectTriggerSubstring})`,
      (result.fallbackTrigger ?? '').includes(expectTriggerSubstring),
      result.fallbackTrigger
    )
    check(`${label}: fell back to quarantine, not removal`, result.status === 'quarantined')
    check(
      `${label}: one stderr line names the trigger`,
      stderrCapture.includes(result.fallbackTrigger ?? '\0')
    )
    if (result.status === 'quarantined') {
      const f1 = fs.readFileSync(path.join(result.path, 'f1'), 'utf8') === 'user-data-f1'
      check(`${label}: quarantined content intact`, f1)
    }
  } catch (err) {
    check(`${label}: removeTree() did not throw/crash`, false, `threw: ${err.message}`)
  } finally {
    process.stderr.write = origWrite
    teardown?.()
    fs.rmSync(base, { recursive: true, force: true })
  }
}

const platformArch = `${process.platform}-${process.arch}`
const prebuildPath = path.join(PREBUILDS, platformArch, 'shim.node')
const backupPath = `${prebuildPath}.bak-${process.pid}`

async function main() {
  console.log(`platform=${platformArch} prebuildPath=${prebuildPath}`)
  console.log('')

  // --- env-disable: trivially real, every platform ---
  console.log('=== trigger: SKILLSMITH_REMOVAL_NATIVE_DISABLE=1 ===')
  process.env.SKILLSMITH_REMOVAL_NATIVE_DISABLE = '1'
  await runCase('env-disable', 'env-disable', null, null)
  delete process.env.SKILLSMITH_REMOVAL_NATIVE_DISABLE
  console.log('')

  // --- missing file: real deletion of this platform's own prebuild ---
  console.log('=== trigger: missing prebuild file (this platform) ===')
  await runCase(
    'missing-file',
    'no-prebuild-or-missing-file',
    () => fs.renameSync(prebuildPath, backupPath),
    () => fs.renameSync(backupPath, prebuildPath)
  )
  console.log('')

  // --- wrong-platform binary: swap the other platform's binary into this one's slot ---
  const otherArch = process.platform === 'darwin' ? 'linux-arm64' : 'darwin-arm64'
  const otherPath = path.join(PREBUILDS, otherArch, 'shim.node')
  if (fs.existsSync(otherPath)) {
    console.log(
      `=== trigger: wrong-platform binary (${otherArch}'s binary in ${platformArch}'s slot) ===`
    )
    await runCase(
      'wrong-platform',
      'dlopen-failed',
      () => {
        fs.renameSync(prebuildPath, backupPath)
        fs.copyFileSync(otherPath, prebuildPath)
      },
      () => {
        fs.rmSync(prebuildPath, { force: true })
        fs.renameSync(backupPath, prebuildPath)
      }
    )
    console.log('')
  }

  // --- macOS only: genuine SIGKILL-inducing signature tamper ---
  if (process.platform === 'darwin') {
    console.log(
      '=== trigger: macOS signature tamper (SIGKILL the CHILD probe, not this process) ==='
    )
    const size = fs.statSync(prebuildPath).size
    const original = fs.readFileSync(prebuildPath)
    await runCase(
      'sigkill-tamper',
      'native-probe-killed',
      () => {
        const tampered = Buffer.from(original)
        tampered[Math.floor(size / 2)] ^= 0xff // inside the code segment, keeps the old (now-mismatched) signature
        fs.writeFileSync(prebuildPath, tampered)
      },
      () => fs.writeFileSync(prebuildPath, original)
    )
    console.log('')
  }

  if (failures > 0) {
    console.error(`[test-hybrid-triggers] FAIL -- ${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('[test-hybrid-triggers] all checks passed')
}

main()
