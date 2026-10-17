/**
 * SMI-7121: scripts/ci/autochain-alert.sh posts the autochain's
 * {type, message, workflow, runId, runUrl} alert and succeeds ONLY on HTTP 200.
 * A stubbed curl records the request; nothing calls the network.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const SCRIPT = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
  'scripts/ci/autochain-alert.sh'
)

// curl stub: saves its -d payload and URL, prints $HTTP_CODE (the -w output), exits $CURL_RC.
const CURL = `#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    -d) printf '%s' "$2" > "$STUB_DIR/body.json"; shift 2 ;;
    -o|-w|-X|-H) shift 2 ;;
    -s) shift ;;
    *) printf '%s' "$1" > "$STUB_DIR/url"; shift ;;
  esac
done
printf '%s' "\${HTTP_CODE:-200}"
exit "\${CURL_RC:-0}"
`

function alert(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'smi7121-alert-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'curl'), CURL)
  chmodSync(join(dir, 'bin', 'curl'), 0o755)
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      STUB_DIR: dir,
      GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      ALERT_TYPE: 'indexer_backfill_autochain_halted',
      ALERT_MESSAGE: 'it said "hi"; $(rm -rf /) `x`\nline2',
      ALERT_RUN_ID: '42',
      ALERT_RUN_URL: 'https://github.com/o/r/actions/runs/42',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'key',
      ...env,
    },
  })
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '')
  return {
    status: r.status,
    out: r.stdout + r.stderr,
    body: read('body.json'),
    url: read('url'),
    summary: read('summary'),
  }
}

describe('autochain-alert.sh', () => {
  it('HTTP 200: exit 0, the exact payload shape, values passed as data', () => {
    const r = alert({})
    expect(r.status, r.out).toBe(0)
    expect(JSON.parse(r.body)).toEqual({
      type: 'indexer_backfill_autochain_halted',
      message: 'it said "hi"; $(rm -rf /) `x`\nline2',
      workflow: 'Skill Indexer Backfill Autochain',
      runId: '42',
      runUrl: 'https://github.com/o/r/actions/runs/42',
    })
    expect(r.url).toBe('https://example.supabase.co/functions/v1/alert-notify')
    expect(r.summary).toContain('HTTP: 200')
  })

  it.each(['500', '201', '000'])('HTTP %s: exit 1, says the email was NOT sent', (code) => {
    const r = alert({ HTTP_CODE: code })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/email was NOT sent/)
  })

  it('a curl failure: exit 1', () => {
    expect(alert({ CURL_RC: '7' }).status).toBe(1)
  })

  it.each(['ALERT_TYPE', 'ALERT_MESSAGE', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])(
    'missing %s: exit 1 without calling curl',
    (v) => {
      const r = alert({ [v]: '' })
      expect(r.status).toBe(1)
      expect(r.body).toBe('')
    }
  )
})
