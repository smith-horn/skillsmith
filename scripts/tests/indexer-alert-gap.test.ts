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
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureTempDir } from './_lib/git-fixture-env.js'
import { extractStep } from './_lib/workflow-yaml.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const INDEXER_PATH = join(REPO_ROOT, '.github', 'workflows', 'indexer.yml')
const WATCHER_PATH = join(REPO_ROOT, '.github', 'workflows', 'indexer-watch.yml')

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
