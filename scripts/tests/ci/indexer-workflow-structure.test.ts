/**
 * SMI-7113: both indexer workflows must carry the upstream-block output provenance and
 * the alert step, in the right order, and the pieces must agree with each other.
 *
 * A step that exists only in one file, or an alert step gated on `success()`, is the exact
 * silent-gap shape this wave closes: the alert would not fire for the case that matters
 * (the run that went green while a row was being refused). So the structure is asserted
 * per file, and the indexer step's real shell is executed once to prove the file it writes
 * is the file the alert script accepts.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { extractStep } from '../_lib/workflow-yaml.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ALERT_SCRIPT = join(REPO_ROOT, 'scripts', 'ci', 'alert-upstream-block.sh')

const WORKFLOWS = [
  { file: 'indexer.yml', runStep: 'Run indexer', id: 'indexer' },
  { file: 'indexer-backfill.yml', runStep: 'Run backfill indexer', id: 'backfill_run' },
] as const

const read = (file: string) => readFileSync(join(REPO_ROOT, '.github', 'workflows', file), 'utf8')
const stepNames = (yaml: string) =>
  [...yaml.matchAll(/\n {6}- name: (.+)/g)].map((m) => m[1].trim())

describe.each(WORKFLOWS)('$file', ({ file, runStep, id }) => {
  const yaml = read(file)
  const names = stepNames(yaml)

  it('resets the output file immediately before the indexer step', () => {
    const at = names.indexOf(runStep)
    expect(at).toBeGreaterThan(0)
    expect(names[at - 1]).toBe('Reset indexer output')
    expect(extractStep(yaml, 'Reset indexer output').runScript).toContain(
      'rm -f "$RUNNER_TEMP/indexer-output.jsonl"'
    )
  })

  it('creates the file exclusively with a run+attempt provenance line, then appends the output', () => {
    const script = extractStep(yaml, runStep).runScript
    expect(script).toContain('set -o noclobber')
    expect(script).toContain('"$GITHUB_RUN_ID"')
    expect(script).toContain('"$GITHUB_RUN_ATTEMPT"')
    expect(script).toContain('tee -a "$OUTPUT_FILE"')
    expect(script).toContain('$RUNNER_TEMP/indexer-output.jsonl')
  })

  it('passes the WAF kill switch and budget into the indexer step', () => {
    const env = extractStep(yaml, runStep).envBlock
    expect(env).toHaveProperty('SKILLSMITH_INDEXER_UPSERT_BISECT_DISABLE')
    expect(env).toHaveProperty('INDEXER_UPSERT_BLOCK_BISECT_BUDGET')
  })

  it('runs the alert step after the indexer step, on always() && !cancelled(), via the script', () => {
    expect(names.indexOf('Alert on upstream upsert block')).toBeGreaterThan(names.indexOf(runStep))
    const start = yaml.indexOf('- name: Alert on upstream upsert block')
    const block = yaml.slice(start, yaml.indexOf('\n      - name: ', start + 10))
    expect(block).toMatch(/\n {8}if: always\(\) && !cancelled\(\)\n/)
    expect(block).not.toMatch(/if: success\(\)/)
    const step = extractStep(yaml, 'Alert on upstream upsert block')
    expect(step.runScript).toContain('scripts/ci/alert-upstream-block.sh')
    expect(step.envBlock.INDEXER_STEP_OUTCOME).toBe(`\${{ steps.${id}.outcome }}`)
    expect(step.envBlock).toHaveProperty('SKILLSMITH_INDEXER_UPSERT_BLOCK_ALERT_DISABLE')
  })

  it('writes a file the alert script accepts, refuses to reuse a stale one, and keeps RESPONSE clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smi7113-wf-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const block = {
      repoUrl: 'https://github.com/acme/skill-17',
      fullName: 'acme/skill-17',
      payloadBytes: 119,
      fieldLengths: {},
      rayId: 'abc123def456',
    }
    const summary = JSON.stringify({
      data: { upsert_newly_blocked: [block] },
      meta: { run_type: 'discovery' },
    })
    // `npx tsx scripts/indexer/run.ts` plays the indexer; curl plays alert-notify.
    writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash\nprintf '%s\\n' '${summary}'\n`)
    writeFileSync(
      join(bin, 'curl'),
      `#!/usr/bin/env bash\nprintf '%s' "$*" >> "${dir}/curl.args"\nprintf 200\n`
    )
    chmodSync(join(bin, 'npx'), 0o755)
    chmodSync(join(bin, 'curl'), 0o755)
    const scriptFile = join(dir, 'step.sh')
    writeFileSync(scriptFile, extractStep(yaml, runStep).runScript)
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RUNNER_TEMP: dir,
      GITHUB_RUN_ID: '777',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_OUTPUT: join(dir, 'gh-output'),
    }
    const first = spawnSync('bash', [scriptFile], { env, encoding: 'utf8' })
    expect(first.status).toBe(0)
    const file = join(dir, 'indexer-output.jsonl')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0])).toEqual({ provenance: { run_id: '777', run_attempt: '2' } })
    expect(lines[lines.length - 1]).toBe(summary)
    // RESPONSE is the indexer's last line, never the provenance line.
    expect(readFileSync(join(dir, 'gh-output'), 'utf8')).toContain(`response=${summary}`)

    // The file the workflow wrote is the file the alert script trusts, for this run only.
    const alertEnv = {
      ...env,
      INDEXER_OUTPUT_FILE: file,
      INDEXER_STEP_OUTCOME: 'success',
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
    }
    const ok = spawnSync('bash', [ALERT_SCRIPT], { env: alertEnv, encoding: 'utf8' })
    expect(ok.status).toBe(0)
    expect(readFileSync(join(dir, 'curl.args'), 'utf8')).toContain('alert-notify')
    const wrongAttempt = spawnSync('bash', [ALERT_SCRIPT], {
      env: { ...alertEnv, GITHUB_RUN_ATTEMPT: '3' },
      encoding: 'utf8',
    })
    expect(wrongAttempt.status).toBe(1)

    // Without the Reset step the stale file is still there: creation must fail, not append.
    const second = spawnSync('bash', [scriptFile], { env, encoding: 'utf8' })
    expect(second.status).not.toBe(0)
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(lines.length)
  })
})
