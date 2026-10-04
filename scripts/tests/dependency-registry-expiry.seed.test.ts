/**
 * SMI-6954 Wave 2: the daily workflow's seed loop and its failure-specific issue text
 * (rows W1-W6 of docs/internal/implementation/smi-6954-seed-lockfile-dependency-registry.md).
 * Executes the workflow's own script with stub node, npm and gh.
 */
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, exec, verbs } from './dependency-registry-expiry.harness'

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
  it('W3 a seed npm audit with no output is an ::error:: and a failure, never clean', () => {
    const r = exec(GREEN, 0, '', '', root(), { list: `${SEED}\n`, auditOut: '' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain(`::error::npm audit produced no JSON output for ${SEED}`)
    expect(r.nodeCalls.some((c) => c.includes('--seed'))).toBe(false)
    expect(r.body).toContain(SEED)
  })
  it('W6 a failing --list-seeds fails the job and says so in the issue', () => {
    const r = exec(GREEN, 0, '', '', root(), { listRc: 1 })
    expect(r.status).toBe(1)
    expect(r.body).toMatch(/--list-seeds failed/)
  })
})

describe('failure-specific issue text (PR-2, #3005 retro)', () => {
  it('W4 a seed-reconcile-only failure names the seed and does not claim code PRs fail', () => {
    const r = exec(GREEN, 0, '', '', root(), { list: `${SEED}\n`, rec: SEED_FAIL, recRc: 1 })
    expect(r.body).toContain(`### Failing seed reconcile (fails this daily job only`)
    expect(r.body).toContain(SEED)
    expect(r.body).toContain(`--seed ${SEED}`) // the seed remediation command
    expect(r.body).not.toContain('every code PR fails')
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
