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
import { execFileSync, spawnSync } from 'node:child_process'
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

/** Substituted with the scanner's runtime scope wherever an expected report states it. */
const RUNTIME_SCOPE = '__RUNTIME_PATHSPECS__'

let pathspecCache: string[] | undefined

/**
 * The scanner's PATHSPECS as bash itself expands them, read out of the live
 * variable rather than out of the report line, so the report line remains an
 * independent channel this one can be compared against.
 *
 * `git` is shadowed to a function returning 127, which `run_grep` classifies as
 * an error and turns into `exit 2` before any search runs; the EXIT trap then
 * prints the array the prologue has already assigned. Separator is NUL, the one
 * byte a pathspec cannot contain, so an entry holding a space arrives intact
 * instead of being split.
 */
function scannerPathspecs(): string[] {
  if (pathspecCache) return pathspecCache
  let raw: string
  try {
    raw = execFileSync(
      'bash',
      [
        '-euo',
        'pipefail',
        '-c',
        [
          'git() { return 127; }',
          'emit() { printf "%s\\0" "${PATHSPECS[@]}"; }',
          "trap 'emit || exit 3; exit 0' EXIT",
          'source "$1" state-flip-pathspec-probe >/dev/null 2>&1',
        ].join('\n'),
        'bash',
        SCANNER_PATH,
      ],
      { encoding: 'utf8' }
    )
  } catch (err) {
    const { stderr } = err as { stderr?: string }
    throw new Error(`could not read PATHSPECS from ${SCANNER_PATH}: ${stderr ?? String(err)}`)
  }
  const specs = raw.split('\0').filter((s) => s.length > 0)
  if (specs.length === 0) {
    throw new Error(`${SCANNER_PATH} expanded PATHSPECS to nothing`)
  }
  pathspecCache = specs
  return specs
}

/**
 * Fills an expected report's pathspec text from the one runtime PATHSPECS reader:
 * `__RUNTIME_PATHSPECS__` becomes the whole space-joined scope line, `{{spec0}}` the
 * first entry, and `{{spec:<glob>}}` whichever entry bears that glob.
 *
 * Spelling the entries out literally instead would pin one spelling of the magic
 * prefix, so rewriting the array to an equivalent spelling -- `:/` for `:(top)` --
 * would red every stored document while the scan behaved identically.
 */
function withRuntimeScope(doc: string): string {
  const specs = scannerPathspecs()
  let out = doc.split(RUNTIME_SCOPE).join(specs.join(' ')).split('{{spec0}}').join(specs[0])
  for (const spec of specs) out = out.split(`{{spec:${bareSpec(spec)}}}`).join(spec)
  if (out.includes('{{spec')) {
    throw new Error(`expected report references a pathspec the scanner no longer has: ${out}`)
  }
  return out
}

/** A pathspec with its leading magic removed -- long `:(…)` or short `:/` -- leaving the glob. */
function bareSpec(spec: string): string {
  return spec.replace(/^:\([^)]*\)/, '').replace(/^:\//, '')
}

/**
 * The scanner's header comment block: the contiguous `#` run from the top of the
 * file, less the shebang and the shellcheck directive, ending at the first line
 * that is not a comment. Both boundaries are derived, so no line number appears.
 */
