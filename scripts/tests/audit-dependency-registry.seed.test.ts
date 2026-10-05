/**
 * SMI-6954: Check 76 covers seed lockfiles (registry `seeds` section, ADR-176 section 6).
 * Rows S0-S10 are the plan's Wave 1 red tests
 * (docs/internal/implementation/smi-6954-seed-lockfile-dependency-registry.md).
 * Synthetic inputs only; `trackedLockfiles` and `seedInputs` are injected.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import * as reg from '../audit-dependency-registry-helpers.mjs'
// @ts-expect-error - .mjs helper has no typings
import { listTrackedLockfiles } from '../audit-dependency-registry-seeds.mjs'
import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env'

const {
  evaluateDependencyRegistry,
  readDependencyRegistryInputs,
  emitGithubActionsReport,
  runDependencyRegistryCheck,
} = reg

type Finding = { severity: 'fail' | 'warn'; message: string }
type Result = {
  findings: Finding[]
  examined: Record<string, number>
  windowEntries: Array<Record<string, unknown>>
  evaluated: boolean
}
const K = 'scripts/x/package-lock.json'
const TODAY = '2026-10-03'
const A = 'GHSA-aaaa-bbbb-cccc'

const ov = (pin: string) => ({
  pin,
  reason: 'why',
  advisories: [A],
  introducedBy: ['SMI-1'],
  crossesMajor: null,
  removeWhen: 'when fixed',
})
const seedAcc = (over: Record<string, unknown> = {}) => ({
  advisory: A,
  package: 'braces',
  severity: 'high',
  scope: 'seed',
  tier: 'R3',
  basis: 'no fix; served with no network',
  owner: 'someone',
  accepted: '2026-10-03',
  expires: '2026-12-01',
  ...over,
})
const rootAcc = (over: Record<string, unknown> = {}) => ({
  ...seedAcc({ package: 'pkgone', scope: 'dev', tier: 'R2' }),
  ...over,
})
const SEED_LOCK = {
  lockfileVersion: 3,
  packages: {
    '': {},
    'node_modules/toml': {},
    'node_modules/braces': { optional: true },
  },
}
const ROOT_LOCK = {
  lockfileVersion: 3,
  packages: { '': {}, 'node_modules/pkgone': { dev: true } },
}

interface Fx {
  seeds?: unknown
  seedOverrides?: Record<string, unknown>
  seedAcceptances?: unknown[]
  rootAcceptances?: unknown[]
  seedPkg?: unknown
  seedLock?: unknown
  seedInputs?: unknown
  trackedLockfiles?: unknown
  today?: string
  exists?: (p: string) => boolean
}
function run(fx: Fx = {}): Result {
  const seeds =
    'seeds' in fx
      ? fx.seeds
      : {
          [K]: {
            overrides: fx.seedOverrides ?? { toml: ov('4.2.0') },
            acceptances: fx.seedAcceptances ?? [seedAcc()],
          },
        }
  const registry: Record<string, unknown> = {
    overrides: { alpha: ov('^1.0.0') },
    acceptances: fx.rootAcceptances ?? [],
  }
  if (seeds !== undefined) registry.seeds = seeds
  const input: Record<string, unknown> = {
    pkg: { overrides: { alpha: '^1.0.0' } },
    registryText: JSON.stringify(registry),
    lock: ROOT_LOCK,
    today: fx.today ?? TODAY,
    exists: fx.exists ?? (() => true),
    seedInputs:
      'seedInputs' in fx
        ? fx.seedInputs
        : {
            [K]: {
              pkg: fx.seedPkg ?? { overrides: { toml: '4.2.0' } },
              lock: fx.seedLock ?? SEED_LOCK,
            },
          },
  }
  input.trackedLockfiles = 'trackedLockfiles' in fx ? fx.trackedLockfiles : ['package-lock.json', K]
  return evaluateDependencyRegistry(input) as Result
}
const fails = (r: Result) => r.findings.filter((f) => f.severity === 'fail').map((f) => f.message)
const warns = (r: Result) => r.findings.filter((f) => f.severity === 'warn').map((f) => f.message)

describe('S0 control', () => {
  it('a coherent root plus seed section has zero findings and counts the seed entries', () => {
    const r = run()
    expect(r.evaluated).toBe(true)
    expect(r.findings).toEqual([])
    expect(r.examined).toMatchObject({ seedOverrides: 1, seedAcceptances: 1 })
  })
})

describe('S1-S3 completeness and seed overrides', () => {
  it('S1 a tracked lockfile with no seeds entry fails', () => {
    expect(fails(run({ seeds: {} }))).toContainEqual(
      expect.stringMatching(/scripts\/x\/package-lock\.json has no "seeds" entry/)
    )
  })
  it('S1 deleting the whole seeds key fails the same way', () => {
    expect(fails(run({ seeds: undefined }))).toContainEqual(
      expect.stringMatching(/scripts\/x\/package-lock\.json has no "seeds" entry/)
    )
  })
  it('S2 a seed package.json override with no seed registry entry fails, labelled with the key', () => {
    expect(fails(run({ seedOverrides: {} }))).toContainEqual(
      expect.stringMatching(/\[scripts\/x\/package-lock\.json\].*override "toml" has no entry/)
    )
  })
  it('S3 a seed pin mismatch fails, labelled with the key', () => {
    expect(fails(run({ seedOverrides: { toml: ov('4.1.0') } }))).toContainEqual(
      expect.stringMatching(
        /\[scripts\/x\/package-lock\.json\].*override "toml" pin "4\.1\.0" != package\.json "4\.2\.0"/
      )
    )
  })
})

describe('S4-S6 acceptance scope, presence and duplicates', () => {
  it('S4 a seed acceptance with scope "dev" fails', () => {
    expect(fails(run({ seedAcceptances: [seedAcc({ scope: 'dev' })] }))).toContainEqual(
      expect.stringMatching(/\[scripts\/x\/package-lock\.json\].*scope must be "seed"/)
    )
  })
  it('S4 regression: a ROOT acceptance with scope "seed" still fails as "must be dev"', () => {
    const msgs = fails(run({ rootAcceptances: [rootAcc({ scope: 'seed' })] }))
    expect(msgs).toContainEqual(expect.stringMatching(/scope must be "dev"/))
  })
  it('S5 a seed acceptance for a non-dev optional install passes (no dev-only rule)', () => {
    expect(fails(run())).toEqual([])
  })
  it('S5b the same acceptance with the package absent from the seed lockfile fails', () => {
    const seedLock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/toml': {} } }
    expect(fails(run({ seedLock }))).toContainEqual(
      expect.stringMatching(
        /\[scripts\/x\/package-lock\.json\].*"braces", which is not in scripts\/x\/package-lock\.json/
      )
    )
  })
  it('S6 the same GHSA in the root and the seed is allowed', () => {
    const msgs = fails(run({ rootAcceptances: [rootAcc()] }))
    expect(msgs).toEqual([])
  })
  it('S6 the same GHSA twice in one seed section fails', () => {
    expect(fails(run({ seedAcceptances: [seedAcc(), seedAcc()] }))).toContainEqual(
      expect.stringMatching(
        /\[scripts\/x\/package-lock\.json\].*advisory GHSA-aaaa-bbbb-cccc is accepted twice/
      )
    )
  })
})

describe('S7 tiers', () => {
  it.each(['R1', 'R2'])('S7 a seed acceptance at tier %s fails', (tier) => {
    expect(fails(run({ seedAcceptances: [seedAcc({ tier })] }))).toContainEqual(
      expect.stringMatching(
        new RegExp(`\\[scripts/x/package-lock\\.json\\].*tier ${tier} .*must be R3 or R4`)
      )
    )
  })
  it('S7 a seed R3 spanning 91 days fails; exactly 90 passes', () => {
    expect(fails(run({ seedAcceptances: [seedAcc({ expires: '2027-01-02' })] }))).toContainEqual(
      expect.stringMatching(
        /\[scripts\/x\/package-lock\.json\].*spans 91 days \(UTC\), above the tier R3 ceiling of 90/
      )
    )
    expect(fails(run({ seedAcceptances: [seedAcc({ expires: '2027-01-01' })] }))).toEqual([])
  })
  it('S7b a seed R4 with tracking and no pinnedBy is a FAILURE', () => {
    const r = run({ seedAcceptances: [seedAcc({ tier: 'R4', tracking: 'SMI-1' })] })
    expect(fails(r)).toContainEqual(
      expect.stringMatching(/seed acceptance .* R4 requires pinnedBy/)
    )
    expect(warns(r).filter((m) => /unpinned/.test(m))).toEqual([])
  })
  it('S7b regression: the same ROOT R4 only warns', () => {
    const r = run({ rootAcceptances: [rootAcc({ tier: 'R4', tracking: 'SMI-1' })] })
    expect(fails(r)).toEqual([])
    expect(warns(r)).toEqual([expect.stringMatching(/is tracked by SMI-1 only/)])
  })
  it('S7c a seed R4 with a pinnedBy naming an existing test file passes', () => {
    const r = run({
      seedAcceptances: [
        seedAcc({ tier: 'R4', tracking: 'SMI-1', pinnedBy: 'scripts/tests/pin.test.ts' }),
      ],
    })
    expect(fails(r)).toEqual([])
    expect(warns(r)).toEqual([])
  })
})

describe('S8 expiry and the warn window', () => {
  it('S8 on its expiry day a seed acceptance fails with a seed-labelled re-triage message', () => {
    expect(fails(run({ today: '2026-12-01' }))).toContainEqual(
      expect.stringMatching(
        /\[scripts\/x\/package-lock\.json\].*expired 2026-12-01 \(UTC\)\. Re-triage/
      )
    )
  })
  it('S8 at expiry minus 14 days it warns, and the Actions annotation names the seed', () => {
    const r = run({ today: '2026-11-17' })
    expect(fails(r)).toEqual([])
    expect(warns(r)).toContainEqual(
      expect.stringMatching(
        /\[scripts\/x\/package-lock\.json\].*expires 2026-12-01 \(UTC\) in 14 day/
      )
    )
    expect(r.windowEntries).toHaveLength(1)
    const lines: string[] = []
    emitGithubActionsReport(r.windowEntries, { GITHUB_ACTIONS: 'true' }, (l: string) =>
      lines.push(l)
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^::warning file=\.github\/dependency-registry\.json::/)
    expect(lines[0]).toContain(K)
  })
})

describe('S9 seeds shape and keys', () => {
  it('S9 seeds as an array fails', () => {
    expect(fails(run({ seeds: [] }))).toContainEqual(
      expect.stringMatching(/"seeds" must be an object/)
    )
  })
  it.each([
    ['scripts/../x/package-lock.json', /"\.\." segment/],
    ['/abs/package-lock.json', /not a repo-relative/],
    ['scripts/x/yarn.lock', /does not end in "\/package-lock\.json"/],
    ['package-lock.json', /is the root lockfile/],
    ['scripts/y/package-lock.json', /is not a tracked lockfile/],
    ['node_modules/x/package-lock.json', /not a permitted lockfile location/],
    ['.worktrees/w/package-lock.json', /not a permitted lockfile location/],
    ['scripts/a\nb/package-lock.json', /control character/],
    ['scripts/a\rb/package-lock.json', /control character/],
    ['scripts/a\tb/package-lock.json', /control character/],
  ])('S9 the key %s fails', (key, re) => {
    const section = { overrides: {}, acceptances: [] }
    const msgs = fails(
      run({ seeds: { [K]: { overrides: { toml: ov('4.2.0') }, acceptances: [] }, [key]: section } })
    )
    expect(msgs).toContainEqual(expect.stringMatching(re))
  })
})

describe('S9b forbidden lockfile locations in git mode', () => {
  it.each(['node_modules/x/package-lock.json', '.worktrees/w/package-lock.json'])(
    'a tracked %s fails',
    (p) => {
      expect(fails(run({ trackedLockfiles: ['package-lock.json', K, p] }))).toContainEqual(
        expect.stringContaining(
          `${p} is not a permitted lockfile location (under node_modules/ or .worktrees/)`
        )
      )
    }
  )
  it('the existing paths still pass', () => {
    expect(fails(run({}))).toEqual([])
  })
})

describe('S10 enumeration and inputs fail closed', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('S10 trackedLockfiles %s is NOT EVALUATED, never a pass', (_l, tracked) => {
    expect(fails(run({ trackedLockfiles: tracked }))).toContainEqual(
      expect.stringMatching(/NOT EVALUATED - cannot list tracked lockfiles/)
    )
  })
  it('S10b a seed section whose package.json and lockfile were not read is NOT EVALUATED', () => {
    expect(fails(run({ seedInputs: {} }))).toContainEqual(
      expect.stringMatching(/\[scripts\/x\/package-lock\.json\].*NOT EVALUATED/)
    )
  })
  it('S-read readDependencyRegistryInputs lists tracked lockfiles with git and reads seed inputs', () => {
    const root = makeFixtureTempDir('smi6954-read')
    mkdirSync(join(root, '.github'), { recursive: true })
    mkdirSync(join(root, 'scripts/x'), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{}')
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify(ROOT_LOCK))
    writeFileSync(join(root, 'scripts/x/package.json'), '{"overrides":{"toml":"4.2.0"}}')
    writeFileSync(join(root, K), JSON.stringify(SEED_LOCK))
    writeFileSync(join(root, 'untracked-lock.txt'), '')
    writeFileSync(
      join(root, '.github/dependency-registry.json'),
      JSON.stringify({ overrides: {}, acceptances: [], seeds: { [K]: {} } })
    )
    const git = (...a: string[]) =>
      spawnSync('git', a, { cwd: root, encoding: 'utf8', env: makeFixtureEnv() })
    expect(git('init', '-q').status).toBe(0)
    expect(git('add', '-A').status).toBe(0)
    const i = readDependencyRegistryInputs(root)
    expect(i.lockfileSource).toBe('git') // F5: the git path is used when git works
    expect([...i.trackedLockfiles].sort()).toEqual(['package-lock.json', K])
    expect(i.seedInputs[K].pkg).toEqual({ overrides: { toml: '4.2.0' } })
    expect(i.seedInputs[K].lock.packages['node_modules/toml']).toEqual({})
    // negative control: a tree without .git is not listed by git; the file scan serves it instead
    const bare = mkdtempSync(join(tmpdir(), 'smi6954-nogit-'))
    writeFileSync(join(bare, 'package-lock.json'), '{}')
    const b = readDependencyRegistryInputs(bare)
    expect(b.lockfileSource).toBe('scan')
    expect(b.trackedLockfiles).toEqual(['package-lock.json'])
  })
  const TWO = ['other/package-lock.json', 'package-lock.json'] // what makeTrackedRepo tracks
  const makeTrackedRepo = (prefix: string) => {
    const root = makeFixtureTempDir(prefix)
    mkdirSync(join(root, 'other'), { recursive: true })
    for (const f of ['package-lock.json', 'other/package-lock.json'])
      writeFileSync(join(root, f), '{}')
    const git = (...a: string[]) =>
      spawnSync('git', a, { cwd: root, encoding: 'utf8', env: makeFixtureEnv() })
    for (const a of [
      ['init', '-q'],
      ['add', '-A'],
    ])
      expect(git(...a).status).toBe(0)
    return { root, git }
  }
  it('S-env an inherited GIT_DIR does not redirect the tracked-lockfile listing (SMI-6994)', () => {
    const { root: fixture } = makeTrackedRepo('smi6994-env')
    const bare = makeFixtureTempDir('smi6994-env-bare')
    writeFileSync(join(bare, 'package-lock.json'), '{}')
    const helpers = new URL('../audit-dependency-registry-helpers.mjs', import.meta.url).pathname
    const code = `import(${JSON.stringify(helpers)}).then((m) => { const i = m.readDependencyRegistryInputs(process.argv[1]); console.log(JSON.stringify({ source: i.lockfileSource, tracked: [...i.trackedLockfiles].sort() })) })`
    const read = (root: string) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, root], {
        encoding: 'utf8',
        env: { ...makeFixtureEnv(), GIT_DIR: join(fixture, '.git') },
      })
      expect(r.status, r.stderr).toBe(0)
      return JSON.parse(r.stdout) as { source: string; tracked: string[] }
    }
    // known-positive: GIT_DIR names a live repo, which lists; the bare root is not its work tree
    expect(read(fixture)).toEqual({ source: 'git', tracked: TWO })
    expect(read(bare)).toEqual({ source: 'scan', tracked: ['package-lock.json'] })
  })
  it('S-fsmon listing tracked lockfiles never runs a repo-configured fsmonitor hook (SMI-6994)', () => {
    const { root, git } = makeTrackedRepo('smi6994-fsmon')
    const aux = makeFixtureTempDir('smi6994-aux')
    const [marker, hook] = [join(aux, 'marker'), join(aux, 'hook.sh')]
    writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\nprintf '\\0'\n`, { mode: 0o755 })
    writeFileSync(marker, '')
    expect(git('config', 'core.fsmonitor', hook).status).toBe(0)
    git('status', '--porcelain') // known-positive: the hook is wired, so git runs it
    expect(readFileSync(marker, 'utf8')).not.toBe('')
    writeFileSync(marker, '')
    expect([...(listTrackedLockfiles(root) ?? [])].sort()).toEqual(TWO)
    expect(readFileSync(marker, 'utf8')).toBe('')
  })
})

/** A tree with NO .git: root files, the seed at K, and optional extra lockfiles. */
function noGitTree(seeds: unknown, extraLocks: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'smi6954-scan-'))
  const write = (rel: string, body: string) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  write('package.json', JSON.stringify({ overrides: { alpha: '^1.0.0' } }))
  write('package-lock.json', JSON.stringify(ROOT_LOCK))
  write('scripts/x/package.json', JSON.stringify({ overrides: { toml: '4.2.0' } }))
  write(K, JSON.stringify(SEED_LOCK))
  for (const rel of extraLocks) write(rel, JSON.stringify(SEED_LOCK))
  const registry: Record<string, unknown> = { overrides: { alpha: ov('^1.0.0') }, acceptances: [] }
  if (seeds !== undefined) registry.seeds = seeds
  write('.github/dependency-registry.json', JSON.stringify(registry))
  return root
}
const FULL_SEEDS = { [K]: { overrides: { toml: ov('4.2.0') }, acceptances: [seedAcc()] } }
const evalTree = (root: string) =>
  evaluateDependencyRegistry({
    ...readDependencyRegistryInputs(root),
    today: TODAY,
    exists: () => true,
  }) as Result

