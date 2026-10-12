/**
 * SMI-6949 review round 1: Check 76 field-level validation (R1-M3, R1-L1, R1-L2,
 * R1-L3, R1-M5, mutant D). Companion to audit-dependency-registry.test.ts.
 * Every case has a valid control beside it, and every rule was driven RED by the
 * mutation declared in the PR's redtests log.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import { evaluateDependencyRegistry } from '../audit-dependency-registry-helpers.mjs'

type Finding = { severity: 'fail' | 'warn'; message: string }
type Result = { findings: Finding[]; evaluated: boolean }
const TODAY = '2026-10-03'

const ov = (over: Record<string, unknown> = {}) => ({
  pin: '^1.0.0',
  reason: 'why',
  advisories: ['GHSA-aaaa-bbbb-cccc'],
  introducedBy: ['SMI-1'],
  crossesMajor: null,
  removeWhen: 'when fixed',
  ...over,
})
const acc = (over: Record<string, unknown> = {}) => ({
  advisory: 'GHSA-aaaa-bbbb-cccc',
  package: 'pkgone',
  severity: 'high',
  scope: 'dev',
  tier: 'R2',
  basis: 'reason text',
  owner: 'someone',
  accepted: '2026-10-03',
  expires: '2026-12-01',
  ...over,
})
const lockWith = (...names: string[]) => ({
  lockfileVersion: 3,
  // every listed package is a dev install (Check 76 requires an acceptance's package to be dev-only)
  packages: Object.fromEntries(
    ['', ...names].map((n) => [n ? `node_modules/${n}` : '', n ? { dev: true } : {}])
  ),
})

interface Fx {
  pkg?: unknown
  overrides?: Record<string, unknown>
  acceptances?: unknown[]
  lock?: unknown
  root?: string
  /** omit to use the REAL filesystem probe */
  exists?: (p: string) => boolean
}
function run(fx: Fx = {}): Result {
  const input: Record<string, unknown> = {
    pkg: fx.pkg ?? { overrides: { alpha: '^1.0.0' } },
    registryText: JSON.stringify({
      overrides: fx.overrides ?? { alpha: ov() },
      acceptances: fx.acceptances ?? [acc()],
    }),
    lock: fx.lock ?? lockWith('pkgone'),
    trackedLockfiles: ['package-lock.json'], // SMI-6954: no seed lockfile in these fixtures
    today: TODAY,
  }
  if (fx.root !== undefined) input.root = fx.root
  if (fx.exists !== undefined) input.exists = fx.exists
  return evaluateDependencyRegistry(input) as Result
}
const failText = (r: Result) =>
  r.findings
    .filter((f) => f.severity === 'fail')
    .map((f) => f.message)
    .join('\n')
const r4 = (pinnedBy: unknown, fx: Fx = {}) =>
  run({ ...fx, acceptances: [acc({ tier: 'R4', expires: '2027-01-01', pinnedBy })] })

describe('pinnedBy (R1-M3, mutant D)', () => {
  // Real files: <root>/tests/ok.test.ts, <root>/tests/plain.ts, a DIRECTORY named like a test,
  // and a real test file OUTSIDE the root (so a `..` escape cannot be "rejected for not existing").
  const base = mkdtempSync(join(tmpdir(), 'smi6949-pin-'))
  const root = join(base, 'repo')
  mkdirSync(join(root, 'tests', 'dir.test.ts'), { recursive: true })
  writeFileSync(join(root, 'tests', 'ok.test.ts'), '')
  writeFileSync(join(root, 'tests', 'plain.ts'), '')
  writeFileSync(join(base, 'outside.test.ts'), '')

  it('control: a repo-relative regular test file passes with no findings at all', () => {
    expect(r4('tests/ok.test.ts', { root }).findings).toEqual([])
  })
  it('control: a path that normalises to a file inside the root passes', () => {
    expect(r4('tests/../tests/./ok.test.ts', { root }).findings).toEqual([])
  })
  it('a directory is not a regular file, even when named like a test', () => {
    expect(failText(r4('tests/dir.test.ts', { root }))).toMatch(
      /does not name an existing regular file/
    )
  })
  it('a ../ escape fails even though the target file exists', () => {
    expect(failText(r4('../outside.test.ts', { root }))).toMatch(
      /resolves outside the repository root/
    )
  })
  it('an absolute path fails even though the target file exists', () => {
    const abs = join(root, 'tests', 'ok.test.ts')
    expect(failText(r4(abs, { root }))).toMatch(/is an absolute path/)
  })
  it('an existing regular file that is not a test file fails', () => {
    expect(failText(r4('tests/plain.ts', { root }))).toMatch(/is not a test file/)
  })
  it('a test file under a node_modules segment fails even though it exists', () => {
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'x.test.ts'), '')
    expect(failText(r4('node_modules/pkg/x.test.ts', { root }))).toMatch(/under a node_modules/)
    expect(failText(r4('tests/../node_modules/pkg/x.test.ts', { root }))).toMatch(
      /under a node_modules/
    )
  })
  it('a missing test file fails', () => {
    expect(failText(r4('tests/missing.test.ts', { root }))).toMatch(
      /does not name an existing regular file/
    )
  })

  it('mutant D: the existence probe receives the JOINED path, exactly once', () => {
    const seen: string[] = []
    const fakeRoot = join(tmpdir(), 'smi6949-fake-root')
    const r = r4('tests/yes.test.ts', {
      root: fakeRoot,
      exists: (p) => {
        seen.push(p)
        return true
      },
    })
    expect(r.findings).toEqual([])
    expect(seen).toEqual([join(fakeRoot, 'tests/yes.test.ts')])
    expect(seen[0]).not.toBe('tests/yes.test.ts')
  })
})

