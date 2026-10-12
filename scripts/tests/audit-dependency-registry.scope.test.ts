/**
 * SMI-6949 round 3 (PR-16/PR-17): an acceptance is dev-scope only if EVERY
 * lockfile occurrence of its package is dev. Name presence is not enough: the
 * reviewer's mutation re-pointed GHSA-83w8-p2f5-377r at a package that is in
 * the lockfile as a production dependency and Check 76 stayed green.
 * The fixtures are synthetic; on this branch's real lockfile @astrojs/check is
 * a production install (the branch predates #2993), which is where the
 * reviewer's mutation was reproduced.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import { evaluateDependencyRegistry } from '../audit-dependency-registry-helpers.mjs'

type Finding = { severity: 'fail' | 'warn'; message: string }
const ov = {
  pin: '^1.0.0',
  reason: 'why',
  advisories: ['GHSA-aaaa-bbbb-cccc'],
  introducedBy: ['SMI-1'],
  crossesMajor: null,
  removeWhen: 'when fixed',
}
const acc = (pkg: string) => ({
  advisory: 'GHSA-aaaa-bbbb-cccc',
  package: pkg,
  severity: 'high',
  scope: 'dev',
  tier: 'R2',
  basis: 'reason text',
  owner: 'someone',
  accepted: '2026-10-03',
  expires: '2026-12-01',
})
type Packages = Record<string, Record<string, unknown>>
const run = (pkg: string, packages: Packages) => {
  const r = evaluateDependencyRegistry({
    pkg: { overrides: { alpha: '^1.0.0' } },
    registryText: JSON.stringify({ overrides: { alpha: ov }, acceptances: [acc(pkg)] }),
    lock: { lockfileVersion: 3, packages: { '': {}, ...packages } },
    today: '2026-10-03',
    trackedLockfiles: ['package-lock.json'], // SMI-6954: no seed lockfile in these fixtures
  }) as { findings: Finding[] }
  return r.findings.filter((f) => f.severity === 'fail').map((f) => f.message)
}

describe('acceptance scope is classified from the lockfile', () => {
  it('control: a package whose only install is dev passes', () => {
    expect(run('devpkg', { 'node_modules/devpkg': { dev: true } })).toEqual([])
  })
  it('devOptional WITHOUT dev is production: npm audit --omit=dev audits it, so the acceptance fails', () => {
    const msgs = run('devpkg', { 'node_modules/devpkg': { devOptional: true } })
    expect(msgs.join('\n')).toMatch(/production \(non-dev\) install at node_modules\/devpkg/)
    expect(msgs.join('\n')).toMatch(
      /node_modules\/devpkg is devOptional without dev, and npm audit --omit=dev audits devOptional installs/
    )
  })
  it('control: an entry with dev AND devOptional set is dev and passes', () => {
    expect(run('devpkg', { 'node_modules/devpkg': { dev: true, devOptional: true } })).toEqual([])
  })
  it('one devOptional-without-dev occurrence among dev ones fails and names only that path', () => {
    const msgs = run('dup', {
      'node_modules/a/node_modules/dup': { dev: true },
      'node_modules/b/node_modules/dup': { devOptional: true },
    }).join('\n')
    expect(msgs).toMatch(/production \(non-dev\) install at node_modules\/b\/node_modules\/dup,/)
    expect(msgs).not.toMatch(/install at [^,]*node_modules\/a\/node_modules\/dup/)
  })
  it('a package that is in the lockfile as a production install fails and names the path', () => {
    const msgs = run('prodpkg', { 'node_modules/prodpkg': {} })
    expect(msgs.join('\n')).toMatch(/production \(non-dev\) install at node_modules\/prodpkg/)
  })
  it('the reviewer mutation: pointing the acceptance at an existing prod package fails (the dev package it was meant for passes)', () => {
    const packages = {
      'node_modules/@fastify/static': { dev: true },
      'node_modules/@astrojs/check': {},
    }
    expect(run('@fastify/static', packages)).toEqual([])
    expect(run('@astrojs/check', packages).join('\n')).toMatch(
      /production \(non-dev\) install at node_modules\/@astrojs\/check/
    )
  })
  it('one dev and one production occurrence fails, whichever is listed first, naming the production path', () => {
    const devFirst = {
      'node_modules/a/node_modules/dup': { dev: true },
      'node_modules/b/node_modules/dup': {},
    }
    const prodFirst = {
      'node_modules/b/node_modules/dup': {},
      'node_modules/a/node_modules/dup': { dev: true },
    }
    for (const packages of [devFirst, prodFirst]) {
      expect(run('dup', packages).join('\n')).toMatch(
        /production \(non-dev\) install at node_modules\/b\/node_modules\/dup/
      )
    }
  })
  it('control: several occurrences that are all dev pass', () => {
    expect(
      run('dup', {
        'node_modules/a/node_modules/dup': { dev: true },
        'node_modules/dup': { dev: true },
      })
    ).toEqual([])
  })
  it('a lookalike production package with a longer name does not make the dev one fail (exact segment match)', () => {
    expect(run('bar', { 'node_modules/bar': { dev: true }, 'node_modules/foobar': {} })).toEqual([])
  })
  it('a package absent from the lockfile still fails as absent, not as production', () => {
    expect(run('ghost', { 'node_modules/other': {} }).join('\n')).toMatch(
      /"ghost", which is not in package-lock\.json/
    )
  })
})
