/**
 * SMI-5974: static assertions over the alert-gap watcher
 * (`.github/workflows/indexer-watch.yml`, new) and the alert-delivery-failure
 * fix in `.github/workflows/indexer.yml`'s `Send Alert on Failure` step.
 * Direct sibling of `indexer-backfill-alert-gap.test.ts` (SMI-5964) -- same
 * no-YAML-parser, string/regex + `bash -n` pattern, same `extractStep` shared
 * helper.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureTempDir } from './_lib/git-fixture-env.js'
import { extractStep } from './_lib/workflow-yaml.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const INDEXER_PATH = join(REPO_ROOT, '.github', 'workflows', 'indexer.yml')
const WATCHER_PATH = join(REPO_ROOT, '.github', 'workflows', 'indexer-watch.yml')
const RUN_TS_PATH = join(REPO_ROOT, 'scripts', 'indexer', 'run.ts')

function bashSyntaxCheck(script: string): { ok: true } | { ok: false; stderr: string } {
  const dir = makeFixtureTempDir('indexer-watch-test')
  const file = join(dir, 'script.sh')
  try {
    writeFileSync(file, script, 'utf8')
    execFileSync('bash', ['-n', file], { stdio: ['ignore', 'ignore', 'pipe'] })
    return { ok: true }
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: Buffer }).stderr)
        : String(err)
    return { ok: false, stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Extracts just the parse_ts()/STARTED/ENDED/ELAPSED_MIN computation out of
 * the watcher's full run: script (up to and including the if/else block's
 * closing `fi`) and runs it FOR REAL under `set -eo pipefail` -- matching
 * the actual script's own settings -- so a `set -e`-vs-fail-open regression
 * (NEEDLE code-review finding: a bare `VAR=$(parse_ts ...)` previously
 * exited the whole step before the fail-open check could run) is caught by
 * execution, not just `bash -n` syntax validity.
 */
function runElapsedCalc(runScript: string, startedAt: string, updatedAt: string): string {
  const start = runScript.indexOf('parse_ts() {')
  const anchor = 'ELAPSED_MIN=$(( (ENDED - STARTED) / 60 ))'
  const anchorIdx = runScript.indexOf(anchor)
  if (start === -1 || anchorIdx === -1) {
    throw new Error('could not locate the elapsed-calc block in watcher runScript')
  }
  // The next `fi` after the ELAPSED_MIN assignment closes the if/else block.
  const fiIdx = runScript.indexOf('fi', anchorIdx)
  if (fiIdx === -1) {
    throw new Error('could not locate the closing fi in watcher runScript')
  }
  const snippet = runScript.slice(start, fiIdx + 2)
  const script = `set -eo pipefail\nRUN_STARTED_AT=${shellQuote(startedAt)}\nRUN_UPDATED_AT=${shellQuote(updatedAt)}\n${snippet}\necho "ELAPSED_MIN=$ELAPSED_MIN"\n`
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' })
}