describe('registry keys are DATA, never inherited properties (R1-L1)', () => {
  const names = ['constructor', 'toString', '__proto__', 'hasOwnProperty']
  // computed keys create OWN properties, including __proto__
  const pkgWith = (...ks: string[]) => ({
    overrides: Object.fromEntries(ks.map((k) => [k, '1.0.0'])),
  })
  const registryWith = (...ks: string[]) =>
    Object.fromEntries(ks.map((k) => [k, ov({ pin: '1.0.0' })]))

  it.each(names)('a package.json override named %s with no registry entry is reported', (k) => {
    const r = run({ pkg: pkgWith(k), overrides: {} })
    expect(failText(r)).toContain(`override "${k}" has no entry`)
  })
  it.each(names)('control: the same override WITH an own registry entry is clean', (k) => {
    expect(run({ pkg: pkgWith(k), overrides: registryWith(k) }).findings).toEqual([])
  })
  it.each(names)('a registry entry named %s with no override is reported', (k) => {
    const r = run({ pkg: { overrides: {} }, overrides: registryWith(k) })
    expect(failText(r)).toContain(`registry entry "${k}" has no matching package.json override`)
  })
  it('an acceptance tier named like an inherited property is an invalid tier', () => {
    expect(failText(run({ acceptances: [acc({ tier: 'constructor' })] }))).toMatch(
      /tier must be one of R1, R2, R3, R4/
    )
  })
})

describe('field types (R1-L2)', () => {
  const ovFails = (over: Record<string, unknown>) =>
    failText(run({ overrides: { alpha: ov(over) } }))
  const accFails = (over: Record<string, unknown>) => failText(run({ acceptances: [acc(over)] }))

  it.each([true, false, 1, ['x'], '', '  '])('crossesMajor %j is rejected', (v) => {
    expect(ovFails({ crossesMajor: v })).toMatch(/crossesMajor must be a non-empty string or null/)
  })
  it.each([null, 'forces x up from 5.x'])('control: crossesMajor %j is accepted', (v) => {
    expect(run({ overrides: { alpha: ov({ crossesMajor: v }) } }).findings).toEqual([])
  })

  it.each([[[]], ['SMI-1'], [['']], [[1]], [null], [{}]])('introducedBy %j is rejected', (v) => {
    expect(ovFails({ introducedBy: v })).toMatch(
      /introducedBy must be a non-empty array of non-empty strings/
    )
  })
  it('control: a non-empty array of non-empty strings is accepted', () => {
    expect(
      run({ overrides: { alpha: ov({ introducedBy: ['SMI-1', 'abc123'] }) } }).findings
    ).toEqual([])
  })

  it.each(['urgent', 'HIGH', 'info'])('severity %j is rejected', (v) => {
    expect(accFails({ severity: v })).toMatch(
      /severity .* must be one of low, moderate, high, critical/
    )
  })
  it.each(['low', 'moderate', 'high', 'critical'])('control: severity %s is accepted', (v) => {
    expect(run({ acceptances: [acc({ severity: v })] }).findings).toEqual([])
  })

  it.each(['SMI-12x', 'smi-12', 'SMI-', 12, 'GHSA-aaaa-bbbb-cccc', ''])(
    'tracking %j is rejected',
    (v) => {
      expect(accFails({ tracking: v })).toMatch(/tracking .* must be null or SMI-<number>/)
    }
  )
  it.each([null, 'SMI-12'])('control: tracking %j is accepted', (v) => {
    expect(run({ acceptances: [acc({ tracking: v })] }).findings).toEqual([])
  })

  it.each(['a b', 'a/b', 'a@b', '@someone', 'a_b'])('owner %j is not a GitHub login', (v) => {
    expect(accFails({ owner: v })).toMatch(/owner .* is not a GitHub login/)
  })
  // GitHub login rules: 1..39 chars, alphanumeric, single hyphens only, none leading or trailing.
  it.each(['-', 'a-', '-a', 'a--b', 'a'.repeat(40), '---', 'a-b-'])(
    'owner %j breaks a GitHub login rule',
    (v) => {
      expect(accFails({ owner: v })).toMatch(/owner .* is not a GitHub login/)
    }
  )
  it.each(['a', 'a-b', 'a-b-c', 'a'.repeat(39), 'A1-b2'])('control: owner %j is valid', (v) => {
    expect(run({ acceptances: [acc({ owner: v })] }).findings).toEqual([])
  })
  it.each(['wrsmith108', 'a-b', 'A1'])('control: owner %s is accepted', (v) => {
    expect(run({ acceptances: [acc({ owner: v })] }).findings).toEqual([])
  })
  it('an empty owner is the existing empty-field failure, not a login failure', () => {
    expect(accFails({ owner: '' })).toMatch(/has an empty "owner"/)
  })
  it('advisories that is not an array fails; an array passes', () => {
    expect(ovFails({ advisories: 'GHSA-aaaa-bbbb-cccc' })).toMatch(/advisories is not an array/)
    expect(run({ overrides: { alpha: ov({ advisories: [] }) } }).findings).toEqual([])
  })
})

