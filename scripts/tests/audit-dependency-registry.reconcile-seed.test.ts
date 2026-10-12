/**
 * SMI-6954 Wave 2: `check-dependency-registry.mjs --reconcile-audit <a.json> --seed <lockfile>`
 * and `--list-seeds`. Rows R0-R7 are the plan's red tests. Spawns the REAL script against a
 * fixture tree, so the exit status and printed lines are what is observed.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = join(REPO_ROOT, 'scripts/check-dependency-registry.mjs')
const K = 'scripts/x/package-lock.json'
const A = 'GHSA-aaaa-bbbb-cccc'
const B = 'GHSA-dddd-eeee-ffff'

const acc = (advisory: string, pkg: string, severity = 'high', scope = 'seed') => ({
  advisory,
  package: pkg,
  severity,
  scope,
  tier: 'R3',
  basis: 'b',
  owner: 'someone',
  accepted: '2026-10-03',
  expires: '2026-12-01',
})
const via = (id: string, name: string, severity = 'high') => ({
  source: 1,
  name,
  severity,
  url: `https://github.com/advisories/${id}`,
})
// Seed lockfile: one optional non-dev install, one plain production install, one dev install.
const SEED_LOCK = {
  lockfileVersion: 3,
  packages: {
    '': {},
    'node_modules/pkg': { optional: true },
    'node_modules/prodpkg': {},
    'node_modules/devpkg': { dev: true },
  },
}
const SEED_TOTAL = 3
const ROOT_LOCK = { lockfileVersion: 3, packages: { '': {}, 'node_modules/rootonly': {} } }
type V = Record<string, { via: unknown[]; nodes?: string[] }>
// `total: null` omits metadata.dependencies (undefined would take the default)
const audit = (vulns: V, total: number | null = SEED_TOTAL) => ({
  auditReportVersion: 2,
  vulnerabilities: Object.fromEntries(
    Object.entries(vulns).map(([name, e]) => [
      name,
      { name, via: e.via, nodes: e.nodes ?? [`node_modules/${name}`] },
    ])
  ),
  metadata: total === null ? {} : { dependencies: { total } },
})

function tree(seedAcceptances: unknown[], rootAcceptances: unknown[] = [], extraSeeds = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'smi6954-rec-'))
  mkdirSync(join(dir, '.github'), { recursive: true })
  mkdirSync(join(dir, 'scripts/x'), { recursive: true })
  writeFileSync(
    join(dir, '.github/dependency-registry.json'),
    JSON.stringify({
      overrides: {},
      acceptances: rootAcceptances,
      seeds: { [K]: { overrides: {}, acceptances: seedAcceptances }, ...extraSeeds },
    })
  )
  writeFileSync(join(dir, K), JSON.stringify(SEED_LOCK))
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(ROOT_LOCK))
  return dir
}
function cli(dir: string, args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout }
}
function seedRec(seedAcceptances: unknown[], report: unknown, seedKey = K) {
  const dir = tree(seedAcceptances)
  writeFileSync(join(dir, 'a.json'), JSON.stringify(report))
  return cli(dir, ['--reconcile-audit', 'a.json', '--seed', seedKey])
}

describe('--reconcile-audit --seed', () => {
  it('R0 control: an accepted seed advisory reported for the accepted package passes', () => {
    const r = seedRec([acc(A, 'pkg')], audit({ pkg: { via: [via(A, 'pkg')] } }))
    expect(r.status).toBe(0)
    expect(r.out).toMatch(
      /1 acceptances match the npm audit report for scripts\/x\/package-lock\.json/
    )
  })
  it('R1 an unaccepted advisory on a non-dev optional install fails', () => {
    const r = seedRec([], audit({ pkg: { via: [via(A, 'pkg')] } }))
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/unaccepted advisory GHSA-aaaa-bbbb-cccc \(pkg, high\)/)
  })
  it('R2 an unaccepted advisory on a production install fails and is never informational', () => {
    const r = seedRec([], audit({ prodpkg: { via: [via(A, 'prodpkg', 'moderate')] } }))
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/unaccepted advisory GHSA-aaaa-bbbb-cccc \(prodpkg, moderate\)/)
    expect(r.out).not.toContain('(informational)')
  })
  it('R2 an unaccepted advisory on a dev install fails too (any scope)', () => {
    const r = seedRec([], audit({ devpkg: { via: [via(A, 'devpkg', 'low')] } }))
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/unaccepted advisory GHSA-aaaa-bbbb-cccc \(devpkg, low\)/)
  })
  it('R3 a report whose affected install is not in the seed lockfile (the root report) fails', () => {
    const r = seedRec(
      [acc(A, 'rootonly')],
      audit({ rootonly: { via: [via(A, 'rootonly')] } }, SEED_TOTAL)
    )
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/is not for scripts\/x\/package-lock\.json/)
  })
  it('R3 a report whose dependency total differs from the seed lockfile fails', () => {
    const r = seedRec([acc(A, 'pkg')], audit({ pkg: { via: [via(A, 'pkg')] } }, 698))
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/is not for scripts\/x\/package-lock\.json/)
  })
  it('R3 a report with no dependency total fails closed', () => {
    const r = seedRec([acc(A, 'pkg')], audit({ pkg: { via: [via(A, 'pkg')] } }, null))
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/is not for scripts\/x\/package-lock\.json/)
  })
  it('R4 an accepted seed advisory absent from the report fails, prefixed by the seed key', () => {
    const r = seedRec([acc(A, 'pkg'), acc(B, 'prodpkg')], audit({ pkg: { via: [via(A, 'pkg')] } }))
    expect(r.status).toBe(1)
    expect(r.out).toMatch(
      /Check 76 reconcile \[scripts\/x\/package-lock\.json\]: accepted advisory GHSA-dddd-eeee-ffff \(prodpkg\) is absent from the npm audit report/
    )
  })
  it('R4 wrong package and wrong severity fail, prefixed by the seed key', () => {
    const wrongPkg = seedRec([acc(A, 'prodpkg')], audit({ pkg: { via: [via(A, 'pkg')] } }))
    expect(wrongPkg.status).toBe(1)
    expect(wrongPkg.out).toMatch(
      /Check 76 reconcile \[scripts\/x\/package-lock\.json\]: accepted advisory GHSA-aaaa-bbbb-cccc is not for package "prodpkg"/
    )
    const wrongSev = seedRec([acc(A, 'pkg', 'moderate')], audit({ pkg: { via: [via(A, 'pkg')] } }))
    expect(wrongSev.status).toBe(1)
    expect(wrongSev.out).toMatch(
      /Check 76 reconcile \[scripts\/x\/package-lock\.json\]: accepted advisory GHSA-aaaa-bbbb-cccc \(pkg\) is recorded as moderate but npm audit reports high/
    )
  })
  it('R5 --seed naming a key that is not in registry.seeds fails (exit 1, never a skip)', () => {
    const r = seedRec([], audit({}), 'scripts/nope/package-lock.json')
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/scripts\/nope\/package-lock\.json is not a key of "seeds"/)
  })
  it('R5 an unreadable seed lockfile fails closed', () => {
    const dir = tree([], [], {
      'scripts/gone/package-lock.json': { overrides: {}, acceptances: [] },
    })
    writeFileSync(join(dir, 'a.json'), JSON.stringify(audit({})))
    const r = cli(dir, ['--reconcile-audit', 'a.json', '--seed', 'scripts/gone/package-lock.json'])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/cannot read scripts\/gone\/package-lock\.json/)
  })
})

describe('--list-seeds and usage', () => {
  it('R6 --list-seeds prints exactly the seeds keys, one per line', () => {
    const dir = tree([], [], { 'scripts/y/package-lock.json': { overrides: {}, acceptances: [] } })
    const r = cli(dir, ['--list-seeds'])
    expect(r.status).toBe(0)
    expect(r.stdout.split('\n').filter(Boolean)).toEqual([K, 'scripts/y/package-lock.json'])
  })
  it('R6 --list-seeds with an unreadable registry exits 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smi6954-noreg-'))
    expect(cli(dir, ['--list-seeds']).status).toBe(1)
  })
  it.each([
    [['--seed', K]],
    [['--list-seeds', 'extra']],
    [['--reconcile-audit', 'a.json', '--seed']],
    [['--reconcile-audit', 'a.json', '--bogus', K]],
  ])('R6b bad usage %j still exits 2', (args) => {
    expect(cli(tree([]), args).status).toBe(2)
  })
})

describe('R7 the root reconcile is unchanged by a seeds section', () => {
  it('R7 a production root advisory stays informational', () => {
    const dir = tree([])
    writeFileSync(
      join(dir, 'a.json'),
      JSON.stringify(audit({ rootonly: { via: [via(A, 'rootonly', 'moderate')] } }))
    )
    const r = cli(dir, ['--reconcile-audit', 'a.json'])
    expect(r.status).toBe(0)
    expect(r.out).toContain('(informational)')
  })
  it('R7 a seed acceptance never satisfies the root reconcile', () => {
    const dir = tree([acc(A, 'rootonly')])
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { '': {}, 'node_modules/rootonly': { dev: true } },
      })
    )
    writeFileSync(
      join(dir, 'a.json'),
      JSON.stringify(audit({ rootonly: { via: [via(A, 'rootonly')] } }))
    )
    const r = cli(dir, ['--reconcile-audit', 'a.json'])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/unaccepted advisory GHSA-aaaa-bbbb-cccc \(rootonly, high\)/)
  })
})
