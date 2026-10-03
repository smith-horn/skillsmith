/**
 * SMI-6949 review round 1: findings R1-H1, R1-H2, R1-H3, R1-M1, R1-M2, the
 * single-severity HIGH fixture (mutant A), the prefix-anchor test for the
 * pre-push soft-pass (mutant B) and the independent argv-literal list (L6).
 * Companion to npm-audit-gate.test.ts (T-numbers there); every assertion here
 * was driven RED by the mutation declared in the PR's redtests log.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  FIXTURE_WORKSPACES,
  FIX_CLEAN,
  FIX_MIXED,
  FIX_SINGLE,
  FIX_SINGLE_HIGH,
  FIX_UNREACHABLE,
  junkLines,
  runGate,
  runPolicyBlock,
} from './npm-audit-gate.helpers'

const bashes = [
  ...new Set(['bash', '/bin/bash'].filter((b) => spawnSync(b, ['-c', 'true']).status === 0)),
]
const distinctBashes = bashes.filter((b, i) => {
  const real = (x: string) => {
    const p = spawnSync('sh', ['-c', `command -v ${x}`], { encoding: 'utf8' }).stdout.trim()
    return existsSync(p) ? realpathSync(p) : x
  }
  return bashes.findIndex((o) => real(o) === real(b)) === i
})

const SUMMARY_LINE = '1 high severity vulnerability'
const NET_LINE =
  'npm warn audit request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org'

describe.each(distinctBashes)('npm-audit-gate.sh round-1 classification under %s', (bash) => {
  it('R1-H2 npm exit 0 WITH a high/critical summary is UNEXPECTED (12), never CLEAN', () => {
    for (const out of [FIX_SINGLE_HIGH, FIX_SINGLE, FIX_MIXED]) {
      const r = runGate({ bash, out, rc: 0 })
      expect(r.all).toMatch(/\d+ (high|critical|vulnerabilities)/) // presence: the summary was output
      expect(r.status).toBe(12)
      expect(r.finalLine).toBe('npm-audit-gate: UNEXPECTED (npm exit 0)')
    }
  })

  it('R1-H2 controls: exit 0 with no summary, or only a moderate summary, is still CLEAN', () => {
    expect(runGate({ bash, out: FIX_CLEAN, rc: 0 }).status).toBe(0)
    const moderate = runGate({ bash, out: '2 moderate severity vulnerabilities\n', rc: 0 })
    expect(moderate.all).toContain('2 moderate severity vulnerabilities')
    expect(moderate.status).toBe(0)
    expect(moderate.finalLine).toBe('npm-audit-gate: CLEAN (npm exit 0)')
  })

  it.each([137, 143, 2, 126])(
    'R1-H3 npm status %i with genuine npm-prefixed network text is UNEXPECTED (12), never UNAVAILABLE',
    (rc) => {
      const r = runGate({ bash, out: FIX_UNREACHABLE, rc })
      expect(r.all).toContain('npm error audit endpoint returned an error') // the network text is there
      expect(r.status).toBe(12)
      expect(r.finalLine).toBe(`npm-audit-gate: UNEXPECTED (npm exit ${rc})`)
    }
  )

  it.each([137, 143])(
    'R1-H3 npm status %i with a vulnerability summary is not VULNERABLE',
    (rc) => {
      const r = runGate({ bash, out: FIX_SINGLE_HIGH, rc })
      expect(r.status).toBe(12)
    }
  )

  it('R1-H3 control: the same network text at npm status exactly 1 is UNAVAILABLE (11)', () => {
    const r = runGate({ bash, out: FIX_UNREACHABLE, rc: 1 })
    expect(r.status).toBe(11)
    expect(r.finalLine).toBe('npm-audit-gate: UNAVAILABLE (npm exit 1)')
  })

  it('mutant A: a single-severity HIGH summary (no critical) is VULNERABLE (10)', () => {
    const r = runGate({ bash, out: FIX_SINGLE_HIGH, rc: 1 })
    expect(r.all).toContain(SUMMARY_LINE)
    expect(r.status).toBe(10)
    expect(r.finalLine).toBe('npm-audit-gate: VULNERABLE (npm exit 1)')
  })

  it('R1-M2 large output: a summary followed by 300 KB and a network line is VULNERABLE, deterministically', () => {
    const out = `${SUMMARY_LINE}\n${junkLines(3000)}${NET_LINE}\n`
    expect(out.length).toBeGreaterThan(200_000)
    for (let i = 0; i < 3; i++) {
      const r = runGate({ bash, out, rc: 1 })
      expect(r.all).toContain('package-002999') // presence: the whole output reached the classifier
      expect(r.status).toBe(10)
    }
  })

  it('R1-M2 large output: a network line first and no summary is UNAVAILABLE (11)', () => {
    const out = `${NET_LINE}\n${junkLines(3000)}`
    for (let i = 0; i < 3; i++) expect(runGate({ bash, out, rc: 1 }).status).toBe(11)
  })

  it('R1-M2 large output: exit 0 with the summary FIRST is still caught (12), not CLEAN', () => {
    const out = `${SUMMARY_LINE}\n${junkLines(3000)}`
    for (let i = 0; i < 3; i++) expect(runGate({ bash, out, rc: 0 }).status).toBe(12)
  })

  it('the argv carries one --workspace per fixture workspace under this bash', () => {
    const r = runGate({ bash, out: FIX_CLEAN, rc: 0 })
    for (const w of FIXTURE_WORKSPACES) expect(r.argv).toContain(`--workspace=${w}`)
  })
})

describe('independent frozen argv literals (L6) and the env npm receives', () => {
  // Deliberately NOT derived from PINNED_ARGV in the helpers file: that list and the
  // helper can be edited together; this one pins the security-critical subset on its own.
  const SECURITY_CRITICAL = Object.freeze([
    '--omit=dev',
    '--include=prod',
    '--offline=false',
    '--prefer-offline=false',
    '--no-json',
    '--color=false',
    '--userconfig=/dev/null',
    '--registry=https://registry.npmjs.org',
    '--audit-level=high',
    '--workspaces=true',
    '--include-workspace-root=true',
  ])

  it('every security-critical literal is its own argv element, and `audit` is the subcommand', () => {
    const r = runGate({ out: FIX_CLEAN, rc: 0 })
    expect(r.argv[0]).toBe('audit')
    for (const lit of SECURITY_CRITICAL) expect(r.argv, lit).toContain(lit)
    for (const w of FIXTURE_WORKSPACES) expect(r.argv, w).toContain(`--workspace=${w}`)
  })

  it('npm never receives npm_config_workspace or npm_config_globalconfig, in any case', () => {
    const ambient = {
      NPM_CONFIG_WORKSPACE: 'packages/a',
      npm_config_workspace: 'packages/a',
      Npm_Config_Workspace: 'packages/a',
      NPM_CONFIG_GLOBALCONFIG: '/tmp/does-not-matter',
      npm_config_globalconfig: '/tmp/does-not-matter',
      Npm_Config_GlobalConfig: '/tmp/does-not-matter',
      NPM_CONFIG_LOGLEVEL: 'silly',
    }
    const r = runGate({ out: FIX_CLEAN, rc: 0, env: ambient })
    // presence: the recorder works and an unrelated NPM_CONFIG_ entry still reaches npm,
    // so the absence below is the helper's doing and not an empty capture
    expect(r.npmEnv.length).toBeGreaterThan(3)
    expect(r.npmEnv).toContain('NPM_CONFIG_LOGLEVEL=silly')
    const leaked = r.npmEnv.filter((l) => /^npm_config_(workspace|globalconfig)=/i.test(l))
    expect(leaked).toEqual([])
  })
})

describe('workspace list derivation (R1-H1)', () => {
  const pkg = (ws: unknown) => JSON.stringify({ name: 'fx', workspaces: ws })
  const dirs = (...d: string[]) =>
    Object.fromEntries(d.map((x) => [`${x}/package.json`, JSON.stringify({ name: x })]))

  it('expands dir/* to directories holding a package.json, plus literal paths, skipping the rest', () => {
    const r = runGate({
      out: FIX_CLEAN,
      rc: 0,
      noWorkspaceDirs: true,
      rootPackageJson: pkg(['packages/*', 'tools/x', 'tools/missing']),
      cwdFiles: {
        ...dirs('packages/a', 'packages/c', 'tools/x'),
        'packages/nopkg/README.md': 'no package.json here',
        'packages/node_modules/package.json': '{}',
      },
    })
    const ws = r.argv.filter((a) => a.startsWith('--workspace='))
    expect(ws).toEqual(['--workspace=packages/a', '--workspace=packages/c', '--workspace=tools/x'])
  })

  it('accepts the object form { packages: [...] }', () => {
    const r = runGate({
      out: FIX_CLEAN,
      rc: 0,
      noWorkspaceDirs: true,
      rootPackageJson: pkg({ packages: ['apps/*'] }),
      cwdFiles: dirs('apps/web'),
    })
    expect(r.argv).toContain('--workspace=apps/web')
  })

  it.each([
    ['an unsupported glob (**)', pkg(['packages/**'])],
    ['a negation', pkg(['packages/*', '!packages/a'])],
    ['a mid-path star', pkg(['packages/*/sub'])],
    ['a multi-star pattern (packages/* beside libs/*/*)', pkg(['packages/*', 'libs/*/*'])],
    ['a star in the base directory (packages/* beside a*/*)', pkg(['packages/*', 'a*/*'])],
    ['a leading multi-star (packages/* beside */*)', pkg(['packages/*', '*/*'])],
    ['no workspaces key', JSON.stringify({ name: 'fx' })],
    ['an empty workspaces list', pkg([])],
    ['patterns that match nothing', pkg(['nowhere/*'])],
    ['an unparseable package.json', '{not json'],
  ])('%s fails closed: exit 12, npm never invoked', (_label, rootPackageJson) => {
    const r = runGate({ out: FIX_CLEAN, rc: 0, rootPackageJson })
    expect(r.status).toBe(12)
    expect(r.finalLine).toBe('npm-audit-gate: UNEXPECTED (npm exit not-run)')
    expect(r.argv).toEqual([]) // npm was never run
  })
})

describe('pre-push soft-pass is anchored at BOTH ends (mutant B)', () => {
  const FINAL = 'npm-audit-gate: UNAVAILABLE (npm exit 1)'
  it('a prefix before the exact final line blocks; the bare line still soft-passes', () => {
    const prefixed = runPolicyBlock(11, `${FIX_UNREACHABLE}xx ${FINAL}\n`)
    expect(prefixed.checksFailed).toBe('1')
    expect(runPolicyBlock(11, `${FIX_UNREACHABLE}${FINAL}\n`).checksFailed).toBe('unset')
  })
})
