// Self-test for fixture-root.mjs's refusal logic. This is the safety
// backstop that keeps the harness off the real HOME/.claude/.skillsmith/
// .agents/.cursor -- it must be proven, not assumed.

import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import {
  refusePath,
  makeFixtureRoot,
  resolveHarnessRoot,
  assertScratchEmpty,
} from './fixture-root.mjs'

let allOk = true
function expectThrow(label, fn) {
  try {
    fn()
    allOk = false
    console.log(`[fixture-root self-test] ${label}: expected throw, got none -- FAIL`)
  } catch (err) {
    console.log(`[fixture-root self-test] ${label}: threw as expected (${err.message}) -- PASS`)
  }
}
function expectOk(label, fn) {
  try {
    fn()
    console.log(`[fixture-root self-test] ${label}: no throw as expected -- PASS`)
  } catch (err) {
    allOk = false
    console.log(
      `[fixture-root self-test] ${label}: expected no throw, got "${err.message}" -- FAIL`
    )
  }
}

const harnessBase = mkdtempSync(path.join(tmpdir(), 's6676-fxtest-'))

// 1. A path under real HOME but not under TMPDIR/scratchpad is refused, even
// if it happens to also be nameable relative to some harness root.
expectThrow('path under real HOME refused', () => {
  refusePath(path.join(homedir(), 'not-a-real-dir-smi6676'), harnessBase, [tmpdir()])
})

// 2. A path under TMPDIR (an allowed root) and under the harness root is OK.
expectOk('path under TMPDIR + harness root allowed', () => {
  refusePath(path.join(harnessBase, 'ok-dir'), harnessBase, [tmpdir()])
})

// 3. A path containing a .claude segment is refused even under TMPDIR.
expectThrow('.claude segment refused', () => {
  refusePath(path.join(harnessBase, '.claude', 'skills'), harnessBase, [tmpdir()])
})
expectThrow('.skillsmith segment refused', () => {
  refusePath(path.join(harnessBase, 'sub', '.skillsmith', 'x'), harnessBase, [tmpdir()])
})
expectThrow('.agents segment refused', () => {
  refusePath(path.join(harnessBase, '.agents'), harnessBase, [tmpdir()])
})
expectThrow('.cursor segment refused', () => {
  refusePath(path.join(harnessBase, '.cursor'), harnessBase, [tmpdir()])
})

// 4. A path outside the harness root entirely is refused, even under TMPDIR.
const siblingBase = mkdtempSync(path.join(tmpdir(), 's6676-fxtest-sibling-'))
expectThrow('path outside harness root refused', () => {
  refusePath(siblingBase, harnessBase, [tmpdir()])
})

// 5. makeFixtureRoot() actually creates a directory under the harness root,
// and cleanup() removes it.
const fx = makeFixtureRoot({ harnessRoot: harnessBase })
const createdUnderHarness =
  fx.root.startsWith(harnessBase) || fx.root.startsWith(path.resolve(harnessBase))
console.log(
  `[fixture-root self-test] makeFixtureRoot creates under harness root: ${createdUnderHarness ? 'PASS' : 'FAIL'} (${fx.root})`
)
allOk = allOk && createdUnderHarness
const existedBeforeCleanup = existsSync(fx.root)
fx.cleanup()
const goneAfterCleanup = !existsSync(fx.root)
console.log(
  `[fixture-root self-test] cleanup removes fixture root: ${existedBeforeCleanup && goneAfterCleanup ? 'PASS' : 'FAIL'}`
)
allOk = allOk && existedBeforeCleanup && goneAfterCleanup

// 6. resolveHarnessRoot() returns a path (smoke test only -- environment
// dependent).
const resolved = resolveHarnessRoot()
console.log(`[fixture-root self-test] resolveHarnessRoot() -> ${resolved} (smoke)`)

// 7. assertScratchEmpty reports non-empty correctly.
const fx2 = makeFixtureRoot({ harnessRoot: harnessBase })
const trashDir = path.join(fx2.root, '.skillsmith-trash')
const emptyCheck = assertScratchEmpty(fx2.root, ['.skillsmith-trash'])
console.log(
  `[fixture-root self-test] assertScratchEmpty on absent dir: ${emptyCheck.clean ? 'PASS' : 'FAIL'}`
)
allOk = allOk && emptyCheck.clean

fx2.cleanup()
rmSync(harnessBase, { recursive: true, force: true })
rmSync(siblingBase, { recursive: true, force: true })

if (!allOk) {
  console.error('[fixture-root self-test] FAIL')
  process.exit(1)
}
console.log('[fixture-root self-test] all cases passed')
process.exit(0)