describe('override keys containing " > " (R1-L3)', () => {
  it('a top-level key that spells a nested path fails', () => {
    const r = run({
      pkg: { overrides: { 'a > b': '1.0.0' } },
      overrides: { 'a > b': ov({ pin: '1.0.0' }) },
    })
    expect(failText(r)).toMatch(/override key "a > b" contains " > "/)
  })
  it('the collision case (top-level "a > b" beside nested a: { b }) fails', () => {
    const r = run({
      pkg: { overrides: { 'a > b': '1.0.0', a: { b: '2.0.0' } } },
      overrides: { 'a > b': ov({ pin: '2.0.0' }) },
    })
    expect(failText(r)).toMatch(/override key "a > b" contains " > "/)
  })
  it('a " > " inside a NESTED key fails (the scan recurses)', () => {
    const r = run({
      pkg: { overrides: { a: { 'x > y': '1.0.0' } } },
      overrides: { 'a > x > y': ov({ pin: '1.0.0' }) },
    })
    expect(failText(r)).toMatch(/override key "a > x > y" contains " > "/)
    const deep = run({
      pkg: { overrides: { a: { b: { 'c > d': '1.0.0' } } } },
      overrides: { 'a > b > c > d': ov({ pin: '1.0.0' }) },
    })
    expect(failText(deep)).toMatch(/override key "a > b > c > d" contains " > "/)
  })
  it('two leaves that JOIN to the same key fail even though neither key contains " > "', () => {
    // {"a >": {"b"}} and {"a": {"> b"}} both join to "a > > b".
    const r = run({
      pkg: { overrides: { 'a >': { b: '1.0.0' }, a: { '> b': '2.0.0' } } },
      overrides: { 'a > > b': ov({ pin: '2.0.0' }) },
    })
    expect(failText(r)).toMatch(/join to the same registry key "a > > b"/)
  })
  it('control: the same shape written as a nested object is clean', () => {
    const r = run({
      pkg: { overrides: { a: { b: '1.0.0' } } },
      overrides: { 'a > b': ov({ pin: '1.0.0' }) },
    })
    expect(r.findings).toEqual([])
  })
})

describe('lockfile shape and package matching (R1-M5)', () => {
  it.each([
    ['lockfileVersion 1', { lockfileVersion: 1, dependencies: {} }],
    ['no lockfileVersion', { packages: { 'node_modules/pkgone': {} } }],
    ['a string lockfileVersion', { lockfileVersion: '3', packages: { 'node_modules/pkgone': {} } }],
    ['no packages object', { lockfileVersion: 3 }],
  ])('%s is NOT EVALUATED, with a message naming the problem', (_l, lock) => {
    const r = run({ lock })
    expect(r.evaluated).toBe(false)
    expect(r.findings[0].message).toMatch(/NOT EVALUATED - package-lock\.json/)
  })
  it.each([2, 3])('control: lockfileVersion %i is evaluated', (v) => {
    const r = run({ lock: { ...lockWith('pkgone'), lockfileVersion: v } })
    expect(r.evaluated).toBe(true)
    expect(r.findings).toEqual([])
  })

  const decoy = (pkgName: string, ...lockNames: string[]) =>
    run({ acceptances: [acc({ package: pkgName })], lock: lockWith(...lockNames) })
  it('a longer name that merely ends with the package name is not a match (foobar vs bar)', () => {
    expect(failText(decoy('bar', 'foobar'))).toMatch(
      /package "bar", which is not in package-lock.json/
    )
    expect(failText(decoy('bar', 'x/node_modules/foobar'))).toMatch(/not in package-lock.json/)
    expect(failText(decoy('@s/bar', '@s/foobar'))).toMatch(/not in package-lock.json/)
  })
  it('control: the exact name matches at top level, nested, and scoped', () => {
    expect(decoy('bar', 'bar').findings).toEqual([])
    expect(decoy('bar', 'x/node_modules/bar').findings).toEqual([])
    expect(decoy('@s/bar', '@s/bar').findings).toEqual([])
  })
})