function scannerHeaderBlock(): string[] {
  const block: string[] = []
  for (const line of readFileSync(SCANNER_PATH, 'utf8').split('\n')) {
    if (!line.startsWith('#')) break
    if (/^#!/.test(line) || /^# shellcheck/.test(line)) continue
    block.push(line)
  }
  return block
}

/**
 * The header block as one prose string. Header sentences wrap across comment
 * lines, so a phrase has to be matched against the unwrapped prose or it matches
 * nothing through no fault of the text.
 */
function scannerHeaderProse(): string {
  return scannerHeaderBlock()
    .map((line) => line.replace(/^#\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
}

/**
 * A reference to the scanner's two-pass structure. Deliberately not a bare
 * `pass`: the header uses that word for the vacuous-success case too ("not a
 * clean pass"), which is a different sense and not a claim about the passes.
 */
const PASS_REFERENCE =
  /\b(?:two passes|both passes|the passes|between the passes|pass to pass|each pass|either pass|first pass|second pass|one pass|other pass)\b/gi

/**
 * The text surrounding a two-pass reference, when `probe` matches near one.
 *
 * Proximity rather than sentence-splitting: the header's prose contains `e.g.`
 * and `--` clauses, so any sentence boundary rule fragments it somewhere useful
 * to an evader. Proximity has no such seam to aim at.
 */
function nearPassReference(text: string, probe: RegExp): string | undefined {
  for (const match of text.matchAll(PASS_REFERENCE)) {
    const at = match.index ?? 0
    const slice = text.slice(Math.max(0, at - 120), at + match[0].length + 120)
    if (probe.test(slice)) return slice.replace(/\s+/g, ' ')
  }
  return undefined
}

/**
 * `exit 2` as a STATEMENT rather than as prose: a statement boundary before it
 * and a statement end after. This counts the two shapes a bare-line match misses
 * and that both have live precedent in this repo's own scripts -- a trailing
 * comment (`exit 2 # why`) and an `&&`/`||`-guarded exit -- while an `exit 2`
 * inside a quoted string has no boundary before it and is not counted.
 */
const EXIT_TWO_STATEMENT = /(?:^|[;&|{]|\bthen\b|\belse\b|\bdo\b)\s*exit\s+2\s*(?:$|[;&|#)}])/

/**
 * Every `exit 2` site with the emitting statement that site itself reaches,
 * found by walking back from the site to its nearest `echo`/`printf` and halting
 * at a block boundary, so a neighbouring block's message is never attributed
 * here. Comment lines are skipped, so a stale wording left behind as a comment
 * cannot stand in for the message the site actually prints.
 */
function exitTwoSites(src: string): { line: number; statement: string; emit?: string }[] {
  const lines = src.split('\n')
  const sites: { line: number; statement: string; emit?: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i]) || !EXIT_TWO_STATEMENT.test(lines[i])) continue
    let emit: string | undefined
    const collected: string[] = []
    for (let j = i; j >= 0 && i - j <= 12; j--) {
      const line = lines[j]
      const boundary =
        /^\s*$/.test(line) ||
        /^\s*(fi|done|esac|\})\s*$/.test(line) ||
        EXIT_TWO_STATEMENT.test(line)
      if (j !== i && boundary) break
      if (/^\s*#/.test(line)) continue
      collected.unshift(line)
      if (/\b(echo|printf)\b/.test(line)) {
        emit = collected.join(' ')
        break
      }
    }
    sites.push({ line: i + 1, statement: lines[i].trim(), emit })
  }
  return sites
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
Scanned paths: \`__RUNTIME_PATHSPECS__\`

> **Scope warning.** These pathspecs hold blobs that are not text -- git-crypt ciphertext in \`--ref\` mode, or genuine binaries: \`{{spec:supabase/functions/**}} (1 of 1)\`. Their bytes ARE searched (this scan passes \`-a\`) and so they DO contribute to the counts below, but any hit in them is a byte coincidence rather than a source reference, and a miss is not evidence about whatever the bytes encode. Treat the counts as unreliable over these paths in both directions. For git-crypt paths, re-run WITHOUT \`--ref\` to search their decrypted working-tree contents.
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
Scanned paths: \`__RUNTIME_PATHSPECS__\`

> **Scope warning.** These pathspecs hold blobs that are not text -- git-crypt ciphertext in \`--ref\` mode, or genuine binaries: \`{{spec:supabase/functions/**}} (1 of 1)\`. Their bytes ARE searched (this scan passes \`-a\`) and so they DO contribute to the counts below, but any hit in them is a byte coincidence rather than a source reference, and a miss is not evidence about whatever the bytes encode. Treat the counts as unreliable over these paths in both directions. For git-crypt paths, re-run WITHOUT \`--ref\` to search their decrypted working-tree contents.
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
Scanned paths: \`__RUNTIME_PATHSPECS__\`

> **Scope warning.** These pathspecs hold blobs that are not text -- git-crypt ciphertext in \`--ref\` mode, or genuine binaries: \`{{spec:packages/*/src/**}} (1 of 1) {{spec:supabase/functions/**}} (1 of 1)\`. Their bytes ARE searched (this scan passes \`-a\`) and so they DO contribute to the counts below, but any hit in them is a byte coincidence rather than a source reference, and a miss is not evidence about whatever the bytes encode. Treat the counts as unreliable over these paths in both directions. For git-crypt paths, re-run WITHOUT \`--ref\` to search their decrypted working-tree contents.
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
Scanned paths: \`__RUNTIME_PATHSPECS__\`

> **Scope warning.** These pathspecs hold blobs that are not text -- git-crypt ciphertext in \`--ref\` mode, or genuine binaries: \`{{spec:packages/*/src/**}} (1 of 1) {{spec:supabase/functions/**}} (1 of 1)\`. Their bytes ARE searched (this scan passes \`-a\`) and so they DO contribute to the counts below, but any hit in them is a byte coincidence rather than a source reference, and a miss is not evidence about whatever the bytes encode. Treat the counts as unreliable over these paths in both directions. For git-crypt paths, re-run WITHOUT \`--ref\` to search their decrypted working-tree contents.
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
Scanned paths: \`__RUNTIME_PATHSPECS__\`

> **Scope warning.** These pathspecs hold blobs that are not text -- git-crypt ciphertext in \`--ref\` mode, or genuine binaries: \`{{spec0}} (1 of 1)\`. Their bytes ARE searched (this scan passes \`-a\`) and so they DO contribute to the counts below, but any hit in them is a byte coincidence rather than a source reference, and a miss is not evidence about whatever the bytes encode. Treat the counts as unreliable over these paths in both directions. For git-crypt paths, re-run WITHOUT \`--ref\` to search their decrypted working-tree contents.
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
Scanned paths: \`__RUNTIME_PATHSPECS__\`

> **Scope warning.** These pathspecs hold blobs that are not text -- git-crypt ciphertext in \`--ref\` mode, or genuine binaries: \`{{spec0}} (1 of 1)\`. Their bytes ARE searched (this scan passes \`-a\`) and so they DO contribute to the counts below, but any hit in them is a byte coincidence rather than a source reference, and a miss is not evidence about whatever the bytes encode. Treat the counts as unreliable over these paths in both directions. For git-crypt paths, re-run WITHOUT \`--ref\` to search their decrypted working-tree contents.
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
      // The unreadable blob is deliberately NOUN-FREE, which makes the only
      // identity-dependent text in the whole report the pathspec name in the warning.
      // So each cell's expected document is the base document with the name and extent
      // substituted -- a rule, not a stored document per cell.
      const specs = scannerPathspecs()
      const REF_SPEC = specs[0]
      const GITCRYPT_MAGIC = Buffer.from([
        0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00,
      ])
      // A pathspec's leading `:(magic)` is git syntax, not part of the path, so it has
      // to come off before the remainder names a file the fixture can create -- left on,
      // the blob lands somewhere the pathspec cannot match and no warning is emitted.
      const materialise = (spec: string): string =>
        bareSpec(spec)
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
        const extent = bareSpec(spec) === 'scripts/*.sh' ? '(1 of 2)' : '(1 of 1)'
        const subst = (base: string): string =>
          withRuntimeScope(base).split(`${REF_SPEC} (1 of 1)`).join(`${spec} ${extent}`)

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
        expect(out, cell.label).toBe(withRuntimeScope(cell.expected))
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
    'the report states the paths it searched, as the whole runtime PATHSPECS array',
    () => {
      // The report's scope line is the array joined on a space, so the printed line
      // and the live array are two channels over one value and each can be checked
      // against the other. Whole-line equality, not containment: a line naming a
      // subset of the array still contains every name it does print.
      const { repoDir } = setupSyntheticStateFlipRepo()
      const out = execFileSync('bash', [SCANNER_PATH, 'widget-tool', '--ref', 'HEAD'], {
        cwd: repoDir,
        encoding: 'utf8',
      })
      const line = out.match(/^Scanned paths: `(.*)`$/m)
      expect(line, 'report states no Scanned paths line').toBeTruthy()
      expect(line![1], 'report scope drifted from the runtime PATHSPECS').toBe(
        scannerPathspecs().join(' ')
      )
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'every PATHSPECS entry is one top-anchored token, so the scan cannot narrow by cwd',
    () => {
      // Top-anchoring resolves a pathspec against the repository root. An entry
      // without it is resolved against the invoking cwd instead, so a scan from a
      // subdirectory silently covers less while still exiting 0 on a non-zero
      // denominator. Whitespace inside an entry narrows the same way -- git reads it
      // as one path that matches nothing, and the report's space-joined scope line
      // renders it indistinguishable from two anchored entries.
      //
      // Git spells top-anchoring two ways and both are accepted here: the long form
      // `:(top)`, where `top` is one word of a comma-separated magic list, and the
      // short form `:/`. The long form is parsed as a word list rather than matched
      // as a literal so that `:(topology)`, which anchors nothing, is not mistaken
      // for it.
      for (const spec of scannerPathspecs()) {
        const short = spec.match(/^:\/(\S+)$/)
        if (short) continue
        const magic = spec.match(/^:\(([^)]*)\)(\S+)$/)
        expect(
          magic,
          `PATHSPECS entry is neither a :/ nor a :(magic) prefixed single token: ${spec}`
        ).toBeTruthy()
        expect(magic![1].split(','), `PATHSPECS entry is not top-anchored: ${spec}`).toContain(
          'top'
        )
      }
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'the whole report, rendered hit paths included, is identical from the root and a subdirectory',
    () => {
      // Two independent mechanisms have to hold, and they fail differently. `top`
      // anchors WHICH paths are searched: without it a subdirectory scan covers a
      // subtree of the paths it names, so the denominator shrinks or collapses to the
      // vacuous-success exit 1. `--full-name` fixes HOW they are rendered: without it
      // the denominator is identical from both cwds while every path in STEP 2 and in
      // the matrix scaffold is written relative to the invoking cwd -- so a scaffold
      // pasted into a PR carries `../../` references that resolve nowhere for the
      // reviewer reading it.
      //
      // Comparing whole stdout covers both. Comparing counts and exit status covers
      // only the first, which is why this asserts the report rather than a summary of
      // it, and why the carriers below straddle the subdirectory: one file above it,
      // one inside it, so a cwd-relative rendering has to show up as `../../` on one
      // and a bare relative path on the other.
      const repoDir = makeFixtureTempDir('state-flip-cwd-fixture')
      createdRepoDirs.push(repoDir)
      git(repoDir, ['init', '-q', '-b', 'main'])
      for (const [rel, body] of [
        ['scripts/fixture.sh', 'widget-tool is not installed by design\n'],
        ['packages/core/src/thing.ts', 'widget-tool absent here\n'],
      ] as [string, string][]) {
        mkdirSync(join(repoDir, dirname(rel)), { recursive: true })
        writeFileSync(join(repoDir, rel), body)
      }
      // A real non-text blob, so the UNREADABLE_SPECS loop -- the scanner's second
      // PATHSPECS consumer, which the STEP counts alone would not exercise -- has
      // something to warn about in both modes.
      mkdirSync(join(repoDir, 'supabase', 'functions'), { recursive: true })
      writeFileSync(
        join(repoDir, 'supabase', 'functions', 'opaque.bin'),
        Buffer.concat([Buffer.from([0x00]), Buffer.from('GITCRYPT nothing relevant\n')])
      )
      git(repoDir, ['add', '-A'])
      git(repoDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])

      // stderr is compared alongside stdout: a diagnostic that named the invoking cwd
      // would otherwise drift freely, since none of the counts or the report carry it.
      const observe = (cwd: string, args: string[]) => {
        const run = spawnSync('bash', [SCANNER_PATH, ...args], { cwd, encoding: 'utf8' })
        if (run.error) throw run.error
        return { status: run.status, stdout: run.stdout, stderr: run.stderr }
      }

      for (const args of [['widget-tool'], ['widget-tool', '--ref', 'HEAD']]) {
        const label = args.join(' ')
        const root = observe(repoDir, args)
        // Non-vacuity, pinned before the comparison so two identically-failing runs
        // cannot satisfy it, and so that the report being compared actually contains
        // the path-bearing surfaces this test exists to check.
        expect(root.status, `root exit status for ${label}`).toBe(0)
        expect(
          Number(root.stdout.match(/^STEP 1 \(denominator\): (\d+)$/m)?.[1]),
          `root denominator for ${label}`
        ).toBeGreaterThan(0)
        expect(root.stdout, `root scope warning for ${label}`).toContain('are not text')
        for (const carrier of ['packages/core/src/thing.ts', 'scripts/fixture.sh']) {
          expect(root.stdout, `root scaffold omits ${carrier} for ${label}`).toContain(
            `| \`${carrier}:1\` |`
          )
        }

        const sub = observe(join(repoDir, 'packages', 'core'), args)
        // Each of the three below catches a class the others cannot, so all three
        // stay. The upward-path check is first because it names the mechanism where
        // the equality would report only an opaque whole-document mismatch.
        for (const [where, out] of [
          ['root', root.stdout],
          ['subdirectory', sub.stdout],
        ] as [string, string][]) {
          expect(out, `${where} report renders an upward path for ${label}`).not.toContain('../')
        }
        expect(sub.status, `exit status drifted by cwd for ${label}`).toBe(root.status)
        expect(sub.stderr, `stderr drifted by cwd for ${label}`).toBe(root.stderr)
        expect(sub.stdout, `report drifted by cwd for ${label}`).toBe(root.stdout)
      }
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'the header documents exit 2 as distinct causes, not just "usage error"',
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
    '--help emits exactly the source header block, no line dropped and none added',
    () => {
      // Two surfaces carry the same header: the assertions above read it from the
      // SOURCE, and `--help` prints it at RUNTIME. They can drift in both directions
      // and each direction is silent on its own -- a printer bounded below the header
      // drops trailing lines, and one with no upper bound spills the file's body
      // comments into the help text.
      //
      // So this is equality of the whole block, not containment of any one line:
      // containment is satisfied by a printer that emits the body comments too, and
      // is satisfied by a single surviving line when the rest are dropped. Both
      // boundaries are derived rather than counted, in the shared helper.
      const block = scannerHeaderBlock()
      expect(
        block.length,
        'no header comment block found at the top of the scanner'
      ).toBeGreaterThan(0)

      const help = execFileSync('bash', [SCANNER_PATH, '--help'], { encoding: 'utf8' })
      const emitted = help.split('\n')
      // A trailing newline on the last line is printf's, not a line of its own.
      if (emitted[emitted.length - 1] === '') emitted.pop()
      expect(emitted, '--help output is not exactly the source header block').toEqual(block)
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'the header and the invariant guard name the same cause, on a single-assignment PATHSPECS',
    () => {
      // The header's exit-2 clause and the guard's own runtime stderr are two
      // descriptions of ONE mechanism, and nothing coupled them, so they drifted:
      // both came to assert the two passes had searched different scopes. That cause
      // is impossible while PATHSPECS is assigned once and never appended to, which
      // is why the premise is asserted here as well -- an appended pathspec would
      // make it reachable and both texts would then need revisiting.
      const src = readFileSync(SCANNER_PATH, 'utf8')
      expect(
        (src.match(/^\s*PATHSPECS=\(/gm) ?? []).length,
        'PATHSPECS is not assigned exactly once'
      ).toBe(1)
      expect(
        (src.match(/PATHSPECS\+=/g) ?? []).length,
        'PATHSPECS is appended to, so a scope change between the passes is reachable'
      ).toBe(0)

      const guardStart = src.indexOf('if ((STEP2_COUNT > STEP1_COUNT)); then')
      expect(guardStart, 'invariant guard not found by its own condition').toBeGreaterThan(-1)
      const guard = src.slice(guardStart, src.indexOf('exit 2', guardStart))
      expect(guard, 'invariant guard emits no stderr before exiting').toContain('>&2')

      // Both halves are matched as CONCEPTS, not phrasings. A phrase match fails in
      // both directions: it reds on a legitimate rewording, and it is evaded by a
      // near-miss. Both happened -- the guard's own wording was rewritten from
      // "content may have changed" to "a write landing between the passes", and one
      // inserted word ("different path scopes") slipped past a literal ban.
      //
      // Positive: something that mutates the searched content is named near a
      // reference to the passes. Negative: scope, paths and PATHSPECS are not,
      // because a single-assignment PATHSPECS makes a scope difference impossible and
      // there is no honest reason to name scope in the same breath as the passes.
      // Naming no difference verb is what makes the negative paraphrase-proof.
      for (const [surface, text] of [
        ['header', scannerHeaderProse()],
        ['guard stderr', guard],
      ] as [string, string][]) {
        expect(
          nearPassReference(
            text,
            /\b(?:chang\w*|writ\w*|wrote|edit\w*|modif\w*|content|land\w*)\b/
          ),
          `${surface} names no mutation of the searched content near the passes`
        ).toBeTruthy()
        expect(
          nearPassReference(text, /\b(?:scopes?|paths?|pathspecs?|PATHSPECS)\b/),
          `${surface} couples scope to the passes, which a single-assignment PATHSPECS rules out`
        ).toBeUndefined()
      }
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'the STEP 2 > STEP 1 guard exits 2, names the reachable cause, and suppresses STEP 2',
    () => {
      // Reached through a PATH `git` shim, not a modified scanner: the shim runs the
      // real git, then plants extra matching lines, so the STEP 2 pass sees strictly
      // more than the STEP 1 pass did. That is the one reachable cause the two texts
      // above name, and it exercises the shipped script unmodified.
      const repoDir = makeFixtureTempDir('state-flip-invariant-fixture')
      createdRepoDirs.push(repoDir)
      git(repoDir, ['init', '-q', '-b', 'main'])
      mkdirSync(join(repoDir, 'scripts'), { recursive: true })
      // Noun only, no absence-vocabulary: STEP 1 sees one line, STEP 2 sees none.
      writeFileSync(join(repoDir, 'scripts', 'fixture.sh'), 'widget-tool here\n')
      git(repoDir, ['add', '-A'])
      git(repoDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])

      const shimDir = makeFixtureTempDir('state-flip-git-shim')
      createdRepoDirs.push(shimDir)
      const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
      expect(realGit, 'no real git on PATH to delegate to').toBeTruthy()
      const marker = join(shimDir, 'fired')
      const planted = join(repoDir, 'scripts', 'planted.sh')
      writeFileSync(
        join(shimDir, 'git'),
        [
          '#!/bin/sh',
          `if [ ! -e ${JSON.stringify(marker)} ]; then`,
          `  : > ${JSON.stringify(marker)}`,
          `  ${JSON.stringify(realGit)} "$@"; rc=$?`,
          // Three lines carrying noun AND absence-vocabulary, so STEP 2 > STEP 1.
          `  printf 'widget-tool is not installed by design\\n%.0s' 1 2 3 > ${JSON.stringify(planted)}`,
          '  exit $rc',
          'fi',
          `exec ${JSON.stringify(realGit)} "$@"`,
          '',
        ].join('\n'),
        { mode: 0o755 }
      )

      const run = spawnSync('bash', [SCANNER_PATH, 'widget-tool'], {
        cwd: repoDir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` },
      })
      if (run.error) throw run.error

      expect(run.status, 'the invariant guard did not exit 2').toBe(2)
      // Concept, not phrasing, for the same reason as the source-level check above:
      // this ran against the shipped wording and a phrase match reds when that
      // wording is legitimately rewritten.
      expect(
        nearPassReference(
          run.stderr,
          /\b(?:chang\w*|writ\w*|wrote|edit\w*|modif\w*|content|land\w*)\b/
        ),
        'guard stderr names no mutation of the searched content near the passes'
      ).toBeTruthy()
      // Non-vacuity: the run reached STEP 1 rather than refusing earlier.
      expect(run.stdout, 'the run never reached a STEP 1 denominator').toContain(
        'STEP 1 (denominator):'
      )
      // The guard suppresses STEP 2, which is what keeps the header's "all measured
      // against the same denominator" true on every exit-0 path.
      expect(run.stdout, 'a STEP 2 section was emitted despite the broken invariant').not.toContain(
        '### STEP 2'
      )
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'the header enumerates a cause for every exit 2 site the script has',
    () => {
      // A cause added to the code and not to the header is invisible, because the
      // header is what a reader consults on seeing exit 2. The site count is read
      // from the file rather than written down, so a new site fails the coverage
      // check instead of landing unnoticed; each row then has to match BOTH surfaces,
      // so a reworded stderr and a dropped header cause each fail on their own.
      const sites = exitTwoSites(readFileSync(SCANNER_PATH, 'utf8'))
      const prose = scannerHeaderProse()

      // One row per exit-2 site: the signature that site's OWN emitting statement
      // carries, and the header text that has to account for it.
      const causes: [RegExp, RegExp][] = [
        [/--ref requires a value/, /--ref without a value/],
        [/unexpected extra arg/, /extra arg/],
        [/usage: \$0 <noun>/, /missing noun/],
        [/newline or carriage return/, /newline or carriage return/],
        [/begins with '-'/, /beginning with '-'/],
        [/git grep exited %d searching/, /git grep itself failing/],
        [/git grep exited %d narrowing/, /git grep itself failing/],
        [/STEP 2 narrows STEP 1 and cannot exceed it/, /STEP 2 exceeding STEP 1/],
      ]

      expect(
        causes.length,
        `the script has ${sites.length} exit-2 site(s) and this table accounts for ${causes.length}`
      ).toBe(sites.length)

      // Matched per SITE, not against the whole file. Searching the whole source
      // only establishes that a string exists somewhere in it -- satisfied by a
      // stale wording left behind as a comment while the site prints something the
      // table never mentions.
      for (const site of sites) {
        expect(site.emit, `the exit-2 site at line ${site.line} emits nothing`).toBeTruthy()
        const matched = causes.filter(([signature]) => signature.test(site.emit as string))
        expect(
          matched.length,
          `the exit-2 site at line ${site.line} matches ${matched.length} table row(s): ${site.emit}`
        ).toBe(1)
      }
      // And the other direction, so an obsolete row cannot linger unmatched.
      for (const [signature, headerCause] of causes) {
        expect(
          sites.filter((site) => site.emit && signature.test(site.emit)).length,
          `no exit-2 site's own message matches ${signature}`
        ).toBeGreaterThan(0)
        expect(prose, `the header does not account for the site emitting ${signature}`).toMatch(
          headerCause
        )
      }
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
 * The UNSCOPED "vocabulary-only, no noun" baseline the noun-scope-first
 * collapse is measured against. The vocabulary is deliberately narrower than
 * the scanner's own ABSENCE_VOCAB, which additionally ORs in noun-dependent
 * terms that mean nothing unscoped -- but the SCOPE must be the scanner's own
 * current PATHSPECS, passed in by the caller. A numerator counted over a
 * narrower path set than the STEP 2 denominator it divides understates the
 * ratio, so the gate consumes real headroom without ever saying so.
 */
function countUnscopedAbsenceVocab(ref: string, pathspecs: string[]): number {
  const vocab =
    "not installed|not present|not available|not on path|absent|does not exist|unavailable|by design|isn't|is NOT"
  try {
    const out = execFileSync('git', ['grep', '-niE', vocab, ref, '--', ...pathspecs], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
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
    // The gate is the invariant, not the integers: the command reproduces, and
    // narrowing by noun before narrowing by vocabulary still collapses the
    // candidate set by >=50x. The integers drift whenever the scanner's
    // vocabulary or pathspecs are tuned, so pinning them would fail on the first
    // legitimate improvement.
    //
    // The ratio is the UNSCOPED vocabulary-only count over STEP 2, both taken
    // over the same pathspecs. STEP 1 / STEP 2 is a different quantity and does
    // not clear 50x against this ref in either direction.
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

      // `step2` is the DENOMINATOR of the collapse ratio below, so that ratio RISES
      // when the scanner's mandated output shrinks: a regression losing real
      // casualties makes the gate pass more comfortably, not less. It therefore
      // cannot be the only constraint on `step2`. The two below bound it directly,
      // and they bind in different regimes rather than as a stricter/looser pair --
      // the ceiling when STEP 2 alone shrinks, the floor when STEP 1 shrinks with it
      // and the ceiling consequently stays satisfied. The ceiling is checked first
      // because it is the arm that answers the question this block exists for.
      //
      // The ref is a frozen SHA, so both are constants against an immutable subject
      // rather than numbers that rot as the tree changes.
      //
      // Ceiling: three independent measurements of STEP 1 / STEP 2 against this same
      // ref cluster near 20 -- the plan's two, pre- and post-fix, plus the live value
      // under the widened pathspec set. 40 is roughly double the highest of them, so
      // a modest vocabulary or scope change passes and a collapse does not.
      //
      // Floor: the current pathspec set is a strict superset of the narrower one the
      // plan measured this ref under (a plain `*` matches `/`, so `scripts/*.ts`
      // covers everything `scripts/**/*.ts` did), and the plan recorded 29 there. 20
      // sits below that with room for a vocabulary tightening that legitimately
      // reduces false positives.
      expect(
        step1 / step2,
        `STEP 1 ${step1} / STEP 2 ${step2} = ${(step1 / step2).toFixed(1)}x: the mandated ` +
          `output is too small a fraction of the denominator for frozen ref '${HISTORICAL_REF}'`
      ).toBeLessThanOrEqual(40)
      expect(
        step2,
        `STEP 2 for frozen ref '${HISTORICAL_REF}' fell below its floor`
      ).toBeGreaterThanOrEqual(20)

      const unscopedCount = countUnscopedAbsenceVocab(HISTORICAL_REF, scannerPathspecs())
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
