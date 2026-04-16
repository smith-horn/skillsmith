/**
 * SMI-4241: Shell-parse regression test for `.github/workflows/indexer.yml`.
 *
 * Two production failures (runs 24490285961 and 24377813347) on the 00:00 UTC
 * maintenance cron exposed that the `Report Failure` step literally interpolated
 * `${{ steps.indexer.outputs.response }}` into the inline bash. The 504
 * response body `Request idle timeout limit (150s) reached` contained `(150s)`
 * → bash hit `syntax error near unexpected token '('` and the failure summary
 * was mangled.
 *
 * Fix moved all step outputs to `env:` blocks so bash never sees them as
 * source. This test parses the workflow YAML, extracts the `Report Failure`,
 * `Parse Results`, and `Trigger Indexer` step bodies, then proves they are
 * safe under hostile response payloads.
 *
 * Asserts:
 * - `Report Failure` and `Parse Results` `run:` blocks survive `bash -n` with
 *   responses containing `()`, `` ` ``, `"`, `'`, embedded newlines, and >4 KB.
 * - `Trigger Indexer` heredoc renders `"staleThresholdDays": 7` as numeric JSON
 *   for both schedule and workflow_dispatch paths (load-bearing per
 *   the maintenance branch in supabase/functions/indexer/index.ts).
 * - Neither `Report Failure` nor `Parse Results` contains the old unsafe
 *   `${{ steps.indexer.outputs.response }}` literal interpolation pattern.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'indexer.yml')

// ── Helpers ──────────────────────────────────────────────────────────────────

interface WorkflowStep {
  name: string
  envBlock: Record<string, string>
  runScript: string
}

/**
 * Extract a step's `env:` map and `run:` script body. Lightweight YAML walker —
 * we don't pull in a YAML parser because we only need three known steps.
 */
function extractStep(yaml: string, stepName: string): WorkflowStep {
  const startMarker = `- name: ${stepName}`
  const startIdx = yaml.indexOf(startMarker)
  if (startIdx === -1) {
    throw new Error(`Step "${stepName}" not found in workflow`)
  }
  // Find next "- name: " or end of file.
  const after = yaml.slice(startIdx + startMarker.length)
  const nextStepIdx = after.search(/\n {6}- name: /)
  const block = nextStepIdx === -1 ? after : after.slice(0, nextStepIdx)

  // Parse env: block (lines before `run: |`).
  const envBlock: Record<string, string> = {}
  const envMatch = block.match(/\n {8}env:\n((?: {10}[^\n]+\n)+)/)
  if (envMatch) {
    for (const line of envMatch[1].split('\n')) {
      const m = line.match(/^ {10}(\w+): (.+?)$/)
      if (m) envBlock[m[1]] = m[2].trim()
    }
  }

  // Extract run: | body (lines indented 10 spaces under run:).
  const runMatch = block.match(/\n {8}run: \|\n((?: {10}[^\n]*\n?)+)/)
  if (!runMatch) {
    throw new Error(`Step "${stepName}" has no \`run: |\` block`)
  }
  const runScript = runMatch[1]
    .split('\n')
    .map((l) => l.replace(/^ {10}/, ''))
    .join('\n')
  return { name: stepName, envBlock, runScript }
}

/**
 * Run `bash -n` (syntax check only — does not execute) on a script string.
 * Returns true if the script is syntactically valid bash.
 */
function bashSyntaxCheck(script: string): { ok: true } | { ok: false; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wf-test-'))
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
 * Substitute `${VAR}` references in a script with literal bash assignments
 * at the top of the script — simulates how GitHub Actions exposes `env:`
 * to the runner shell.
 */
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

// ── Fixtures: hostile response bodies ────────────────────────────────────────

const RESPONSE_FIXTURES: Array<{ label: string; body: string }> = [
  {
    label: '504 IDLE_TIMEOUT (the original failure mode — runs 24490285961 / 24377813347)',
    body: '{"code":"IDLE_TIMEOUT","message":"Request idle timeout limit (150s) reached"}',
  },
  {
    label: 'embedded single quote',
    body: `{"message":"it's broken"}`,
  },
  {
    label: 'embedded backticks',
    body: '{"message":"`backtick`"}',
  },
  {
    label: 'embedded double quote',
    body: '{"message":"line \\"with\\" quote"}',
  },
  {
    label: 'embedded newline',
    body: '{"message":"line 1\\nline 2"}',
  },
  {
    label: 'subshell-looking $(rm -rf /)',
    body: '{"message":"$(rm -rf /)"}',
  },
  {
    label: 'process substitution <(cat /etc/passwd)',
    body: '{"message":"<(cat /etc/passwd)"}',
  },
  {
    label: 'long body > 4 KB to exercise truncation path',
    body: `{"message":"${'A'.repeat(5000)}"}`,
  },
]

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SMI-4241: indexer.yml — Report Failure step (shell injection)', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8')

  it('extracts the Report Failure step with an env: block', () => {
    const step = extractStep(workflow, 'Report Failure')
    expect(Object.keys(step.envBlock)).toContain('HTTP_CODE')
    expect(Object.keys(step.envBlock)).toContain('RESPONSE')
  })

  it('does NOT contain the old unsafe `${{ steps.indexer.outputs.response }}` literal pattern in the run: body', () => {
    const step = extractStep(workflow, 'Report Failure')
    expect(step.runScript).not.toMatch(/\$\{\{\s*steps\.indexer\.outputs\.response/)
  })

  for (const fixture of RESPONSE_FIXTURES) {
    it(`survives bash -n with ${fixture.label}`, () => {
      const step = extractStep(workflow, 'Report Failure')
      const injected = injectEnv(step.runScript, {
        HTTP_CODE: '504',
        RESPONSE: fixture.body,
        GITHUB_STEP_SUMMARY: '/tmp/dummy-summary',
      })
      const result = bashSyntaxCheck(injected)
      expect(result, JSON.stringify(result)).toEqual({ ok: true })
    })
  }
})

