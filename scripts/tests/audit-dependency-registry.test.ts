/**
 * SMI-6949: audit:standards Check 76 (dependency registry) and the Check 11 text.
 * T-numbers refer to the Test Plan in
 * docs/internal/implementation/smi-6949-audit-gate-and-dependency-registry-enforcement.md.
 * Dates are injected; nothing here reads the clock.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import * as reg from '../audit-dependency-registry-helpers.mjs'
// @ts-expect-error - .mjs helper has no typings
import { scanDuplicateJsonKeys } from '../audit-dependency-registry-json.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { evaluateDependencyRegistry, readDependencyRegistryInputs, exactPinOverrideWarning } = reg

type Finding = { severity: 'fail' | 'warn'; message: string }
const TODAY = '2026-10-03'

const ov = (pin: string) => ({
  pin,
  reason: 'why',
  advisories: ['GHSA-aaaa-bbbb-cccc'],
  introducedBy: ['SMI-1'],
  crossesMajor: null,
  removeWhen: 'when fixed',
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
  today?: string
  registryText?: string
  exists?: (p: string) => boolean
}
function evalFx(fx: Fx = {}) {
  const overrides = fx.overrides ?? { alpha: ov('^1.0.0') }
  const acceptances = fx.acceptances ?? [acc()]
  const registryText = fx.registryText ?? JSON.stringify({ overrides, acceptances })
  return evaluateDependencyRegistry({
    pkg: fx.pkg ?? { overrides: { alpha: '^1.0.0' } },
    registryText,
    lock: fx.lock ?? lockWith('pkgone'),
    trackedLockfiles: ['package-lock.json'], // SMI-6954: no seed lockfile in these fixtures
    today: fx.today ?? TODAY,
    exists: fx.exists ?? (() => true),
  }) as {
    findings: Finding[]
    examined: { overrides: number; overrideLeaves: number; acceptances: number }
    windowEntries: unknown[]
    evaluated: boolean
  }
}
const fails = (r: { findings: Finding[] }) => r.findings.filter((f) => f.severity === 'fail')
const warns = (r: { findings: Finding[] }) => r.findings.filter((f) => f.severity === 'warn')

describe('Check 76 baseline', () => {
  it('a coherent fixture has zero findings (negative control for every rule below)', () => {
    const r = evalFx()
    expect(r.evaluated).toBe(true)
    expect(r.findings).toEqual([])
    expect(r.examined).toMatchObject({ overrides: 1, overrideLeaves: 1, acceptances: 1 })
  })
})

describe('overrides vs package.json (T12-T14)', () => {
  it('T12 an override missing from the registry fails, naming the key', () => {
    const r = evalFx({ pkg: { overrides: { alpha: '^1.0.0', beta: '^2.0.0' } } })
    expect(
      fails(r)
        .map((f) => f.message)
        .join('\n')
    ).toMatch(/override "beta" has no entry/)
  })
  it('T13 a registry entry with no override fails, naming the key', () => {
    const r = evalFx({ overrides: { alpha: ov('^1.0.0'), gone: ov('^9.0.0') } })
    expect(
      fails(r)
        .map((f) => f.message)
        .join('\n')
    ).toMatch(/registry entry "gone" has no matching package.json override/)
  })
  it('T14 a pin mismatch fails', () => {
    const r = evalFx({ overrides: { alpha: ov('^1.0.1') } })
    expect(
      fails(r)
        .map((f) => f.message)
        .join('\n')
    ).toMatch(/override "alpha" pin "\^1.0.1" != package.json "\^1.0.0"/)
  })
  it('nested override leaves are keyed `a > b` and `a > .`', () => {
    const r = evalFx({
      pkg: { overrides: { parent: { '.': '1.0.0', child: '^2.0.0' } } },
      overrides: { 'parent > .': ov('1.0.0'), 'parent > child': ov('^2.0.0') },
    })
    expect(r.findings).toEqual([])
    expect(r.examined.overrideLeaves).toBe(2)
  })
  it('missing reason, removeWhen, crossesMajor key and non-array advisories each fail', () => {
    const bad = { pin: '^1.0.0', reason: ' ', removeWhen: '', advisories: 'x', introducedBy: [] }
    const msgs = fails(evalFx({ overrides: { alpha: bad } }))
      .map((f) => f.message)
      .join('\n')
    expect(msgs).toMatch(/empty or missing "reason"/)
    expect(msgs).toMatch(/empty or missing "removeWhen"/)
    expect(msgs).toMatch(/missing the key "crossesMajor"/)
    expect(msgs).toMatch(/advisories is not an array/)
  })
})

describe('advisory ids (T15)', () => {
  it('T15 a truncated GHSA id fails in overrides[].advisories', () => {
    const o = { ...ov('^1.0.0'), advisories: ['GHSA-5c6j'] }
    expect(
      fails(evalFx({ overrides: { alpha: o } }))
        .map((f) => f.message)
        .join('\n')
    ).toMatch(/GHSA-5c6j" is not a full GHSA or CVE id/)
  })
  it('T15 a truncated GHSA id fails in acceptances[].advisory', () => {
    expect(
      fails(evalFx({ acceptances: [acc({ advisory: 'GHSA-5c6j' })] }))
        .map((f) => f.message)
        .join('\n')
    ).toMatch(/acceptance advisory "GHSA-5c6j" is not a full/)
  })
  it('a CVE id is rejected as an acceptance id, because npm audit reports GHSA ids', () => {
    const msgs = fails(evalFx({ acceptances: [acc({ advisory: 'CVE-2026-12345' })] })).map(
      (f) => f.message
    )
    expect(msgs.join('\n')).toMatch(
      /acceptance advisory "CVE-2026-12345" is not a full GHSA id \(npm audit reports GHSA ids/
    )
  })
  it('a CVE id is still accepted as an override advisory reference (never matched against audit)', () => {
    const o = { ...ov('^1.0.0'), advisories: ['CVE-2026-12345'] }
    expect(fails(evalFx({ overrides: { alpha: o } }))).toEqual([])
  })
})

describe('expiry and ceilings (T16-T18, T21b)', () => {
  // an R2 acceptance accepted 2026-07-01 expiring 2026-10-03 (94 days would breach 90, so use 2026-07-05)
  const exp = '2026-10-03'
  const mk = (today: string) =>
    evalFx({ today, acceptances: [acc({ accepted: '2026-07-05', expires: exp })] })

  it('T16 expiry day itself FAILS with the verbatim re-triage message', () => {
    const r = mk(exp)
    expect(fails(r)).toHaveLength(1)
    expect(fails(r)[0].message).toBe(
      `Check 76: acceptance GHSA-aaaa-bbbb-cccc (pkgone, tier R2, owner someone) expired ${exp} (UTC). Re-triage: if still unfixed, set accepted=${exp} and expires <= today+90d in .github/dependency-registry.json; if fixed, delete the entry. No opt-out exists; every code PR fails until this is done.`
    )
  })
  it('T16 the day before expiry does not fail (it warns)', () => {
    const r = mk('2026-10-02')
    expect(fails(r)).toHaveLength(0)
    expect(warns(r)).toHaveLength(1)
  })
  it('T17 today == expires - 14d warns (not fails); expires - 15d does neither', () => {
    const at14 = mk('2026-09-19')
    expect(fails(at14)).toHaveLength(0)
    expect(warns(at14)).toHaveLength(1)
    expect(at14.windowEntries).toHaveLength(1)
    const at15 = mk('2026-09-18')
    expect(fails(at15)).toHaveLength(0)
    expect(warns(at15)).toHaveLength(0)
    expect(at15.windowEntries).toHaveLength(0)
  })
  it('T18 an R1 acceptance spanning 31 days breaches the 30 day ceiling; 30 days passes', () => {
    const over = evalFx({ acceptances: [acc({ tier: 'R1', expires: '2026-11-03' })] })
    expect(
      fails(over)
        .map((f) => f.message)
        .join('\n')
    ).toMatch(/spans 31 days \(UTC\), above the tier R1 ceiling of 30/)
    expect(
      fails(evalFx({ acceptances: [acc({ tier: 'R1', expires: '2026-11-02' })] }))
    ).toHaveLength(0)
  })
  it('R2/R3 ceiling is 90 and R4 is 180 (boundary passes, one over fails)', () => {
    expect(
      fails(evalFx({ acceptances: [acc({ tier: 'R3', expires: '2027-01-01' })] }))
    ).toHaveLength(0)
    expect(
      fails(evalFx({ acceptances: [acc({ tier: 'R3', expires: '2027-01-02' })] }))
    ).toHaveLength(1)
    const r4 = (expires: string) =>
      evalFx({ acceptances: [acc({ tier: 'R4', expires, tracking: 'SMI-1' })] })
    expect(fails(r4('2027-04-01'))).toHaveLength(0)
    expect(fails(r4('2027-04-02'))).toHaveLength(1)
  })
  it('T21b an impossible date (2027-02-30) fails instead of rolling to March 1', () => {
    const r = evalFx({ acceptances: [acc({ expires: '2027-02-30' })] })
    expect(
      fails(r)
        .map((f) => f.message)
        .join('\n')
    ).toMatch(/expires "2027-02-30" is not a valid UTC YYYY-MM-DD date/)
  })
  it('accepted in the future, expires <= accepted, wrong scope, bad tier, empty basis each fail', () => {
    const msgs = (a: Record<string, unknown>) =>
      fails(evalFx({ acceptances: [acc(a)] }))
        .map((f) => f.message)
        .join('\n')
    expect(msgs({ accepted: '2026-10-04', expires: '2026-11-04' })).toMatch(
      /is after today 2026-10-03/
    )
    expect(msgs({ expires: '2026-10-03' })).toMatch(/is not after accepted/)
    expect(msgs({ scope: 'prod' })).toMatch(/scope must be "dev"/)
    expect(msgs({ tier: 'R9' })).toMatch(/tier must be one of R1, R2, R3, R4/)
    expect(msgs({ basis: '  ' })).toMatch(/empty "basis"/)
  })
  it('two acceptances for one advisory fail', () => {
    const r = evalFx({ acceptances: [acc(), acc({ owner: 'other' })] })
    expect(
      fails(r)
        .map((f) => f.message)
        .join('\n')
    ).toMatch(/GHSA-aaaa-bbbb-cccc is accepted twice/)
  })
})

describe('R4 pinning (H3)', () => {
  const r4 = (extra: Record<string, unknown>, exists?: (p: string) => boolean) =>
    evalFx({ acceptances: [acc({ tier: 'R4', expires: '2027-01-01', ...extra })], exists })
  it('R4 with neither pinnedBy nor tracking fails', () => {
    expect(
      fails(r4({}))
        .map((f) => f.message)
        .join('\n')
    ).toMatch(/neither pinnedBy .* nor a tracking issue/)
  })
  it('R4 with tracking only warns that the R4 condition is unpinned', () => {
    const r = r4({ tracking: 'SMI-6945' })
    expect(fails(r)).toHaveLength(0)
    expect(
      warns(r)
        .map((f) => f.message)
        .join('\n')
    ).toMatch(/tracked by SMI-6945 only; the R4 condition is unpinned/)
  })
  it('R4 pinnedBy naming a missing file fails; naming an existing file passes with no warn', () => {
    expect(
      fails(r4({ pinnedBy: 'tests/nope.test.ts' }, () => false))
        .map((f) => f.message)
        .join('\n')
    ).toMatch(/pinnedBy "tests\/nope.test.ts" does not name an existing regular file/)
    const ok = r4({ pinnedBy: 'tests/yes.test.ts' }, () => true)
    expect(fails(ok)).toHaveLength(0)
    expect(warns(ok)).toHaveLength(0)
  })
})

describe('raw registry shape and duplicate keys (T24-T26, M2)', () => {
  it('a missing registry, unparseable registry and missing lockfile are NOT EVALUATED failures', () => {
    const missing = evaluateDependencyRegistry({
      pkg: {},
      registryText: null,
      lock: {},
      today: TODAY,
    })
    expect(missing.evaluated).toBe(false)
    expect(missing.findings[0].message).toMatch(/NOT EVALUATED/)
    expect(evalFx({ registryText: '{not json' }).evaluated).toBe(false)
    expect(evalFx({ registryText: '{"overrides":{}}' }).evaluated).toBe(false)
    const noLock = evaluateDependencyRegistry({
      pkg: {},
      registryText: '{}',
      lock: null,
      today: TODAY,
    })
    expect(noLock.evaluated).toBe(false)
    const badToday = evalFx({ today: '2026-13-01' })
    expect(badToday.evaluated).toBe(false)
  })

  it('T24 a duplicate top-level override key fails, naming the key', () => {
    const registryText = `{"overrides":{"alpha":${JSON.stringify(ov('^1.0.0'))},"alpha":${JSON.stringify(ov('^1.0.0'))}},"acceptances":[]}`
    const r = evalFx({ registryText })
    expect(JSON.parse(registryText).overrides.alpha).toBeTruthy() // JSON.parse alone sees nothing wrong
    expect(
      fails(r)
        .map((f) => f.message)
        .join('\n')
    ).toMatch(/duplicate key "alpha" at overrides/)
  })

  it.each([
    [
      'pin',
      (t: string) => t.replace('"pin":"^1.0.0"', '"pin":"^1.0.0","pin":"^1.0.0"'),
      'overrides.alpha',
    ],
    [
      'advisory',
      (t: string) =>
        t.replace(
          '"advisory":"GHSA-aaaa-bbbb-cccc"',
          '"advisory":"GHSA-aaaa-bbbb-cccc","advisory":"GHSA-aaaa-bbbb-cccc"'
        ),
      'acceptances[0]',
    ],
    [
      'expires',
      (t: string) =>
        t.replace('"expires":"2026-12-01"', '"expires":"2026-12-01","expires":"2026-12-01"'),
      'acceptances[0]',
    ],
  ])('T25 a duplicate `%s` field inside an entry fails', (field, mutate, where) => {
    const base = JSON.stringify({ overrides: { alpha: ov('^1.0.0') }, acceptances: [acc()] })
    const registryText = mutate(base)
    expect(registryText).not.toBe(base) // the fixture really contains the duplicate
    const r = evalFx({ registryText })
    expect(
      fails(r)
        .map((f) => f.message)
        .join('\n')
    ).toContain(`duplicate key "${field}" at ${where}`)
  })

  it('the scanner reports nothing on a clean document and finds nested duplicates', () => {
    expect(scanDuplicateJsonKeys('{"a":{"b":1},"c":[{"d":1},{"d":2}]}')).toEqual([])
    expect(scanDuplicateJsonKeys('{"a":{"b":1,"b":2}}')).toEqual([{ key: 'b', path: 'a' }])
  })

  it('T26 an acceptance whose package is absent from package-lock.json fails; with the lockfile intact it passes', () => {
    const absent = evalFx({ lock: lockWith('someother') })
    expect(
      fails(absent)
        .map((f) => f.message)
        .join('\n')
    ).toMatch(/package "pkgone", which is not in package-lock.json/)
    expect(fails(evalFx({ lock: lockWith('pkgone') }))).toHaveLength(0)
    expect(
      fails(
        evalFx({
          lock: {
            lockfileVersion: 3,
            packages: { 'node_modules/x/node_modules/pkgone': { dev: true } },
          },
        })
      )
    ).toHaveLength(0)
  })
})

describe('GitHub Actions visibility (H4)', () => {
  it('emits ::warning annotations and a step-summary table inside the window, nothing outside GITHUB_ACTIONS', () => {
    const entries = [
      {
        advisory: 'GHSA-aaaa-bbbb-cccc',
        package: 'pkgone',
        expires: '2026-10-10',
        owner: 'someone',
      },
    ]
    const summary = join(mkdtempSync(join(tmpdir(), 'smi6949-sum-')), 'summary.md')
    const lines: string[] = []
    reg.emitGithubActionsReport(
      entries,
      { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary },
      (l: string) => lines.push(l)
    )
    expect(lines).toEqual([
      '::warning file=.github/dependency-registry.json::GHSA-aaaa-bbbb-cccc expires 2026-10-10 (UTC), owner someone',
    ])
    expect(readFileSync(summary, 'utf8')).toContain(
      '| GHSA-aaaa-bbbb-cccc | pkgone | 2026-10-10 | someone |'
    )
    const quiet: string[] = []
    reg.emitGithubActionsReport(entries, {}, (l: string) => quiet.push(l))
    expect(quiet).toEqual([])
    const before = readFileSync(summary, 'utf8')
    reg.emitGithubActionsReport(
      [],
      { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary },
      (l: string) => quiet.push(l)
    )
    expect(readFileSync(summary, 'utf8')).toBe(before)
  })
})

describe('Check 76 against the real repo files (T19, T21)', () => {
  const inputs = () => readDependencyRegistryInputs(REPO_ROOT)
  type Seeds = Record<string, { overrides: object; acceptances: Array<{ accepted: string }> }>
  const todayFromRegistry = () => {
    const parsed = JSON.parse(inputs().registryText as string) as {
      acceptances: Array<{ accepted: string }>
      seeds?: Seeds
    }
    const seedAcceptances = Object.values(parsed.seeds ?? {}).flatMap((s) => s.acceptances)
    return [...parsed.acceptances, ...seedAcceptances]
      .map((a) => a.accepted)
      .sort()
      .pop() as string
  }
  // SMI-6954: Check 76 lists tracked lockfiles with git ls-files, and falls back to a file scan
  // where git cannot run (a worktree dev container's .git names an unmounted host path). Either
  // way the real tree must enumerate exactly the root and the seed lockfile, and these tests run
  // in every environment; the source is logged so a run shows which one served it.
  const enumerated = () => {
    const i = inputs()
    console.log(
      `check76 real-tree lockfiles: source=${i.lockfileSource} ${JSON.stringify(i.trackedLockfiles)}`
    )
    expect(['git', 'scan']).toContain(i.lockfileSource)
    const parsed = JSON.parse(i.registryText as string) as { seeds?: Seeds }
    expect([...i.trackedLockfiles].sort()).toEqual(
      ['package-lock.json', ...Object.keys(parsed.seeds ?? {})].sort()
    )
  }

  it('T19 zero fails; warns are exactly the tracking-only R4 entries; examined counts equal the registry own counts', () => {
    enumerated()
    const i = inputs()
    const parsed = JSON.parse(i.registryText as string) as {
      overrides: object
      acceptances: Array<Record<string, unknown>>
      seeds?: Seeds
    }
    const r = evaluateDependencyRegistry({ ...i, today: todayFromRegistry() }) as ReturnType<
      typeof evalFx
    >
    expect(r.evaluated).toBe(true)
    expect(fails(r).map((f) => f.message)).toEqual([])
    // presence: the run examined what the registry actually holds, and it is non-empty
    expect(r.examined.overrides).toBe(Object.keys(parsed.overrides).length)
    expect(r.examined.acceptances).toBe(parsed.acceptances.length)
    expect(r.examined.overrides).toBeGreaterThan(0)
    expect(r.examined.acceptances).toBeGreaterThan(0)
    expect(r.examined.overrideLeaves).toBe(r.examined.overrides)
    // SMI-6954: every seed section was examined, and the real tree has at least one
    const seeds = Object.values(parsed.seeds ?? {})
    expect(r.examined.seedSections).toBe(seeds.length)
    expect(r.examined.seedSections).toBeGreaterThan(0)
    expect(r.examined.seedOverrides).toBe(
      seeds.reduce((n, s) => n + Object.keys(s.overrides).length, 0)
    )
    expect(r.examined.seedAcceptances).toBe(seeds.reduce((n, s) => n + s.acceptances.length, 0))
    const expected = parsed.acceptances
      .filter((a) => a.tier === 'R4' && a.tracking && !a.pinnedBy)
      .map((a) => a.advisory as string)
      .sort()
    const warned = warns(r)
      .map((f) => /acceptance (GHSA-[a-z0-9-]+)/.exec(f.message)?.[1] ?? f.message)
      .sort()
    expect(warned).toEqual(expected)
  })

  it('T19 control: an empty registry examines nothing, which the count assertion distinguishes', () => {
    enumerated()
    const i = inputs()
    const r = evaluateDependencyRegistry({
      ...i,
      registryText: '{"overrides":{},"acceptances":[]}',
      today: todayFromRegistry(),
    }) as ReturnType<typeof evalFx>
    expect(r.examined.overrides).toBe(0)
    expect(fails(r).length).toBeGreaterThan(0) // every real override is now "missing"
    // and the tracked seed lockfile now has no seeds entry (SMI-6954 completeness, real tree)
    expect(fails(r).map((f) => f.message)).toContainEqual(
      expect.stringMatching(/package-lock\.json has no "seeds" entry/)
    )
  })

  it('T26 positive control: every real acceptance package is found in package-lock.json', () => {
    enumerated()
    const i = inputs()
    const r = evaluateDependencyRegistry({ ...i, today: todayFromRegistry() }) as ReturnType<
      typeof evalFx
    >
    expect(fails(r).filter((f) => /not in package-lock.json/.test(f.message))).toEqual([])
    expect(r.examined.acceptances).toBeGreaterThan(0)
  })

  // T21 uses its OWN fixture registry (not the real one), so it discriminates a local-time date
  // parse whatever the real registry happens to hold. Each acceptance spans EXACTLY its tier
  // ceiling (R1: 30 days) across a DST fall-back in one tested zone, so a parse that reads local
  // midnight sees 30 days + 1 hour and breaches the ceiling; each is evaluated on the day 14 days
  // before expiry, which is where the same hour moves the warn window. Spring-forward spans are
  // included for the same zones. 2026 transitions: America/Los_Angeles fell back 2026-11-01 and
  // sprang forward 2026-03-08; Pacific/Auckland fell back 2026-04-05 and sprang forward 2026-09-27.
  const T21_ACCEPTANCES = [
    ['GHSA-aaaa-aaaa-aaa1', 'laFall', '2026-10-10', '2026-11-09'], // spans LA fall-back (Nov 1)
    ['GHSA-aaaa-aaaa-aaa2', 'nzFall', '2026-03-20', '2026-04-19'], // spans NZ fall-back (Apr 5)
    ['GHSA-aaaa-aaaa-aaa3', 'laSpring', '2026-02-20', '2026-03-22'], // spans LA spring-forward (Mar 8)
    ['GHSA-aaaa-aaaa-aaa4', 'nzSpring', '2026-09-10', '2026-10-10'], // spans NZ spring-forward (Sep 27)
  ] as const
  const T21_TODAYS = ['2026-10-26', '2026-04-05', '2026-03-08', '2026-09-26'] // each expires - 14d

  function t21Root(): string {
    const root = mkdtempSync(join(tmpdir(), 'smi6949-tz-'))
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', overrides: {} }))
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify(lockWith(...T21_ACCEPTANCES.map((a) => a[1])))
    )
    writeFileSync(
      join(root, '.github/dependency-registry.json'),
      JSON.stringify({
        overrides: {},
        acceptances: T21_ACCEPTANCES.map(([advisory, pkg, accepted, expires]) =>
          acc({ advisory, package: pkg, tier: 'R1', accepted, expires })
        ),
      })
    )
    // Check 76 lists tracked lockfiles with git (SMI-6954): make the fixture a repository
    for (const a of [
      ['init', '-q'],
      ['add', '-A'],
    ]) {
      expect(spawnSync('git', a, { cwd: root, env: { PATH: process.env.PATH ?? '' } }).status).toBe(
        0
      )
    }
    return root
  }

  it('T21 the verdict is timezone-independent on a DST-straddling fixture (UTC, America/Los_Angeles, Pacific/Auckland agree)', () => {
    const root = t21Root()
    // Paths and dates travel as argv, never spliced into the code string (CodeQL js/code-injection).
    const child =
      'const [helper, root, todays] = process.argv.slice(1);' +
      "const { pathToFileURL } = require('node:url');" +
      'import(pathToFileURL(helper).href).then((m) => {' +
      'const i = m.readDependencyRegistryInputs(root);' +
      'console.log(JSON.stringify(JSON.parse(todays).map((today) => {' +
      'const r = m.evaluateDependencyRegistry({ ...i, today });' +
      "return r.findings.map((f) => f.severity + ' ' + f.message).sort();" +
      '})));' +
      '})'
    const helper = join(REPO_ROOT, 'scripts/audit-dependency-registry-helpers.mjs')
    const run = (tz: string): string[][] =>
      JSON.parse(
        spawnSync(process.execPath, ['-e', child, helper, root, JSON.stringify(T21_TODAYS)], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', TZ: tz },
        }).stdout
      )
    const utc = run('UTC')
    // presence: the fixture really ran, for every day, and exercised the warn window
    expect(utc).toHaveLength(T21_TODAYS.length)
    expect(utc[0].join('\n')).toMatch(
      /warn .*GHSA-aaaa-aaaa-aaa1 .* expires 2026-11-09 \(UTC\) in 14 day/
    )
    expect(utc[1].join('\n')).toMatch(
      /warn .*GHSA-aaaa-aaaa-aaa2 .* expires 2026-04-19 \(UTC\) in 14 day/
    )
    // UTC itself: every span is exactly the ceiling, so no ceiling finding on any day
    expect(utc.flat().filter((m) => /ceiling|NOT EVALUATED|impossible|invalid/.test(m))).toEqual([])
    // agreement, in both directions of DST
    expect(run('America/Los_Angeles')).toEqual(utc)
    expect(run('Pacific/Auckland')).toEqual(utc)
  })

  it('--only dependency-registry is a registered check (the unknown-check message lists it)', () => {
    const r = spawnSync(
      process.execPath,
      ['scripts/audit-standards.mjs', '--only', 'no-such-check'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('dependency-registry')
  })
})

describe('Check 11 text (T20, static + behavioural)', () => {
  const RETRACTED = ['may not take effect', 'dismiss with documented rationale']
  it('T20 the warning no longer repeats the retracted rule, and the new text is emitted in the same run', () => {
    const w = exactPinOverrideWarning(3)
    const all = `${w.message}\n${w.fix}`
    expect(all).toContain('3 npm override(s)') // presence: this really is the emitted warning
    expect(all).toContain('no version that satisfies the override')
    for (const phrase of RETRACTED) expect(all).not.toContain(phrase)
    expect(w.fix).toContain('ci-reference.md')
  })
  it('T20 static pin: Check 11 source cites ci-reference.md, not CLAUDE.md, and routes its warning through the helper', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts/audit-standards.mjs'), 'utf8')
    const start = src.indexOf('// npm override effectiveness check')
    const end = src.indexOf('// 21. Workflow continue-on-error')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).toContain('exactPinOverrideWarning(exactPinIssues.length)')
    expect(block).toContain('ci-reference.md')
    for (const phrase of [...RETRACTED, "CLAUDE.md's `npm overrides` note"])
      expect(block).not.toContain(phrase)
  })
})
