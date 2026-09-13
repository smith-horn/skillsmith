/**
 * Regression tests for publish.yml's CLI-wrapper smoke-tail guards: the
 * `SMOKE_DIR="$(mktemp -d)"` guard (SMI-6512) and the `sleep 8` guard
 * (SMI-6583, folded into SMI-6512 — see
 * docs/internal/implementation/smi-6512-smokedir-guard.md).
 *
 * Both commands sit inside the `publish-skillsmith-cli` job's "Verify
 * skillsmith-cli on npm + smoke the wrapper" step, in the exact span
 * SMI-6513's Check 71 pins by digest (scripts/lib/verify-block-identity.mjs).
 * Before these guards landed, either command failing aborted the step via
 * errexit with NO `::warning::` and no explicit `::error::` either — a bare
 * red X for a publish the four preceding "Verify X on npm" steps had already
 * confirmed live on npm.
 *
 * **Design: extract and execute the REAL bash text shipped in the workflow**,
 * rather than re-implementing the guard logic separately (which could drift
 * from what's actually running). The tail is split at the exact marker
 * Check 71 anchors on, via the SAME exported helper
 * (`splitAtTailMarker`/`TAIL_MARKER`) rather than a re-implemented copy of its
 * predicate — reuse is the point: this suite and Check 71 can never silently
 * disagree about where the tail begins.
 *
 * **Shell semantics**: the workflow declares no `shell:` key and no
 * `defaults:` block anywhere (verified in the plan doc's Context section), so
 * GitHub Actions' documented default applies to every `run:` step here:
 * `bash -e` — errexit ON, pipefail OFF, nounset OFF. The harness below
 * invokes `bash -e` ONLY. Do not add `-u` (nounset) or pipefail — neither is
 * enabled by the real step, and testing under stricter semantics than
 * production would only prove the guard works in an environment the real job
 * never runs in.
 *
 * Fallible external commands (`mktemp`, `npx`, `sleep`) are shadowed with
 * fake executables placed first on PATH, per test case. The `sleep` fakes
 * never actually sleep — only their exit code matters to the guard, so making
 * them instant keeps this suite fast without weakening what it proves.
 *
 * Case numbering below matches the plan's Wave 1 Step 4 list (cases 5-10;
 * cases 1-4 are the extraction/harness mechanics, not standalone assertions).
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { TAIL_MARKER, splitAtTailMarker } from '../lib/verify-block-identity.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/publish.yml')

const JOB_ID = 'publish-skillsmith-cli'
const STEP_NAME = 'Verify skillsmith-cli on npm + smoke the wrapper'

// js-yaml via createRequire — the pattern already used by
// scripts/audit-standards.mjs, scripts/audit-host-volume-fs-guard-helpers.mjs,
// and scripts/tests/verify-block-identity.test.ts.
const require = createRequire(import.meta.url)
const yaml = require('js-yaml') as { load: (text: string) => unknown }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed YAML is untyped
type Workflow = any

/**
 * Extract the real, unmodified smoke-tail script from the live workflow
 * file, split at the SAME marker (via the SAME exported predicate) SMI-6513's
 * Check 71 anchors on. Throws loudly — never a silent skip — if the marker is
 * missing or duplicated, mirroring `splitAtTailMarker`'s own contract. This
 * is computed once, at module load, so a marker regression fails every test
 * in this file rather than one.
 */
function extractRealTail(): string {
  const doc = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow
  const steps = (doc?.jobs?.[JOB_ID]?.steps ?? []) as Array<{ name?: string; run?: string }>
  const step = steps.find((s) => s.name === STEP_NAME)
  if (!step || typeof step.run !== 'string') {
    throw new Error(`fixture error: no run body for "${JOB_ID} :: ${STEP_NAME}"`)
  }
  const split = splitAtTailMarker(step.run)
  if (!split.ok) {
    throw new Error(
      `fixture error: splitAtTailMarker failed (${split.code}) -- expected exactly one ` +
        `"${TAIL_MARKER}" marker in "${JOB_ID} :: ${STEP_NAME}"`
    )
  }
  return split.tail
}

const REAL_TAIL = extractRealTail()

