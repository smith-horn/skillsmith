/**
 * SMI-7112 (R3-1): scripts/ci/autochain-read-enable.sh is the autochain's
 * authoritative pre-dispatch read. It must exit 0 ONLY for a successful API
 * read that yields exactly "0"; every other outcome exits 1 so the dispatch step
 * never runs. A stubbed `gh` plays each outcome; nothing calls GitHub.
 *
 * Fixture: GH_TOKEN and GITHUB_REPOSITORY are set, so every case differs from
 * the control only in what the (stubbed) API says.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'ci', 'autochain-read-enable.sh')

// Per variable: BACKFILL_KILL_SWITCH plays KS_MODE/KS_VALUE (default: readable "0");
// every other read plays STUB_MODE/STUB_VALUE.
const GH_STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/args.log"
case "$*" in
  *BACKFILL_KILL_SWITCH*) MODE="\${KS_MODE:-value}"; VAL="\${KS_VALUE-0}" ;;
  *) MODE="$STUB_MODE"; VAL="$STUB_VALUE" ;;
esac
case "$MODE" in
  value) printf '%s\\n' "$VAL"; exit 0 ;;
  raw) printf '%s' "$VAL"; exit 0 ;;
  401) echo "gh: Bad credentials (HTTP 401)" >&2; exit 1 ;;
  404) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  403) echo "gh: Resource not accessible by personal access token (HTTP 403)" >&2; exit 1 ;;
  net) echo "error connecting to api.github.com" >&2; exit 1 ;;
  500) echo "gh: Server Error (HTTP 500)" >&2; exit 1 ;;
esac
exit 99
`

function run(
  mode: string,
  value = '',
  over: Record<string, string | undefined> = {},
  cliArgs: string[] = []
) {
  const dir = mkdtempSync(join(tmpdir(), 'smi7112-read-'))
  writeFileSync(join(dir, 'gh'), GH_STUB)
  chmodSync(join(dir, 'gh'), 0o755)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    STUB_DIR: dir,
    STUB_MODE: mode,
    STUB_VALUE: value,
    GH_TOKEN: 'pat-for-test',
    GITHUB_REPOSITORY: 'smith-horn/skillsmith',
    ...over,
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
  const r = spawnSync('bash', [SCRIPT, ...cliArgs], { env, encoding: 'utf8', timeout: 30_000 })
  let args = ''
  try {
    args = readFileSync(join(dir, 'args.log'), 'utf8')
  } catch {
    /* gh never called */
  }
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), args }
}

