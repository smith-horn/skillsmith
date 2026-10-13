/**
 * SMI-7113: scripts/ci/alert-upstream-block.sh decides whether an indexer run's
 * upstream-WAF block reaches a human. It reads the indexer's output file, trusts it only
 * if line 1 names THIS run and attempt (R2-6), and POSTs alert-notify for a newly blocked
 * row or an exhausted bisect budget. `curl` is a stub that records its arguments; nothing
 * touches the network.
 *
 * The control case differs from every other case in exactly one respect, so a red case
 * names the thing it breaks.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'ci', 'alert-upstream-block.sh')

const CURL_STUB = `#!/usr/bin/env bash
body=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-d" ]; then body="$a"; fi
  prev="$a"
done
printf '%s\\n' "$*" >> "$STUB_DIR/curl.args"
printf '%s' "$body" > "$STUB_DIR/curl.body"
[ "$STUB_CURL_FAIL" = "1" ] && exit 7
printf '%s' "\${STUB_HTTP:-200}"
`

const prov = (runId = '4242', attempt = '1') =>
  JSON.stringify({ provenance: { run_id: runId, run_attempt: attempt } })
const blockedRow = {
  repoUrl: 'https://github.com/acme/skill-17',
  fullName: 'acme/skill-17',
  payloadBytes: 119,
  fieldLengths: { description: 17 },
  rayId: '9a1b2c3d4e5f6789',
}
const summary = (data: Record<string, unknown>) =>
  JSON.stringify({ data, meta: { run_type: 'discovery' } })
const withBlock = summary({ upsert_newly_blocked: [blockedRow], upsert_blocked_count: 1 })

interface Opts {
  lines?: string[] | null
  env?: Record<string, string | undefined>
  http?: string
  curlFail?: boolean
}
function run({ lines = [prov(), withBlock], env = {}, http, curlFail }: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'smi7113-alert-'))
  writeFileSync(join(dir, 'curl'), CURL_STUB)
  chmodSync(join(dir, 'curl'), 0o755)
  const file = join(dir, 'indexer-output.jsonl')
  if (lines !== null) writeFileSync(file, lines.join('\n') + '\n')
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    STUB_DIR: dir,
    STUB_HTTP: http ?? '200',
    STUB_CURL_FAIL: curlFail ? '1' : '0',
    INDEXER_OUTPUT_FILE: file,
    INDEXER_STEP_OUTCOME: 'success',
    GITHUB_RUN_ID: '4242',
    GITHUB_RUN_ATTEMPT: '1',
    SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key-for-test',
    RUN_URL: 'https://github.com/example/actions/runs/4242',
    WORKFLOW_NAME: 'Skill Indexer',
    GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
    ...env,
  }
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]
  const r = spawnSync('bash', [SCRIPT], { env: merged, encoding: 'utf8', timeout: 30_000 })
  const read = (n: string) => {
    try {
      return readFileSync(join(dir, n), 'utf8')
    } catch {
      return ''
    }
  }
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    args: read('curl.args'),
    body: read('curl.body'),
  }
}

describe('alert-upstream-block.sh', () => {
  it('control: matching provenance + a newly blocked row -> one POST, exit 0', () => {
    const r = run()
    expect(r.status).toBe(0)
    expect(r.args.trim().split('\n')).toHaveLength(1)
    expect(r.args).toContain('/functions/v1/alert-notify')
    const body = JSON.parse(r.body)
    expect(body).toMatchObject({
      type: 'indexer_upsert_blocked',
      workflow: 'Skill Indexer',
      runId: '4242',
    })
    expect(body.message).toContain('acme/skill-17')
    expect(body.message).toContain('9a1b2c3d4e5f6789')
    expect(body.message).not.toContain('description') // identity only
  })

  it('a budget-exhausted run alerts even with no newly blocked row', () => {
    const r = run({
      lines: [prov(), summary({ upsert_newly_blocked: [], upsert_block_budget_exhausted: true })],
    })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.body).message).toContain('budget')
  })

  it.each([
    ['a different run id', prov('9999', '1')],
    ['a different run attempt', prov('4242', '2')],
  ])('rejects %s in the provenance line: exit 1, no POST', (_n, line) => {
    const r = run({ lines: [line, withBlock] })
    expect(r.status).toBe(1)
    expect(r.out).toContain('provenance mismatch')
    expect(r.args).toBe('')
  })

  it('rejects a file whose first line is not provenance (a stale file from a run that predates it)', () => {
    const r = run({ lines: [withBlock] })
    expect(r.status).toBe(1)
    expect(r.out).toContain('no provenance')
    expect(r.args).toBe('')
  })

  it('an absent output file after a successful step is an error, not a skip', () => {
    const r = run({ lines: null })
    expect(r.status).toBe(1)
    expect(r.out).toContain('absent')
  })

  it.each(['failure', 'skipped', 'cancelled', ''])(
    'skips (exit 0, no POST) when the indexer step outcome is %j',
    (o) => {
      const r = run({ env: { INDEXER_STEP_OUTCOME: o } })
      expect(r.status).toBe(0)
      expect(r.args).toBe('')
    }
  )

  it('skips the lock-skip shape (exit 0, no POST)', () => {
    const lockSkip = JSON.stringify({ event: 'lock_held_by_other_run', request_id: 'r' })
    const r = run({ lines: [prov(), lockSkip] })
    expect(r.status).toBe(0)
    expect(r.args).toBe('')
  })

  it.each([
    ['garbage', 'this is not json'],
    ['a JSON array', '[1,2]'],
    ['a summary with no data object', JSON.stringify({ meta: {} })],
    ['newly_blocked of the wrong type', summary({ upsert_newly_blocked: 'acme/skill-17' })],
    ['budget flag of the wrong type', summary({ upsert_block_budget_exhausted: 'yes' })],
  ])('treats %s after a successful step as an error (exit 1, no POST)', (_n, last) => {
    const r = run({ lines: [prov(), last] })
    expect(r.status).toBe(1)
    expect(r.args).toBe('')
  })

  it('a provenance line with nothing after it is an error', () => {
    const r = run({ lines: [prov()] })
    expect(r.status).toBe(1)
  })

  it.each([
    ['no upsert fields at all (absent = 0)', summary({ found: 3 })],
    [
      'deferred rows only',
      summary({ upsert_newly_blocked: [], upsert_deferred_count: 3, upsert_blocked_count: 0 }),
    ],
    [
      'a known (not newly) blocked row',
      summary({ upsert_newly_blocked: [], upsert_blocked_count: 1 }),
    ],
  ])('does not alert on %s', (_n, last) => {
    const r = run({ lines: [prov(), last] })
    expect(r.status).toBe(0)
    expect(r.args).toBe('')
  })

  it.each([
    ['500', '500', false],
    ['a curl that never completes', '200', true],
  ])('fails the step when alert-notify did not confirm delivery (%s)', (_n, http, curlFail) => {
    const r = run({ http, curlFail })
    expect(r.status).toBe(1)
    expect(r.out).toContain('email was NOT sent')
  })

  it('the kill switch skips only the POST: no curl, exit 0 ...', () => {
    const r = run({ env: { SKILLSMITH_INDEXER_UPSERT_BLOCK_ALERT_DISABLE: '1' } })
    expect(r.status).toBe(0)
    expect(r.args).toBe('')
    expect(r.out).toContain('POST is disabled')
  })

  it('... and still fails loudly on a provenance mismatch', () => {
    const r = run({
      lines: [prov('9999'), withBlock],
      env: { SKILLSMITH_INDEXER_UPSERT_BLOCK_ALERT_DISABLE: '1' },
    })
    expect(r.status).toBe(1)
  })
})