/** Reverts the mktemp guard (SMI-6512) back to the pre-fix bare assignment. */
function revertMktempGuard(tail: string): string {
  const guarded = [
    'if ! SMOKE_DIR="$(mktemp -d)"; then',
    '  echo "::warning::mktemp -d failed while preparing the skillsmith-cli smoke sandbox (disk full, an invalid/unwritable explicitly-set TMPDIR, or permissions) - skipping the bin-delegation smoke check. Non-fatal: the publish is already verified live on npm above."',
    '  exit 0',
    'fi',
  ].join('\n')
  if (!tail.includes(guarded)) {
    throw new Error(
      'fixture error: mktemp guard text not found in extracted tail -- has it drifted?'
    )
  }
  return tail.replace(guarded, 'SMOKE_DIR="$(mktemp -d)"')
}

/** Reverts the sleep guard (SMI-6583) back to the pre-fix bare `sleep 8`. */
function revertSleepGuard(tail: string): string {
  const guarded = [
    '  sleep 8 || {',
    '    echo "::warning::sleep failed during the npx smoke retry loop - skipping remaining attempts. Non-fatal: the publish is already verified live on npm above."',
    '    exit 0',
    '  }',
  ].join('\n')
  if (!tail.includes(guarded)) {
    throw new Error(
      'fixture error: sleep guard text not found in extracted tail -- has it drifted?'
    )
  }
  return tail.replace(guarded, '  sleep 8')
}

const scratchDirs: string[] = []

function makeScratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** Write an executable fake binary named `name` inside `dir` with shell body `body`. */
function writeFakeBin(dir: string, name: string, body: string): void {
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, `#!/bin/sh\n${body}\n`)
  fs.chmodSync(filePath, 0o755)
}

/** Count non-empty lines in a counter-log file, or 0 if it was never created. */
function countLines(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0).length
}

type RunResult = { status: number | null; combined: string }

/**
 * Run `script` under `bash -e` -- matching the workflow's real per-step
 * semantics (see the module doc comment for why nothing stricter is added)
 * -- with `binDir` prepended to PATH so its fakes shadow the real
 * `mktemp`/`npx`/`sleep`.
 */
