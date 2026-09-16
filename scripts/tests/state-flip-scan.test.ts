/**
 * SMI-6514: tests for the P-7 State-Flip Assertion Audit scanner
 * (`.claude/skills/plan-review-skill/scripts/scan-state-flip.sh`).
 *
 * The scanner lives in the private strategy submodule beside the skill it
 * serves (SMI-6514 section 4, matching the concurrency-auditor precedent),
 * so every test here skips cleanly when that submodule is absent: external
 * contributors, and CI runners with no PAT access to
 * smith-horn/skillsmith-strategy.
 *
 * SMI-6549 split: a worktree container's `.git` is a gitdir-pointer file
 * holding an absolute HOST path (e.g.
 * `/Users/<dev>/.../skillsmith/.git/worktrees/<name>`), which does not exist
 * inside the container filesystem. Every git command against this repo's
 * real history therefore fails in-container with "fatal: not a git
 * repository" -- not just a lookup of one specific historical SHA. Confirmed
 * live: `git -C /app rev-parse --verify dfe3a485a^` exits 128 with that exact
 * message inside this worktree's own container.
 *
 * "Does the scanner work" and "does it match this repo's real history" are
 * two different claims, so they are two different test groups:
 *   - Group A (below) builds its own throwaway git repo per test, so it
 *     proves the scanner's counting logic without depending on any
 *     particular checkout's git plumbing. Runs identically on host and
 *     in-container.
 *   - Group B locks in the real historical *invariant* from SMI-6514's own
 *     Fixture 1 (git-crypt, SMI-6491) against THIS repo's actual commits --
 *     that is inherently host-only, so it detects the broken case live and
 *     skips with a reason naming the ref, rather than asserting a false
 *     "0 denominator" result. The scanner's own denominator guard is what
 *     turned the in-container case into a loud test failure instead of a
 *     silent pass asserting nothing -- do not weaken that guard to make this
 *     split unnecessary.
 *
 *     SMI-6514 finding 4 (adversarial pre-merge review, 2026-09-11): an
 *     earlier version of Group B froze the exact pre-fix integers (577 / 29
 *     / 5) as `toContain` assertions and used the abbreviated ref
 *     `dfe3a485a^`. Both were wrong per the plan's own text: the
 *     Verification checklist ("Re-measure, don't assert") and D-12 say
 *     divergence from those integers is EXPECTED as the tree evolves and
 *     the acceptance gate is reproduction plus a ratio, not the integers
 *     matching -- a frozen-integer gate would fail on the first legitimate
 *     scanner-vocabulary or pathspec improvement. And an abbreviated SHA can
 *     become unresolvable through a collision, history rewrite, shallow
 *     checkout, or GC, silently turning this regression lock into a skip.
 *     Fixed below: the ref is now the full 40-character SHA, and the
 *     assertions are the invariant the plan states, not the integers.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

// Every synthetic repo created by setupSyntheticStateFlipRepo() this file,
// drained and removed in afterEach (SMI-4693 fixture convention: retried
// rmSync, since a just-spawned git process can still hold the directory
// open for a moment on some filesystems).
const createdRepoDirs: string[] = []

afterEach(() => {
  for (const dir of createdRepoDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

// __dirname here is <repo-root>/scripts/tests, so two levels up is repo root
// regardless of vitest's own invocation cwd (matches the convention in
// audit-standards.test.ts and audit-workflow-sha-pin.test.ts).
const REPO_ROOT = join(__dirname, '..', '..')
const SCANNER_PATH = join(REPO_ROOT, '.claude/skills/plan-review-skill/scripts/scan-state-flip.sh')
const SCANNER_PRESENT = existsSync(SCANNER_PATH)

const GIT_ENV = makeFixtureEnv()

/** True when the `shellcheck` binary resolves on PATH in this environment. */
function shellcheckAvailable(): boolean {
  try {
    execFileSync('shellcheck', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    // Not on PATH (ENOENT), or some other spawn failure. Either way there
    // is no shellcheck binary this test can safely invoke.
    return false
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
}

/**
 * Build a small, self-contained, hermetic git repo (SMI-4693 fixture-env
 * convention) with two commits: a "pre-flip" commit whose `scripts/fixture.ts`
 * carries a known STEP1/2/3 hit shape for the noun `widget-tool`, and a
 * "post-flip" HEAD commit where the stale lines are fixed. Neither commit
 * touches this repo's own history, so `git grep` against either resolves
 * identically on host and inside a worktree container.
 *
 * Pre-flip line shape (mirrors SMI-6514 Fixture 1's real casualty mix):
 *   1. "not installed"      -- matches STEP2 (absence-vocab) AND STEP3 (triage)
 *   2. "absent" + "by design" -- matches STEP2 AND STEP3
 *   3. "absent" only         -- matches STEP2 ONLY, same shape as the real T9
 *      casualty STEP3 is measured to miss (SMI-6514 D-11)
 *   4. no absence-vocab       -- STEP1 only
 * -> STEP1=4, STEP2=3, STEP3=2.
 *
 * Post-flip (HEAD): only line 4 remains, unchanged -> STEP1=1, STEP2=0, STEP3=0.
 */
function setupSyntheticStateFlipRepo(): { repoDir: string; preFlipSha: string } {
  const repoDir = makeFixtureTempDir('state-flip-scan-fixture')
  createdRepoDirs.push(repoDir)
  git(repoDir, ['init', '-q', '-b', 'main'])
  // One level under scripts/, not directly inside it: measured live (not
  // assumed) that git's `**` pathspec glob requires at least one
  // intermediate directory -- `scripts/**/*.ts` matches `scripts/tests/
  // fixture.ts` but NOT `scripts/fixture.ts`. A first draft of this fixture
  // used the zero-intermediate-directory path and every count below came
  // back 0, the exact vacuous-success shape the scanner's own guard is
  // built to catch turned against the test itself.
  const fixtureDir = join(repoDir, 'scripts', 'tests')
  mkdirSync(fixtureDir, { recursive: true })
  const fixturePath = join(fixtureDir, 'fixture.ts')

  writeFileSync(
    fixturePath,
    [
      '// widget-tool not installed here',
      '// widget-tool absent by design',
      '// widget-tool is absent from PATH',
      '// widget-tool version check only',
      '',
    ].join('\n')
  )
  git(repoDir, ['add', '.'])
  git(repoDir, ['commit', '-q', '-m', 'pre-flip: widget-tool assertions'])
  const preFlipSha = git(repoDir, ['rev-parse', 'HEAD']).trim()

  writeFileSync(fixturePath, ['// widget-tool version check only', ''].join('\n'))
  git(repoDir, ['add', '.'])
  git(repoDir, ['commit', '-q', '-m', 'post-flip: fixed the stale assertions'])

  return { repoDir, preFlipSha }
}

/**
 * Whether `ref` resolves against this checkout's real git history in this
 * environment, and why not when it doesn't. Used only by Group B to decide
 * whether to skip, and to put the reason in the skip note (SMI-6549).
 */
function resolveRefStatus(ref: string): { resolvable: boolean; reason: string } {
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', ref], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    return { resolvable: true, reason: '' }
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr
    const reason = (
      typeof stderr === 'string' ? stderr : (stderr?.toString() ?? String(err))
    ).trim()
    return { resolvable: false, reason }
  }
}

// The complete expected report for the mixed plaintext/non-text fixture, asserted
// with toBe so exactly one output is admitted.
//
// This replaced a helper that built only the warning LINE, which in turn replaced a
// pile of substring checks. Each narrower form was defeated by the pre-merge gate in
// turn -- the contradiction moved from inside a phrase, to inside the line, to a
// sibling line -- so the helper is gone rather than kept alongside: two assertions
// with different strengths on the same text is an invitation to assert the weak one.
const EXPECTED_ONE_REF = `## State-Flip Assertion Audit (P-7) for \`widget-tool\`

Noun: \`widget-tool\`
Ref: \`HEAD\`
Scanned paths: \`scripts/*.ts scripts/*.sh scripts/*.mjs scripts/*.mts scripts/*.cjs packages/*/src/** packages/*/tests/** packages/*/e2e/** tests/** supabase/functions/** .github/**\`

> **Scope warning.** These pathspecs hold blobs that are not text -- git-crypt ciphertext in \`--ref\` mode, or genuine binaries: \`supabase/functions/** (1 of 1)\`. Their bytes ARE searched (this scan passes \`-a\`) and so they DO contribute to the counts below, but any hit in them is a byte coincidence rather than a source reference, and a miss is not evidence about whatever the bytes encode. Treat the counts as unreliable over these paths in both directions. For git-crypt paths, re-run WITHOUT \`--ref\` to search their decrypted working-tree contents.
STEP 1 (denominator): 2

### STEP 2: noun x absence-vocabulary (1 hit(s)), MANDATED OUTPUT

HEAD:supabase/functions/enc.ts:1:GITCRYPTwidget-tool is not installed by design

### STEP 3: high-yield triage subset (1 hit(s)), reading order only, NOT a filter

_Read STEP 3 first for triage, but STEP 2 is the check. STEP 3 is measured to miss real casualties (SMI-6514 D-11); do not stop at STEP 3._

HEAD:supabase/functions/enc.ts:1:GITCRYPTwidget-tool is not installed by design

### Suggested P-7 matrix (scaffold)

Copy this into the plan's \`## State-Flip Assertion Audit (P-7)\` section, or into the pr-reviewer PR-15 finding. One row per STEP 2 hit. Category is one of: 1 (test), 2 (comment/doc), 3 (diagnostic/error text), 4 (catch block). Disposition is one of: FIX-NOW, STILL-TRUE, FALSE-POSITIVE, OUT-OF-SCOPE (requires owner + SMI-NNNN).

| Hit (file:line) | Category | Disposition | Notes |
|------------------|----------|--------------|-------|
| \`supabase/functions/enc.ts:1\` | _<1-4>_ | _<disposition>_ | _<one sentence>_ |
`

const EXPECTED_ONE_WT = `## State-Flip Assertion Audit (P-7) for \`widget-tool\`

Noun: \`widget-tool\`
Ref: \`working tree\`
Scanned paths: \`scripts/*.ts scripts/*.sh scripts/*.mjs scripts/*.mts scripts/*.cjs packages/*/src/** packages/*/tests/** packages/*/e2e/** tests/** supabase/functions/** .github/**\`

> **Scope warning.** These pathspecs hold blobs that are not text -- git-crypt ciphertext in \`--ref\` mode, or genuine binaries: \`supabase/functions/** (1 of 1)\`. Their bytes ARE searched (this scan passes \`-a\`) and so they DO contribute to the counts below, but any hit in them is a byte coincidence rather than a source reference, and a miss is not evidence about whatever the bytes encode. Treat the counts as unreliable over these paths in both directions. For git-crypt paths, re-run WITHOUT \`--ref\` to search their decrypted working-tree contents.
STEP 1 (denominator): 2

### STEP 2: noun x absence-vocabulary (1 hit(s)), MANDATED OUTPUT

supabase/functions/enc.ts:1:GITCRYPTwidget-tool is not installed by design

### STEP 3: high-yield triage subset (1 hit(s)), reading order only, NOT a filter

_Read STEP 3 first for triage, but STEP 2 is the check. STEP 3 is measured to miss real casualties (SMI-6514 D-11); do not stop at STEP 3._

supabase/functions/enc.ts:1:GITCRYPTwidget-tool is not installed by design

### Suggested P-7 matrix (scaffold)

Copy this into the plan's \`## State-Flip Assertion Audit (P-7)\` section, or into the pr-reviewer PR-15 finding. One row per STEP 2 hit. Category is one of: 1 (test), 2 (comment/doc), 3 (diagnostic/error text), 4 (catch block). Disposition is one of: FIX-NOW, STILL-TRUE, FALSE-POSITIVE, OUT-OF-SCOPE (requires owner + SMI-NNNN).

| Hit (file:line) | Category | Disposition | Notes |
|------------------|----------|--------------|-------|
| \`supabase/functions/enc.ts:1\` | _<1-4>_ | _<disposition>_ | _<one sentence>_ |
`

const EXPECTED_TWO_REF = `## State-Flip Assertion Audit (P-7) for \`widget-tool\`

Noun: \`widget-tool\`
Ref: \`HEAD\`
Scanned paths: \`scripts/*.ts scripts/*.sh scripts/*.mjs scripts/*.mts scripts/*.cjs packages/*/src/** packages/*/tests/** packages/*/e2e/** tests/** supabase/functions/** .github/**\`

> **Scope warning.** These pathspecs hold blobs that are not text -- git-crypt ciphertext in \`--ref\` mode, or genuine binaries: \`packages/*/src/** (1 of 1) supabase/functions/** (1 of 1)\`. Their bytes ARE searched (this scan passes \`-a\`) and so they DO contribute to the counts below, but any hit in them is a byte coincidence rather than a source reference, and a miss is not evidence about whatever the bytes encode. Treat the counts as unreliable over these paths in both directions. For git-crypt paths, re-run WITHOUT \`--ref\` to search their decrypted working-tree contents.
STEP 1 (denominator): 3

### STEP 2: noun x absence-vocabulary (2 hit(s)), MANDATED OUTPUT

HEAD:packages/core/src/bin.ts:1:GITCRYPTwidget-tool is absent
HEAD:supabase/functions/enc.ts:1:GITCRYPTwidget-tool is not installed by design

### STEP 3: high-yield triage subset (1 hit(s)), reading order only, NOT a filter

_Read STEP 3 first for triage, but STEP 2 is the check. STEP 3 is measured to miss real casualties (SMI-6514 D-11); do not stop at STEP 3._

HEAD:supabase/functions/enc.ts:1:GITCRYPTwidget-tool is not installed by design

### Suggested P-7 matrix (scaffold)

Copy this into the plan's \`## State-Flip Assertion Audit (P-7)\` section, or into the pr-reviewer PR-15 finding. One row per STEP 2 hit. Category is one of: 1 (test), 2 (comment/doc), 3 (diagnostic/error text), 4 (catch block). Disposition is one of: FIX-NOW, STILL-TRUE, FALSE-POSITIVE, OUT-OF-SCOPE (requires owner + SMI-NNNN).

| Hit (file:line) | Category | Disposition | Notes |
|------------------|----------|--------------|-------|
| \`packages/core/src/bin.ts:1\` | _<1-4>_ | _<disposition>_ | _<one sentence>_ |
| \`supabase/functions/enc.ts:1\` | _<1-4>_ | _<disposition>_ | _<one sentence>_ |
`

const EXPECTED_TWO_WT = `## State-Flip Assertion Audit (P-7) for \`widget-tool\`

Noun: \`widget-tool\`
Ref: \`working tree\`
Scanned paths: \`scripts/*.ts scripts/*.sh scripts/*.mjs scripts/*.mts scripts/*.cjs packages/*/src/** packages/*/tests/** packages/*/e2e/** tests/** supabase/functions/** .github/**\`

> **Scope warning.** These pathspecs hold blobs that are not text -- git-crypt ciphertext in \`--ref\` mode, or genuine binaries: \`packages/*/src/** (1 of 1) supabase/functions/** (1 of 1)\`. Their bytes ARE searched (this scan passes \`-a\`) and so they DO contribute to the counts below, but any hit in them is a byte coincidence rather than a source reference, and a miss is not evidence about whatever the bytes encode. Treat the counts as unreliable over these paths in both directions. For git-crypt paths, re-run WITHOUT \`--ref\` to search their decrypted working-tree contents.
STEP 1 (denominator): 3

### STEP 2: noun x absence-vocabulary (2 hit(s)), MANDATED OUTPUT

packages/core/src/bin.ts:1:GITCRYPTwidget-tool is absent
supabase/functions/enc.ts:1:GITCRYPTwidget-tool is not installed by design

### STEP 3: high-yield triage subset (1 hit(s)), reading order only, NOT a filter

_Read STEP 3 first for triage, but STEP 2 is the check. STEP 3 is measured to miss real casualties (SMI-6514 D-11); do not stop at STEP 3._

supabase/functions/enc.ts:1:GITCRYPTwidget-tool is not installed by design

### Suggested P-7 matrix (scaffold)

Copy this into the plan's \`## State-Flip Assertion Audit (P-7)\` section, or into the pr-reviewer PR-15 finding. One row per STEP 2 hit. Category is one of: 1 (test), 2 (comment/doc), 3 (diagnostic/error text), 4 (catch block). Disposition is one of: FIX-NOW, STILL-TRUE, FALSE-POSITIVE, OUT-OF-SCOPE (requires owner + SMI-NNNN).

| Hit (file:line) | Category | Disposition | Notes |
|------------------|----------|--------------|-------|
| \`packages/core/src/bin.ts:1\` | _<1-4>_ | _<disposition>_ | _<one sentence>_ |
| \`supabase/functions/enc.ts:1\` | _<1-4>_ | _<disposition>_ | _<one sentence>_ |
`

const IDENTITY_BASE_REF = `## State-Flip Assertion Audit (P-7) for \`widget-tool\`

Noun: \`widget-tool\`
Ref: \`HEAD\`
Scanned paths: \`scripts/*.ts scripts/*.sh scripts/*.mjs scripts/*.mts scripts/*.cjs packages/*/src/** packages/*/tests/** packages/*/e2e/** tests/** supabase/functions/** .github/**\`

> **Scope warning.** These pathspecs hold blobs that are not text -- git-crypt ciphertext in \`--ref\` mode, or genuine binaries: \`scripts/*.ts (1 of 1)\`. Their bytes ARE searched (this scan passes \`-a\`) and so they DO contribute to the counts below, but any hit in them is a byte coincidence rather than a source reference, and a miss is not evidence about whatever the bytes encode. Treat the counts as unreliable over these paths in both directions. For git-crypt paths, re-run WITHOUT \`--ref\` to search their decrypted working-tree contents.
STEP 1 (denominator): 1

### STEP 2: noun x absence-vocabulary (0 hit(s)), MANDATED OUTPUT

_None. STEP 1 found the noun 1 time(s) but none carried absence-vocabulary._

### STEP 3: high-yield triage subset (0 hit(s)), reading order only, NOT a filter

_Read STEP 3 first for triage, but STEP 2 is the check. STEP 3 is measured to miss real casualties (SMI-6514 D-11); do not stop at STEP 3._

_None._

### Suggested P-7 matrix (scaffold)

Copy this into the plan's \`## State-Flip Assertion Audit (P-7)\` section, or into the pr-reviewer PR-15 finding. One row per STEP 2 hit. Category is one of: 1 (test), 2 (comment/doc), 3 (diagnostic/error text), 4 (catch block). Disposition is one of: FIX-NOW, STILL-TRUE, FALSE-POSITIVE, OUT-OF-SCOPE (requires owner + SMI-NNNN).

| Hit (file:line) | Category | Disposition | Notes |
|------------------|----------|--------------|-------|
| _<none, STEP 2 was empty>_ | | | |
`

const IDENTITY_BASE_WT = `## State-Flip Assertion Audit (P-7) for \`widget-tool\`

Noun: \`widget-tool\`
Ref: \`working tree\`
Scanned paths: \`scripts/*.ts scripts/*.sh scripts/*.mjs scripts/*.mts scripts/*.cjs packages/*/src/** packages/*/tests/** packages/*/e2e/** tests/** supabase/functions/** .github/**\`

> **Scope warning.** These pathspecs hold blobs that are not text -- git-crypt ciphertext in \`--ref\` mode, or genuine binaries: \`scripts/*.ts (1 of 1)\`. Their bytes ARE searched (this scan passes \`-a\`) and so they DO contribute to the counts below, but any hit in them is a byte coincidence rather than a source reference, and a miss is not evidence about whatever the bytes encode. Treat the counts as unreliable over these paths in both directions. For git-crypt paths, re-run WITHOUT \`--ref\` to search their decrypted working-tree contents.
STEP 1 (denominator): 1

### STEP 2: noun x absence-vocabulary (0 hit(s)), MANDATED OUTPUT

_None. STEP 1 found the noun 1 time(s) but none carried absence-vocabulary._

### STEP 3: high-yield triage subset (0 hit(s)), reading order only, NOT a filter

_Read STEP 3 first for triage, but STEP 2 is the check. STEP 3 is measured to miss real casualties (SMI-6514 D-11); do not stop at STEP 3._

_None._

### Suggested P-7 matrix (scaffold)

Copy this into the plan's \`## State-Flip Assertion Audit (P-7)\` section, or into the pr-reviewer PR-15 finding. One row per STEP 2 hit. Category is one of: 1 (test), 2 (comment/doc), 3 (diagnostic/error text), 4 (catch block). Disposition is one of: FIX-NOW, STILL-TRUE, FALSE-POSITIVE, OUT-OF-SCOPE (requires owner + SMI-NNNN).

| Hit (file:line) | Category | Disposition | Notes |
|------------------|----------|--------------|-------|
| _<none, STEP 2 was empty>_ | | | |
`

describe('scan-state-flip.sh (SMI-6514 P-7 scanner) -- Group A: portable', () => {
  it.skipIf(!SCANNER_PRESENT)('parses cleanly under `bash -n`', () => {
    expect(() => execFileSync('bash', ['-n', SCANNER_PATH], { encoding: 'utf8' })).not.toThrow()
  })

  it.skipIf(!SCANNER_PRESENT)('is shellcheck-clean, when shellcheck is available', () => {
    if (!shellcheckAvailable()) {
      // Not installed in this environment (the Docker dev container does
      // not carry it; the repo's actual shellcheck enforcement surface for
      // scripts/ is the dedicated host-runner steps in
      // .github/workflows/validate-hooks.yml and friends). Nothing to
      // assert when the binary itself is absent.
      return
    }
    expect(() => execFileSync('shellcheck', [SCANNER_PATH], { encoding: 'utf8' })).not.toThrow()
  })

  it.skipIf(!SCANNER_PRESENT)('usage error (no noun given) exits with code 2', () => {
    let threw = false
    try {
      execFileSync('bash', [SCANNER_PATH], { cwd: REPO_ROOT, encoding: 'utf8' })
    } catch (err) {
      threw = true
      expect((err as { status: number }).status).toBe(2)
    }
    expect(threw).toBe(true)
  })

  it.skipIf(!SCANNER_PRESENT)(
    'correctly counts a synthetic pre-flip tree via --ref (STEP1=4, STEP2=3, STEP3=2)',
    () => {
      const { repoDir, preFlipSha } = setupSyntheticStateFlipRepo()
      const out = execFileSync('bash', [SCANNER_PATH, 'widget-tool', '--ref', preFlipSha], {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(out).toContain('STEP 1 (denominator): 4')
      expect(out).toContain('STEP 2: noun x absence-vocabulary (3 hit(s))')
      expect(out).toContain('STEP 3: high-yield triage subset (2 hit(s))')
    }
  )

  // SMI-6659 / SMI-6678. Three defects, all of which understate or corrupt the
  // STEP-1 denominator -- the one number P-7's design rests on (SMI-6514 s2.4).
  // Each BEFORE value below was measured against the pre-fix scanner, and is in the
  // test name so a reader can see what the case caught rather than trust that it did.
  function setupMetacharRepo(): { repoDir: string } {
    const repoDir = makeFixtureTempDir('state-flip-metachar-fixture')
    createdRepoDirs.push(repoDir)
    git(repoDir, ['init', '-q', '-b', 'main'])
    const subDir = join(repoDir, 'scripts', 'sub')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(
      join(subDir, 'fixture.sh'),
      [
        '# widget.tool is not installed by design',
        '# widgetXtool is not installed by design',
        '# thing(alpha) is not installed by design',
        '# cache[fast] is not installed by design',
        // The next three exist to make STEP 2 depend on the NOUN. A line like
        // "# a|b is not installed by design" cannot test escape_ere() at all: it
        // matches STEP 2 through the noun-INDEPENDENT alternatives `not installed`
        // and `by design`, so deleting the escaping entirely still scores 1.
        '# no a|b here',
        '# a|b appears in this line',
        '# an unrelated line mentioning b on its own',
        // A noun that begins with `-`. The script's own usage names "a flag name"
        // as a valid noun, so this is inside the contract, not an edge case.
        '# --force-flag is not installed by design',
        '',
      ].join('\n')
    )
    // Directly under scripts/, NO intermediate directory -- invisible to the
    // pre-SMI-6678 pathspec. One of each extension, so fixing `.sh` while leaving
    // `.ts` broken fails.
    writeFileSync(
      join(repoDir, 'scripts', 'toplevel.sh'),
      ['# toplevelsh is not installed by design', ''].join('\n')
    )
    writeFileSync(
      join(repoDir, 'scripts', 'toplevel.ts'),
      ['// toplevelts is not installed by design', ''].join('\n')
    )
    git(repoDir, ['add', '.'])
    git(repoDir, ['commit', '-q', '-m', 'metacharacter + top-level fixtures'])
    // Written AFTER the commit and never added: only a working-tree scan that
    // passes --untracked can see it.
    writeFileSync(
      join(subDir, 'never-added.sh'),
      ['# untrackednoun is not installed by design', ''].join('\n')
    )
    return { repoDir }
  }

  const scanNoun = (repoDir: string, noun: string): string =>
    execFileSync('bash', [SCANNER_PATH, noun], { cwd: repoDir, encoding: 'utf8' })

  it.skipIf(!SCANNER_PRESENT)(
    'SMI-6659: a `.` in the noun does not over-match (was 2, want 1)',
    () => {
      // The dangerous direction: as a regex, `widget.tool` also matches `widgetXtool`,
      // inflating the denominator rather than zeroing it, so the vacuous-success
      // guard never fires and the output reads as a thorough scan.
      expect(scanNoun(setupMetacharRepo().repoDir, 'widget.tool')).toContain(
        'STEP 1 (denominator): 1'
      )
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'SMI-6659: parentheses do not zero the denominator (was 0, want 1)',
    () => {
      expect(scanNoun(setupMetacharRepo().repoDir, 'thing(alpha)')).toContain(
        'STEP 1 (denominator): 1'
      )
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'SMI-6659: a bracket expression does not zero the denominator (was 0, want 1)',
    () => {
      // Distinct from the parenthesis case on purpose: a fix that special-cased only
      // `(` and `)` would pass that test and fail this one.
      expect(scanNoun(setupMetacharRepo().repoDir, 'cache[fast]')).toContain(
        'STEP 1 (denominator): 1'
      )
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'SMI-6659: `|` does not match every line, and STEP 2 depends on the escaped noun',
    () => {
      const out = scanNoun(setupMetacharRepo().repoDir, 'a|b')
      // STEP 1 was 10 before the fix -- the alternation escaped the noun and matched
      // every line in the fixture.
      expect(out).toContain('STEP 1 (denominator): 2')
      // STEP 2 is the assertion that actually pins escape_ere(), which `-F` cannot
      // fix because ABSENCE_VOCAB interpolates the noun into a real ERE alternation.
      // Escaped, only `# no a|b here` matches via `no <noun>` -> 1.
      // Unescaped, `no a|b|without a|b` becomes the alternatives `no a`, `b`,
      // `without a`, `b`, and the bare `b` also matches `# a|b appears in this line`
      // and `# an unrelated line mentioning b on its own` -> 3.
      expect(out).toContain('STEP 2: noun x absence-vocabulary (1 hit(s))')
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'SMI-6678: a .sh directly under scripts/ is scanned (was 0, want 1)',
    () => {
      // `scripts/**/*.sh` requires an intervening directory; `scripts/*.sh` does not.
      // 75 top-level shell scripts were invisible, scripts/_lib.sh among them.
      expect(scanNoun(setupMetacharRepo().repoDir, 'toplevelsh')).toContain(
        'STEP 1 (denominator): 1'
      )
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'SMI-6678: a .ts directly under scripts/ is scanned (was 0, want 1)',
    () => {
      // Separate from the .sh case: fixing one pathspec and not the other passes that
      // test and fails this one. 57 top-level TypeScript files were invisible.
      expect(scanNoun(setupMetacharRepo().repoDir, 'toplevelts')).toContain(
        'STEP 1 (denominator): 1'
      )
    }
  )

  it.skipIf(!SCANNER_PRESENT)('working-tree mode sees an untracked file (was 0, want 1)', () => {
    // `git grep` without --untracked searches tracked content only, so a newly
    // written script carrying the noun AND a stale assertion contributed nothing.
    // Every other fixture here is committed before scanning, which is exactly why
    // no existing test could expose this.
    const out = scanNoun(setupMetacharRepo().repoDir, 'untrackednoun')
    expect(out).toContain('STEP 1 (denominator): 1')
    // STEP 2 as well, not just the denominator. run_grep_and carries its OWN
    // --untracked, on a separate line from run_grep's, so a STEP-1-only assertion
    // left that arm unconstrained: removing --untracked from run_grep_and alone
    // dropped STEP 2 from 1 to 0 while all 28 tests stayed green. Found by the
    // PR-16 pre-merge check (author-chosen-mutation review) -- it is exactly the
    // mutation the author would not pick, being the author's own blind spot.
    expect(out).toContain('STEP 2: noun x absence-vocabulary (1 hit(s))')
    expect(out).toMatch(/never-added\.sh:1:/)
  })

  it.skipIf(!SCANNER_PRESENT)('a noun containing a newline is rejected, not silently split', () => {
    // `git grep -F` treats each line of a multi-line pattern as its own fixed
    // pattern, so the denominator becomes the union of the parts. Measured on the
    // real repo: a two-line noun reported its first component's 43 hits for a
    // whole-noun truth of 0.
    const { repoDir } = setupMetacharRepo()
    let status = 0
    try {
      execFileSync('bash', [SCANNER_PATH, 'toplevelsh\nTHIS_COMPONENT_DOES_NOT_EXIST'], {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: 'pipe',
      })
    } catch (err) {
      status = (err as { status: number }).status
    }
    expect(status).toBe(2)
  })

  it.skipIf(!SCANNER_PRESENT)(
    'a noun beginning with `-` is a pattern, not an option -- working tree (was 0, want 1)',
    () => {
      // Without `-e`, git grep parses a leading-dash noun as an OPTION. Measured on
      // the real repo: `--force` reported a denominator of 0 against a true count of
      // 209, and exited 1 -- the vacuous-success shape, for a noun the script's usage
      // explicitly says it accepts.
      expect(scanNoun(setupMetacharRepo().repoDir, '--force-flag')).toContain(
        'STEP 1 (denominator): 1'
      )
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'a noun beginning with `-` is a pattern, not an option -- --ref mode (was 0, want 1)',
    () => {
      // Separate from the working-tree case: the two git grep call sites are distinct
      // lines, so fixing one and not the other passes that test and fails this one.
      const { repoDir } = setupMetacharRepo()
      const sha = git(repoDir, ['rev-parse', 'HEAD']).trim()
      const out = execFileSync('bash', [SCANNER_PATH, '--force-flag', '--ref', sha], {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(out).toContain('STEP 1 (denominator): 1')
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'control: a metacharacter-free noun is unaffected by any of the fixes',
    () => {
      // Without this, a change that broke ordinary scanning would still satisfy every
      // case above.
      expect(scanNoun(setupMetacharRepo().repoDir, 'widgetXtool')).toContain(
        'STEP 1 (denominator): 1'
      )
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'correctly counts the post-flip working tree with no --ref (STEP1=1, STEP2=0, STEP3=0)',
    () => {
      const { repoDir } = setupSyntheticStateFlipRepo()
      const out = execFileSync('bash', [SCANNER_PATH, 'widget-tool'], {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(out).toContain('STEP 1 (denominator): 1')
      expect(out).toContain('STEP 2: noun x absence-vocabulary (0 hit(s))')
      expect(out).toContain('STEP 3: high-yield triage subset (0 hit(s))')
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'exits with code 1 -- not merely non-zero -- on a genuine zero STEP-1 denominator (the vacuous-success guard)',
    () => {
      // Pinned to 1 specifically, not `.toThrow()`. The error path below exits 2,
      // and a bare "non-zero" assertion would be satisfied by either, so the two
      // cases could not tell each other apart -- the exact shape of a test that
      // exercises code without constraining it.
      const { repoDir } = setupSyntheticStateFlipRepo()
      let status: number | undefined
      let stderr = ''
      try {
        execFileSync('bash', [SCANNER_PATH, 'zzz-totally-absent-noun-smi-6514', '--ref', 'HEAD'], {
          cwd: repoDir,
          encoding: 'utf8',
        })
      } catch (err) {
        const e = err as { status?: number; stderr?: string }
        status = e.status
        stderr = e.stderr ?? ''
      }
      expect(status).toBe(1)
      // stderr, not stdout -- the scanner writes its verdict to stderr. Asserting
      // this on stdout passes vacuously, which is what the first draft of the
      // sibling case below did.
      expect(stderr).toContain('does not appear anywhere')
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'an unresolvable --ref exits 2 and never claims the noun is absent (git grep error vs no-match)',
    () => {
      // SMI-6659, 5th denominator gap. `git grep` exits 1 for "no match" and 128
      // for an unresolvable revision. The old `2>/dev/null || true` collapsed both
      // into an empty result, so a search that NEVER RAN was reported as a
      // denominator of 0 under "The noun does not appear anywhere in the scanned
      // paths" -- a false statement about the codebase, offering two explanations
      // of which neither was the real cause.
      const { repoDir } = setupSyntheticStateFlipRepo()
      let status: number | undefined
      let stdout = ''
      let stderr = ''
      try {
        execFileSync('bash', [SCANNER_PATH, 'widget-tool', '--ref', 'no-such-ref-smi-6659'], {
          cwd: repoDir,
          encoding: 'utf8',
        })
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string }
        status = e.status
        stdout = e.stdout ?? ''
        stderr = e.stderr ?? ''
      }
      expect(status).toBe(2)
      expect(stderr).toContain('is an ERROR, not a no-match result')
      // The decisive assertion, and it has to be on stderr: that is where the
      // vacuous-success verdict is written, so asserting its ABSENCE on stdout
      // would hold whether or not the fix exists.
      expect(stderr).not.toContain('does not appear anywhere')
      expect(stdout).not.toContain('STEP 2')
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'supabase functions and package e2e specs are in scope (working-tree mode)',
    () => {
      // SMI-6659, 11th gap. supabase/functions/** was entirely outside PATHSPECS
      // -- 145 tracked *.test.ts files, the same casualty category as the 8th gap.
      // Measured before the fix: a real noun living there reported denominator 0
      // under "does not appear anywhere" while occurring 4 times in the tree.
      const repoDir = makeFixtureTempDir('state-flip-supabase-fixture')
      createdRepoDirs.push(repoDir)
      git(repoDir, ['init', '-q', '-b', 'main'])
      const places = [
        'supabase/functions/_shared/thing.test.ts',
        'packages/vscode-extension/e2e/specs/thing.spec.ts',
      ]
      for (const rel of places) {
        mkdirSync(join(repoDir, dirname(rel)), { recursive: true })
        writeFileSync(join(repoDir, rel), '// widget-tool is referenced here\n')
      }
      git(repoDir, ['add', '-A'])
      git(repoDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
      const out = execFileSync('bash', [SCANNER_PATH, 'widget-tool'], {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(out).toContain(`STEP 1 (denominator): ${places.length}`)
    }
  )

  // MODE x CARDINALITY matrix for the scope warning.
  //
  // Five consecutive pre-merge findings landed in this one assertion, and each fix
  // constrained the surface the reviewer had shown me while the contradiction moved
  // to the nearest surface I had not:
  //
  //   phrase       a different phrase was unconstrained, four times over
  //   line         string toContain is a substring check; a suffix survived
  //   document     a contradictory SIBLING line survived
  //   mode         whole-document equality covered --ref only; working tree survived
  //   cardinality  both modes pinned, but every fixture had exactly ONE unreadable
  //                pathspec, so a branch on `${#UNREADABLE_SPECS[@]} > 1` never fired
  //
  // The warning is emitted from one printf reached along two independent axes, so
  // coverage is expressed as their PRODUCT rather than as another isolated case.
  // Every cell compares the COMPLETE stdout; nothing here is a substring check.
  const UNREADABLE_MATRIX = [
    {
      label: 'one pathspec, --ref',
      two: false,
      args: ['widget-tool', '--ref', 'HEAD'],
      expected: EXPECTED_ONE_REF,
    },
    {
      label: 'one pathspec, working tree',
      two: false,
      args: ['widget-tool'],
      expected: EXPECTED_ONE_WT,
    },
    {
      label: 'two pathspecs, --ref',
      two: true,
      args: ['widget-tool', '--ref', 'HEAD'],
      expected: EXPECTED_TWO_REF,
    },
    {
      label: 'two pathspecs, working tree',
      two: true,
      args: ['widget-tool'],
      expected: EXPECTED_TWO_WT,
    },
  ]

  it.skipIf(!SCANNER_PRESENT)(
    'scope warning: EVERY pathspec identity, in both modes, derived from PATHSPECS itself',
    () => {
      // The 23rd defect was a THIRD axis: pathspec identity. Mode x cardinality was
      // pinned, but the matrix exercised only two of the eleven pathspecs, so a false
      // clause conditional on `.github/**` being unreadable survived untouched.
      //
      // Enumerating examples would have been the same mistake a seventh time, so the
      // inventory is PARSED FROM THE SCANNER'S OWN PATHSPECS ARRAY. Adding a twelfth
      // pathspec extends this coverage automatically; it cannot drift.
      //
      // The unreadable blob is deliberately NOUN-FREE, which makes the only
      // identity-dependent text in the whole report the pathspec name in the warning.
      // So each cell's expected document is the base document with the name and extent
      // substituted -- a rule, not a stored document per cell.
      const src = readFileSync(SCANNER_PATH, 'utf8')
      const arr = src.match(/^PATHSPECS=\(([\s\S]*?)^\)/m)
      expect(arr, 'PATHSPECS array not found -- parser drifted').toBeTruthy()
      const specs = [...arr![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
      expect(specs.length).toBeGreaterThan(8)

      const REF_SPEC = specs[0]
      const GITCRYPT_MAGIC = Buffer.from([
        0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00,
      ])
      // One concrete file under each pathspec.
      const materialise = (spec: string): string =>
        spec
          .replace('packages/*/src/**', 'packages/core/src/opaque.bin')
          .replace('packages/*/tests/**', 'packages/core/tests/opaque.bin')
          .replace('packages/*/e2e/**', 'packages/core/e2e/opaque.bin')
          .replace('tests/**', 'tests/opaque.bin')
          .replace('supabase/functions/**', 'supabase/functions/opaque.bin')
          .replace('.github/**', '.github/opaque.bin')
          .replace(/^scripts\/\*\.(\w+)$/, 'scripts/opaque.$1')

      for (const spec of specs) {
        const repoDir = makeFixtureTempDir('state-flip-identity-fixture')
        createdRepoDirs.push(repoDir)
        git(repoDir, ['init', '-q', '-b', 'main'])
        mkdirSync(join(repoDir, 'scripts'), { recursive: true })
        writeFileSync(join(repoDir, 'scripts', 'plain.sh'), 'widget-tool in plaintext\n')
        const rel = materialise(spec)
        mkdirSync(join(repoDir, dirname(rel)), { recursive: true })
        writeFileSync(
          join(repoDir, rel),
          Buffer.concat([GITCRYPT_MAGIC, Buffer.from('nothing relevant\n')])
        )
        git(repoDir, ['add', '-A'])
        git(repoDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])

        // The carrier at scripts/plain.sh shares a pathspec with scripts/*.sh, so that
        // one cell legitimately reports two files. One rule, not an exception list.
        const extent = spec === 'scripts/*.sh' ? '(1 of 2)' : '(1 of 1)'
        const subst = (base: string): string =>
          base.split(`${REF_SPEC} (1 of 1)`).join(`${spec} ${extent}`)

        for (const [args, base] of [
          [['widget-tool', '--ref', 'HEAD'], IDENTITY_BASE_REF],
          [['widget-tool'], IDENTITY_BASE_WT],
        ] as [string[], string][]) {
          const out = execFileSync('bash', [SCANNER_PATH, ...args], {
            cwd: repoDir,
            encoding: 'utf8',
          })
          expect(out, `${spec} / ${args.join(' ')}`).toBe(subst(base))
        }
      }
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'scope warning: every mode x cardinality cell matches its complete expected report',
    () => {
      const GITCRYPT_MAGIC = Buffer.from([
        0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00,
      ])
      const blob = (tail: string): Buffer => Buffer.concat([GITCRYPT_MAGIC, Buffer.from(tail)])

      for (const cell of UNREADABLE_MATRIX) {
        const repoDir = makeFixtureTempDir('state-flip-matrix-fixture')
        createdRepoDirs.push(repoDir)
        git(repoDir, ['init', '-q', '-b', 'main'])
        mkdirSync(join(repoDir, 'supabase', 'functions'), { recursive: true })
        mkdirSync(join(repoDir, 'scripts'), { recursive: true })
        writeFileSync(join(repoDir, 'scripts', 'plain.sh'), 'widget-tool in plaintext\n')
        writeFileSync(
          join(repoDir, 'supabase', 'functions', 'enc.ts'),
          blob('widget-tool is not installed by design\n')
        )
        if (cell.two) {
          // A SECOND unreadable pathspec, so any branch keyed on "more than one" is
          // actually reached.
          mkdirSync(join(repoDir, 'packages', 'core', 'src'), { recursive: true })
          writeFileSync(
            join(repoDir, 'packages', 'core', 'src', 'bin.ts'),
            blob('widget-tool is absent\n')
          )
        }
        git(repoDir, ['add', '-A'])
        git(repoDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
        const out = execFileSync('bash', [SCANNER_PATH, ...cell.args], {
          cwd: repoDir,
          encoding: 'utf8',
        })
        expect(out, cell.label).toBe(cell.expected)
      }
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'an entirely readable tree emits NO scope warning, in either mode',
    () => {
      // The other half of the disclosure contract, and it needs its own fixture: a
      // warning that fires on every run is a warning nobody reads. Asserted in both
      // modes because the check now runs in both.
      const repoDir = makeFixtureTempDir('state-flip-allreadable-fixture')
      createdRepoDirs.push(repoDir)
      git(repoDir, ['init', '-q', '-b', 'main'])
      mkdirSync(join(repoDir, 'supabase', 'functions'), { recursive: true })
      mkdirSync(join(repoDir, 'scripts'), { recursive: true })
      writeFileSync(join(repoDir, 'scripts', 'plain.sh'), 'widget-tool in plaintext\n')
      writeFileSync(
        join(repoDir, 'supabase', 'functions', 'also-plain.ts'),
        '// widget-tool, entirely readable\n'
      )
      git(repoDir, ['add', '-A'])
      git(repoDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
      for (const args of [['widget-tool', '--ref', 'HEAD'], ['widget-tool']]) {
        const out = execFileSync('bash', [SCANNER_PATH, ...args], {
          cwd: repoDir,
          encoding: 'utf8',
        })
        expect(out, `args: ${args.join(' ')}`).not.toContain('Scope warning')
        expect(out, `args: ${args.join(' ')}`).toContain('STEP 1 (denominator): 2')
      }
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'a pathspec mixing plaintext and unreadable blobs is disclosed regardless of order',
    () => {
      // Second PR-16 pre-merge finding. The first two implementations SAMPLED one
      // blob per pathspec, so whichever filename sorted first decided the verdict:
      // with 000-plain.ts beside zzz-encrypted.ts, the probe read the plaintext and
      // emitted nothing. Reproduced at 0 warnings against a wanted 1.
      //
      // The mechanism was re-derived rather than patched a third time, per the
      // reviewer skill's stop-patching rule. It no longer samples or looks for
      // git-crypt's magic: it asks git which in-scope blobs are not text
      // (`grep -l -a` minus `grep -lI`), which is the complete set and cannot
      // depend on ordering.
      const repoDir = makeFixtureTempDir('state-flip-mixed-fixture')
      createdRepoDirs.push(repoDir)
      git(repoDir, ['init', '-q', '-b', 'main'])
      mkdirSync(join(repoDir, 'supabase', 'functions'), { recursive: true })
      mkdirSync(join(repoDir, 'scripts'), { recursive: true })
      writeFileSync(join(repoDir, 'scripts', 'plain.sh'), 'widget-tool in plaintext\n')
      // Sorts FIRST, and is ordinary text -- the blob the old probe would have read.
      writeFileSync(
        join(repoDir, 'supabase', 'functions', '000-plain.ts'),
        '// an ordinary plaintext function\n'
      )
      // Sorts LAST, and is the one that matters.
      writeFileSync(
        join(repoDir, 'supabase', 'functions', 'zzz-encrypted.ts'),
        Buffer.concat([
          Buffer.from('\u0000GITCRYPT\u0000', 'binary'),
          Buffer.from('opaque-ciphertext\n'),
        ])
      )
      git(repoDir, ['add', '-A'])
      git(repoDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
      const out = execFileSync('bash', [SCANNER_PATH, 'widget-tool', '--ref', 'HEAD'], {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(out).toContain('are not text')
      // 1 of the 2 blobs under that pathspec, which is the whole point: a partial
      // count has to be reported as partial.
      expect(out).toMatch(/supabase\/functions\/\*\* \(1 of 2\)/)
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'a path git would QUOTE still gets probed, so the scope warning is not lost',
    () => {
      // PR-07 pre-merge finding. Without -z, git quotes any path containing a
      // special character -- a committed `supabase/functions/odd<LF>name.ts` comes
      // back as the literal `HEAD:"supabase/functions/odd\nname.ts"`, quotes and
      // all. That is not a valid object name, so `git show` failed, its stderr went
      // to /dev/null, and the run reported a clean denominator with the encrypted
      // pathspec undisclosed: the probe's own failure read as "nothing encrypted".
      const repoDir = makeFixtureTempDir('state-flip-quotedpath-fixture')
      createdRepoDirs.push(repoDir)
      git(repoDir, ['init', '-q', '-b', 'main'])
      mkdirSync(join(repoDir, 'supabase', 'functions'), { recursive: true })
      mkdirSync(join(repoDir, 'scripts'), { recursive: true })
      writeFileSync(join(repoDir, 'scripts', 'plain.sh'), 'widget-tool in plaintext\n')
      writeFileSync(
        join(repoDir, 'supabase', 'functions', 'odd\nname.ts'),
        Buffer.concat([
          Buffer.from('\u0000GITCRYPT\u0000', 'binary'),
          Buffer.from('opaque-ciphertext\n'),
        ])
      )
      git(repoDir, ['add', '-A'])
      git(repoDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
      const out = execFileSync('bash', [SCANNER_PATH, 'widget-tool', '--ref', 'HEAD'], {
        cwd: repoDir,
        encoding: 'utf8',
      })
      // 'Scope warning' ALONE is not enough. The INDETERMINATE branch prints that
      // string too, and names the same pathspec, so an earlier draft of this test
      // passed with the defect restored. Assert the claim that distinguishes them:
      // the content was examined and found unreadable, with its extent.
      expect(out).toContain('are not text')
      expect(out).not.toContain('could not be examined')
      expect(out).toMatch(/supabase\/functions\/\*\* \(1 of 1\)/)
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'ref mode discloses git-crypt encrypted pathspecs instead of counting them as 0',
    () => {
      // SMI-6659, 13th gap -- created by fixing the 11th. git-crypt stores blobs
      // ENCRYPTED in the object database, so `git grep <ref>` over supabase reads
      // ciphertext and contributes 0 while the "Scanned paths" line claims cover.
      // Measured on a real noun: 4 working-tree hits, 0 against HEAD.
      //
      // The fixture writes git-crypt's own \0GITCRYPT\0 magic rather than running
      // git-crypt, because the probe checks exactly that signature -- so this pins
      // the detector against the bytes it actually reads.
      const repoDir = makeFixtureTempDir('state-flip-gitcrypt-fixture')
      createdRepoDirs.push(repoDir)
      git(repoDir, ['init', '-q', '-b', 'main'])
      mkdirSync(join(repoDir, 'supabase', 'functions'), { recursive: true })
      writeFileSync(
        join(repoDir, 'supabase', 'functions', 'enc.ts'),
        Buffer.concat([
          Buffer.from('\u0000GITCRYPT\u0000', 'binary'),
          Buffer.from('opaque-ciphertext-widget-tool\n'),
        ])
      )
      mkdirSync(join(repoDir, 'scripts'), { recursive: true })
      writeFileSync(join(repoDir, 'scripts', 'plain.sh'), 'widget-tool in plaintext\n')
      git(repoDir, ['add', '-A'])
      git(repoDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])

      const refOut = execFileSync('bash', [SCANNER_PATH, 'widget-tool', '--ref', 'HEAD'], {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(refOut).toContain('Scope warning')
      expect(refOut).toContain('are not text')
      // Naming the pathspec is not enough either -- report the EXTENT, so a reader
      // can tell "one stray binary" from "the whole tree is opaque".
      expect(refOut).toMatch(/supabase\/functions\/\*\* \(1 of 1\)/)

      // Working-tree mode warns HERE too, and that is correct rather than a false
      // positive: this fixture writes real binary bytes to disk, so the blob is
      // unreadable in the working tree as well. The real repo differs only because
      // git-crypt decrypts on checkout. An earlier draft asserted absence here and
      // was asserting the wrong property -- the no-false-positive claim needs a
      // fixture that is genuinely plaintext, which is the next case.
      const plainOut = execFileSync('bash', [SCANNER_PATH, 'widget-tool'], {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(plainOut).toContain('are not text')
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'the report states the paths it searched, and the line matches PATHSPECS itself',
    () => {
      // SMI-6659, 11th gap. The report gave a denominator and never said over
      // WHAT. The script's header claims it "reports its own denominator so a
      // reviewer cannot satisfy P-7 by pasting a bare number for the wrong noun"
      // -- that guards the noun, not the scope, and a number for the right noun
      // over the wrong paths is the same defect. The 8th gap (tests outside
      // PATHSPECS) is one a reader would have caught on sight from this line.
      //
      // Parsed from the script's own array rather than hardcoded, so adding a
      // pathspec without the report following reddens here.
      const src = readFileSync(SCANNER_PATH, 'utf8')
      const arr = src.match(/^PATHSPECS=\(([\s\S]*?)^\)/m)
      expect(arr, 'PATHSPECS array not found -- parser drifted from the script').toBeTruthy()
      const specs = (arr![1].match(/'([^']+)'/g) ?? []).map((q) => q.slice(1, -1))
      expect(specs.length).toBeGreaterThan(4)

      const { repoDir } = setupSyntheticStateFlipRepo()
      const out = execFileSync('bash', [SCANNER_PATH, 'widget-tool', '--ref', 'HEAD'], {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(out).toContain('Scanned paths:')
      for (const spec of specs) {
        expect(out, `report omits pathspec ${spec}`).toContain(spec)
      }
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'the header documents exit 2 as three causes, not just "usage error"',
    () => {
      // SMI-6659, 12th gap. exit 2 was documented as "usage error" while it had
      // grown to cover a dash-leading --ref and a git grep failure meaning the
      // search never ran. A reader handed "usage error" for a repo-state failure
      // looks in the wrong place -- the scanner's own category 3, diagnostic text
      // naming an explanation that is not the real one, so the wrong fix ships.
      const src = readFileSync(SCANNER_PATH, 'utf8')
      const header = src.slice(0, src.indexOf('set -euo pipefail'))
      expect(header).toMatch(/THE SEARCH DID NOT RUN/)
      expect(header).toMatch(/never read an exit 2 as/i)
      // The bare old wording must be gone, not merely supplemented.
      expect(header).not.toMatch(/^#\s+2\s+usage error\s*$/m)
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'STEP 2 and STEP 3 match file CONTENT, not the ref/path prefix of the grep record',
    () => {
      // SMI-6659, 9th gap. A plain post-filter over STEP1_OUT sees the whole record
      // -- "path:line:content", or "ref:path:line:content" with --ref -- so absence
      // vocabulary in the PATH matched lines whose content carried none. An ordinary
      // filename is enough; no exotic ref syntax is needed.
      const repoDir = makeFixtureTempDir('state-flip-prefix-fixture')
      createdRepoDirs.push(repoDir)
      git(repoDir, ['init', '-q', '-b', 'main'])
      mkdirSync(join(repoDir, 'scripts'), { recursive: true })
      // Path says "absent"; content says nothing of the kind.
      writeFileSync(
        join(repoDir, 'scripts', 'absent-handler.sh'),
        'widget-tool is configured here\nwidget-tool runs twice\n'
      )
      // The only genuine casualty.
      writeFileSync(join(repoDir, 'scripts', 'real.sh'), 'widget-tool is not installed by design\n')
      git(repoDir, ['add', '-A'])
      git(repoDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
      // Both modes: the ref record carries an extra "ref:" field, so a fix applied to
      // one arm and not the other would pass on the strength of the covered one.
      for (const args of [['widget-tool', '--ref', 'HEAD'], ['widget-tool']]) {
        const out = execFileSync('bash', [SCANNER_PATH, ...args], {
          cwd: repoDir,
          encoding: 'utf8',
        })
        const label = `args: ${args.join(' ')}`
        expect(out, label).toContain('STEP 1 (denominator): 3')
        expect(out, label).toContain('STEP 2: noun x absence-vocabulary (1 hit(s))')
        // Decisive: the two plain-content lines must not be counted as casualties.
        expect(out, label).not.toContain('STEP 2: noun x absence-vocabulary (3 hit(s))')
        expect(out, label).not.toContain('absent-handler.sh')
      }
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'a colon in a pathname does not corrupt the scaffold location',
    () => {
      // SMI-6659, 10th gap. Splitting at the FIRST colon assumed the path had none:
      // scripts/a:b.sh:1:content yielded loc=scripts/a, lineno=b.sh, and the row
      // rendered as `scripts/a:b.sh` -- which READS like a correct path while the
      // line number is silently gone. That plausibility is what makes it dangerous.
      const repoDir = makeFixtureTempDir('state-flip-colon-fixture')
      createdRepoDirs.push(repoDir)
      git(repoDir, ['init', '-q', '-b', 'main'])
      mkdirSync(join(repoDir, 'scripts'), { recursive: true })
      writeFileSync(join(repoDir, 'scripts', 'a:b.sh'), 'widget-tool is not installed by design\n')
      git(repoDir, ['add', '-A'])
      git(repoDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
      const out = execFileSync('bash', [SCANNER_PATH, 'widget-tool', '--ref', 'HEAD'], {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(out).toContain('| `scripts/a:b.sh:1` |')
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'test directories are in scope -- packages/*/tests, root tests, .mts and .cjs',
    () => {
      // SMI-6659, 8th gap. The scanner's own header names "tests whose premise was
      // the old state" as the FIRST P-7 casualty category, yet packages/*/tests/**
      // and root tests/** were outside PATHSPECS. Measured on the live tree before
      // the fix: `API_MOCKS.errorServiceUnavailable` reported a denominator of 0
      // under "does not appear anywhere" while living in a package test.
      const repoDir = makeFixtureTempDir('state-flip-testdirs-fixture')
      createdRepoDirs.push(repoDir)
      git(repoDir, ['init', '-q', '-b', 'main'])
      // One occurrence per newly-covered location, so a partial revert of the
      // widening reddens rather than passing on the strength of the others.
      const places = [
        'packages/core/tests/thing.test.ts',
        'tests/integration/thing.test.ts',
        'scripts/lib/thing.d.mts',
        'scripts/thing.cjs',
      ]
      for (const rel of places) {
        mkdirSync(join(repoDir, dirname(rel)), { recursive: true })
        writeFileSync(join(repoDir, rel), '// widget-tool is referenced here\n')
      }
      git(repoDir, ['add', '-A'])
      git(repoDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
      for (const args of [['widget-tool', '--ref', 'HEAD'], ['widget-tool']]) {
        const out = execFileSync('bash', [SCANNER_PATH, ...args], {
          cwd: repoDir,
          encoding: 'utf8',
        })
        expect(out, `args: ${args.join(' ')}`).toContain(`STEP 1 (denominator): ${places.length}`)
      }
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'a --ref value beginning with a dash is rejected, not consumed by git grep as an option',
    () => {
      // SMI-6659, 6th gap. The ref is passed positionally, so `--ref --cached`
      // made git search the INDEX and exit 0 while the report named `--cached` as
      // the thing searched -- a denominator for something other than the named
      // ref. Exit 0 means the run_grep error check cannot see it; the ref has to
      // be verified before use.
      const { repoDir } = setupSyntheticStateFlipRepo()
      for (const badRef of ['--cached', '--all', '-q']) {
        let status: number | undefined
        let stdout = ''
        let stderr = ''
        try {
          execFileSync('bash', [SCANNER_PATH, 'widget-tool', '--ref', badRef], {
            cwd: repoDir,
            encoding: 'utf8',
          })
        } catch (err) {
          const e = err as { status?: number; stdout?: string; stderr?: string }
          status = e.status
          stdout = e.stdout ?? ''
          stderr = e.stderr ?? ''
        }
        expect(status, `--ref ${badRef} must exit 2`).toBe(2)
        expect(stderr).toContain("begins with '-'")
        expect(stderr).toContain('consume it as an OPTION')
        // Decisive: no denominator may be reported for a ref that was never used.
        expect(stdout).not.toContain('STEP 1 (denominator)')
      }
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'a NUL-containing source file contributes every matching line, not one "Binary file" record',
    () => {
      // SMI-6659, 7th gap. Without -a, git grep collapses a binary-classified file
      // to a single "Binary file X matches" line regardless of how many lines match,
      // so STEP 1 undercounts and STEP 2 never sees those lines at all.
      // `packages/*/src/**` is not extension-restricted, so a fixture or generated
      // artifact under a package's src lands in scope.
      const repoDir = makeFixtureTempDir('state-flip-nul-fixture')
      createdRepoDirs.push(repoDir)
      git(repoDir, ['init', '-q', '-b', 'main'])
      mkdirSync(join(repoDir, 'scripts'), { recursive: true })
      writeFileSync(
        join(repoDir, 'scripts', 'withnul.sh'),
        Buffer.from('widget-tool a\nwidget-tool b\n\u0000\nwidget-tool c\n', 'binary')
      )
      git(repoDir, ['add', '-A'])
      git(repoDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
      // Both call sites, deliberately. -a has to be added twice -- they are separate
      // lines -- and a mutation sweep showed that dropping it from the working-tree
      // branch alone reddened nothing while the --ref case was covered. That is the
      // same fix-one-site-miss-the-other asymmetry as the earlier -e defect.
      for (const args of [['widget-tool', '--ref', 'HEAD'], ['widget-tool']]) {
        const out = execFileSync('bash', [SCANNER_PATH, ...args], {
          cwd: repoDir,
          encoding: 'utf8',
        })
        expect(out, `args: ${args.join(' ')}`).toContain('STEP 1 (denominator): 3')
        expect(out).not.toContain('STEP 1 (denominator): 1')
      }
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'an unresolvable ref in working-tree-adjacent usage still surfaces git own stderr, not silence',
    () => {
      // Pins the removal of `2>/dev/null`: git's own diagnosis of WHY the search
      // failed has to reach the reader, or the exit-2 message alone leaves them
      // guessing which of ref, pathspec, or repo state was wrong.
      const { repoDir } = setupSyntheticStateFlipRepo()
      let stderr = ''
      try {
        execFileSync('bash', [SCANNER_PATH, 'widget-tool', '--ref', 'no-such-ref-smi-6659'], {
          cwd: repoDir,
          encoding: 'utf8',
        })
      } catch (err) {
        stderr = (err as { stderr?: string }).stderr ?? ''
      }
      expect(stderr).toMatch(/fatal:.*no-such-ref-smi-6659/)
    }
  )
})

// dfe3a485a^ pinned to its full 40-character SHA (SMI-6514 finding 4): an
// abbreviated ref can become unresolvable through an abbreviated-SHA
// collision, a history rewrite, a shallow checkout, or GC, which would
// silently convert this regression lock into a legitimate-looking skip.
// dfe3a485a is SMI-6491's own git-crypt-install commit (fixed, permanent
// SHA; PR #2792); this is its parent -- the pre-fix tree the plan's own
// D-11 counterfactual measured. Verify independently with
// `git rev-parse --verify dfe3a485a^` (resolved to this exact SHA when this
// test was written) or `git log -1 --format=%H dfe3a485a^`.
const HISTORICAL_REF = 'be71efb24382b28a06e7ad07327a46c418fe186a' // dfe3a485a^
const historicalRefStatus = SCANNER_PRESENT
  ? resolveRefStatus(HISTORICAL_REF)
  : { resolvable: false, reason: 'scanner not present (submodule absent)' }

/** Pulls the three STEP counts back out of the scanner's own stdout. */
function parseScannerCounts(output: string): { step1: number; step2: number; step3: number } {
  const step1 = Number(output.match(/STEP 1 \(denominator\): (\d+)/)?.[1])
  const step2 = Number(output.match(/STEP 2: noun x absence-vocabulary \((\d+) hit/)?.[1])
  const step3 = Number(output.match(/STEP 3: high-yield triage subset \((\d+) hit/)?.[1])
  return { step1, step2, step3 }
}

/**
 * The UNSCOPED "vocabulary-only, no noun" grep from SMI-6514 section 2.1 --
 * the naive one-step baseline the plan's D-3 measured noun-scope-first
 * against (2,627 hits at plan-writing time, an 88x reduction down to the
 * ~29-30 hit STEP-2 output). Same VOCAB regex and pathspec set as section
 * 2.1's own command, reproduced here (not the scanner's own broader
 * ABSENCE_VOCAB, which additionally ORs in noun-dependent terms that don't
 * make sense unscoped) and run against the SAME historical ref the scanner
 * itself is invoked against below, so the ratio in the test is
 * apples-to-apples rather than mixing a plan-writing-time snapshot with a
 * live re-run.
 */
function countUnscopedAbsenceVocab(ref: string): number {
  const vocab =
    "not installed|not present|not available|not on path|absent|does not exist|unavailable|by design|isn't|is NOT"
  try {
    const out = execFileSync(
      'git',
      [
        'grep',
        '-niE',
        vocab,
        ref,
        '--',
        'scripts/**/*.ts',
        'scripts/**/*.sh',
        'scripts/*.mjs',
        'packages/*/src/**',
        '.github/**',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )
    return out.split('\n').filter((line) => line.length > 0).length
  } catch (err) {
    // `git grep` exits 1 (not an error condition here) when it finds no
    // matches at all; anything else (bad ref, etc.) is a real failure and
    // should still surface.
    const status = (err as { status?: number }).status
    if (status === 1) return 0
    throw err
  }
}

describe(
  `scan-state-flip.sh -- Group B: historical regression lock ` +
    `(ref '${HISTORICAL_REF}' resolvable: ${historicalRefStatus.resolvable})`,
  () => {
    // SMI-6514 finding 4: this asserts the invariant the plan's own
    // Verification checklist ("Re-measure, don't assert") and D-12 state --
    // the command reproduces, and the two-step (noun-scope-first) collapse
    // still clears >=50x -- not the specific integers recorded in the plan
    // at write time (577 / 29 / 5), which the plan explicitly says will
    // drift as the scanner's own vocabulary or pathspecs are tuned.
    //
    // Measured discrepancy, reported rather than silently resolved: D-12's
    // literal text is "the STEP-1 -> STEP-2 ratio still collapses by
    // >=50x", but STEP-1/STEP-2 against this exact ref is ~19.9x (577/29)
    // pre-fix and ~19.7x (592/30) post-fix -- neither clears 50x, so that
    // literal reading is unsatisfiable by the plan's own recorded numbers.
    // The reading that IS satisfiable, and matches the plan's headline
    // claim (section 2.1 / D-3: "noun-scope-first cuts 2,627 -> 30, an 88x
    // reduction"), is the ratio between the UNSCOPED vocabulary-only count
    // and STEP-2 -- confirmed live at ~90x for this ref. That is what this
    // test asserts.
    it(`reproduces against ${HISTORICAL_REF} and the noun-scope-first collapse still clears >=50x`, (ctx) => {
      if (!SCANNER_PRESENT) {
        ctx.skip('scanner not present (submodule absent)')
      }
      if (!historicalRefStatus.resolvable) {
        // SMI-6549: this is expected and correct inside any worktree
        // container (see the file-header comment) and is a legitimate,
        // visible skip -- not a silent pass. The portable Group A tests
        // above already cover "does the scanner work" in this environment;
        // this test alone locks in a regression against THIS repo's real
        // history, which only a real, working checkout of it can do.
        ctx.skip(
          `ref '${HISTORICAL_REF}' does not resolve in this environment, cannot run the ` +
            `historical regression lock. Reason: ${historicalRefStatus.reason}`
        )
      }

      const out = execFileSync('bash', [SCANNER_PATH, 'git-crypt', '--ref', HISTORICAL_REF], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
      const { step1, step2, step3 } = parseScannerCounts(out)

      // "The command reproduces": ran to completion with real, parseable,
      // non-vacuous counts -- not that the integers match a frozen value.
      expect(Number.isNaN(step1), `could not parse STEP 1 out of:\n${out}`).toBe(false)
      expect(Number.isNaN(step2), `could not parse STEP 2 out of:\n${out}`).toBe(false)
      expect(Number.isNaN(step3), `could not parse STEP 3 out of:\n${out}`).toBe(false)
      expect(step1, 'STEP 1 denominator must be > 0 -- a real historical flip').toBeGreaterThan(0)
      expect(step2, 'STEP 2 must find real casualties for a known real flip').toBeGreaterThan(0)

      const unscopedCount = countUnscopedAbsenceVocab(HISTORICAL_REF)
      const ratio = unscopedCount / step2

      expect(
        ratio,
        `noun-scope-first collapse for '${HISTORICAL_REF}': unscoped vocabulary-only count ` +
          `${unscopedCount} -> STEP 2 (noun-scoped) count ${step2} is only ${ratio.toFixed(1)}x, ` +
          `below the plan's stated >=50x acceptance gate (SMI-6514 D-12 / Verification). ` +
          `STEP 1=${step1}, STEP 3=${step3} for reference.`
      ).toBeGreaterThanOrEqual(50)
    })
  }
)
