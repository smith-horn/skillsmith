/**
 * SMI-5964 Case 13: static assertions over the alert-gap watcher
 * (`.github/workflows/indexer-backfill-watch.yml`, new) and the three §3e
 * edits to `.github/workflows/indexer-backfill.yml`.
 *
 * No live dispatch (the driver owns that workflow -- see the plan's §Smoke
 * vs CI FORBIDDEN clause), no YAML parser dependency -- string/regex +
 * `bash -n`, matching every existing workflow test in this repo. `extractStep`
 * is shared with `indexer-workflow-report-failure.test.ts` via
 * `_lib/workflow-yaml.ts` (SMI-4241's original home for this walker).
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// SMI-4693: this file invokes `bash -n` (syntax check only) — no git
// mutation. Use `makeFixtureTempDir` for symlink consistency.
import { makeFixtureTempDir } from './_lib/git-fixture-env.js'
import { extractStep } from './_lib/workflow-yaml.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const BACKFILL_PATH = join(REPO_ROOT, '.github', 'workflows', 'indexer-backfill.yml')
const WATCHER_PATH = join(REPO_ROOT, '.github', 'workflows', 'indexer-backfill-watch.yml')

// ── Helpers (mirror indexer-workflow-report-failure.test.ts's pattern) ─────

function bashSyntaxCheck(script: string): { ok: true } | { ok: false; stderr: string } {
  const dir = makeFixtureTempDir('backfill-watch-test')
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

function injectEnv(script: string, env: Record<string, string>): string {
  const assignments = Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join('\n')
  return `${assignments}\n${script}`
}

function shellQuote(value: string): string {
  // POSIX-safe single-quote wrap; embedded `'` becomes `'\''`.
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

// ── Tests ────────────────────────────────────────────────────────────────

describe('SMI-5964 Case 13: indexer-backfill-watch.yml (the new alert-gap watcher)', () => {
  const watcher = readFileSync(WATCHER_PATH, 'utf8')
  const backfill = readFileSync(BACKFILL_PATH, 'utf8')

  it("the watcher's workflows: value matches indexer-backfill.yml's name: byte-for-byte -- a mismatch means workflow_run silently never fires", () => {
    const nameMatch = backfill.match(/^name: (.+)$/m)
    expect(nameMatch).not.toBeNull()
    const backfillName = nameMatch![1].trim()
    expect(watcher).toContain(`workflows: ['${backfillName}']`)
  })

  it('triggers on workflow_run / types: [completed] / branches: [main] (the established repo pattern -- smoke-prod.yml, billing-monitor.yml, mirror-mcp-server.yml, e2e-usage-counter.yml)', () => {
    expect(watcher).toMatch(/workflow_run:/)
    expect(watcher).toMatch(/types: \[completed\]/)
    expect(watcher).toMatch(/branches: \[main\]/)
  })

  it("the job's if: condition is scoped to conclusion == 'cancelled' only", () => {
    expect(watcher).toMatch(/if: github\.event\.workflow_run\.conclusion == 'cancelled'/)
  })

  it('permissions include actions: read (for the /jobs API call that labels the alert)', () => {
    const permsMatch = watcher.match(/permissions:\n((?: {2}[^\n]+\n)+)/)
    expect(permsMatch).not.toBeNull()
    expect(permsMatch![1]).toMatch(/actions: read/)
  })

  it("has its own timeout-minutes, independent of the dying job's 330-min budget", () => {
    expect(watcher).toMatch(/timeout-minutes: 5/)
  })

  it('has no `uses:` step -- nothing for audit-workflow-sha-pin (Check 42) to pin', () => {
    expect(watcher).not.toMatch(/uses:/)
  })

  it('the run: body survives bash -n under hostile $RUN_ID/$RUN_URL-shaped fixtures', () => {
    const step = extractStep(watcher, 'Classify and alert')
    for (const fixture of HOSTILE_FIXTURES) {
      const injected = injectEnv(step.runScript, {
        RUN_STARTED_AT: '2026-08-09T01:05:54Z',
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

  it('fail-open: an absent STEP_CONCLUSION degrades to cancelled-unknown rather than skipping the alert', () => {
    const step = extractStep(watcher, 'Classify and alert')
    expect(step.runScript).toMatch(/KIND="cancelled-unknown"/)
  })

  it('the alert-notify HTTP code is captured, written to the step summary, and a non-200 fails the job (code-review finding: a warning-only annotation left this watcher green on a failed delivery, defeating its purpose)', () => {
    const step = extractStep(watcher, 'Classify and alert')
    expect(step.runScript).toMatch(
      /if RESPONSE_CODE=\$\(curl -s -o \/dev\/null -w '%\{http_code\}'/
    )
    expect(step.runScript).toMatch(/alert-notify HTTP \| \$HTTP/)
    expect(step.runScript).toMatch(/::error::alert-notify returned \$HTTP/)
    expect(step.runScript).toMatch(/exit 1/)
  })

  it('posts the type: "indexer_backfill_cancelled" alert (a free-form string alert-notify only presence-validates)', () => {
    const step = extractStep(watcher, 'Classify and alert')
    expect(step.runScript).toMatch(/type:"indexer_backfill_cancelled"/)
  })
})

describe('SMI-5964 Case 13: indexer-backfill.yml (§3e edits only -- no if:/timeout-minutes change)', () => {
  const backfill = readFileSync(BACKFILL_PATH, 'utf8')

  it('no timeout-minutes was added to any step -- only the pre-existing job-level 330 remains', () => {
    const matches = backfill.match(/timeout-minutes:/g) ?? []
    expect(matches).toHaveLength(1)
    expect(backfill).toMatch(/timeout-minutes: 330/)
  })

  it('the two if: failure() conditions are unchanged', () => {
    const matches = backfill.match(/if: failure\(\)/g) ?? []
    expect(matches).toHaveLength(2)
  })

  it('Send Alert on Failure captures the alert-notify HTTP code, writes it to the step summary, and fails the step on non-200 (code-review finding: a warning-only annotation left this step green on a failed delivery)', () => {
    const step = extractStep(backfill, 'Send Alert on Failure')
    expect(step.runScript).toMatch(
      /if RESPONSE_CODE=\$\(curl -s -o \/dev\/null -w '%\{http_code\}'/
    )
    expect(step.runScript).toMatch(/alert-notify HTTP \| \$HTTP/)
    expect(step.runScript).toMatch(/::error::alert-notify returned \$HTTP/)
    expect(step.runScript).toMatch(/exit 1/)
  })

  it("Send Alert on Failure uses ${HTTP_CODE:-n/a}, matching Report Failure's existing convention", () => {
    const step = extractStep(backfill, 'Send Alert on Failure')
    expect(step.runScript).toMatch(/\$\{HTTP_CODE:-n\/a\}/)
  })

  it('Send Alert on Failure survives bash -n under hostile fixtures', () => {
    const step = extractStep(backfill, 'Send Alert on Failure')
    for (const fixture of HOSTILE_FIXTURES) {
      const injected = injectEnv(step.runScript, {
        HTTP_CODE: '500',
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

  it('the max_elapsed_minutes input description no longer asserts the falsified "~10-15 min" per-page assumption', () => {
    expect(backfill).not.toMatch(/10-15 min/)
  })

  it('all eight workflow_dispatch input names backfill-rollout-driver.sh passes (:117-119) are unchanged', () => {
    const inputNames = [
      'dry_run',
      'resume_from',
      'path_prefix',
      'min_size_bytes',
      'max_ranges',
      'max_skills_per_dispatch',
      'max_skills_per_repo',
      'max_elapsed_minutes',
    ]
    for (const name of inputNames) {
      expect(backfill).toMatch(new RegExp(`^\\s+${name}:`, 'm'))
    }
  })
})