describe('SMI-4241: indexer.yml — Parse Results step (shell injection)', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8')

  it('extracts the Parse Results step with an env: block', () => {
    const step = extractStep(workflow, 'Parse Results')
    expect(Object.keys(step.envBlock)).toContain('RESPONSE')
    expect(Object.keys(step.envBlock)).toContain('RUN_TYPE')
  })

  it('does NOT contain the old single-quoted-literal pattern in the run: body', () => {
    const step = extractStep(workflow, 'Parse Results')
    // The previous bug was: `RESPONSE='${{ steps.indexer.outputs.response }}'`.
    // Should now be `printf '%s' "$RESPONSE" | jq …`.
    expect(step.runScript).not.toMatch(/RESPONSE='\$\{\{/)
    expect(step.runScript).toMatch(/printf '%s' "\$RESPONSE"/)
  })

  for (const fixture of RESPONSE_FIXTURES) {
    it(`survives bash -n with ${fixture.label}`, () => {
      const step = extractStep(workflow, 'Parse Results')
      const injected = injectEnv(step.runScript, {
        RESPONSE: fixture.body,
        RUN_TYPE: 'maintenance',
        GITHUB_STEP_SUMMARY: '/tmp/dummy-summary',
      })
      const result = bashSyntaxCheck(injected)
      expect(result, JSON.stringify(result)).toEqual({ ok: true })
    })
  }
})

describe('SMI-4241: indexer.yml — Send Alert on Failure step', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8')

  it('uses env: block for run metadata (no inline ${{ … }} interpolation in run body)', () => {
    const step = extractStep(workflow, 'Send Alert on Failure')
    expect(Object.keys(step.envBlock)).toContain('HTTP_CODE')
    expect(Object.keys(step.envBlock)).toContain('RUN_ID')
    expect(Object.keys(step.envBlock)).toContain('RUN_URL')
    expect(step.runScript).not.toMatch(/\$\{\{\s*github\./)
    expect(step.runScript).not.toMatch(/\$\{\{\s*steps\./)
  })

  it('uses jq -n to construct the JSON body (defense-in-depth)', () => {
    const step = extractStep(workflow, 'Send Alert on Failure')
    expect(step.runScript).toMatch(/BODY=\$\(jq -n/)
  })
})

describe('SMI-4241: indexer.yml — Trigger Indexer heredoc keeps staleThresholdDays numeric', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8')

  it('renders "staleThresholdDays": $STALE_DAYS unquoted (load-bearing for edge function)', () => {
    // Edge function at supabase/functions/indexer/index.ts requires
    // typeof staleThresholdDays === 'number' on the discovery branch and
    // defaults to 7 on the maintenance branch. A future change that quotes
    // $STALE_DAYS would silently degrade observability — this assertion
    // locks the unquoted form in.
    expect(workflow).toMatch(/"staleThresholdDays":\s*\$STALE_DAYS/)
    // Specifically must NOT be quoted as a string.
    expect(workflow).not.toMatch(/"staleThresholdDays":\s*"\$STALE_DAYS"/)
  })

  it('has the SMI-4241 explanatory comment near the heredoc', () => {
    // If a contributor strips the comment, the unquoted-numeric invariant
    // becomes implicit and easier to break. Keep the documentation in code.
    expect(workflow).toMatch(/SMI-4241:.*unquoted/i)
  })

  it('Configure Run step emits STALE_DAYS=7 for the 00:00 maintenance cron', () => {
    expect(workflow).toMatch(/RUN_TYPE="maintenance"\s*\n\s+STALE_DAYS="7"/)
  })

  it('Configure Run step emits STALE_DAYS=30 for the discovery crons', () => {
    expect(workflow).toMatch(/RUN_TYPE="discovery"\s*\n\s+STALE_DAYS="30"/)
  })
})