describe('autochain-read-enable.sh', () => {
  it('CONTROL: value "0" => exit 0 (and the read targets the variables API for this repo)', () => {
    const r = run('value', '0')
    expect(r.status, r.out).toBe(0)
    expect(r.args).toContain(
      'repos/smith-horn/skillsmith/actions/variables/BACKFILL_AUTOCHAIN_DISABLE'
    )
  })

  describe('the BACKFILL_KILL_SWITCH re-read (SMI-7121 G2)', () => {
    it('reads it AFTER the enable variable, in the same command', () => {
      const r = run('value', '0')
      const lines = r.args.trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain('actions/variables/BACKFILL_AUTOCHAIN_DISABLE')
      expect(lines[1]).toContain(
        'repos/smith-horn/skillsmith/actions/variables/BACKFILL_KILL_SWITCH'
      )
    })

    it('"1" (engaged) => exit 1, never a dispatch', () => {
      const r = run('value', '0', { KS_VALUE: '1' })
      expect(r.status, r.out).toBe(1)
      expect(r.out).toMatch(/::error::.*BACKFILL_KILL_SWITCH is "1" \(engaged\)/)
    })

    it.each([
      ['403', '403', /403/],
      ['401', '401', /expired or revoked/],
      ['5xx', '500', /BACKFILL_KILL_SWITCH failed/],
      ['network error', 'net', /BACKFILL_KILL_SWITCH failed/],
    ])('a failed read (%s) => exit 1 (an unread kill switch is never "off")', (_l, mode, msg) => {
      const r = run('value', '0', { KS_MODE: mode })
      expect(r.status, r.out).toBe(1)
      expect(r.out).toMatch(msg)
    })

    it.each([
      ['404 (unset)', { KS_MODE: '404' }, /BACKFILL_KILL_SWITCH is unset/],
      ['"0"', { KS_VALUE: '0' }, /not engaged/],
      ['empty', { KS_VALUE: '' }, /not engaged/],
    ])('%s => not engaged, exit 0', (_l, over, msg) => {
      const r = run('value', '0', over)
      expect(r.status, r.out).toBe(0)
      expect(r.out).toMatch(msg)
    })

    it('a failed enable read stops before the kill-switch read', () => {
      const r = run('403', '', { KS_VALUE: '0' })
      expect(r.status).toBe(1)
      expect(r.args).not.toContain('BACKFILL_KILL_SWITCH')
    })

    it('--verify-read reports an engaged switch without failing, and fails on an unreadable one', () => {
      const ok = run('value', '0', { KS_VALUE: '1' }, ['--verify-read'])
      expect(ok.status, ok.out).toBe(0)
      expect(ok.out).toMatch(/BACKFILL_KILL_SWITCH is engaged \(no dispatch authorised\)/)
      const bad = run('value', '0', { KS_MODE: '403' }, ['--verify-read'])
      expect(bad.status).toBe(1)
    })
  })

  it.each([
    ['"1" (disabled)', 'value', '1'],
    ['empty value', 'value', ''],
    ['leading space " 0"', 'value', ' 0'],
    ['trailing space "0 "', 'value', '0 '],
    ['"00"', 'value', '00'],
    ['"false"', 'value', 'false'],
    ['"0" followed by an extra newline in the value', 'value', '0\n'],
    ['no output at all', 'raw', ''],
  ])('%s => exit 1', (_label, mode, value) => {
    const r = run(mode, value)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toMatch(/::error::/)
  })

  it('404 (variable missing) => exit 1, error names the cause', () => {
    const r = run('404')
    expect(r.status, r.out).toBe(1)
    expect(r.out).toMatch(/does not exist \(404\)/)
  })

  it('403 (token cannot read variables) => exit 1, error names the cause', () => {
    const r = run('403')
    expect(r.status, r.out).toBe(1)
    expect(r.out).toMatch(/403/)
  })

  it.each([
    ['network error', 'net'],
    ['5xx', '500'],
  ])('%s => exit 1', (_label, mode) => {
    const r = run(mode)
    expect(r.status, r.out).toBe(1)
  })

  it('a missing/empty token (secret not provisioned) => exit 1 WITHOUT calling gh', () => {
    const r = run('value', '0', { GH_TOKEN: '' })
    expect(r.status, r.out).toBe(1)
    expect(r.args).toBe('')
  })

  it('no GITHUB_REPOSITORY => exit 1 WITHOUT calling gh', () => {
    const r = run('value', '0', { GITHUB_REPOSITORY: '' })
    expect(r.status, r.out).toBe(1)
    expect(r.args).toBe('')
  })

  it('401 (PAT expired or revoked) => exit 1, classified explicitly (fail closed)', () => {
    const r = run('401')
    expect(r.status, r.out).toBe(1)
    expect(r.out).toMatch(/401/)
    expect(r.out).toMatch(/expired or revoked/)
  })

  it('an unknown argument => exit 1 WITHOUT calling gh', () => {
    const r = run('value', '0', {}, ['--dispatch'])
    expect(r.status, r.out).toBe(1)
    expect(r.args).toBe('')
  })

  describe('--verify-read (verify-only autochain runs)', () => {
    it.each([
      ['"0" (enabled)', '0'],
      ['"1" (disabled)', '1'],
    ])('a readable well-formed %s => exit 0 (the PAT works; nothing is authorised)', (_l, v) => {
      const r = run('value', v, {}, ['--verify-read'])
      expect(r.status, r.out).toBe(0)
      expect(r.out).toMatch(/no dispatch authorised/)
    })

    it.each([
      ['empty', 'value', ''],
      ['malformed "yes"', 'value', 'yes'],
      ['padded " 1"', 'value', ' 1'],
      ['404', '404', ''],
      ['403', '403', ''],
      ['401', '401', ''],
      ['network error', 'net', ''],
      ['5xx', '500', ''],
    ])('%s => exit 1 (a failed or malformed read turns the verify run red)', (_l, mode, v) => {
      const r = run(mode, v, {}, ['--verify-read'])
      expect(r.status, r.out).toBe(1)
      expect(r.out).toMatch(/::error::/)
    })

    it('a missing token => exit 1 WITHOUT calling gh', () => {
      const r = run('value', '0', { GH_TOKEN: '' }, ['--verify-read'])
      expect(r.status, r.out).toBe(1)
      expect(r.args).toBe('')
    })
  })
})
