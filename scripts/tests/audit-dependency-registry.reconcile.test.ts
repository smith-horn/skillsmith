/**
 * SMI-6949 round 3: `check-dependency-registry.mjs --reconcile-audit <audit.json>`.
 * Ties acceptances to what `npm audit --json --package-lock-only` reports.
 * Runs the REAL script as a subprocess against fixture audit JSON, so the exit
 * status and the printed lines are what is observed.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = join(REPO_ROOT, 'scripts/check-dependency-registry.mjs')

const accept = (advisory: string, pkg: string, severity = 'high') => ({
  advisory,
  package: pkg,
  severity,
  scope: 'dev',
  tier: 'R2',
  basis: 'b',
  owner: 'someone',
  accepted: '2026-10-03',
  expires: '2026-12-01',
})
const advisory = (id: string, name: string, severity = 'high') => ({
  source: 1,
  name,
  severity,
  url: `https://github.com/advisories/${id}`,
})
const report = (vulns: Record<string, unknown[]>) => ({
  auditReportVersion: 2,
  vulnerabilities: Object.fromEntries(
    Object.entries(vulns).map(([name, via]) => [name, { name, via }])
  ),
  metadata: {},
})

const A = 'GHSA-aaaa-bbbb-cccc'
const B = 'GHSA-dddd-eeee-ffff'

type LockSpec = Record<string, { dev?: boolean } | Array<{ dev?: boolean }>>
// package-lock.json fixture: name -> install(s); [] or an absent name means "not in the lockfile".
const lockOf = (spec: LockSpec) => {
  const packages: Record<string, unknown> = { '': {} }
  for (const [name, v] of Object.entries(spec)) {
    const installs = Array.isArray(v) ? v : [v]
    installs.forEach((e, i) => {
      packages[i === 0 ? `node_modules/${name}` : `node_modules/host${i}/node_modules/${name}`] = e
    })
  }
  return { lockfileVersion: 3, packages }
}
const DEV_LOCK: LockSpec = {
  pkgone: { dev: true },
  pkgtwo: { dev: true },
  other: { dev: true },
}

function reconcile(
  acceptances: unknown[],
  audit: unknown | string,
  lock: unknown | null = lockOf(DEV_LOCK)
) {
  const dir = mkdtempSync(join(tmpdir(), 'smi6949-rec-'))
  mkdirSync(join(dir, '.github'), { recursive: true })
  writeFileSync(
    join(dir, '.github/dependency-registry.json'),
    JSON.stringify({ overrides: {}, acceptances })
  )
  if (lock !== null) writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock))
  const auditPath = join(dir, 'audit.json')
  writeFileSync(auditPath, typeof audit === 'string' ? audit : JSON.stringify(audit))
  const r = spawnSync(process.execPath, [SCRIPT, '--reconcile-audit', auditPath], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('--reconcile-audit', () => {
  it('control: an accepted advisory present for the accepted package passes', () => {
    const r = reconcile([accept(A, 'pkgone')], report({ pkgone: [advisory(A, 'pkgone')] }))
    expect(r.status).toBe(0)
    expect(r.out).toContain('1 acceptances match the npm audit report; no unaccepted advisories')
  })
  it('control: string via items (transitive links) are not advisories and do not fail', () => {
    const r = reconcile(
      [accept(A, 'pkgone')],
      report({ pkgone: [advisory(A, 'pkgone')], parent: ['pkgone'] })
    )
    expect(r.status).toBe(0)
  })
  it('an accepted advisory that is absent from the audit fails', () => {
    const r = reconcile(
      [accept(A, 'pkgone'), accept(B, 'pkgtwo')],
      report({ pkgone: [advisory(A, 'pkgone')] })
    )
    expect(r.status).toBe(1)
    expect(r.out).toMatch(new RegExp(`${B} \\(pkgtwo\\) is absent from the npm audit report`))
  })
  it('an accepted advisory present for a DIFFERENT package fails and names the real one', () => {
    const r = reconcile([accept(A, 'wrongpkg')], report({ pkgone: [advisory(A, 'pkgone')] }))
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/not for package "wrongpkg"; npm audit reports it for "pkgone"/)
  })
  it('a severity that disagrees with the audit fails', () => {
    const r = reconcile(
      [accept(A, 'pkgone', 'low')],
      report({ pkgone: [advisory(A, 'pkgone', 'high')] })
    )
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/recorded as low but npm audit reports high/)
  })
  it('an audit advisory with no acceptance fails, at any severity', () => {
    for (const severity of ['low', 'moderate', 'high', 'critical']) {
      const r = reconcile(
        [accept(A, 'pkgone')],
        report({ pkgone: [advisory(A, 'pkgone')], pkgtwo: [advisory(B, 'pkgtwo', severity)] })
      )
      expect(r.status).toBe(1)
      expect(r.out).toContain(`unaccepted advisory ${B} (pkgtwo, ${severity})`)
    }
  })
  describe('scope of an unaccepted advisory (ADR-176)', () => {
    const INFO = (id: string, pkg: string, sev: string) =>
      `ℹ Check 76 reconcile (informational): advisory ${id} (${pkg}, ${sev}) has no acceptance; ${pkg} has a production install, so it is production scope, outside this registry, and governed by the production audit gate (npm audit --omit=dev)`
    const withB = (pkg: string, severity: string) =>
      report({ pkgone: [advisory(A, 'pkgone')], [pkg]: [advisory(B, pkg, severity)] })
    it.each(['moderate', 'high'])(
      'a %s production-scope unaccepted advisory is informational, not a failure',
      (severity) => {
        const r = reconcile(
          [accept(A, 'pkgone')],
          withB('pkgtwo', severity),
          lockOf({
            ...DEV_LOCK,
            pkgtwo: { dev: false },
          })
        )
        expect(r.status).toBe(0)
        expect(r.out).toContain(INFO(B, 'pkgtwo', severity))
        expect(r.out).not.toContain('✗')
        expect(r.out).toContain(
          '✓ Check 76 reconcile: 1 acceptances match the npm audit report; no unaccepted dev-scope advisories; 1 production-scope advisories listed as informational'
        )
      }
    )
    it('a dev-only unaccepted advisory still fails and is not printed as informational', () => {
      const r = reconcile([accept(A, 'pkgone')], withB('pkgtwo', 'moderate'))
      expect(r.status).toBe(1)
      expect(r.out).toContain(`✗ Check 76 reconcile: unaccepted advisory ${B} (pkgtwo, moderate)`)
      expect(r.out).not.toContain('informational')
    })
    it('a package with one dev and one production install counts as production', () => {
      const r = reconcile(
        [accept(A, 'pkgone')],
        withB('pkgtwo', 'high'),
        lockOf({
          ...DEV_LOCK,
          pkgtwo: [{ dev: true }, {}],
        })
      )
      expect(r.status).toBe(0)
      expect(r.out).toContain(INFO(B, 'pkgtwo', 'high'))
    })
    it('devOptional alone is dev-scope, so it still fails', () => {
      const r = reconcile(
        [accept(A, 'pkgone')],
        withB('pkgtwo', 'high'),
        lockOf({
          ...DEV_LOCK,
          pkgtwo: { devOptional: true } as { dev?: boolean },
        })
      )
      expect(r.status).toBe(1)
    })
    it('a package absent from the lockfile fails closed (unknown is not production)', () => {
      const r = reconcile([accept(A, 'pkgone')], withB('ghostpkg', 'moderate'))
      expect(r.status).toBe(1)
      expect(r.out).toContain(`unaccepted advisory ${B} (ghostpkg, moderate)`)
      expect(r.out).toContain('ghostpkg could not be placed in package-lock.json')
      expect(r.out).not.toContain('informational')
    })
    it('a missing or unparseable lockfile fails closed for every unaccepted advisory', () => {
      for (const lock of [null, 'not a lockfile', { lockfileVersion: 3 }]) {
        const r = reconcile([accept(A, 'pkgone')], withB('pkgtwo', 'high'), lock)
        expect(r.status).toBe(1)
        expect(r.out).not.toContain('informational')
      }
    })
    it('an ACCEPTED advisory is unaffected by the production rule (matching acceptance passes)', () => {
      const r = reconcile([accept(A, 'pkgone')], report({ pkgone: [advisory(A, 'pkgone')] }))
      expect(r.status).toBe(0)
      expect(r.out).toContain('no unaccepted advisories')
      expect(r.out).not.toContain('informational')
    })
  })
  it.each([
    ['low then high', 'low', 'high'],
    ['high then low', 'high', 'low'],
  ])('a repeated advisory with conflicting severities (%s) fails closed', (_l, first, second) => {
    const r = reconcile(
      [accept(A, 'pkgone', 'high')],
      report({ pkgone: [advisory(A, 'pkgone', first)], other: [advisory(A, 'pkgone', second)] })
    )
    expect(r.status).toBe(1)
    expect(r.out).toContain('the npm audit output is unusable')
    expect(r.out).toContain(`conflicting severities "${first}" and "${second}"`)
    expect(r.out).not.toContain('acceptances match')
  })
  it('a repeated advisory with the SAME severity is fine', () => {
    const r = reconcile(
      [accept(A, 'pkgone')],
      report({ pkgone: [advisory(A, 'pkgone')], other: [advisory(A, 'pkgone')] })
    )
    expect(r.status).toBe(0)
    expect(r.out).toContain('1 acceptances match the npm audit report')
  })
  it('an advisory with no GHSA in its url is identified by source and is never accepted', () => {
    const noGhsa = {
      source: 4242,
      name: 'pkgone',
      severity: 'high',
      url: 'https://example.invalid/x',
    }
    const r = reconcile([accept(A, 'pkgone')], report({ pkgone: [advisory(A, 'pkgone'), noGhsa] }))
    expect(r.status).toBe(1)
    expect(r.out).toContain('unaccepted advisory src:4242 (pkgone, high)')
  })
  it.each([
    ['not JSON', 'this is not json'],
    ['empty', ''],
    ['a JSON array', '[]'],
    ['an npm error object', JSON.stringify({ error: { code: 'ENOTFOUND', summary: 'x' } })],
    ['the wrong report version', JSON.stringify({ auditReportVersion: 1, vulnerabilities: {} })],
    ['no vulnerabilities object', JSON.stringify({ auditReportVersion: 2 })],
    [
      'a vulnerability without via',
      JSON.stringify({ auditReportVersion: 2, vulnerabilities: { x: {} } }),
    ],
    [
      'an advisory with no severity',
      JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: { x: { via: [{ source: 1, name: 'x' }] } },
      }),
    ],
  ])('malformed audit (%s) fails closed, never clean', (_label, text) => {
    const r = reconcile([accept(A, 'pkgone')], text)
    expect(r.status).toBe(1)
    expect(r.out).toContain('the npm audit output is unusable')
    expect(r.out).not.toContain('acceptances match')
  })
  it('a missing audit file fails closed', () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--reconcile-audit', '/nonexistent/audit.json'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }
    )
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('the npm audit output is unusable')
  })
  it('an unknown argument is a usage error (2), not a silent default run', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--reconcile-audit'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('usage:')
  })
  it('failure lines carry the marker and "Check 76", which the workflow issue grep keys on', () => {
    const r = reconcile([accept(A, 'wrongpkg')], report({ pkgone: [advisory(A, 'pkgone')] }))
    expect(r.out).toMatch(/✗ Check 76 reconcile:/)
  })
})
