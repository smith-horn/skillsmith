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
// npm audit v2 report, shaped like real output (verified 2026-10-04 against
// `npm audit --json --package-lock-only`): every vulnerabilities[<pkg>] entry
// carries `nodes`, the lockfile paths of the installs npm reports as affected.
// `report` gives each entry the one root path `node_modules/<pkg>`; use
// `reportWith` to set (or omit) `nodes` explicitly.
type Entry = { via: unknown[]; nodes?: unknown }
const reportWith = (vulns: Record<string, Entry>) => ({
  auditReportVersion: 2,
  vulnerabilities: Object.fromEntries(
    Object.entries(vulns).map(([name, e]) => [
      name,
      'nodes' in e ? { name, via: e.via, nodes: e.nodes } : { name, via: e.via },
    ])
  ),
  metadata: {},
})
const report = (vulns: Record<string, unknown[]>) =>
  reportWith(
    Object.fromEntries(
      Object.entries(vulns).map(([name, via]) => [name, { via, nodes: [`node_modules/${name}`] }])
    )
  )

const A = 'GHSA-aaaa-bbbb-cccc'
const B = 'GHSA-dddd-eeee-ffff'

type Install = { dev?: boolean; devOptional?: boolean; version?: string }
type LockSpec = Record<string, Install | Install[]>
// package-lock.json fixture: name -> install(s). The first install is at
// node_modules/<name>, the i-th further one at node_modules/host<i>/node_modules/<name>.
const NESTED = (name: string, i = 1) => `node_modules/host${i}/node_modules/${name}`
const lockOf = (spec: LockSpec) => {
  const packages: Record<string, unknown> = { '': {} }
  for (const [name, v] of Object.entries(spec)) {
    const installs = Array.isArray(v) ? v : [v]
    installs.forEach((e, i) => {
      packages[i === 0 ? `node_modules/${name}` : NESTED(name, i)] = e
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
  it('a dev-scope audit advisory with no acceptance fails, at any severity', () => {
    for (const severity of ['low', 'moderate', 'high', 'critical']) {
      const r = reconcile(
        [accept(A, 'pkgone')],
        report({ pkgone: [advisory(A, 'pkgone')], pkgtwo: [advisory(B, 'pkgtwo', severity)] })
      )
      expect(r.status).toBe(1)
      expect(r.out).toContain(`unaccepted advisory ${B} (pkgtwo, ${severity})`)
    }
  })
  describe('scope of an unaccepted advisory (ADR-176): decided by the installs npm reports as affected', () => {
    const INFO = (id: string, pkg: string, sev: string, paths: string[]) =>
      `ℹ Check 76 reconcile (informational): advisory ${id} (${pkg}, ${sev}) has no acceptance; npm audit reports it affecting production install(s) ${paths.join(', ')}, so it is production scope, outside this registry, and governed by the production audit gate (npm audit --omit=dev)`
    const withB = (pkg: string, severity: string) =>
      report({ pkgone: [advisory(A, 'pkgone')], [pkg]: [advisory(B, pkg, severity)] })
    // pkgone accepted; pkgtwo carries the unaccepted advisory B with explicit `nodes`.
    const withBNodes = (nodes: unknown, via: unknown[] = [advisory(B, 'pkgtwo')]) =>
      reportWith({
        pkgone: { via: [advisory(A, 'pkgone')], nodes: ['node_modules/pkgone'] },
        pkgtwo: { via, nodes },
      })
    const NOT_PROD = 'it is not treated as production'
    it.each(['moderate', 'high'])(
      'a %s advisory whose affected install is production is informational, not a failure',
      (severity) => {
        const r = reconcile(
          [accept(A, 'pkgone')],
          withB('pkgtwo', severity),
          lockOf({ ...DEV_LOCK, pkgtwo: { dev: false } })
        )
        expect(r.status).toBe(0)
        expect(r.out).toContain(INFO(B, 'pkgtwo', severity, ['node_modules/pkgtwo']))
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
    it('the production copy is unaffected and the affected copy is dev-only, so it FAILS', () => {
      // The name has a production install (pkgtwo@2.0.0 at the root), but npm reports
      // only the dev-only pkgtwo@1.0.0 as affected; `npm audit --omit=dev` never sees it.
      const r = reconcile(
        [accept(A, 'pkgone')],
        withBNodes([NESTED('pkgtwo')]),
        lockOf({ ...DEV_LOCK, pkgtwo: [{ version: '2.0.0' }, { version: '1.0.0', dev: true }] })
      )
      expect(r.status).toBe(1)
      expect(r.out).toContain(`✗ Check 76 reconcile: unaccepted advisory ${B} (pkgtwo, high)`)
      expect(r.out).not.toContain('informational')
    })
    it('affected installs mixing dev and production, with this advisory the sole cause, are informational', () => {
      const r = reconcile(
        [accept(A, 'pkgone')],
        withBNodes(['node_modules/pkgtwo', NESTED('pkgtwo')]),
        lockOf({ ...DEV_LOCK, pkgtwo: [{ dev: true }, {}] })
      )
      expect(r.status).toBe(0)
      expect(r.out).toContain(INFO(B, 'pkgtwo', 'high', [NESTED('pkgtwo')]))
    })
    it.each([
      [
        'a second advisory',
        [advisory(B, 'pkgtwo'), advisory('GHSA-gggg-hhhh-iiii', 'pkgtwo', 'moderate')],
      ],
      ['a vulnerable dependency (string via)', [advisory(B, 'pkgtwo'), 'other']],
    ])(
      'affected installs mixing dev and production across several causes (%s) fail closed',
      (_label, via) => {
        // `nodes` is per package, the union over every cause, so it cannot say which
        // of these installs advisory B affects (measured: minimist 1.2.5 prod + 0.0.8 dev).
        const r = reconcile(
          [accept(A, 'pkgone')],
          withBNodes(['node_modules/pkgtwo', NESTED('pkgtwo')], via),
          lockOf({ ...DEV_LOCK, pkgtwo: [{ dev: true }, {}] })
        )
        expect(r.status).toBe(1)
        expect(r.out).toContain(
          `✗ Check 76 reconcile: unaccepted advisory ${B} (pkgtwo, high) is reported by npm audit and has no acceptance; npm reports pkgtwo's affected installs as one set across several causes, some production and some dev, so the installs this advisory affects could not be determined; ${NOT_PROD}`
        )
        expect(r.out).not.toContain(
          `advisory ${B} (pkgtwo, high) has no acceptance; npm audit reports`
        )
      }
    )
    it('several causes whose affected installs are ALL production stay informational', () => {
      const r = reconcile(
        [accept(A, 'pkgone')],
        withBNodes(['node_modules/pkgtwo', NESTED('pkgtwo')], [advisory(B, 'pkgtwo'), 'other']),
        lockOf({ ...DEV_LOCK, pkgtwo: [{}, {}] })
      )
      expect(r.status).toBe(0)
      expect(r.out).toContain(INFO(B, 'pkgtwo', 'high', ['node_modules/pkgtwo', NESTED('pkgtwo')]))
    })
    it('devOptional alone is dev-scope, so it still fails', () => {
      const r = reconcile(
        [accept(A, 'pkgone')],
        withB('pkgtwo', 'high'),
        lockOf({ ...DEV_LOCK, pkgtwo: { devOptional: true } })
      )
      expect(r.status).toBe(1)
      expect(r.out).not.toContain('informational')
    })
    it.each([
      ['missing', undefined],
      ['empty', []],
      ['not an array', 'node_modules/pkgtwo'],
      ['holding a non-string', ['node_modules/pkgtwo', 7]],
    ])('an advisory whose package entry has %s "nodes" fails closed', (label, nodes) => {
      const audit =
        label === 'missing'
          ? reportWith({
              pkgone: { via: [advisory(A, 'pkgone')], nodes: ['node_modules/pkgone'] },
              pkgtwo: { via: [advisory(B, 'pkgtwo')] },
            })
          : withBNodes(nodes)
      // pkgtwo's only install is production, so anything but fail-closed would waive it.
      const r = reconcile([accept(A, 'pkgone')], audit, lockOf({ ...DEV_LOCK, pkgtwo: {} }))
      expect(r.status).toBe(1)
      expect(r.out).toContain(
        `unaccepted advisory ${B} (pkgtwo, high) is reported by npm audit and has no acceptance; npm audit reports no usable "nodes" for pkgtwo, so the affected installs could not be determined; ${NOT_PROD}`
      )
      expect(r.out).not.toContain('informational')
    })
    it('an affected install path that is not in package-lock.json fails closed', () => {
      // The name IS in the lockfile as production, at a path npm did not report.
      const r = reconcile(
        [accept(A, 'pkgone')],
        withBNodes([NESTED('pkgtwo', 9)]),
        lockOf({ ...DEV_LOCK, pkgtwo: {} })
      )
      expect(r.status).toBe(1)
      expect(r.out).toContain(
        `affected install "${NESTED('pkgtwo', 9)}" is not in package-lock.json, so the affected installs could not be determined; ${NOT_PROD}`
      )
      expect(r.out).not.toContain('informational')
    })
    it('one known production path does not rescue an unknown one', () => {
      const r = reconcile(
        [accept(A, 'pkgone')],
        withBNodes(['node_modules/pkgtwo', 'node_modules/__proto__']),
        lockOf({ ...DEV_LOCK, pkgtwo: {} })
      )
      expect(r.status).toBe(1)
      expect(r.out).toContain(
        'affected install "node_modules/__proto__" is not in package-lock.json'
      )
    })
    it('a package absent from the lockfile fails closed (unknown is not production)', () => {
      const r = reconcile([accept(A, 'pkgone')], withB('ghostpkg', 'moderate'))
      expect(r.status).toBe(1)
      expect(r.out).toContain(`unaccepted advisory ${B} (ghostpkg, moderate)`)
      expect(r.out).toContain(
        'affected install "node_modules/ghostpkg" is not in package-lock.json'
      )
      expect(r.out).not.toContain('informational')
    })
    it('a missing or unparseable lockfile fails closed for every unaccepted advisory', () => {
      for (const lock of [null, 'not a lockfile', { lockfileVersion: 3 }]) {
        const r = reconcile([accept(A, 'pkgone')], withB('pkgtwo', 'high'), lock)
        expect(r.status).toBe(1)
        expect(r.out).toContain('package-lock.json is missing or unusable')
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
