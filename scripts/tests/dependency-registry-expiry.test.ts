/**
 * SMI-6949 review round 1 (R1-L4): .github/workflows/dependency-registry-expiry.yml.
 * Static shape (schedule, permissions, command, pinned actions) plus an EXECUTED
 * run of the workflow's own script with stub `node`, `npm` and `gh` (the harness in
 * dependency-registry-expiry.harness.ts), so the dedup and close-when-clean behaviour
 * is observed, not just spelled. The seed loop (SMI-6954) is tested in
 * dependency-registry-expiry.seed.test.ts.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WORKFLOW, doc, exec, script, verbs } from './dependency-registry-expiry.harness'
import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env'

describe('workflow shape', () => {
  it('exists, is ASCII only, and has a daily schedule plus workflow_dispatch', () => {
    expect(existsSync(WORKFLOW)).toBe(true)
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7f]/.test(readFileSync(WORKFLOW, 'utf8'))).toBe(false)
    const d = doc()
    expect(d.on.schedule).toHaveLength(1)
    expect(d.on.schedule?.[0].cron).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/)
    expect('workflow_dispatch' in d.on).toBe(true)
  })
  it('permissions are exactly contents: read and issues: write', () => {
    expect(doc().permissions).toEqual({ contents: 'read', issues: 'write' })
  })
  it('runs exactly the narrow Check 76 command', () => {
    expect(script()).toContain('node scripts/check-dependency-registry.mjs')
    expect(script()).not.toContain('audit-standards')
    expect(script()).toContain('gh issue list --label "$ISSUE_LABEL"')
    expect(Object.values(doc().jobs)[0].env?.ISSUE_LABEL).toBe('dependency-registry-expiry')
  })
  it('every third-party action is pinned to a 40-hex commit SHA', () => {
    const uses = Object.values(doc().jobs)[0]
      .steps.map((s) => s.uses)
      .filter(Boolean) as string[]
    expect(uses.length).toBeGreaterThanOrEqual(2)
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}( |$)/)
  })
})

describe('executed run of the workflow script (stub node and gh)', () => {
  const GREEN_R4 =
    'Check 76: dependency registry coherence and expiry (SMI-6949)\n' +
    '⚠ Check 76: R4 acceptance GHSA-aaaa-bbbb-cccc (pkg, tier R4, owner x) is tracked by SMI-1 only; the R4 condition is unpinned (no test checks it yet)\n' +
    '  Fix: Add pinnedBy\n' +
    '✓ Check 76: dependency registry coherent (1 override entries for 1 override leaves, 1 acceptances examined)\n'
  const EXPIRING =
    '::warning file=.github/dependency-registry.json::GHSA-xxxx-yyyy-zzzz expires 2026-10-10 (UTC), owner someone\n' +
    '⚠ Check 76: acceptance GHSA-xxxx-yyyy-zzzz (pkg, tier R2, owner someone) expires 2026-10-10 (UTC) in 7 day(s), owner someone\n'
  const FAILED =
    '✗ Check 76: acceptance GHSA-ffff-gggg-hhhh (pkg, tier R2, owner someone) expired 2026-10-01 (UTC). Re-triage.\n'

  it('clean run (only the standing R4 unpinned warning): no label, create, edit or close', () => {
    const r = exec(GREEN_R4, 0)
    expect(r.status).toBe(0)
    expect(verbs(r.calls)).toEqual(['issue list']) // presence: the script ran and looked for an issue
  })
  it('clean run with an open issue closes it, by number, and does not create', () => {
    const r = exec(GREEN_R4, 0, '42')
    expect(r.status).toBe(0)
    expect(r.calls.some((c) => c.startsWith('issue close 42 '))).toBe(true)
    expect(verbs(r.calls)).not.toContain('issue create')
  })
  it('an expiring acceptance with no open issue creates ONE labelled issue naming the entry', () => {
    const r = exec(EXPIRING, 0)
    expect(r.status).toBe(0)
    const creates = r.calls.filter((c) => c.startsWith('issue create '))
    expect(creates).toHaveLength(1)
    expect(creates[0]).toContain('--label dependency-registry-expiry')
    expect(r.calls.some((c) => c.startsWith('label create dependency-registry-expiry'))).toBe(true)
    expect(r.body).toContain('GHSA-xxxx-yyyy-zzzz expires 2026-10-10')
    expect(r.body).toContain('Expiring within 14 days')
    expect(r.body).toContain('/actions/runs/123')
  })
  it('an expiring acceptance with an open issue UPDATES it (dedup): edit 42, no second create', () => {
    const r = exec(EXPIRING, 0, '42')
    expect(r.calls.some((c) => c.startsWith('issue edit 42 '))).toBe(true)
    expect(verbs(r.calls)).not.toContain('issue create')
    expect(r.body).toContain('GHSA-xxxx-yyyy-zzzz')
  })
  const INFO_LINE =
    "\u2139 Check 76 reconcile (informational): advisory GHSA-iiii-jjjj-kkkk (prodpkg, moderate) has no acceptance; npm audit reports it affecting production install(s) node_modules/prodpkg, so it is production scope and outside this registry; it is below the production gate's high threshold, so no gate fails on it; it is listed here for visibility only\n"
  const INFO_SUMMARY =
    '\u2713 Check 76 reconcile: 1 acceptances match the npm audit report; no unaccepted dev-scope advisories; 1 production-scope advisories listed as informational\n'
  it('an informational-only run opens ONE labelled issue with an Informational section, and the job stays green', () => {
    const r = exec(GREEN_R4, 0, '', '', { rec: INFO_LINE + INFO_SUMMARY, recRc: 0 })
    expect(r.status).toBe(0)
    const creates = r.calls.filter((c) => c.startsWith('issue create '))
    expect(creates).toHaveLength(1)
    expect(creates[0]).toContain('--label dependency-registry-expiry')
    expect(r.body).toContain('### Informational (production scope, below or outside the registry)')
    expect(r.body).toContain(
      '- \u2139 Check 76 reconcile (informational): advisory GHSA-iiii-jjjj-kkkk'
    )
    expect(r.body).not.toContain('Failing (every code PR fails')
    expect(r.body).not.toContain('The check did not complete')
    expect(r.body).not.toContain('Expiring within 14 days')
  })
  it('an informational-only run with an open issue UPDATES it (edit 42) and does not close it', () => {
    const r = exec(GREEN_R4, 0, '42', '', { rec: INFO_LINE + INFO_SUMMARY, recRc: 0 })
    expect(r.status).toBe(0)
    expect(r.calls.some((c) => c.startsWith('issue edit 42 '))).toBe(true)
    expect(verbs(r.calls)).not.toContain('issue close')
    expect(verbs(r.calls)).not.toContain('issue create')
    expect(r.body).toContain('### Informational (production scope')
    expect(r.body).toContain('advisory GHSA-iiii-jjjj-kkkk (prodpkg, moderate)')
  })
  it('a failing `gh issue edit` on an informational-only run still fails the job', () => {
    const r = exec(GREEN_R4, 0, '42', 'issue edit', { rec: INFO_LINE + INFO_SUMMARY, recRc: 0 })
    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain('::error::gh issue edit failed')
  })
  it('a fully clean reconcile summary (no informational line) still closes an open issue', () => {
    const rec =
      '\u2713 Check 76 reconcile: 1 acceptances match the npm audit report; no unaccepted advisories\n'
    const r = exec(GREEN_R4, 0, '42', '', { rec, recRc: 0 })
    expect(r.status).toBe(0)
    expect(r.calls.some((c) => c.startsWith('issue close 42 '))).toBe(true)
    expect(verbs(r.calls)).not.toContain('issue edit')
  })
  it('a failure opens the issue AND the script exits with the check status', () => {
    const r = exec(FAILED, 1)
    expect(r.status).toBe(1)
    expect(verbs(r.calls)).toContain('issue create')
    expect(r.body).toContain('Failing (every code PR fails')
    expect(r.body).toContain('GHSA-ffff-gggg-hhhh')
  })
  it('a colour-coded failure line is recognised (ANSI codes stripped)', () => {
    const r = exec(`\u001b[0;31m✗\u001b[0m Check 76: acceptance GHSA-ffff-gggg-hhhh expired\n`, 1)
    expect(r.body).toContain('GHSA-ffff-gggg-hhhh expired')
    expect(r.body).not.toContain('\u001b') // the colour codes did not leak into the issue body
    expect(r.body).toContain('- \u2717 Check 76: acceptance GHSA-ffff-gggg-hhhh expired')
  })
  it('a failing `gh issue list` aborts non-zero and never creates (no duplicate issue)', () => {
    const r = exec(EXPIRING, 0, '42', 'issue list')
    expect(r.status).not.toBe(0)
    expect(verbs(r.calls)).toEqual(['issue list'])
    expect(r.stdout).toContain('::error::gh issue list failed')
  })
  it.each([
    ['issue create', EXPIRING, 0, ''],
    ['issue edit', EXPIRING, 0, '42'],
    ['issue close', GREEN_R4, 0, '42'],
  ])('a failing `gh %s` exits non-zero even when the check itself passed', (cmd, out, rc, ex) => {
    const r = exec(out, rc, ex, cmd)
    expect(r.status).not.toBe(0)
    expect(verbs(r.calls)).toContain(cmd)
    expect(r.stdout).toContain(`::error::gh ${cmd} failed`)
  })
  it('runs npm audit with the pinned flags, then reconciles against the file it wrote', () => {
    const r = exec(GREEN_R4, 0)
    const npmCall = r.nodeCalls.find((c) => c.startsWith('audit '))
    expect(npmCall).toBeDefined()
    for (const flag of [
      '--json',
      '--package-lock-only',
      '--offline=false',
      '--prefer-offline=false',
      '--registry=https://registry.npmjs.org',
      '--userconfig=/dev/null',
    ]) {
      expect(npmCall).toContain(flag)
    }
    expect(
      r.nodeCalls.some((c) =>
        /^scripts\/check-dependency-registry\.mjs --reconcile-audit \S*audit\.json$/.test(c)
      )
    ).toBe(true)
  })
  it('a reconcile failure opens the issue naming it and fails the job, though the expiry check passed', () => {
    const rec =
      '\u2717 Check 76 reconcile: unaccepted advisory GHSA-aaaa-bbbb-cccc (pkg, high) is reported by npm audit and has no acceptance\n'
    const r = exec(GREEN_R4, 0, '', '', { rec, recRc: 1 })
    expect(r.status).toBe(1)
    expect(verbs(r.calls)).toContain('issue create')
    // SMI-6954 PR-2: a root reconcile failure fails the daily job only, and the body says so
    expect(r.body).toContain('### Failing root reconcile (fails this daily job only')
    expect(r.body).not.toContain('every code PR fails')
    expect(r.body).toContain('unaccepted advisory GHSA-aaaa-bbbb-cccc')
  })
  it('npm audit producing no output is a ::error:: and a failing job, never a clean run', () => {
    const r = exec(GREEN_R4, 0, '', '', { out: '' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('::error::npm audit produced no JSON output')
    expect(verbs(r.calls)).toContain('issue create')
    expect(r.body).toContain('npm audit produced no JSON output')
    expect(r.nodeCalls.some((c) => c.includes('--reconcile-audit'))).toBe(false)
  })
  it('a crash with no failure line still opens the issue and says the check did not complete', () => {
    const r = exec('Error: boom\n', 2)
    expect(r.status).toBe(2)
    expect(verbs(r.calls)).toContain('issue create')
    expect(r.body).toContain('did not complete (exit 2)')
  })
})

describe('the REAL script runs with no node_modules on the path (M1)', () => {
  // The workflow has no `npm ci`. Copy scripts/ plus the three data files
  // into a bare directory and run the real script with the real node.
  // The dev container has /node_modules above any temp dir, so a bare `import 'semver'`
  // would still resolve there and the run below cannot prove the closure by itself
  // (measured: adding that import left the run green). Walk the import closure statically; the
  // dynamic runs below catch an UNRESOLVABLE package, and their verdict is deliberately not asserted.
  it('the import closure of the script is node builtins and repo files only', () => {
    const seen = new Set<string>()
    const bare: string[] = []
    const walk = (file: string): void => {
      if (seen.has(file)) return
      seen.add(file)
      const src = readFileSync(file, 'utf8')
      const re = /(?:\bfrom\s+|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g
      for (const m of src.matchAll(re)) {
        const spec = m[1]
        if (spec.startsWith('.')) walk(resolve(dirname(file), spec))
        else if (!spec.startsWith('node:') && !builtinModules.includes(spec)) {
          bare.push(`${file}: ${spec}`)
        }
      }
    }
    walk(join(REPO_ROOT, 'scripts/check-dependency-registry.mjs'))
    expect(seen.size).toBeGreaterThanOrEqual(4) // presence: the walk reached the helper modules
    expect(bare).toEqual([])
  })
  // The property under test is the IMPORT CLOSURE, not the registry's policy verdict: which
  // acceptances are live depends on the clock, so the verdict legitimately turns red on an
  // expiry date. So: the CLI must load and evaluate with no node_modules anywhere (module
  // errors are the failure), and exit 0 or 1 (a verdict), never a crash.
  const FAKE_CLOCK = `const T = Date.parse(process.env.FAKE_NOW + 'T12:00:00Z')
const R = Date
globalThis.Date = class extends R {
  constructor(...a) { if (a.length === 0) super(T); else super(...a) }
  static now() { return T }
}
`
  // Every bare-copy run uses its OWN tree, never the real registry (which can legitimately hold
  // zero acceptances): no overrides, one dev-only package, and the given acceptances. By default
  // that is one R4 acceptance pinned by a test file written into the tree, so the pinnedBy probe
  // is exercised too. FIXTURE_ACCEPTANCE (R2) expires 2026-12-01: live on the real clock today,
  // expired by 2099.
  const FIXTURE_ACCEPTANCE = {
    advisory: 'GHSA-aaaa-bbbb-cccc',
    package: 'devpkg',
    severity: 'high',
    scope: 'dev',
    tier: 'R2',
    basis: 'fixture acceptance for the fake-clock control',
    owner: 'someone',
    accepted: '2026-10-03',
    expires: '2026-12-01',
  }
  const FIXTURE_PIN = 'scripts/tests/fixture-pin.test.ts'
  const FIXTURE_PINNED_ACCEPTANCE = {
    ...FIXTURE_ACCEPTANCE,
    tier: 'R4',
    expires: '2027-04-01',
    tracking: 'SMI-1',
    pinnedBy: FIXTURE_PIN,
  }
  const FIXTURE_LOCK = {
    lockfileVersion: 3,
    packages: { '': {}, 'node_modules/devpkg': { dev: true } },
  }
  function runFromBareCopy(
    opts: {
      inject?: string
      fakeNow?: string
      acceptances?: unknown[]
      omitPinFile?: boolean
    } = {}
  ) {
    const dir = makeFixtureTempDir('smi6949-bare')
    // The whole scripts/ tree (minus tests, any node_modules and any lockfile): the closure must
    // resolve in it. A copied seed lockfile would be tracked below and need a seeds entry (SMI-6954).
    cpSync(join(REPO_ROOT, 'scripts'), join(dir, 'scripts'), {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|tests|package-lock\.json)$/.test(src),
    })
    mkdirSync(join(dir, '.github'), { recursive: true })
    writeFileSync(
      join(dir, '.github/dependency-registry.json'),
      JSON.stringify({
        overrides: {},
        acceptances: opts.acceptances ?? [FIXTURE_PINNED_ACCEPTANCE],
      })
    )
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture' }))
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(FIXTURE_LOCK))
    if (!opts.omitPinFile) {
      mkdirSync(join(dir, 'scripts/tests'), { recursive: true })
      writeFileSync(join(dir, FIXTURE_PIN), '// pin\n')
    }
    if (opts.inject) {
      const helper = join(dir, 'scripts/audit-dependency-registry-helpers.mjs')
      writeFileSync(helper, `${readFileSync(helper, 'utf8')}\n${opts.inject}\n`)
    }
    expect(existsSync(join(dir, 'node_modules'))).toBe(false)
    // Check 76 lists tracked lockfiles with git ls-files (SMI-6954); without a repository it
    // reports NOT EVALUATED, so the copy is a real repository and the real path is exercised.
    for (const a of [
      ['init', '-q'],
      ['add', '-A'],
    ]) {
      expect(spawnSync('git', a, { cwd: dir, env: makeFixtureEnv() }).status).toBe(0)
    }
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
    if (opts.fakeNow) {
      writeFileSync(join(dir, 'fake-clock.mjs'), FAKE_CLOCK)
      env.FAKE_NOW = opts.fakeNow
      env.NODE_OPTIONS = `--import ${join(dir, 'fake-clock.mjs')}`
    }
    const r = spawnSync(process.execPath, ['scripts/check-dependency-registry.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      env,
    })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }
  /** Every way the closure can fail: a module error on stderr, or a crash-shaped exit. */
  function closureProblems(r: ReturnType<typeof runFromBareCopy>): string[] {
    const bad: string[] = []
    if (/ERR_MODULE_NOT_FOUND|Cannot find (package|module)/.test(r.stderr)) bad.push('module-error')
    if (r.status !== 0 && r.status !== 1) bad.push(`crash-status-${r.status}`)
    if (!r.stdout.includes('Check 76: dependency registry coherence and expiry'))
      bad.push('no-banner')
    return bad
  }
  it.each([
    // fixed clocks: the fixture acceptance (R4, expires 2027-04-01) is live under both, on any real date
    ['a fixed clock (2026-10-04)', '2026-10-04'],
    ['a later fixed clock (2026-11-03)', '2026-11-03'],
  ])('loads and evaluates from a node_modules-free copy under %s', (_label, fakeNow) => {
    const r = runFromBareCopy({ fakeNow })
    expect(closureProblems(r)).toEqual([])
    // positive control: the evaluation ran. Either the coherent summary, or a real finding naming
    // an acceptance; NOT EVALUATED means it never reached the registry at all.
    expect(r.stdout).not.toContain('NOT EVALUATED')
    expect(r.stdout).toMatch(/acceptances examined\)|acceptance GHSA-[a-z0-9-]+ /)
    // positive control: the FIXTURE acceptance was evaluated, and its pinnedBy file was found
    // (the copied tree really contains it) rather than the pin probe being skipped.
    expect(r.stdout).toContain('1 acceptances examined)')
    expect(r.stdout).not.toMatch(/pinnedBy|unpinned/)
    // the verdict agrees with the exit status in both directions
    expect(r.status).toBe(r.stdout.includes('✗') ? 1 : 0)
  })
  it('positive control: the fake clock really moves the CLI (by 2099 every acceptance has expired)', () => {
    // Its own fixture, never the real registry: this must hold when the real one has none.
    const base = runFromBareCopy({
      fakeNow: '2026-10-04',
      acceptances: [FIXTURE_ACCEPTANCE],
    })
    expect(base.stdout).toContain('1 acceptances examined)') // presence: the fixture is evaluated, and live today
    expect(base.status).toBe(0)
    const r = runFromBareCopy({ fakeNow: '2099-01-01', acceptances: [FIXTURE_ACCEPTANCE] })
    expect(closureProblems(r)).toEqual([]) // a policy failure is not a closure failure
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/acceptance GHSA-[a-z0-9-]+ .* expired \d{4}-\d{2}-\d{2} \(UTC\)/)
  })
  it('positive control: the pinnedBy probe runs in the bare copy (a missing pin file is reported)', () => {
    const r = runFromBareCopy({ omitPinFile: true })
    expect(closureProblems(r)).toEqual([])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain(`pinnedBy "${FIXTURE_PIN}" does not name an existing regular file`)
  })
  it('negative control: a bare import added to the copy is caught as a module error', () => {
    const r = runFromBareCopy({ inject: "import 'smi6949-not-installed-pkg'" })
    expect(r.stderr).toMatch(/ERR_MODULE_NOT_FOUND|Cannot find package 'smi6949-not-installed-pkg'/)
    expect(closureProblems(r)).toContain('module-error')
  })
})
