/**
 * Guards for publish.yml's npx-wrapper smoke tail (SMI-6512 mktemp + sleep;
 * re-anchored and extended by SMI-6497).
 *
 * WHERE THE TAIL LIVES NOW. SMI-6497 split the old
 * "Verify skillsmith-cli on npm + smoke the wrapper" step into two steps and
 * deleted the `# audit:verify-block-smoke-tail` marker, because a step boundary
 * now does the marker's job. The tail is therefore no longer a sub-span of
 * anything: it is the ENTIRE `run:` body of
 * (publish-skillsmith-cli, Smoke the npx wrapper). It is resolved by
 * (jobId, stepName) with an exactly-one-matching-step assertion -- never by
 * marker split, never by line offset. scripts/lib/verify-block-identity.mjs is
 * retired in the same wave; nothing here may import it.
 *
 * WHAT THIS FILE REPLACES. The retired module pinned the tail by digest. A
 * digest detects any byte moving; these assertions detect only what they name.
 * That is a deliberate trade, not an equivalence. Each retired value maps to a
 * live assertion:
 *   retry count      -> K2's sleep call count
 *   sleep interval   -> K2's recorded sleep ARGUMENT (not merely its count)
 *   /tmp handling    -> K1's stdout round-trip + K2's post-warning `cat`
 *   warning path     -> K2 and K3
 *   terminal exit 0  -> K2
 * It also re-homes the retired VB-UNSAFE-WHITESPACE arm (backslash + heredoc)
 * and adds scalar-style, ASCII, registry-probe and explicit-termination arms.
 *
 * OWNERSHIP. K1 is SMI-6497's own case. K2 is SMI-6512's, extended here with
 * the sleep ARGUMENT, the attempt lines and the post-warning `cat`. K3, K4 and
 * K5 are SMI-6512's assertions: SMI-6497 does not restate them and must not
 * re-pin the plan's pre-fix M-9 values (which record exit 1 for K3 and K4 and
 * are historical) -- it only keeps them passing through the re-anchor.
 *
 * SHELL SEMANTICS. The workflow declares no `shell:` and no `defaults:`, so
 * GitHub Actions' default applies: `bash -e` -- errexit ON, pipefail OFF,
 * nounset OFF. The harness invokes `bash -e` only. Do NOT add `-u` or
 * pipefail: production does not, and proving a guard under stricter semantics
 * than production proves nothing about production.
 *
 * STUBS. `jq`, `npx`, `sleep` and (where relevant) `mktemp` are shadowed by
 * fakes first on PATH. `jq` MUST be stubbed because the relocated step body now
 * begins with `VERSION=$(jq -r .version ...)` -- that line was outside the old
 * marker-split tail and is inside the step now.
 *
 * MEASURED, NOT PREDICTED. Every K expectation was measured against the
 * workflow as it stands. The heredoc table's verdicts were established by
 * running each line through `bash -n` under GNU bash 5.2.15(1)-release on
 * linux/aarch64 (the container), the same major version family as the
 * ubuntu-latest runner -- NOT the macOS host's bash 3.2. A `bash -n` warning
 * of the form "here-document at line N delimited by end-of-file" is the
 * ground-truth signal; exit STATUS is not, because an unrelated construct
 * (`for ...; do` with no `done`) also exits 2.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  cleanupScratchDirs,
  findHeredocOpener,
  harness,
  HELPER_PATH,
  JOB_ID,
  makeScratchDir,
  nonAsciiHits,
  parseDocument,
  REAL_TAIL,
  resolveSingleStepRun,
  revertMktempGuard,
  revertSleepGuard,
  runTail,
  RUN_BODIES,
  SELF_PATH,
  smokeScalarType,
  STEP_NAME,
  stripWholeLineComments,
  terminationViolations,
  UNSAFE_BACKSLASH_RE,
  WORKFLOW_TEXT,
  writeFakeBin,
} from './publish-smoke-tail-guards.helpers'

afterEach(cleanupScratchDirs)

// ---------------------------------------------------------------------------
// The allow-list for the whitespace arm
// ---------------------------------------------------------------------------

type AllowEntry = { jobId: string; stepName: string; lineDigest: string }
type Finding = { code: string; jobId: string; stepName: string; detail: string }

/**
 * Keyed by (jobId, stepName, digest of the exact line): the digest so editing a
 * line invalidates its exemption instead of carrying it forward silently; the
 * job and step so an exemption cannot be reused on a different surface.
 *
 * NO line-scoped suppression marker exists and none may be built. This guard's
 * whole job is to decide whether a line opens a heredoc, so a marker that
 * overrules it line-locally makes a suppressed true positive indistinguishable
 * from a suppressed false one. The repo's `# audit:carveout-pure-js` markers
 * are not a precedent: those annotate a structural fact a reviewer can verify
 * independently of the check.
 *
 * MEASURED EMPTY: across all 68 reachable `run:` bodies of publish.yml (501
 * lines) the rebuilt heredoc predicate fires on zero lines and the backslash
 * predicate on zero lines. The equality assertion below pins that zero.
 */