describe('F file-scan fallback when git cannot list lockfiles (owner decision)', () => {
  it('F1 git unavailable: a seed lockfile on disk with no seeds entry fails, naming it and the scan', () => {
    const msgs = fails(evalTree(noGitTree({})))
    expect(msgs).toContainEqual(
      expect.stringMatching(
        /scripts\/x\/package-lock\.json has no "seeds" entry.*tracked lockfiles from a file scan: git unavailable/
      )
    )
    expect(msgs.filter((m) => /NOT EVALUATED/.test(m))).toEqual([])
  })
  it('F2 git unavailable: full entries pass, and the result records the scan', () => {
    const r = evalTree(noGitTree(FULL_SEEDS))
    expect(fails(r)).toEqual([])
    expect(r.examined).toMatchObject({ seedSections: 1, seedOverrides: 1, seedAcceptances: 1 })
    expect(String(r.examined.lockfileNote)).toMatch(/file scan: git unavailable/)
  })
  it('F2b the pass line says the lockfiles came from a file scan', () => {
    const passes: string[] = []
    const failures = runDependencyRegistryCheck(
      { pass: (m: string) => passes.push(m), warn: () => {}, fail: () => {} },
      { root: noGitTree(FULL_SEEDS), today: TODAY, env: {} }
    )
    expect(failures).toBe(0)
    expect(passes).toHaveLength(1)
    expect(passes[0]).toContain('(tracked lockfiles from a file scan: git unavailable)')
  })
  it('F3 the scan skips only node_modules, .git and .worktrees; dist, coverage and tests/fixtures are found', () => {
    const root = noGitTree(FULL_SEEDS, [
      'node_modules/a/package-lock.json',
      '.worktrees/w/package-lock.json',
      'dist/package-lock.json',
      'coverage/package-lock.json',
      'scripts/tests/fixtures/package-lock.json',
      'pkg/tests/fixtures/deep/package-lock.json',
    ])
    const i = readDependencyRegistryInputs(root)
    expect(i.lockfileSource).toBe('scan')
    expect([...i.trackedLockfiles].sort()).toEqual(
      [
        'package-lock.json',
        K,
        'dist/package-lock.json',
        'coverage/package-lock.json',
        'scripts/tests/fixtures/package-lock.json',
        'pkg/tests/fixtures/deep/package-lock.json',
      ].sort()
    )
  })
  it('F3 a lockfile under dist/ with no seeds entry fails in fallback mode', () => {
    const root = noGitTree(FULL_SEEDS, ['dist/package-lock.json'])
    expect(fails(evalTree(root))).toContainEqual(
      expect.stringMatching(/dist\/package-lock\.json has no "seeds" entry/)
    )
  })
  it('F3 control: a lockfile in an ordinary directory IS found (untracked lockfiles count)', () => {
    const root = noGitTree(FULL_SEEDS, [
      'scratch/package-lock.json',
      'pkg/fixtures/package-lock.json',
    ])
    expect([...readDependencyRegistryInputs(root).trackedLockfiles].sort()).toEqual(
      ['package-lock.json', 'pkg/fixtures/package-lock.json', K, 'scratch/package-lock.json'].sort()
    )
    // and the stray untracked one needs a seeds entry like any other
    expect(fails(evalTree(root))).toContainEqual(
      expect.stringMatching(/scratch\/package-lock\.json has no "seeds" entry/)
    )
  })
  it('F3b the scan does not follow a symlinked directory', () => {
    const root = noGitTree(FULL_SEEDS)
    const outside = mkdtempSync(join(tmpdir(), 'smi6954-outside-'))
    writeFileSync(join(outside, 'package-lock.json'), '{}')
    symlinkSync(outside, join(root, 'linked'), 'dir')
    expect([...readDependencyRegistryInputs(root).trackedLockfiles].sort()).toEqual([
      'package-lock.json',
      K,
    ])
  })
  it('F4 git and the scan both failing is NOT EVALUATED, never a pass', () => {
    const missing = join(tmpdir(), 'smi6954-does-not-exist-' + process.pid)
    const i = readDependencyRegistryInputs(missing)
    expect(i.trackedLockfiles).toBeNull()
    expect(fails(run({ trackedLockfiles: i.trackedLockfiles }))).toContainEqual(
      expect.stringMatching(/NOT EVALUATED - cannot list tracked lockfiles/)
    )
  })
})
