/**
 * SMI-6954 Wave 2: the daily workflow's seed loop and its failure-specific issue text
 * (rows W1-W6 of docs/internal/implementation/smi-6954-seed-lockfile-dependency-registry.md).
 * Executes the workflow's own script with stub node, npm and gh.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeFixtureTempDir } from './_lib/git-fixture-env'
import {
  FINDINGS_AUDIT,
  REPO_ROOT,
  exec,
  section,
  verbs,
} from './dependency-registry-expiry.harness'

const LIST_HEADING =
  '### Seed lockfiles not listed (fails this daily job only; code PRs are not blocked)'

// Any existing repo directory works as the seed directory: the stub npm records its cwd.
const SEED = 'scripts/tests/fixtures/package-lock.json'
const GREEN =
  'Check 76: dependency registry coherence and expiry (SMI-6949)\n' +
  '✓ Check 76: dependency registry coherent (1 override entries for 1 override leaves, 1 acceptances examined)\n'
const ROOT_OK =
  '✓ Check 76 reconcile: 1 acceptances match the npm audit report; no unaccepted advisories\n'
const SEED_FAIL = `✗ Check 76 reconcile [${SEED}]: unaccepted advisory GHSA-aaaa-bbbb-cccc (pkg, high) is reported by npm audit for ${SEED} and has no acceptance\n`
const SEED_OK = `✓ Check 76 reconcile [${SEED}]: 1 acceptances match the npm audit report for ${SEED}; no unaccepted advisories\n`
const EXPIRED =
  '✗ Check 76: acceptance GHSA-ffff-gggg-hhhh (pkg, tier R2, owner someone) expired 2026-10-01 (UTC). Re-triage.\n'
const INFO =
  'ℹ Check 76 reconcile (informational): advisory GHSA-iiii-jjjj-kkkk (prodpkg, moderate) has no acceptance; it is listed here for visibility only\n'
const root = (rec = ROOT_OK, recRc = 0) => ({ rec, recRc })

describe('seed loop', () => {
  it('W1 runs npm audit with the pinned flags inside each listed seed directory, then reconciles with --seed', () => {
    const r = exec(GREEN, 0, '', '', root(), { list: `${SEED}\n`, rec: SEED_OK })
    expect(r.status).toBe(0)
    expect(r.npmCwds).toEqual([REPO_ROOT, `${REPO_ROOT}/scripts/tests/fixtures`])
    const audits = r.nodeCalls.filter((c) => c.startsWith('audit '))
    expect(audits).toHaveLength(2)
    for (const flag of [
      '--json',
      '--package-lock-only',
      '--offline=false',
      '--prefer-offline=false',
      '--registry=https://registry.npmjs.org',
      '--userconfig=/dev/null',
    ]) {
      expect(audits[1].split(' ')).toContain(flag)
    }
    expect(
      r.nodeCalls.some((c) =>
        /^scripts\/check-dependency-registry\.mjs --reconcile-audit \S*audit-seed-1\.json --seed scripts\/tests\/fixtures\/package-lock\.json$/.test(
          c
        )
      )
    ).toBe(true)
    expect(r.stdout).toContain(`Check 76 reconcile [${SEED}]`)
  })
  it('W1 control: no listed seeds means no seed audit and no --seed call', () => {
    const r = exec(GREEN, 0, '', '', root())
    expect(r.npmCwds).toEqual([REPO_ROOT])
    expect(r.nodeCalls.some((c) => c.includes('--seed'))).toBe(false)
  })
  it('W2 a seed reconcile failure opens the issue and fails the job while the root is clean', () => {
    const r = exec(GREEN, 0, '', '', root(), { list: `${SEED}\n`, rec: SEED_FAIL, recRc: 1 })
    expect(r.status).toBe(1)
    expect(verbs(r.calls)).toContain('issue create')
    expect(r.body).toContain('unaccepted advisory GHSA-aaaa-bbbb-cccc')
  })
  it('a seed npm audit exiting 1 because it found advisories still reconciles that seed (SMI-6993)', () => {
    const r = exec(GREEN, 0, '', '', root(), {
      list: `${SEED}\n`,
      auditOut: FINDINGS_AUDIT,
      auditRc: 1,
      rec: SEED_OK,
    })
    expect(r.status).toBe(0)
    expect(r.nodeCalls.some((c) => c.includes(`--seed ${SEED}`))).toBe(true)
  })
  it('W3 a seed npm audit with no output is an ::error:: and a failure, never clean', () => {
    const r = exec(GREEN, 0, '', '', root(), { list: `${SEED}\n`, auditOut: '' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain(`::error::npm audit produced no JSON output for ${SEED}`)
    expect(r.nodeCalls.some((c) => c.includes('--seed'))).toBe(false)
    expect(r.body).toContain(SEED)
  })
  it('W6 a failing --list-seeds gets its own section carrying the real cause, not the root reconcile', () => {
    // The cause comes from the REAL CLI, run where it cannot find the registry.
    const real = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts/check-dependency-registry.mjs'), '--list-seeds'],
      { cwd: makeFixtureTempDir('smi6994-ls'), encoding: 'utf8' }
    )
    expect(real.status).toBe(1)
    expect(real.stderr.startsWith('Check 76 --list-seeds: cannot read')).toBe(true)
    const cause = real.stderr.replace(/\n$/, '')
    const r = exec(GREEN, 0, '', '', root(), { listRc: 1, listErr: cause })
    expect(r.status).toBe(1)
    const sec = section(r.body, LIST_HEADING)
    expect(sec).toBeDefined()
    expect(sec).toContain('--list-seeds failed (exit 1)')
    for (const line of cause.split('\n')) expect(sec).toContain('    ' + line)
    expect(sec).toContain('Reproduce: node scripts/check-dependency-registry.mjs --list-seeds')
    expect(r.body).not.toContain('### Failing root reconcile')
    expect(r.body).not.toContain('--reconcile-audit A.json.')
    expect(r.body).not.toContain('every code PR fails')
  })
  it('W6b a --list-seeds usage error (exit 2) is reported as exit 2 and the job exits 2', () => {
    const r = exec(GREEN, 0, '', '', root(), {
      listRc: 2,
      listErr: 'usage: --list-seeds takes no argument',
    })
    expect(r.status).toBe(2)
    const sec = section(r.body, LIST_HEADING)
    expect(sec).toBeDefined()
    expect(sec).toContain('--list-seeds failed (exit 2)')
  })
  // Markdown (CommonMark) ends a line at LF, CR or CRLF, so the body is split on all three.
  it.each([
    ['LF', '\n'],
    ['CR', '\r'],
    ['CRLF', '\r\n'],
  ])(
    'W6c a multiline cause (%s) with markdown and mentions is indented line by line, never raw',
    (_n, sep) => {
      const payload = [
        'Check 76 --list-seeds: cannot read x',
        '### injected heading',
        '```sh',
        '<details><summary>injected</summary>',
        '@team please look',
      ]
      const r = exec(GREEN, 0, '', '', root(), { listRc: 1, listErr: payload.join(sep) })
      const sec = section(r.body, LIST_HEADING)
      expect(sec).toBeDefined()
      // Absence first: no unindented copy of any payload line anywhere in the body...
      const bodyLines = r.body.split(/\r\n|\r|\n/)
      for (const line of payload) {
        for (const b of bodyLines.filter((l) => l.includes(line))) expect(b).toBe('    ' + line)
      }
      for (const lead of ['### injected', '```', '<details>', '@team']) {
        expect(bodyLines.filter((l) => l.startsWith(lead))).toEqual([])
      }
      // ...paired with presence from the same run: every payload line is there, indented.
      const secLines = (sec as string).split(/\r\n|\r|\n/)
      for (const line of payload) expect(secLines).toContain('    ' + line)
    }
  )
})

describe('failure-specific issue text (PR-2, #3005 retro)', () => {
  it('W4 a seed-reconcile-only failure names the seed and does not claim code PRs fail', () => {
    const r = exec(GREEN, 0, '', '', root(), { list: `${SEED}\n`, rec: SEED_FAIL, recRc: 1 })
    expect(r.body).toContain(`### Failing seed reconcile (fails this daily job only`)
    expect(r.body).toContain(SEED)
    expect(r.body).toContain(`--seed '${SEED}'`) // the seed remediation command, shell-quoted
    expect(r.body).not.toContain('every code PR fails')
  })
  it('W4b a failed seed path with a space stays one path, single-quoted, in one remediation block', () => {
    const SP = 'scripts/my seed/package-lock.json'
    const rec = SEED_FAIL.split(SEED).join(SP)
    const r = exec(GREEN, 0, '', '', root(), { list: `${SP}\n`, rec, recRc: 1 })
    expect(r.status).toBe(1)
    const blocks = r.body.split('\n').filter((l) => l.startsWith('Reproduce '))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatch(
      /^Reproduce 'scripts\/my seed\/package-lock\.json': \(cd 'scripts\/my seed' && npm audit .*\) > A\.json, then node scripts\/check-dependency-registry\.mjs --reconcile-audit A\.json --seed 'scripts\/my seed\/package-lock\.json'$/
    )
  })
  it('W4 an expiry failure still says every code PR fails', () => {
    const r = exec(EXPIRED, 1, '', '', root())
    expect(r.body).toContain('### Failing (every code PR fails until this is fixed)')
  })
  it('W5 an informational-only issue has a title and advice that fit it', () => {
    const r = exec(GREEN, 0, '', '', root(INFO + ROOT_OK))
    expect(r.status).toBe(0)
    const create = r.calls.find((c) => c.startsWith('issue create ')) as string
    expect(create).toBeDefined()
    expect(create).toContain('--label dependency-registry-expiry') // dedup is by label
    expect(create).toContain('Dependency registry (Check 76): informational advisories')
    expect(create).not.toContain('acceptances failing or expiring')
    expect(r.body).not.toContain('renew within the tier ceiling')
    expect(r.body).toContain('no job fails on them')
  })
  it('W5 control: an expiring acceptance keeps the renew advice and an expiry title', () => {
    const expiring =
      '::warning file=.github/dependency-registry.json::GHSA-xxxx-yyyy-zzzz expires 2026-10-10 (UTC), owner someone\n'
    const r = exec(expiring, 0, '', '', root())
    const create = r.calls.find((c) => c.startsWith('issue create ')) as string
    expect(create).toContain('Dependency registry (Check 76): acceptances expiring')
    expect(r.body).toContain('renew within the tier ceiling')
  })
})