const HEREDOC_ALLOWLIST: AllowEntry[] = []

function digestOf(line: string): string {
  return crypto.createHash('sha256').update(line, 'utf8').digest('hex').slice(0, 16)
}

function isAllowed(list: AllowEntry[], jobId: string, stepName: string, line: string): boolean {
  const d = digestOf(line)
  return list.some((e) => e.jobId === jobId && e.stepName === stepName && e.lineDigest === d)
}

/** VB-UNSAFE-WHITESPACE over every reachable `run:` body, on RAW text. */
function whitespaceFindings(
  bodies: Array<{ jobId: string; stepName: string; run: string }>,
  allowList: AllowEntry[] = HEREDOC_ALLOWLIST
): Finding[] {
  const out: Finding[] = []
  for (const { jobId, stepName, run } of bodies) {
    run.split('\n').forEach((line, idx) => {
      if (isAllowed(allowList, jobId, stepName, line)) return
      if (UNSAFE_BACKSLASH_RE.test(line)) {
        out.push({
          code: 'VB-UNSAFE-WHITESPACE',
          jobId,
          stepName,
          detail:
            `line ${idx + 1} ends in a backslash followed by whitespace, which does NOT ` +
            `continue the line: ${JSON.stringify(line)}`,
        })
      }
      const hd = findHeredocOpener(line)
      if (hd) {
        out.push({
          code: 'VB-UNSAFE-WHITESPACE',
          jobId,
          stepName,
          detail:
            `line ${idx + 1} opens a heredoc (delimiter ${JSON.stringify(hd.delimiter)}, ` +
            `written as ${JSON.stringify(hd.raw)}), whose ` +
            `payload indentation and blank lines are significant: ${JSON.stringify(line)}. If ` +
            `this is a false positive, add {jobId: ${JSON.stringify(jobId)}, stepName: ` +
            `${JSON.stringify(stepName)}, lineDigest: ${JSON.stringify(digestOf(line))}} to ` +
            `HEREDOC_ALLOWLIST in ${SELF_PATH} and update its equality assertion.`,
        })
      }
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Case tables -- literal inputs, so two implementers cannot execute different
// tables and both believe they ran "the" table.
// ---------------------------------------------------------------------------

/**
 * [id, line, opensHeredoc, expectedDelimiter].
 *
 * Every verdict AND every expected delimiter was established by running the
 * line through `bash -n` under bash 5.2.15 and reading its own
 * "here-document at line 1 delimited by end-of-file (wanted 'D')" warning --
 * bash names the delimiter it resolved, so the fourth column is ground truth
 * rather than a second opinion. Asserting it is what makes the delimiter-word
 * piece kinds killable: without it, dropping any single piece kind leaves the
 * boolean verdict unchanged (measured: mutations MH6/MH7/MH8 all survived a
 * boolean-only table).
 */
const HEREDOC_CASES: Array<[string, string, boolean, string]> = [
  ['R01', 'cat <<EOF', true, 'EOF'],
  ['R02', 'cat <<-EOF', true, 'EOF'],
  ['R03', "cat <<'EOF'", true, 'EOF'],
  ['R04', 'cat <<"EOF"', true, 'EOF'],
  ['R05', 'cat << EOF', true, 'EOF'],
  ['R06', 'cat <<\\EOF', true, 'EOF'],
  ['R07', "cat <<$'EOF'", true, 'EOF'],
  ['R08', "cat <<-'EOF'", true, 'EOF'],
  ['R09', 'cat <<-"EOF"', true, 'EOF'],
  ['R10', 'cat <<-\\EOF', true, 'EOF'],
  ['R11', "cat <<-$'EOF'", true, 'EOF'],
  ['R12', 'cat 0<<EOF', true, 'EOF'],
  ['R13', 'exec 3<<EOF', true, 'EOF'],
  ['R14', "cat <<E'O'F", true, 'EOF'],
  ['R15', 'cat <<"E"O\'F\'', true, 'EOF'],
  ['R16', 'cat <<E\\OF', true, 'EOF'],
  ['R17', 'cat <<-\'E\'"O"F', true, 'EOF'],
  ['R18', 'cat <<EOF | grep x', true, 'EOF'],
  ['R19', 'x=$((1<<2)); cat <<EOF', true, 'EOF'],
  ['R20', 'cat <<$\'E\'"O"F', true, 'EOF'],
  ['R21', 'echo ${PATH#x} <<EOF', true, 'EOF'],
  ['R22', "cat <<'EOF' # trailing comment", true, 'EOF'],
  ['R23', 'cat <<"EOF"; echo \'done\'', true, 'EOF'],
  ['R24', 'cat <<EOF;', true, 'EOF'],
  ['R25', "echo 'it\"s' <<EOF", true, 'EOF'],
  ['R26', 'cat <<-\t EOF', true, 'EOF'],
  ['A01', 'echo $((1<<2))', false, ''],
  ['A02', 'echo $(( 1 << 2 ))', false, ''],
  ['A03', '(( x = 1 << 2 ))', false, ''],
  ['A04', '(( x <<= 2 ))', false, ''],
  ['A05', 'cat <<<word', false, ''],
  ['A06', 'cat <<< word', false, ''],
  ['A07', "echo 'a <<EOF b'", false, ''],
  ['A08', 'echo "a <<EOF b"', false, ''],
  ['A09', 'echo hi # cat <<EOF', false, ''],
  ['A10', '# cat <<EOF', false, ''],
  ['A11', 'echo "${PATH#*:}"', false, ''],
  ['A12', 'cat < file', false, ''],
  ['A13', 'for attempt in 1 2 3; do', false, ''],
  ['A14', 'echo $(( 1 << 2 )) # <<EOF', false, ''],
  ['A15', 'if [ "$a" -lt 2 ]; then :; fi', false, ''],
  ['A16', 'echo ${PATH#*:}', false, ''],
  ['A17', 'echo "it\'s fine <<EOF"', false, ''],
  ['A18', "cat <<<'word'", false, ''],
  ['A19', 'cat <<<"$x"', false, ''],
  ['A20', 'for (( i = 0; i < n; i = i << 1 )); do :; done', false, ''],
  ['A21', 'echo "a" <<< "b"', false, ''],
  ['A22', 'printf "%s" foo \\', false, ''],
  ['A23', 'grep -E "a<<b" file', false, ''],
  // Added after the first mutation round: each of these is the ONLY row that
  // kills a clause the original 49 left untouched. See the report in the
  // describe block below for which mutation each one answers.
  ['X01', 'cat <<<<EOF', false, ''],
  ['X02', 'cat <<\\', false, ''],
  ['X03', "cat <<'E F'", true, 'E F'],
  ['X04', 'cat <<\\ EOF', true, ' EOF'],
  // Y-rows exercise the ESCAPE tables inside the quoted pieces. Their expected
  // delimiters could NOT be read off bash's own warning: that message escapes
  // the delimiter it prints, so `wanted 'E\\"F'` is ambiguous between `E"F` and
  // `E\\"F`. They were established by EXECUTION instead -- run the opener with a
  // candidate terminator line and take the ABSENCE of the
  // "delimited by end-of-file" warning as the match. (Do not read stdout for
  // this: an unterminated heredoc makes `cat` echo the rest of the script, so a
  // marker line appears in the output either way.)
  ['Y01', 'cat <<"E\\"F"', true, 'E"F'],
  ['Y02', "cat <<$'E\\tF'", true, 'E\tF'],
  ['Y03', 'cat <<"E\\\\F"', true, 'E\\F'],
]

/**
 * WHAT IS NOT CLAIMED, carried as the failure message of the real-tail
 * assertion below so it reaches whoever the guard stops. This policy
 * constrains EXPLICIT TERMINATION CONSTRUCTS. It does not prove the step
 * always exits zero, and cannot: under `bash -e` any ordinary command in the
 * tail can fail, and it is the K1..K5 behavioural cases -- not this predicate
 * -- that cover the commands actually present.
 */
const TERMINATION_BOUND =
  'VB-TAIL-EXPLICIT-TERMINATION: this prohibits explicit termination constructs ' +
  '(exit/return with a non-zero-literal status, a trap handler that terminates, ' +
  'kill aimed at the current shell). It does NOT prove the step always exits ' +
  'zero -- under bash -e any ordinary command can fail, and the K1-K5 ' +
  'behavioural cases, not this predicate, cover the commands actually present.'

/**
 * Scores the RETIRED predicates get on the tables below. Pinned as measured
 * numbers, not as prose, so "rebuilt, not ported" and "broadened, not copied"
 * are auditable claims rather than assertions about intent.
 */
const SHIPPED_HEREDOC_SCORE = 33
const SHIPPED_TERMINATION_SCORE = 16

/** [id, line, rejected] for the bounded explicit-termination prohibition. */
const TERMINATION_CASES: Array<[string, string, boolean]> = [
  ['T01', 'exit 0', false],
  ['T02', '  exit 0', false],
  ['T03', 'exit 1', true],
  ['T04', 'exit 2', true],
  ['T05', 'exit 137', true],
  ['T06', 'exit "$rc"', true],
  ['T07', 'exit $rc', true],
  ['T08', 'exit $?', true],
  ['T09', 'exit', true],
  ['T10', 'return 1', true],
  ['T11', 'return "$x"', true],
  ['T12', 'return 0', false],
  ['T13', "trap 'cleanup || exit 1' EXIT", true],
  ['T14', "trap 'echo bye' EXIT", false],
  ['T15', 'trap - EXIT', false],
  ['T16', 'echo "exit 1"', false],
  ['T17', "echo 'the step must exit 1 only on a real failure'", false],
  ['T18', 'kill $$', true],
  ['T19', 'kill -9 $$', true],
  ['T20', 'kill 0', true],
  ['T21', 'kill "$child"', false],
  ['T22', 'if [ "$x" = y ]; then exit 1; fi', true],
  ['T23', 'cleanup_smoke || exit 1', true],
  ['T24', 'exit "0"', false],
  [
    'T25',
    '    echo "OK npx skillsmith-cli@${VERSION} --version -> $(tail -1 /tmp/sk-smoke.out)"',
    false,
  ],
  ['T26', 'trap \'trap "exit 2" INT\' EXIT', true],
  ['T27', '# exit 1', false],
  ['T28', 'for attempt in 1 2 3; do', false],
  [
    'T29',
    'if (cd "$SMOKE_DIR" && npx -y "skillsmith-cli@${VERSION}" --version) >/tmp/sk-smoke.out 2>&1; then',
    false,
  ],
  ['T30', 'cat /tmp/sk-smoke.out || true', false],
  // Added after the first mutation round: the ONLY rows that kill the
  // quote-masking clause (mutation MH13). Without masking, the separator
  // inside the string splits the line and the trailing words read as commands.
  ['T31', 'echo "a; exit 1"', false],
  ['T32', 'echo "done || exit 1"', false],
]

/** [id, text, expectedHitCount] -- literal codepoints, both directions. */
const ASCII_CASES: Array<[string, string, number]> = [
  ['N01', 'plain ascii line', 0],
  ['N02', 'tab\tand\nnewline are allowed', 0],
  ['N03', 'em dash \u2014 here', 1],
  ['N04', 'nbsp \u00a0 here', 1],
  ['N05', 'curly quote \u2019 here', 1],
  ['N06', 'NUL \u0000 here', 1],
  ['N07', 'DEL \u007f here', 1],
  ['N08', 'two \u2014 bad \u2019 chars', 2],
]

/** Lines the tables claim come from the real tail. Asserted present, so they cannot rot. */
const REAL_TAIL_LINES = [
  'for attempt in 1 2 3; do',
  '  exit 0',
  '    echo "OK npx skillsmith-cli@${VERSION} --version -> $(tail -1 /tmp/sk-smoke.out)"',
  'cat /tmp/sk-smoke.out || true',
]

describe('the re-anchor (SMI-6497 Edit A)', () => {
  // SMI-6497 / PR-15. The step split is a state flip on an IRREVERSIBLE path, and
  // the condition below is the only thing standing between it and a smoke run
  // against a publish that never happened. Nothing else in either replacement
  // suite looks at this field, so without this case a future deletion of the
  // `if:` passes everything.
  it('the smoke step carries the same `if:` as the step it was split from', () => {
    const req = createRequire(import.meta.url)
    const YAML = req('yaml') as { parse: (t: string) => unknown }
    const wf = YAML.parse(WORKFLOW_TEXT) as {
      jobs?: Record<string, { steps?: Array<{ name?: string; if?: string }> }>
    }
    const steps = wf.jobs?.[JOB_ID]?.steps ?? []
    const pick = (n: string) => {
      const hits = steps.filter((st) => st.name === n)
      expect(hits.length, `expected exactly one ${JOB_ID} step named ${n}`).toBe(1)
      return hits[0]
    }
    const verify = pick('Verify skillsmith-cli on npm')
    const smoke = pick(STEP_NAME)

    // A step with no `if:` carries only the implicit success(). A SKIPPED publish
    // is not a FAILED one: `Publish skillsmith-cli` is gated on
    // `steps.version-check.outputs.exists != 'true'`, so on the already-published
    // path it skips, the verify step skips with it, and a skipped step does not
    // fail the job -- leaving the smoke to run against a publish that never
    // happened. The two conditions must stay identical.
    // Pin the REQUIRED PREDICATE itself, not merely that the two agree. Asserting
    // equality alone is satisfied by mutating BOTH conditions to the same wrong
    // expression -- e.g. `github.event_name == 'release'` -- which would permit
    // the smoke to run after a skipped publish while the test stayed green.
    const REQUIRED_GATE = "steps.publish-skillsmith-cli-oidc.outcome == 'success'"
    expect(smoke.if, 'the smoke step must carry an explicit `if:`').toBeTruthy()
    expect(smoke.if).toBe(REQUIRED_GATE)
    expect(verify.if).toBe(REQUIRED_GATE)

    // And it must contain NO status-check function, because that is precisely
    // what keeps GitHub's default success() applied -- which is what preserves
    // FT-2: a verify step that fails must stop the smoke. Case-insensitive:
    // GitHub's expression functions are, so `Success()` would otherwise evade it.
    expect(smoke.if).not.toMatch(/\b(success|failure|cancelled|always)\s*\(/i)
  })

  it('resolves the tail by (jobId, stepName), not by any marker', () => {
    expect(REAL_TAIL.length).toBeGreaterThan(0)
    expect(REAL_TAIL).toContain('if ! SMOKE_DIR="$(mktemp -d)"; then')
    expect(REAL_TAIL).toContain('sleep 8 || {')
    // The VERSION read lives INSIDE this step -- it sat outside the old
    // marker-split tail, so its presence here is part of what proves the
    // re-anchor resolved the right body. SMI-6497 guards it, because the step
    // split put a SECOND `jq` on this job's path AFTER verification already
    // passed, and every other fallible command in this tail is non-fatal.
    // Assert the first EXECUTABLE line, not the first line: a comment above it
    // is not a regression, and pinning line 1 would make it read as one.
    const firstCode = REAL_TAIL.split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '' && !l.startsWith('#'))
    expect(firstCode).toBe(
      'if ! VERSION=$(jq -r .version packages/skillsmith-cli/package.json); then'
    )
  })

  it('the retired marker is gone and this file does not reference the retired module', () => {
    expect(WORKFLOW_TEXT).not.toContain('# audit:verify-block-smoke-tail')
    // The property is "no IMPORT of the retired module", not "no mention": the
    // header above names it deliberately, and a prose ban would make this test
    // pass only while the file stays silent about what it replaced.
    const importsRetired = /\bfrom\s+['"][^'"]*verify-block-identity/
    const here = path.dirname(fileURLToPath(import.meta.url))
    for (const f of ['publish-smoke-tail-guards.test.ts', 'publish-smoke-tail-guards.helpers.ts']) {
      expect(importsRetired.test(fs.readFileSync(path.join(here, f), 'utf8'))).toBe(false)
    }
    // The detector itself, exercised in the direction that matters. The needle
    // is assembled from parts ON PURPOSE: written as one literal it would be
    // found by the scan above, in this very file, and the whole assertion would
    // fail on its own fixture.
    const needle = `import { X } from '../lib/verify-block-${'identity'}.mjs'`
    expect(importsRetired.test(needle)).toBe(true)
  })

  it('a duplicate or missing (jobId, stepName) is a loud failure, not a silent pick', () => {
    // The re-anchor's own clause, exercised directly. Resolving the REAL file
    // can only ever show the one-match case, so the other two arms of
    // `matches.length !== 1` would otherwise never be observed at all.
    const one = [{ name: STEP_NAME, run: 'echo one' }]
    expect(resolveSingleStepRun(one, JOB_ID, STEP_NAME)).toBe('echo one')
    const dup = [...one, { name: STEP_NAME, run: 'echo two' }]
    expect(() => resolveSingleStepRun(dup, JOB_ID, STEP_NAME)).toThrow(/found 2/)
    expect(() => resolveSingleStepRun([], JOB_ID, STEP_NAME)).toThrow(/found 0/)
    expect(() => resolveSingleStepRun([{ name: STEP_NAME }], JOB_ID, STEP_NAME)).toThrow(
      /no run body/
    )
  })

  it('every literal the case tables borrow from the tail is still in the tail', () => {
    for (const line of REAL_TAIL_LINES) expect(REAL_TAIL.split('\n')).toContain(line)
  })
})

describe('K1-K5: behavioural cases on the relocated step', () => {
  it('K1 (SMI-6497): npx succeeds on attempt 1 -- exit 0, no sleep, OK line carries the stub stdout', () => {
    const h = harness()
    writeFakeBin(h.binDir, 'npx', `echo "${h.marker}"; exit 0`)
    const { status, combined, sleepArgs } = runTail(REAL_TAIL, h)
    expect(status).toBe(0)
    expect(sleepArgs).toEqual([])
    // The OK line reads `$(tail -1 /tmp/sk-smoke.out)`, so containing the stub's
    // own stdout is what pins the /tmp round trip -- not merely "a line appeared".
    expect(combined).toContain(`OK npx skillsmith-cli@${h.version} --version -> ${h.marker}`)
    expect(combined).not.toMatch(/::warning::/)
  })

  it('K2 (SMI-6512, extended): npx fails all 3 -- exit 0, warning, 3 sleeps of 8, attempt lines, cat', () => {
    const h = harness()
    writeFakeBin(h.binDir, 'npx', `echo "${h.marker}"; exit 1`)
    const { status, combined, sleepArgs } = runTail(REAL_TAIL, h)
    expect(status).toBe(0)
    expect(combined).toMatch(/::warning::/)
    expect(sleepArgs).toEqual(['8', '8', '8'])
    expect(combined).toContain('attempt 1/3')
    expect(combined).toContain('attempt 2/3')
    expect(combined).toContain('attempt 3/3')
    // The marker reaches stdout ONLY via the post-warning `cat` of the output
    // file. A fresh per-run marker means a stale /tmp/sk-smoke.out cannot pass it.
    const afterWarning = combined.slice(combined.indexOf('::warning::npx'))
    expect(afterWarning).toContain(h.marker)
  })

  it('K3 (SMI-6512): mktemp fails -- exit 0 with a warning', () => {
    const h = harness()
    writeFakeBin(h.binDir, 'mktemp', 'exit 1')
    writeFakeBin(
      h.binDir,
      'npx',
      'echo "fixture error: npx ran despite mktemp failing" >&2; exit 111'
    )
    const { status, combined } = runTail(REAL_TAIL, h)
    expect(status).toBe(0)
    expect(combined).toMatch(/::warning::/)
  })

  it('K4 (SMI-6512): sleep fails on the slow path -- exit 0, sleep warning, exactly one sleep', () => {
    const h = harness()
    writeFakeBin(h.binDir, 'npx', 'exit 1')
    writeFakeBin(h.binDir, 'sleep', 'echo "$@" >> "$SLEEP_ARG_LOG"; exit 1')
    const { status, combined, sleepArgs } = runTail(REAL_TAIL, h)
    expect(status).toBe(0)
    expect(combined).toMatch(/::warning::sleep failed/)
    expect(sleepArgs).toEqual(['8'])
  })

  it('K5 (SMI-6512): sleep fails on the fast path -- exit 0, no warning, sleep never called', () => {
    const h = harness()
    writeFakeBin(h.binDir, 'npx', `echo "${h.marker}"; exit 0`)
    writeFakeBin(h.binDir, 'sleep', 'echo "$@" >> "$SLEEP_ARG_LOG"; exit 1')
    const { status, combined, sleepArgs } = runTail(REAL_TAIL, h)
    expect(status).toBe(0)
    expect(combined).not.toMatch(/::warning::/)
    expect(sleepArgs).toEqual([])
  })

  it('the sleep stub records the ARGUMENT it is given, not a constant', () => {
    // K2's ['8','8','8'] is the only thing pinning the retry interval, and it
    // pins nothing if this stub hardcodes a value instead of echoing "$@".
    // Measured: replacing `echo "$@"` with `echo 8` left the whole suite green
    // (mutation MH26), so the stub's own fidelity needs its own assertion.
    const h = harness()
    const r = runTail('sleep 41\nsleep 42\n', h)
    expect(r.status).toBe(0)
    expect(r.sleepArgs).toEqual(['41', '42'])
  })

  it('mutation: reverting the mktemp guard turns K3 red', () => {
    const h = harness()
    writeFakeBin(h.binDir, 'mktemp', 'exit 1')
    const { status, combined } = runTail(revertMktempGuard(REAL_TAIL), h)
    expect(status).not.toBe(0)
    expect(combined).not.toMatch(/::warning::/)
  })

  it('mutation: reverting the sleep guard turns K4 red', () => {
    const h = harness()
    writeFakeBin(h.binDir, 'npx', 'exit 1')
    writeFakeBin(h.binDir, 'sleep', 'echo "$@" >> "$SLEEP_ARG_LOG"; exit 1')
    const { status, combined } = runTail(revertSleepGuard(REAL_TAIL), h)
    expect(status).not.toBe(0)
    expect(combined).not.toMatch(/::warning::/)
  })

  it('mutation: dropping the $(tail -1 ...) round trip turns K1 red', () => {
    const h = harness()
    writeFakeBin(h.binDir, 'npx', `echo "${h.marker}"; exit 0`)
    const mutated = REAL_TAIL.replace('$(tail -1 /tmp/sk-smoke.out)', 'ok')
    expect(mutated).not.toBe(REAL_TAIL)
    const { combined } = runTail(mutated, h)
    expect(combined).not.toContain(`--version -> ${h.marker}`)
  })

  it('mutation: dropping the post-warning cat turns K2 red', () => {
    const h = harness()
    writeFakeBin(h.binDir, 'npx', `echo "${h.marker}"; exit 1`)
    const mutated = REAL_TAIL.replace('cat /tmp/sk-smoke.out || true\n', '')
    expect(mutated).not.toBe(REAL_TAIL)
    const { combined } = runTail(mutated, h)
    expect(combined.slice(combined.indexOf('::warning::npx'))).not.toContain(h.marker)
  })
})

describe('VB-UNSAFE-WHITESPACE (re-homed): backslash + heredoc, RAW text', () => {
  it('the backslash predicate is the retired module byte-for-byte', () => {
    expect(UNSAFE_BACKSLASH_RE.source).toBe('\\\\[ \\t]+$')
  })

  it('backslash predicate: positive control and the hazard', () => {
    // Positive control: a hazard-free REAL line must be clean, so a predicate
    // that matches everything cannot pass as a predicate that matches the hazard.
    for (const line of REAL_TAIL_LINES) expect(UNSAFE_BACKSLASH_RE.test(line)).toBe(false)
    expect(UNSAFE_BACKSLASH_RE.test('printf "%s" foo \\')).toBe(false)
    expect(UNSAFE_BACKSLASH_RE.test('printf "%s" foo \\ ')).toBe(true)
    expect(UNSAFE_BACKSLASH_RE.test('printf "%s" foo \\\t')).toBe(true)
  })

  it.each(HEREDOC_CASES)('heredoc case %s', (_id, line, opens, delimiter) => {
    const hit = findHeredocOpener(line)
    expect(hit !== null).toBe(opens)
    if (opens) expect(hit?.delimiter).toBe(delimiter)
  })

  it('the heredoc table has both arms and a real-tail positive control', () => {
    expect(HEREDOC_CASES.length).toBe(56)
    expect(HEREDOC_CASES.filter(([, , o]) => o).length).toBe(31)
    expect(HEREDOC_CASES.filter(([, , o]) => !o).length).toBe(25)
    expect(
      HEREDOC_CASES.some(([id, line]) => id === 'A13' && REAL_TAIL.split('\n').includes(line))
    ).toBe(true)
    // The shipped predicate scored 29/49 (5 false negatives, 15 false positives).
    // Pinning that here is what makes "rebuilt, not ported" auditable.
    const shipped = (l: string) => /<<-?\s*['"]?\w/.test(l)
    const shippedScore = HEREDOC_CASES.filter(([, line, o]) => shipped(line) === o).length
    expect(shippedScore).toBe(SHIPPED_HEREDOC_SCORE)
  })

  it('every reachable run: body is scanned and is clean today', () => {
    expect(RUN_BODIES.length).toBeGreaterThan(1)
    // Do NOT assert an exact line count on any body: the four verify steps each
    // carry an `# audit:publish-verify-step` first line owned by another surface.
    expect(RUN_BODIES.some((b) => b.jobId === JOB_ID && b.stepName === STEP_NAME)).toBe(true)
    expect(whitespaceFindings(RUN_BODIES)).toEqual([])
  })

  it('the arm fires when a hazard is injected into either shape', () => {
    const inject = (run: string) => [{ jobId: 'j', stepName: 's', run }]
    const bs = whitespaceFindings(inject('echo a\nprintf "%s" foo \\ \necho b'))
    expect(bs).toHaveLength(1)
    expect(bs[0].code).toBe('VB-UNSAFE-WHITESPACE')
    expect(bs[0].detail).toContain('line 2')
    const hd = whitespaceFindings(inject('echo a\ncat <<-\'E\'"O"F\necho b'))
    expect(hd).toHaveLength(1)
    expect(hd[0].detail).toContain('opens a heredoc')
    // The message names BOTH the resolved delimiter (what bash would look for)
    // and the word as written, so a mixed-quoting opener stays legible either way.
    expect(hd[0].detail).toContain('delimiter "EOF"')
    expect(hd[0].detail).toContain('written as')
  })
})

describe('the allow-list', () => {
  it('is empty and is asserted EQUAL, not merely honoured', () => {
    expect(HEREDOC_ALLOWLIST).toEqual([])
  })

  it('appending any entry turns the equality assertion red', () => {
    const appended = [
      ...HEREDOC_ALLOWLIST,
      { jobId: 'j', stepName: 's', lineDigest: digestOf('x') },
    ]
    expect(appended).not.toEqual(HEREDOC_ALLOWLIST)
  })

  it('an allow-listed key passes; changing any one of the three components still fails', () => {
    const line = "cat <<'EOF'"
    const body = [{ jobId: 'j', stepName: 's', run: line }]
    const key = { jobId: 'j', stepName: 's', lineDigest: digestOf(line) }
    expect(whitespaceFindings(body, [key])).toEqual([])
    expect(whitespaceFindings(body, [{ ...key, jobId: 'other' }])).toHaveLength(1)
    expect(whitespaceFindings(body, [{ ...key, stepName: 'other' }])).toHaveLength(1)
    expect(whitespaceFindings(body, [{ ...key, lineDigest: digestOf('cat <<EOF') }])).toHaveLength(
      1
    )
  })

  it('the failure message names the allow-list file and prints the exact key', () => {
    const line = "cat <<'EOF'"
    const [finding] = whitespaceFindings([{ jobId: 'j', stepName: 's', run: line }])
    expect(finding.detail).toContain(SELF_PATH)
    expect(finding.detail).toContain('HEREDOC_ALLOWLIST')
    expect(finding.detail).toContain(digestOf(line))
  })
})

describe('VB-TAIL-SCALAR-STYLE', () => {
  it('the smoke step run: is a literal block, determined from the node TYPE', () => {
    expect(smokeScalarType()).toBe('BLOCK_LITERAL')
  })

  it('a folded scalar is detected, and the whitespace arm alone reports clean on it', () => {
    // The invisible-success path, closed only once observed open: folding erases
    // the line structure the whitespace arm depends on, so the arm goes quiet
    // while examining nothing relevant. Measured, not reasoned.
    const hazard = 'printf "%s" foo \\   '
    const literal = `jobs:\n  j:\n    steps:\n      - name: S\n        run: |\n          echo a\n          ${hazard}\n          echo b\n`
    const folded = literal.replace('run: |', 'run: >')
    const typeOf = (src: string) => {
      const doc = parseDocument(src)
      const jobs = doc.get('jobs', true) as { get: (k: unknown, s?: boolean) => unknown }
      const j = jobs.get('j', true) as { get: (k: unknown, s?: boolean) => unknown }
      const steps = j.get('steps', true) as {
        items: Array<{ get: (k: unknown, s?: boolean) => unknown }>
      }
      return steps.items[0].get('run', true) as { type: string; value: string }
    }
    const lit = typeOf(literal)
    const fold = typeOf(folded)
    expect(lit.type).toBe('BLOCK_LITERAL')
    expect(fold.type).toBe('BLOCK_FOLDED')
    const hits = (body: string) =>
      body.split('\n').filter((l) => UNSAFE_BACKSLASH_RE.test(l)).length
    expect(hits(String(lit.value))).toBe(1)
    expect(hits(String(fold.value))).toBe(0)
  })
})

describe('non-fatal tail assertions', () => {
  it('VB-TAIL-CONTAINS-PROBE: no registry probe, with whole-line comments stripped', () => {
    const decommented = stripWholeLineComments(REAL_TAIL)
    expect(decommented).not.toContain('npm view')
    // Comment-stripping is deliberate and must survive the move: a comment
    // merely MENTIONING a probe does not fire the arm.
    expect(stripWholeLineComments('# npm view foo\necho ok')).not.toContain('npm view')
    expect(stripWholeLineComments('npm view foo\necho ok')).toContain('npm view')
  })

  it.each(TERMINATION_CASES)('termination case %s', (_id, line, rejected) => {
    expect(terminationViolations(line).length > 0).toBe(rejected)
  })

  it('VB-TAIL-EXPLICIT-TERMINATION: the real tail is clean', () => {
    // The bound rides on the assertion itself, so it appears in the FAILURE
    // OUTPUT a developer actually reads -- not only in a comment they may not.
    expect(terminationViolations(stripWholeLineComments(REAL_TAIL)), TERMINATION_BOUND).toEqual([])
    expect(TERMINATION_CASES.length).toBe(32)
    // The shipped predicate was a substring test for one literal. It misses
    // every other status and every indirect termination, and fires on the
    // literal as string content. Pinned so "broadened" is auditable.
    const shipped = (l: string) => l.includes('exit 1')
    const shippedScore = TERMINATION_CASES.filter(([, line, r]) => shipped(line) === r).length
    expect(shippedScore).toBe(SHIPPED_TERMINATION_SCORE)
  })

  it('the motivating shape is caught and the claim is bounded in the message', () => {
    const [v] = terminationViolations('cleanup_smoke || exit 1')
    expect(v).toContain('exit with a nonzero status')
    // WHAT IS NOT CLAIMED: this prohibits EXPLICIT termination constructs. It
    // does not prove the step always exits zero and cannot -- under `bash -e`
    // any ordinary command can fail, and it is K1..K5, not this predicate, that
    // cover the commands actually present.
    expect(terminationViolations('some_command_that_may_fail')).toEqual([])
  })
})

describe('ASCII-only over BOTH surfaces (D-5)', () => {
  it.each(ASCII_CASES)('codepoint case %s', (_id, text, hits) => {
    expect(nonAsciiHits(text)).toHaveLength(hits)
  })

  it('reports the offending codepoint AND its offset', () => {
    expect(nonAsciiHits('ab\u2014')).toEqual(['offset 2: U+2014'])
  })

  it('surface 1: scripts/ci/verify-npm-publish.sh is ASCII-clean', () => {
    expect(nonAsciiHits(fs.readFileSync(HELPER_PATH, 'utf8'))).toEqual([])
  })

  it('surface 2: the relocated smoke-tail run: body is ASCII-clean', () => {
    expect(nonAsciiHits(REAL_TAIL)).toEqual([])
  })

  it('mutation 1: one non-ASCII codepoint in the helper is reported', () => {
    const mutated = `${fs.readFileSync(HELPER_PATH, 'utf8')}\n# \u2014\n`
    expect(nonAsciiHits(mutated)).toHaveLength(1)
  })

  it('mutation 2: one non-ASCII codepoint in the tail body is reported', () => {
    const mutated = REAL_TAIL.replace('exit 0', 'exit 0 # \u2019')
    expect(mutated).not.toBe(REAL_TAIL)
    expect(nonAsciiHits(mutated)).toHaveLength(1)
  })

  it('the scratch-dir harness itself works (guards against a vacuous suite)', () => {
    const dir = makeScratchDir('sk-smoke-selfcheck-')
    expect(fs.existsSync(dir)).toBe(true)
  })
})