function injectEnv(script: string, env: Record<string, string>): string {
  const assignments = Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join('\n')
  return `${assignments}\n${script}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const HOSTILE_FIXTURES: Array<{ label: string; value: string }> = [
  { label: 'embedded single quote', value: "it's broken" },
  { label: 'embedded backticks', value: '`backtick`' },
  { label: 'embedded double quote', value: 'line "with" quote' },
  { label: 'embedded newline', value: 'line 1\nline 2' },
  { label: 'subshell-looking $(rm -rf /)', value: '$(rm -rf /)' },
  { label: 'process substitution <(cat /etc/passwd)', value: '<(cat /etc/passwd)' },
]

describe('SMI-5974: indexer-watch.yml (the new alert-gap watcher)', () => {
  const watcher = readFileSync(WATCHER_PATH, 'utf8')
  const indexer = readFileSync(INDEXER_PATH, 'utf8')

  it("the watcher's workflows: value matches indexer.yml's name: byte-for-byte -- a mismatch means workflow_run silently never fires", () => {
    const nameMatch = indexer.match(/^name: (.+)$/m)
    expect(nameMatch).not.toBeNull()
    const indexerName = nameMatch![1].trim()
    expect(watcher).toContain(`workflows: ['${indexerName}']`)
  })

  it('triggers on workflow_run / types: [completed] / branches: [main]', () => {
    expect(watcher).toMatch(/workflow_run:/)
    expect(watcher).toMatch(/types: \[completed\]/)
    expect(watcher).toMatch(/branches: \[main\]/)
  })

  it("the job's if: condition is scoped to conclusion == 'cancelled' only", () => {
    expect(watcher).toMatch(/if: github\.event\.workflow_run\.conclusion == 'cancelled'/)
  })

  it("has its own timeout-minutes, independent of the dying job's 30-min budget", () => {
    expect(watcher).toMatch(/timeout-minutes: 5/)
  })

  it('has no `uses:` step -- nothing for audit-workflow-sha-pin (Check 42) to pin', () => {
    expect(watcher).not.toMatch(/uses:/)
  })

  it("elapsed time is computed from the watched run's own RUN_UPDATED_AT, not watcher wall-clock (NEEDLE plan-review requirement)", () => {
    const step = extractStep(watcher, 'Classify and alert')
    expect(step.runScript).toMatch(/RUN_UPDATED_AT/)
    expect(step.runScript).not.toMatch(/NOW=\$\(date \+%s\)/)
    expect(step.runScript).toMatch(/ENDED=\$\(parse_ts "\$RUN_UPDATED_AT"\)/)
    expect(step.runScript).toMatch(/STARTED=\$\(parse_ts "\$RUN_STARTED_AT"\)/)
  })

  it('an unparseable or inverted timestamp pair fails open to ELAPSED_MIN=0, never crashing the step (real execution, not just bash -n -- NEEDLE code-review regression test)', () => {
    const step = extractStep(watcher, 'Classify and alert')
    expect(step.runScript).toMatch(/ELAPSED_MIN=0/)

    // Both attempts inside parse_ts() fail -- this is exactly the case
    // where a bare `STARTED=$(parse_ts ...)` under set -e previously
    // terminated the step before reaching the fail-open check.
    const malformed = runElapsedCalc(step.runScript, 'not-a-timestamp', 'also-not-a-timestamp')
    expect(malformed.trim()).toBe('ELAPSED_MIN=0')

    // Missing values (empty string) -- same failure class.
    const missing = runElapsedCalc(step.runScript, '', '')
    expect(missing.trim()).toBe('ELAPSED_MIN=0')

    // Inverted pair (end before start) -- valid timestamps, but the other
    // fail-open condition ("$ENDED" -lt "$STARTED").
    const inverted = runElapsedCalc(step.runScript, '2026-08-09T02:00:00Z', '2026-08-09T01:00:00Z')
    expect(inverted.trim()).toBe('ELAPSED_MIN=0')

    // Sanity: a real, valid, 30-minute-apart pair computes the real value,
    // proving the fail-open branch isn't just always returning 0.
    const real = runElapsedCalc(step.runScript, '2026-08-09T01:00:00Z', '2026-08-09T01:30:00Z')
    expect(real.trim()).toBe('ELAPSED_MIN=30')

    const injected = injectEnv(step.runScript, {
      RUN_STARTED_AT: 'not-a-timestamp',
      RUN_UPDATED_AT: 'also-not-a-timestamp',
      RUN_ID: '123',
      RUN_URL: 'https://example.com',
      GH_REPOSITORY: 'smith-horn/skillsmith',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'dummy',
      GITHUB_STEP_SUMMARY: '/tmp/dummy-summary',
    })
    const result = bashSyntaxCheck(injected)
    expect(result).toEqual({ ok: true })
  })

  it('uses the 29-minute threshold (1-minute tolerance against the 30-min job budget, per NEEDLE plan review)', () => {
    const step = extractStep(watcher, 'Classify and alert')
    expect(step.runScript).toMatch(/"\$ELAPSED_MIN" -ge 29/)
  })

  it('looks up the exact step name "Run indexer" (confirmed against the live file, not guessed)', () => {
    expect(indexer).toMatch(/- name: Run indexer/)
    const step = extractStep(watcher, 'Classify and alert')
    expect(step.runScript).toMatch(/select\(\.name == "Run indexer"\)/)
  })

  it('labels a resolved-but-not-cancelled step as cancelled-outside-indexer, not cancelled-before-indexer (NEEDLE: "before" can be factually wrong)', () => {
    const step = extractStep(watcher, 'Classify and alert')
    expect(step.runScript).toMatch(/KIND="cancelled-outside-indexer"/)
    expect(step.runScript).not.toMatch(/cancelled-before-indexer/)
  })

  it('the run: body survives bash -n under hostile $RUN_ID/$RUN_URL-shaped fixtures', () => {
    const step = extractStep(watcher, 'Classify and alert')
    for (const fixture of HOSTILE_FIXTURES) {
      const injected = injectEnv(step.runScript, {
        RUN_STARTED_AT: '2026-08-09T01:05:54Z',
        RUN_UPDATED_AT: '2026-08-09T01:35:54Z',
        RUN_ID: fixture.value,
        RUN_URL: fixture.value,
        GH_REPOSITORY: 'smith-horn/skillsmith',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'dummy',
        GITHUB_STEP_SUMMARY: '/tmp/dummy-summary',
      })
      const result = bashSyntaxCheck(injected)
      expect(result, `${fixture.label}: ${JSON.stringify(result)}`).toEqual({ ok: true })
    }
  })

  it('classification is a label, never a gate -- the alert-notify POST is never wrapped in a $KIND conditional', () => {
    const step = extractStep(watcher, 'Classify and alert')
    const curlIdx = step.runScript.indexOf('curl -s -o /dev/null')
    expect(curlIdx).toBeGreaterThan(-1)
    expect(step.runScript).not.toMatch(/if \[ "\$KIND"/)
  })

  it('the alert-notify HTTP code is captured, written to the step summary, and a non-200 fails the job', () => {
    const step = extractStep(watcher, 'Classify and alert')
    expect(step.runScript).toMatch(
      /if RESPONSE_CODE=\$\(curl -s -o \/dev\/null -w '%\{http_code\}'/
    )
    expect(step.runScript).toMatch(/alert-notify HTTP \| \$HTTP/)
    expect(step.runScript).toMatch(/::error::alert-notify returned \$HTTP/)
    expect(step.runScript).toMatch(/exit 1/)
  })

  it('posts the type: "indexer_cancelled" alert', () => {
    const step = extractStep(watcher, 'Classify and alert')
    expect(step.runScript).toMatch(/type:"indexer_cancelled"/)
  })

  it('SMI-6223: does not send the dead kind field to alert-notify — AlertRequest never declared it, $KIND stays only in the message string', () => {
    const step = extractStep(watcher, 'Classify and alert')
    expect(step.runScript).not.toMatch(/--arg kind/)
    expect(step.runScript).not.toMatch(/kind:\$kind/)
    // $KIND still does useful work embedded in the human-readable message.
    expect(step.runScript).toMatch(/\(kind: \$KIND\)/)
  })
})

describe('SMI-5974: indexer.yml (Send Alert on Failure alert-delivery-failure fix)', () => {
  const indexer = readFileSync(INDEXER_PATH, 'utf8')

  it('no timeout-minutes was added to any step -- only the pre-existing job-level 30 remains', () => {
    const matches = indexer.match(/timeout-minutes:/g) ?? []
    expect(matches).toHaveLength(1)
    expect(indexer).toMatch(/timeout-minutes: 30/)
  })

  it('the two if: failure() conditions are unchanged', () => {
    const matches = indexer.match(/if: failure\(\)/g) ?? []
    expect(matches).toHaveLength(2)
  })

  it('Send Alert on Failure no longer has a bare `|| true` swallowing delivery failures', () => {
    const step = extractStep(indexer, 'Send Alert on Failure')
    const codeOnly = step.runScript
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(codeOnly).not.toMatch(/alert-notify" \|\| true/)
  })

  it('Send Alert on Failure captures the alert-notify HTTP code and fails the step on non-200', () => {
    const step = extractStep(indexer, 'Send Alert on Failure')
    expect(step.runScript).toMatch(
      /if RESPONSE_CODE=\$\(curl -s -o \/dev\/null -w '%\{http_code\}'/
    )
    expect(step.runScript).toMatch(/::error::alert-notify returned \$HTTP/)
    expect(step.runScript).toMatch(/exit 1/)
  })

  it('Send Alert on Failure survives bash -n under hostile fixtures', () => {
    const step = extractStep(indexer, 'Send Alert on Failure')
    for (const fixture of HOSTILE_FIXTURES) {
      const injected = injectEnv(step.runScript, {
        HTTP_CODE: '500',
        RESPONSE: 'x',
        RUN_ID: fixture.value,
        RUN_URL: fixture.value,
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'dummy',
        GITHUB_STEP_SUMMARY: '/tmp/dummy-summary',
      })
      const result = bashSyntaxCheck(injected)
      expect(result, `${fixture.label}: ${JSON.stringify(result)}`).toEqual({ ok: true })
    }
  })
})

// ---------------------------------------------------------------------------
// SMI-6220: "Evaluate Result Thresholds" step (output-based degraded-run
// alerting). See docs/internal/implementation/smi-6220-indexer-alert-threshold-sparc.md
// for the full design (Guards 0/1, Arms A-D, statelessness rationale).
// ---------------------------------------------------------------------------

interface ThresholdEvalResult {
  exitCode: number
  stdout: string
  stderr: string
  summary: string
  curlCalled: boolean
  curlArgs: string | null
}

/**
 * Generalizes the `runElapsedCalc` real-execution pattern (§4.1): runs the
 * extracted "Evaluate Result Thresholds" `run:` body FOR REAL under the
 * runner's actual default shell (`bash -e {0}` -- `-e` on, pipefail off,
 * per SMI-6220 SPARC §2.4, NOT the stricter `-eo pipefail` `runElapsedCalc`
 * uses for its own step) against a fixture `$RESPONSE`, and returns the
 * verdict (stdout/summary text, exit code, and whether `curl` was invoked).
 *
 * `curl` is stubbed on PATH so no real network call is ever made and the
 * shadow-vs-lifted / disable axis is observable without a live Supabase
 * endpoint.
 */
const FAKE_JQ_PATH = join(__dirname, '_lib', 'fake-jq.cjs')

function runThresholdEval(
  runScript: string,
  response: string,
  env: Record<string, string> = {},
  opts: { curlHttpCode?: string } = {}
): ThresholdEvalResult {
  const dir = makeFixtureTempDir('indexer-threshold-eval')
  const summaryFile = join(dir, 'summary.md')
  const markerFile = join(dir, 'curl-marker.log')
  const binDir = join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const httpCode = opts.curlHttpCode ?? '200'
  writeFileSync(
    join(binDir, 'curl'),
    `#!/bin/bash\necho "curl called: $*" >> "${markerFile}"\necho "${httpCode}"\nexit 0\n`,
    'utf8'
  )
  chmodSync(join(binDir, 'curl'), 0o755)
  // Real `jq` isn't installed in this Docker image (see fake-jq.cjs's own
  // header) -- this wrapper execs the test-only shim under `node` so the
  // extracted step's real jq invocations resolve to a working `jq` on PATH.
  writeFileSync(join(binDir, 'jq'), `#!/bin/bash\nexec node "${FAKE_JQ_PATH}" "$@"\n`, 'utf8')
  chmodSync(join(binDir, 'jq'), 0o755)
  writeFileSync(summaryFile, '', 'utf8')

  const defaultEnv: Record<string, string> = {
    RESPONSE: response,
    RUN_TYPE: 'discovery',
    DISCOVERY_PHASE: '1',
    RUN_ID: '999',
    RUN_URL: 'https://example.com/actions/runs/999',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'dummy-key',
    // Shadow lifted by default so behavioral cases observe the REAL verdict
    // (DEGRADED/OK/SKIPPED) rather than every reason being masked behind
    // WOULD-ALERT; cases 8-10 explicitly override this axis.
    SHADOW: '0',
    DISABLE: '',
    MAX_FAILED_RATIO: '',
    MIN_COHORT: '',
    MAX_SECONDARY_HITS: '',
    GITHUB_STEP_SUMMARY: summaryFile,
    ...env,
  }

  let exitCode = 0
  let stdout = ''
  let stderr = ''
  try {
    // Real runner default: `-e` on, pipefail OFF (SPARC §2.4) -- deliberately
    // NOT `-eo pipefail` here, so the fail-open guards are proven under the
    // actual weaker regime, not a stricter one that would mask a gap.
    stdout = execFileSync('bash', ['-c', `set -e\n${runScript}`], {
      encoding: 'utf8',
      env: { ...process.env, ...defaultEnv, PATH: `${binDir}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }
    exitCode = e.status ?? 1
    stdout = e.stdout ? String(e.stdout) : ''
    stderr = e.stderr ? String(e.stderr) : ''
  }

  const curlCalled = existsSync(markerFile)
  const curlArgs = curlCalled ? readFileSync(markerFile, 'utf8') : null
  const summary = readFileSync(summaryFile, 'utf8')
  rmSync(dir, { recursive: true, force: true })

  return { exitCode, stdout, stderr, summary, curlCalled, curlArgs }
}

/** A healthy baseline fixture -- individual cases override just what they need. */
function fixture(overrides: {
  meta?: Record<string, unknown>
  data?: Record<string, unknown>
}): string {
  return JSON.stringify({
    meta: {
      core_observed: true,
      core_remaining_min: 4200,
      search_observed: true,
      search_remaining_min: 4200,
      code_search_observed: true,
      code_search_remaining_min: 4200,
      rate_limit_remaining_min: 4200,
      secondary_rate_limit_hits: 0,
      ...overrides.meta,
    },
    data: {
      found: 0,
      indexed: 0,
      failed: 0,
      ...overrides.data,
    },
  })
}

describe('SMI-6220: indexer.yml "Evaluate Result Thresholds" step -- behavioral (real execution)', () => {
  const indexer = readFileSync(INDEXER_PATH, 'utf8')
  const step = extractStep(indexer, 'Evaluate Result Thresholds')

  it('§4.2 case 1: SMI-6209 replay -- search bucket exhausted, observed, discovery -- DEGRADED naming the search bucket, posts indexer_degraded', () => {
    const response = fixture({
      meta: { search_observed: true, search_remaining_min: 0 },
      data: { found: 0, indexed: 0, failed: 0 },
    })
    const result = runThresholdEval(step.runScript, response)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/DEGRADED/)
    expect(result.stdout).toMatch(/'search' rate-limit bucket exhausted/)
    expect(result.curlCalled).toBe(true)
    expect(result.curlArgs).toMatch(/"type":\s*"indexer_degraded"/)
  })

  it('§4.2 case 2: lock-skip regression -- no .meta at all -- no alert, SKIPPED, curl never invoked', () => {
    const response = JSON.stringify({ event: 'lock_held_by_other_run', request_id: 'x' })
    const result = runThresholdEval(step.runScript, response)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/SKIPPED \(no \.meta/)
    expect(result.curlCalled).toBe(false)
  })

  it('§4.2 case 3: maintenance -- all buckets unobserved, found=0 -- no alert', () => {
    const response = fixture({
      meta: {
        core_observed: false,
        search_observed: false,
        code_search_observed: false,
        core_remaining_min: 0,
        search_remaining_min: 0,
        code_search_remaining_min: 0,
      },
      data: { found: 0, indexed: 0, failed: 0 },
    })
    const result = runThresholdEval(step.runScript, response, { RUN_TYPE: 'maintenance' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Threshold evaluation: OK/)
    expect(result.curlCalled).toBe(false)
  })

  it('§4.2 case 4: genuine ratio breach -- found=100 failed=30 -- DEGRADED naming the ratio', () => {
    const response = fixture({ data: { found: 100, indexed: 50, failed: 30 } })
    const result = runThresholdEval(step.runScript, response)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/DEGRADED/)
    expect(result.stdout).toMatch(/failure ratio 0\.3 > 0\.25 \(30\/100\)/)
  })

  it('§4.2 case 5: MIN_COHORT guard -- found=4 failed=4 (100%) -- no ratio-arm alert regardless of failed', () => {
    const response = fixture({ data: { found: 4, indexed: 0, failed: 4 } })
    const result = runThresholdEval(step.runScript, response)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Threshold evaluation: OK/)
    expect(result.curlCalled).toBe(false)
  })

  it('§4.2 case 6: SMI-6210 shape -- found=50 failed=0, buckets healthy -- accepted false negative, no alert', () => {
    const response = fixture({ data: { found: 50, indexed: 40, failed: 0 } })
    const result = runThresholdEval(step.runScript, response)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Threshold evaluation: OK/)
  })

  it('§4.2 case 7: healthy -- found=200 indexed=12 failed=1, core healthy+observed -- no alert', () => {
    const response = fixture({
      meta: { core_observed: true, core_remaining_min: 4200 },
      data: { found: 200, indexed: 12, failed: 1 },
    })
    const result = runThresholdEval(step.runScript, response)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Threshold evaluation: OK/)
  })

  it('§4.2 case 8: shadow ON (unset var) + case 1 fixture -- WOULD-ALERT, curl NOT invoked, exit 0', () => {
    const response = fixture({
      meta: { search_observed: true, search_remaining_min: 0 },
      data: { found: 0, indexed: 0, failed: 0 },
    })
    const result = runThresholdEval(step.runScript, response, { SHADOW: '' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/WOULD-ALERT \(shadow\)/)
    expect(result.stdout).toMatch(/'search' rate-limit bucket exhausted/)
    expect(result.curlCalled).toBe(false)
  })

  it("§4.2 case 9: shadow lifted ('0') + case 1 fixture, stubbed curl returning 503 -- ::error::, exit 1", () => {
    const response = fixture({
      meta: { search_observed: true, search_remaining_min: 0 },
      data: { found: 0, indexed: 0, failed: 0 },
    })
    const result = runThresholdEval(
      step.runScript,
      response,
      { SHADOW: '0' },
      { curlHttpCode: '503' }
    )
    expect(result.curlCalled).toBe(true)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toMatch(/::error::alert-notify returned 503/)
  })

  it("§4.2 case 10: disable ('1') + case 1 fixture -- SUPPRESSED (disabled), curl not invoked, exit 0", () => {
    const response = fixture({
      meta: { search_observed: true, search_remaining_min: 0 },
      data: { found: 0, indexed: 0, failed: 0 },
    })
    const result = runThresholdEval(step.runScript, response, { DISABLE: '1' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/SUPPRESSED \(disabled\)/)
    expect(result.curlCalled).toBe(false)
  })

  it('§4.2 case 11: malformed / non-JSON $RESPONSE -- no alert, exit 0, does not fail the job', () => {
    const result = runThresholdEval(step.runScript, 'not json')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/SKIPPED \(no \.meta/)
    expect(result.curlCalled).toBe(false)
  })

  it('§4.2 case 12: set -e fail-open -- the guarded jq failure from case 11 reaches the skip branch rather than dying mid-step', () => {
    // Same fixture as case 11, asserted from the fail-open angle: under the
    // real `-e`-on / pipefail-off runner default, a bare `VAR=$(jq ...)`
    // without `|| VAR=` would abort the whole step here (indexer-alert-gap
    // regression class, :124-160) -- proven by exit 0 + reaching the
    // SKIPPED branch instead of a bash-level abort.
    const result = runThresholdEval(step.runScript, 'not json')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/SKIPPED/)
  })

  it('§4.2 case 13: dry run -- data.dry_run=true + case 1 conditions -- no alert', () => {
    const response = fixture({
      meta: { search_observed: true, search_remaining_min: 0 },
      data: { found: 0, indexed: 0, failed: 0, dry_run: true },
    })
    const result = runThresholdEval(step.runScript, response)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/SKIPPED \(dry run\)/)
    expect(result.curlCalled).toBe(false)
  })

  it('§4.2 case 14: secondary-limit arm -- secondary_rate_limit_hits=7, everything else healthy -- DEGRADED naming the 403/429 count', () => {
    const response = fixture({ meta: { secondary_rate_limit_hits: 7 } })
    const result = runThresholdEval(step.runScript, response)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/DEGRADED/)
    expect(result.stdout).toMatch(/7 secondary rate-limit \(403\/429\) responses/)
  })

  it('§4.2 case 15: per-bucket vs global -- core healthy, code_search exhausted+observed -- DEGRADED naming code_search, not a global-min conflation', () => {
    const response = fixture({
      meta: {
        core_observed: true,
        core_remaining_min: 4200,
        search_observed: false,
        search_remaining_min: 0,
        code_search_observed: true,
        code_search_remaining_min: 0,
      },
      data: { found: 10, indexed: 5, failed: 0 },
    })
    const result = runThresholdEval(step.runScript, response)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/DEGRADED/)
    expect(result.stdout).toMatch(/'code_search' rate-limit bucket exhausted/)
    expect(result.stdout).not.toMatch(/'search' rate-limit bucket exhausted/)
  })

  it('§4.2 case 16: recheck healthy -- errors=0, fetch_error_rate=0.02 -- no alert', () => {
    const response = fixture({ data: { recheck: { errors: 0, fetch_error_rate: 0.02 } } })
    const result = runThresholdEval(step.runScript, response, {
      RUN_TYPE: 'recheck',
      DISCOVERY_PHASE: '',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Threshold evaluation: OK/)
  })

  it('§4.2 case 17: recheck prevention outage -- errors=3, fetch_error_rate=0.15 -- DEGRADED naming the recheck error count/rate', () => {
    const response = fixture({ data: { recheck: { errors: 3, fetch_error_rate: 0.15 } } })
    const result = runThresholdEval(step.runScript, response, {
      RUN_TYPE: 'recheck',
      DISCOVERY_PHASE: '',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/DEGRADED/)
    expect(result.stdout).toMatch(/recheck prevention outage: 3 errors, fetch_error_rate=0\.15/)
  })
})

describe('SMI-6220: indexer.yml "Evaluate Result Thresholds" step -- static/regression (layers 1-2)', () => {
  const indexer = readFileSync(INDEXER_PATH, 'utf8')
  const step = extractStep(indexer, 'Evaluate Result Thresholds')

  // §4.3 case 16 (exactly one timeout-minutes / exactly two if: failure()) is
  // the pre-existing tripwire in the describe block above (lines 223-232) --
  // it already re-validates against the file with this step present, since
  // this step adds `if: success()` (a second, alongside Parse Results) and
  // zero `if: failure()`. Not duplicated here.

  // §4.3 case 17 (Send Alert on Failure's run: body is byte-unchanged) is
  // covered by: (a) the pre-existing assertions in the "SMI-5974: indexer.yml"
  // describe block above, which still pass unmodified against this file, and
  // (b) this implementation touched indexer.yml via a single pure insertion
  // between "Parse Results" and "Report Failure" -- `git diff --stat` shows
  // 0 deletions. Not duplicated here as a snapshot test.

  it('§4.3 case 18: the run: body survives bash -n under all six HOSTILE_FIXTURES injected into RUN_ID/RUN_URL/RESPONSE', () => {
    for (const hostile of HOSTILE_FIXTURES) {
      const injected = injectEnv(step.runScript, {
        RESPONSE: hostile.value,
        RUN_ID: hostile.value,
        RUN_URL: hostile.value,
        RUN_TYPE: 'discovery',
        DISCOVERY_PHASE: '1',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'dummy',
        SHADOW: '0',
        DISABLE: '',
        MAX_FAILED_RATIO: '',
        MIN_COHORT: '',
        MAX_SECONDARY_HITS: '',
        GITHUB_STEP_SUMMARY: '/tmp/dummy-summary',
      })
      const result = bashSyntaxCheck(injected)
      expect(result, `${hostile.label}: ${JSON.stringify(result)}`).toEqual({ ok: true })
    }
  })

  it('§4.3 case 19: posts type:"indexer_degraded" and never "indexer_failed"', () => {
    expect(step.runScript).toMatch(/type:"indexer_degraded"/)
    expect(step.runScript).not.toMatch(/indexer_failed/)
  })

  it('§4.3 case 20: reuses the HTTP="000" + curl -w \'%{http_code}\' + ::error:: + exit 1 shape (SMI-5974 no-silent-delivery contract)', () => {
    expect(step.runScript).toMatch(/HTTP="000"/)
    expect(step.runScript).toMatch(
      /if RESPONSE_CODE=\$\(curl -s -o \/dev\/null -w '%\{http_code\}'/
    )
    expect(step.runScript).toMatch(/::error::alert-notify returned \$HTTP/)
    expect(step.runScript).toMatch(/exit 1/)
  })

  it('§4.3 case 21: job-level permissions: {} is unchanged; no new uses: step was added', () => {
    const permMatches = indexer.match(/permissions: \{\}/g) ?? []
    expect(permMatches).toHaveLength(1)
    const usesMatches = indexer.match(/\n\s+uses:/g) ?? []
    expect(usesMatches).toHaveLength(2) // Checkout + Setup Node, unchanged
    expect(step.runScript).not.toMatch(/\buses:/)
  })

  it("§4.3 case 22: run.ts's RunSummary.meta declares core_observed/search_observed/code_search_observed as boolean", () => {
    const runTs = readFileSync(RUN_TS_PATH, 'utf8')
    const interfaceMatch = runTs.match(/interface RunSummary \{[\s\S]*?\n\}/)
    expect(interfaceMatch).not.toBeNull()
    const body = interfaceMatch![0]
    expect(body).toMatch(/core_observed:\s*boolean/)
    expect(body).toMatch(/search_observed:\s*boolean/)
    expect(body).toMatch(/code_search_observed:\s*boolean/)
  })

  it('the step is placed immediately after Parse Results and before Report Failure, gated if: success()', () => {
    const parseResultsIdx = indexer.indexOf('- name: Parse Results')
    const newStepIdx = indexer.indexOf('- name: Evaluate Result Thresholds')
    const reportFailureIdx = indexer.indexOf('- name: Report Failure')
    expect(parseResultsIdx).toBeGreaterThan(-1)
    expect(newStepIdx).toBeGreaterThan(parseResultsIdx)
    expect(reportFailureIdx).toBeGreaterThan(newStepIdx)

    const startMarker = '- name: Evaluate Result Thresholds'
    const after = indexer.slice(indexer.indexOf(startMarker), reportFailureIdx)
    expect(after).toMatch(/if: success\(\)/)
  })

  it('reuses env.SELECTED_SUPABASE_URL / env.SELECTED_SUPABASE_SERVICE_ROLE_KEY -- no new secret introduced', () => {
    const startMarker = '- name: Evaluate Result Thresholds'
    const startIdx = indexer.indexOf(startMarker)
    const after = indexer.slice(startIdx + startMarker.length)
    const nextStepIdx = after.search(/\n {6}- name: /)
    const block = nextStepIdx === -1 ? after : after.slice(0, nextStepIdx)
    expect(block).toMatch(/SUPABASE_URL: \$\{\{ env\.SELECTED_SUPABASE_URL \}\}/)
    expect(block).toMatch(
      /SUPABASE_SERVICE_ROLE_KEY: \$\{\{ env\.SELECTED_SUPABASE_SERVICE_ROLE_KEY \}\}/
    )
    expect(block).not.toMatch(/secrets\.SUPABASE/)
  })

  it('maybe_alert() is the only curl invocation path to alert-notify in this step (single-gate principle)', () => {
    const curlMatches = step.runScript.match(/curl -s/g) ?? []
    expect(curlMatches).toHaveLength(1)
  })
})
