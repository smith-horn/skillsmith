/**
 * SMI-7114: scripts/ci/refresh-observer.sh is the independent observer of the pg_cron
 * metadata refresh. It reads refresh_metadata_health() over PostgREST, alerts on three
 * arms (stale, dispatch_stale, failures) and writes the `refresh:observer` heartbeat
 * LAST, only after everything else succeeded. `curl` is a stub that logs each call in
 * order; nothing touches the network.
 *
 * The CONTROL case (healthy fixture) proves the harness records a heartbeat when one is
 * due, so the absence assertions in the dead-man cases are not vacuous.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'ci', 'refresh-observer.sh')

const NOW = '2026-10-13T12:00:00Z'
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3600_000).toISOString()

// Records "<kind>" per call in order, keeps each request body, argv and any curl config
// read from stdin (-K -), and answers per kind.
const CURL_STUB = `#!/usr/bin/env bash
out=""; body=""; prev=""; url=""
for a in "$@"; do
  case "$prev" in
    -o) out="$a" ;;
    -d) body="$a" ;;
  esac
  prev="$a"
  url="$a"
done
case "$url" in
  *rpc/refresh_metadata_health) kind=rpc; code="$STUB_RPC_CODE"; resp="$STUB_RPC_BODY" ;;
  *functions/v1/alert-notify) kind=alert; code="$STUB_ALERT_CODE"; resp="$STUB_ALERT_BODY" ;;
  *rest/v1/audit_logs) kind=heartbeat; code="$STUB_HB_CODE"; resp='' ;;
  *) kind=other; code=599; resp='' ;;
esac
echo "$kind" >> "$STUB_DIR/calls.log"
printf '%s' "$*" > "$STUB_DIR/$kind.args"
case " $* " in *" -K - "*) cat > "$STUB_DIR/$kind.config" ;; esac
printf '%s' "$body" > "$STUB_DIR/$kind.body"
[ -n "$out" ] && printf '%s' "$resp" > "$out"
[ "$code" = "000" ] && exit 7
printf '%s' "$code"
`

interface Health {
  last_run: string | null
  last_dispatch: string | null
  last_attempt?: string | null
  failures: unknown[]
  unknown_count: number
}
const healthy = (over: Partial<Health> = {}): Health => ({
  last_run: hoursAgo(2),
  last_dispatch: hoursAgo(2),
  failures: [],
  unknown_count: 0,
  ...over,
})
const transportError = {
  dispatched_at: hoursAgo(3),
  kind: 'transport_error',
  status_code: null,
  error_msg: 'Timeout of 300000 ms reached',
}

interface Opts {
  rpcBody?: string
  rpcCode?: string
  alertCode?: string
  alertResponse?: string
  hbCode?: string
  env?: Record<string, string | undefined>
}
function run({
  rpcBody = JSON.stringify(healthy()),
  rpcCode = '200',
  alertCode = '200',
  alertResponse = '{"data":{"sent":true},"meta":{}}',
  hbCode = '201',
  env = {},
}: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'smi7114-observer-'))
  writeFileSync(join(dir, 'curl'), CURL_STUB)
  chmodSync(join(dir, 'curl'), 0o755)
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    STUB_DIR: dir,
    STUB_RPC_CODE: rpcCode,
    STUB_RPC_BODY: rpcBody,
    STUB_ALERT_CODE: alertCode,
    STUB_ALERT_BODY: alertResponse,
    STUB_HB_CODE: hbCode,
    SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key-for-test',
    REFRESH_OBSERVER_NOW: NOW,
    GITHUB_RUN_ID: '7114',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'smith-horn/skillsmith',
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
  const calls = read('calls.log').split('\n').filter(Boolean)
  const alertBody = read('alert.body')
  return {
    status: r.status,
    out: (r.stdout ?? '') + (r.stderr ?? ''),
    calls,
    alert: alertBody ? (JSON.parse(alertBody) as Record<string, string>) : null,
    heartbeat: read('heartbeat.body') ? JSON.parse(read('heartbeat.body')) : null,
    summary: read('summary.md'),
    args: Object.fromEntries(
      ['rpc', 'alert', 'heartbeat'].map((k) => [k, read(`${k}.args`)])
    ) as Record<string, string>,
    config: Object.fromEntries(
      ['rpc', 'alert', 'heartbeat'].map((k) => [k, read(`${k}.config`)])
    ) as Record<string, string>,
    secretLeaked: (r.stdout + r.stderr + read('summary.md')).includes('service-key-for-test'),
  }
}

describe('refresh-observer.sh', () => {
  it('CONTROL: healthy fixture => exit 0, exactly one heartbeat, and it is the LAST call', () => {
    const r = run()
    expect(r.status, r.out).toBe(0)
    expect(r.calls.filter((c) => c === 'heartbeat')).toHaveLength(1)
    expect(r.calls[r.calls.length - 1]).toBe('heartbeat')
    expect(r.calls).not.toContain('alert')
    expect(r.heartbeat).toMatchObject({
      event_type: 'refresh:observer',
      metadata: { run_id: '7114', arms: [] },
    })
    expect(r.summary).toMatch(/healthy/)
  })

  describe('arms', () => {
    it('last_run 10h old, no failures => POST refresh_unhealthy naming arm stale', () => {
      const r = run({ rpcBody: JSON.stringify(healthy({ last_run: hoursAgo(10) })) })
      expect(r.status, r.out).toBe(0)
      expect(r.calls).toContain('alert')
      expect(r.alert?.type).toBe('refresh_unhealthy')
      expect(r.alert?.message).toMatch(/stale/)
      expect(r.alert?.message).not.toMatch(/dispatch_stale/)
      expect(r.heartbeat?.metadata.arms).toEqual(['stale'])
    })

    it('last_run just inside the 9h window does NOT trip stale (boundary control)', () => {
      const r = run({ rpcBody: JSON.stringify(healthy({ last_run: hoursAgo(8.9) })) })
      expect(r.status, r.out).toBe(0)
      expect(r.calls).not.toContain('alert')
    })

    it('fresh, one transport_error failure => POST naming failures', () => {
      const r = run({ rpcBody: JSON.stringify(healthy({ failures: [transportError] })) })
      expect(r.status, r.out).toBe(0)
      expect(r.calls).toContain('alert')
      expect(r.alert?.message).toMatch(/failures/)
      expect(r.alert?.message).toMatch(/transport_error/)
      expect(r.alert?.message).toMatch(/may still have run/)
      expect(r.heartbeat?.metadata.arms).toEqual(['failures'])
    })

    it.each([
      ['last_dispatch 10h old', hoursAgo(10)],
      ['last_dispatch null', null],
    ])('last_run fresh, %s, no failures => POST naming dispatch_stale', (_l, lastDispatch) => {
      const r = run({ rpcBody: JSON.stringify(healthy({ last_dispatch: lastDispatch })) })
      expect(r.status, r.out).toBe(0)
      expect(r.calls).toContain('alert')
      expect(r.alert?.message).toMatch(/dispatch_stale/)
      expect(r.heartbeat?.metadata.arms).toEqual(['dispatch_stale'])
    })

    it('every tripped arm is named in ONE alert, with the key numbers', () => {
      const r = run({
        rpcBody: JSON.stringify(
          healthy({ last_run: null, last_dispatch: hoursAgo(10), failures: [transportError] })
        ),
      })
      expect(r.status, r.out).toBe(0)
      expect(r.calls.filter((c) => c === 'alert')).toHaveLength(1)
      expect(r.alert?.message).toMatch(/stale/)
      expect(r.alert?.message).toMatch(/dispatch_stale/)
      expect(r.alert?.message).toMatch(/failures/)
      expect(r.alert?.message).toMatch(/10\.0h ago/)
      expect(r.heartbeat?.metadata.arms).toEqual(['stale', 'dispatch_stale', 'failures'])
    })

    it('fresh last_run, one run_failed failure => POST naming it, last_attempt accepted', () => {
      const runFailed = {
        dispatched_at: hoursAgo(1),
        kind: 'run_failed',
        status_code: null,
        error_msg: 'upstream 500',
      }
      const r = run({
        rpcBody: JSON.stringify(healthy({ last_attempt: hoursAgo(1), failures: [runFailed] })),
      })
      expect(r.status, r.out).toBe(0)
      expect(r.calls).toContain('alert')
      expect(r.alert?.message).toMatch(/failures/)
      expect(r.alert?.message).toMatch(/run_failed/)
      expect(r.heartbeat?.metadata.arms).toEqual(['failures'])
    })

    it('last_attempt null or absent is accepted (healthy control)', () => {
      for (const over of [{ last_attempt: null }, {}]) {
        const r = run({ rpcBody: JSON.stringify(healthy(over)) })
        expect(r.status, r.out).toBe(0)
        expect(r.calls).not.toContain('alert')
      }
    })
  })

  describe('dead-man: no heartbeat unless the whole run succeeded', () => {
    it('RPC returns 500 => exit 1, no heartbeat, no healthy summary', () => {
      const r = run({ rpcCode: '500', rpcBody: '{"message":"boom"}' })
      expect(r.status, r.out).toBe(1)
      expect(r.calls).not.toContain('heartbeat')
      expect(r.summary).not.toMatch(/healthy/)
    })

    it('RPC curl itself fails (000) => exit 1, no heartbeat', () => {
      const r = run({ rpcCode: '000' })
      expect(r.status, r.out).toBe(1)
      expect(r.calls).not.toContain('heartbeat')
    })

    it.each([
      ['SUPABASE_SERVICE_ROLE_KEY unset', { SUPABASE_SERVICE_ROLE_KEY: undefined }],
      ['SUPABASE_SERVICE_ROLE_KEY empty', { SUPABASE_SERVICE_ROLE_KEY: '' }],
      ['SUPABASE_URL unset', { SUPABASE_URL: undefined }],
    ])('%s => exit 1 BEFORE any curl, no heartbeat', (_l, env) => {
      const r = run({ env })
      expect(r.status, r.out).toBe(1)
      expect(r.calls).toEqual([])
    })

    it.each([
      ['non-JSON text', 'upstream connect error'],
      ['an empty body', ''],
      ['a JSON array', '[]'],
      [
        'an object without a failures array',
        JSON.stringify({ last_run: hoursAgo(1), last_dispatch: hoursAgo(1) }),
      ],
      ['a non-timestamp last_run', JSON.stringify(healthy({ last_run: 'yesterday-ish' }))],
      ['a last_run 6 minutes in the future', JSON.stringify(healthy({ last_run: hoursAgo(-0.1) }))],
      [
        'a last_attempt 6 minutes in the future',
        JSON.stringify(healthy({ last_attempt: hoursAgo(-0.1) })),
      ],
      [
        'a last_dispatch 6 minutes in the future',
        JSON.stringify(healthy({ last_dispatch: hoursAgo(-0.1) })),
      ],
    ])('RPC returns %s with 200 => exit 1, no heartbeat', (_l, body) => {
      const r = run({ rpcBody: body })
      expect(r.status, r.out).toBe(1)
      expect(r.calls).not.toContain('heartbeat')
      expect(r.calls).not.toContain('alert')
    })

    it.each(['500', '401', '000'])(
      'stale fixture, alert-notify answers %s => exit 1, no heartbeat',
      (alertCode) => {
        const r = run({
          rpcBody: JSON.stringify(healthy({ last_run: hoursAgo(10) })),
          alertCode,
        })
        expect(r.status, r.out).toBe(1)
        expect(r.calls).toContain('alert')
        expect(r.calls).not.toContain('heartbeat')
      }
    )

    it.each([
      ['sent:false', '{"data":{"sent":false}}'],
      ['an unparseable body', 'upstream connect error'],
      ['an empty body', ''],
      ['a body without data', '{}'],
      ['sent as the string "true"', '{"data":{"sent":"true"}}'],
    ])('stale fixture, alert-notify 200 with %s => exit 1, no heartbeat', (_l, alertResponse) => {
      const r = run({ rpcBody: JSON.stringify(healthy({ last_run: hoursAgo(10) })), alertResponse })
      expect(r.status, r.out).toBe(1)
      expect(r.calls).toContain('alert')
      expect(r.calls).not.toContain('heartbeat')
      expect(r.out).toMatch(/::error::/)
    })

    it('stale fixture, alert-notify 200 with sent:true => exit 0 with heartbeat (control)', () => {
      const r = run({
        rpcBody: JSON.stringify(healthy({ last_run: hoursAgo(10) })),
        alertResponse: '{"data":{"sent":true}}',
      })
      expect(r.status, r.out).toBe(0)
      expect(r.calls[r.calls.length - 1]).toBe('heartbeat')
    })

    it('healthy fixture but the heartbeat insert is refused => exit 1', () => {
      const r = run({ hbCode: '401' })
      expect(r.status, r.out).toBe(1)
      expect(r.calls).toContain('heartbeat')
    })
  })

  describe('SKILLSMITH_REFRESH_OBSERVER_ALERT_DISABLE=1', () => {
    it('stale fixture => no alert POST, NO heartbeat, warning, exit 0, summary names the arm', () => {
      const r = run({
        rpcBody: JSON.stringify(healthy({ last_run: hoursAgo(10) })),
        env: { SKILLSMITH_REFRESH_OBSERVER_ALERT_DISABLE: '1' },
      })
      expect(r.status, r.out).toBe(0)
      expect(r.calls).not.toContain('alert')
      expect(r.calls).not.toContain('heartbeat')
      expect(r.out).toMatch(/::warning::/)
      expect(r.summary).toMatch(/stale/)
    })

    it('healthy fixture => heartbeat still written (the switch only gates alerting)', () => {
      const r = run({ env: { SKILLSMITH_REFRESH_OBSERVER_ALERT_DISABLE: '1' } })
      expect(r.status, r.out).toBe(0)
      expect(r.calls[r.calls.length - 1]).toBe('heartbeat')
      expect(r.out).not.toMatch(/::warning::/)
    })

    it('only the exact value "1" disables the alert', () => {
      const r = run({
        rpcBody: JSON.stringify(healthy({ last_run: hoursAgo(10) })),
        env: { SKILLSMITH_REFRESH_OBSERVER_ALERT_DISABLE: 'true' },
      })
      expect(r.calls).toContain('alert')
    })
  })

  describe('service-role key handling', () => {
    // Built from short pieces so no single 44+ character run of word characters sits in the source.
    const b62 = 'aB3dE5fG7hJ9kL1mN3pQ'
    const keys: Array<[string, string]> = [
      ['plain', 'service-key-for-test'],
      [
        'JWT-like',
        ['eyJhbGciOiJIUzI1NiJ9', 'eyJyb2xlIjoic2VydmljZV9yb2xlIn0', 'abc_DEF-123'].join('.'),
      ],
      ['sb_secret_', 'sb_secret_' + b62 + b62],
    ]
    it.each(keys)(
      'the key (%s) is in no curl argv, but every request still carries it via the stdin config',
      (_shape, key) => {
        const r = run({
          rpcBody: JSON.stringify(healthy({ last_run: hoursAgo(10) })),
          env: { SUPABASE_SERVICE_ROLE_KEY: key },
        })
        expect(r.calls).toEqual(['rpc', 'alert', 'heartbeat'])
        for (const k of ['rpc', 'alert', 'heartbeat']) {
          expect(r.args[k], `${k} argv`).not.toContain(key)
          // Presence: the stub saw the key where curl would read it, so the absence above
          // is not vacuous.
          expect(r.config[k], `${k} stdin config`).toContain(`apikey: ${key}`)
          expect(r.config[k], `${k} stdin config`).toContain(`Authorization: Bearer ${key}`)
        }
        expect(r.out + r.summary).not.toContain(key)
      }
    )
  })

  describe('operational timeout', () => {
    it('every curl call carries --max-time between 30 and 120 seconds', () => {
      const r = run({ rpcBody: JSON.stringify(healthy({ last_run: hoursAgo(10) })) })
      expect(r.calls).toEqual(['rpc', 'alert', 'heartbeat'])
      for (const k of ['rpc', 'alert', 'heartbeat']) {
        const m = /(?:^|\s)--max-time\s+(\d+)(?:\s|$)/.exec(r.args[k])
        expect(m, `${k} has --max-time in argv: ${r.args[k]}`).not.toBeNull()
        const secs = Number(m?.[1])
        expect(secs, `${k} --max-time`).toBeGreaterThanOrEqual(30)
        expect(secs, `${k} --max-time`).toBeLessThanOrEqual(120)
      }
    })
  })

  it('never writes the service-role key to its output or summary', () => {
    const r = run({ rpcBody: JSON.stringify(healthy({ last_run: hoursAgo(10) })) })
    expect(r.secretLeaked).toBe(false)
  })
})