function runTail(script: string, binDir: string, extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync('bash', ['-e', '-c', script], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      VERSION: '0.0.0-test',
      ...extraEnv,
    },
    encoding: 'utf8',
  })
  return { status: result.status, combined: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** Fakes for the "mktemp itself fails" family (case 5). npx/sleep must never run. */
function makeMktempFailsBinDir(): string {
  const dir = makeScratchDir('sk-smoke-bin-')
  writeFakeBin(dir, 'mktemp', 'exit 1')
  writeFakeBin(dir, 'npx', 'echo "fixture error: npx ran despite mktemp failing" >&2; exit 111')
  writeFakeBin(dir, 'sleep', 'echo "fixture error: sleep ran despite mktemp failing" >&2; exit 111')
  return dir
}

/** A `mktemp` fake that succeeds, printing a real, pre-created scratch directory. */
function makeMktempSucceedsBinDir(): { binDir: string; smokeDir: string } {
  const binDir = makeScratchDir('sk-smoke-bin-')
  const smokeDir = makeScratchDir('sk-smoke-target-')
  writeFakeBin(binDir, 'mktemp', `echo '${smokeDir}'`)
  return { binDir, smokeDir }
}

describe('publish.yml smoke-tail guards (SMI-6512 mktemp, SMI-6583 sleep)', () => {
  it('extracted tail contains both guarded commands (sanity: fixture matches the plan)', () => {
    expect(REAL_TAIL).toContain('if ! SMOKE_DIR="$(mktemp -d)"; then')
    expect(REAL_TAIL).toContain('sleep 8 || {')
  })

  describe('case 5: mktemp -d failure', () => {
    it('routes through ::warning:: + exit 0, not errexit', () => {
      const binDir = makeMktempFailsBinDir()
      const { status, combined } = runTail(REAL_TAIL, binDir)
      expect(status).toBe(0)
      expect(combined).toMatch(/::warning::/)
    })

    it('mutation check: reverting the guard turns this case red', () => {
      const reverted = revertMktempGuard(REAL_TAIL)
      const binDir = makeMktempFailsBinDir()
      const { status, combined } = runTail(reverted, binDir)
      // The unguarded pre-fix shape aborts via errexit: nonzero exit, no
      // output at all -- matching the plan Context's own measurement
      // (`bash -e -c 'SMOKE_DIR="$(false)"; echo AFTER'` -> exit 1, silent).
      expect(status).not.toBe(0)
      expect(combined).not.toMatch(/::warning::/)
    })
  })

  describe('case 6: mktemp succeeds, npx fails all 3 attempts (regression guard)', () => {
    it('the existing terminal ::warning:: + exit 0 sibling path still fires unchanged', () => {
      const { binDir, smokeDir } = makeMktempSucceedsBinDir()
      const npxLog = path.join(smokeDir, 'npx-calls.log')
      writeFakeBin(binDir, 'npx', 'echo "1" >> "$NPX_CALL_LOG"; exit 1')
      writeFakeBin(binDir, 'sleep', 'exit 0') // instant success -- duration is irrelevant to the guard
      const { status, combined } = runTail(REAL_TAIL, binDir, { NPX_CALL_LOG: npxLog })
      expect(status).toBe(0)
      expect(combined).toMatch(/::warning::/)
      // Regression guard: item 1/1b's edits must not change the retry count
      // on the path where mktemp itself works fine.
      expect(countLines(npxLog)).toBe(3)
    })
  })

  describe('case 7 + 8: sleep failure and its negative control', () => {
    it('case 7: sleep failure routes through ::warning:: + exit 0, not errexit', () => {
      const { binDir } = makeMktempSucceedsBinDir()
      writeFakeBin(binDir, 'npx', 'exit 1')
      writeFakeBin(binDir, 'sleep', 'exit 1')
      const { status, combined } = runTail(REAL_TAIL, binDir)
      expect(status).toBe(0)
      expect(combined).toMatch(/::warning::/)
    })

    it('case 8 (negative control): npx succeeds first try, sleep is never invoked, no warning', () => {
      const { binDir, smokeDir } = makeMktempSucceedsBinDir()
      const sleepLog = path.join(smokeDir, 'sleep-calls.log')
      writeFakeBin(binDir, 'npx', 'echo "1.2.3"; exit 0')
      writeFakeBin(binDir, 'sleep', 'echo "1" >> "$SLEEP_CALL_LOG"; exit 1')
      const { status, combined } = runTail(REAL_TAIL, binDir, { SLEEP_CALL_LOG: sleepLog })
      expect(status).toBe(0)
      expect(combined).not.toMatch(/::warning::/)
      // Without this, case 7 alone cannot distinguish "the guard worked" from
      // "the sleep stub perturbed something else in the tail."
      expect(countLines(sleepLog)).toBe(0)
    })

    it('case 9: sleep failure stops the loop after exactly 1 of 3 attempts', () => {
      const { binDir, smokeDir } = makeMktempSucceedsBinDir()
      const sleepLog = path.join(smokeDir, 'sleep-calls.log')
      writeFakeBin(binDir, 'npx', 'exit 1')
      writeFakeBin(binDir, 'sleep', 'echo "1" >> "$SLEEP_CALL_LOG"; exit 1')
      const { status, combined } = runTail(REAL_TAIL, binDir, { SLEEP_CALL_LOG: sleepLog })
      expect(status).toBe(0)
      expect(combined).toMatch(/::warning::/)
      // SMI-6583's measured defect was specifically that only 1 of 3
      // attempts ran; an exit-code-and-warning-only assertion (case 7 above)
      // would also pass for a guard that forgot to actually stop the loop
      // (e.g. warned without exiting, letting all 3 attempts run and fall
      // through to the terminal warning instead). This pins the loop
      // actually stopping where the guard implies it should.
      expect(countLines(sleepLog)).toBe(1)
    })

    it('mutation check: reverting the sleep guard turns case 7 red', () => {
      const reverted = revertSleepGuard(REAL_TAIL)
      const { binDir } = makeMktempSucceedsBinDir()
      writeFakeBin(binDir, 'npx', 'exit 1')
      writeFakeBin(binDir, 'sleep', 'exit 1')
      const { status, combined } = runTail(reverted, binDir)
      // The unguarded pre-fix `sleep 8` aborts via errexit on its first
      // failure: nonzero exit, no warning -- exactly SMI-6583's measured
      // defect ("sleep fails -> exit 1, 1 of 3 attempts, no warning").
      expect(status).not.toBe(0)
      expect(combined).not.toMatch(/::warning::/)
    })
  })
})
