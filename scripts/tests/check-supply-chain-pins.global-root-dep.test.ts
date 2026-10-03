/**
 * SMI-6944: Check 4 rule `workflow-global-root-dep-install`, the quote/flag-order
 * fixes it rides on, and the workflow-side invariant that every credentialed
 * `vercel` call runs the lockfile binary by absolute path.
 *
 * These run under the required `Test (root)` job and are the real gate: Check 4
 * itself runs in Dependency Guard, which is not a required status context.
 *
 * @see docs/internal/implementation/smi-6944-vercel-cli-from-lockfile.md
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const mod = await import('../ci/check-supply-chain-pins.mjs')
const {
  auditWorkflowInstalls,
  scanRunBlockForInstalls,
  scanRunBlockForGlobalRootDepInstalls,
  scanWorkflowSource,
  loadDirectDependencyNames,
  extractRunBlocks,
  jobBoundaries,
  jobNameOf,
  vercelInvocations,
} = mod as {
  auditWorkflowInstalls: (root: string) => {
    findings: Array<{ file: string; rule: string; job?: string; message: string }>
    scannedFiles: number
    runBlocks: number
    vercelInvocationBlocks: number
  }
  scanRunBlockForInstalls: (b: string, ci: boolean) => Array<{ command: string; pkg: string }>
  scanRunBlockForGlobalRootDepInstalls: (
    b: string,
    deps: Iterable<string>,
    ci?: boolean
  ) => Array<{ command: string; pkg: string; reason: string }>
  scanWorkflowSource: (
    src: string,
    file: string,
    deps: Set<string>
  ) => { findings: Array<{ rule: string; job: string; message: string }> }
  loadDirectDependencyNames: (root: string) => Set<string>
  extractRunBlocks: (src: string) => Array<{ line: number; body: string }>
  jobBoundaries: (src: string) => Array<{ line: number; name: string }>
  jobNameOf: (b: Array<{ line: number; name: string }>, line: number) => string
  vercelInvocations: (body: string) => Array<{ word: string; verb: string }>
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WF_DIR = join(ROOT, '.github', 'workflows')
const RULE = 'workflow-global-root-dep-install'
const ABS = '"$GITHUB_WORKSPACE/node_modules/.bin/vercel"'
const SHIM_STEP = 'Use Vercel CLI from the lockfile (SMI-6944)'
const SHIM_RUN = 'bash scripts/ci/use-lockfile-vercel.sh'

describe('SMI-6944 Test 1: workflow-global-root-dep-install positive control', () => {
  const deps = new Set(['vercel'])
  const flagged = [
    'npm i -g "vercel@$PINNED"',
    'npm install --global vercel@52.2.0',
    "npm i -g 'vercel'",
    'npm i --no-audit -g vercel@latest',
    'npm install vercel@latest -g',
    'npm install --location=global vercel@52.2.0',
    'npm add -g vercel@52.2.0',
  ]
  it.each(flagged)('flags exactly once: %s', (body) => {
    expect(scanRunBlockForGlobalRootDepInstalls(body, deps)).toHaveLength(1)
  })

  it('does not flag a global install of a non-dependency (npm@11.9.0)', () => {
    expect(scanRunBlockForGlobalRootDepInstalls('npm i -g npm@11.9.0', deps)).toHaveLength(0)
  })

  it('does not flag a non-global install of a dependency', () => {
    expect(scanRunBlockForGlobalRootDepInstalls('npm i vercel@52.2.0', deps)).toHaveLength(0)
    expect(scanRunBlockForGlobalRootDepInstalls('pnpm install -g vercel', deps)).toHaveLength(0)
  })

  it('flags `npx <dep>@<ver>` only when no npm ci ran earlier in the job', () => {
    expect(scanRunBlockForGlobalRootDepInstalls('npx vercel@52.2.0 --version', deps)).toHaveLength(
      1
    )
    expect(scanRunBlockForGlobalRootDepInstalls('npx vercel@52.2.0 --version', deps, true)).toEqual(
      []
    )
  })

  it('1b: the pin rule sees a quoted spec (base returned 0 for the quoted @latest)', () => {
    expect(scanRunBlockForInstalls('npm i -g "vercel@latest"', false)).toHaveLength(1)
    expect(scanRunBlockForInstalls('npm i -g vercel@latest', false)).toHaveLength(1)
    // A variable-version spec cannot be verified, so the pin rule refuses it.
    expect(scanRunBlockForInstalls('npm i -g "vercel@$PINNED"', false)).toHaveLength(1)
    expect(scanRunBlockForInstalls('npm i -g vercel@52.2.0', false)).toEqual([])
  })

  it('1c: the npx rule sees a quoted spec', () => {
    expect(scanRunBlockForInstalls('npx "foo@latest" x', false)).toHaveLength(1)
    expect(scanRunBlockForInstalls('npx foo@1.2.3 x', false)).toEqual([])
  })
})

describe('SMI-6944 Test 2: real tree absence, paired with presence + injected positive', () => {
  it('the real workflows hold no global install of a repo dependency', () => {
    const r = auditWorkflowInstalls(ROOT)
    // Presence first: the subject contains the shape the absence claim is about.
    expect(r.scannedFiles).toBeGreaterThan(0)
    expect(r.runBlocks).toBeGreaterThan(0)
    expect(r.vercelInvocationBlocks).toBeGreaterThanOrEqual(7)
    const deps = loadDirectDependencyNames(ROOT)
    expect(deps.has('vercel')).toBe(true)
    expect(deps.has('npm')).toBe(false)
    const hits = r.findings.filter((f) => f.rule === RULE)
    expect(hits).toEqual([])
  })

  it('the same scanner flags an injected global install in deploy-production', () => {
    const src = readFileSync(join(WF_DIR, 'website-deploy-staging.yml'), 'utf-8')
    const deps = loadDirectDependencyNames(ROOT)
    const needle = `        run: ${SHIM_RUN}\n`
    const parts = src.split(needle)
    expect(parts.length).toBe(3) // two jobs carry the shim step
    const injected =
      parts[0] +
      needle +
      parts[1] +
      '        run: |\n          npm i -g "vercel@$PINNED"\n' +
      parts[2]
    const hits = scanWorkflowSource(injected, 'website-deploy-staging.yml', deps).findings.filter(
      (f) => f.rule === RULE
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].job).toBe('deploy-production')
  })
})

// ---------------------------------------------------------------------------
// Test 3: shim presence + per-invocation absolute path (XF-H1)
// ---------------------------------------------------------------------------
interface Failure {
  file: string
  job: string
  kind: string
  line: number
}

const EXPECTED_JOBS = [
  'cross-harness-inventory-e2e.yml/test',
  'device-login-roundtrip.yml/test',
  'website-account-e2e.yml/e2e',
  'website-deploy-staging.yml/deploy-production',
  'website-deploy-staging.yml/deploy-staging',
  'website-preview-pr.yml/preview',
  'website-skills-e2e.yml/e2e',
]
const EXPECTED_INVOCATIONS = 21

const SHADOWING = [
  /(^|[\s;&(])vercel\s*\(\s*\)/,
  /\bfunction\s+vercel\b/,
  /\balias\s+vercel=/,
  /\/usr\/(local\/)?bin\/vercel/,
  /npm\s+(root|prefix|bin)\s+-g/,
]

/** Check every vercel-calling job in the given sources. Pure; no I/O. */
function checkVercelJobs(files: Array<{ file: string; source: string }>) {
  const failures: Failure[] = []
  const jobs = new Set<string>()
  let invocations = 0
  for (const { file, source } of files) {
    const stripped = source
      .split('\n')
      .map((l) => (l.trimStart().startsWith('#') ? '' : l))
      .join('\n')
    const bounds = jobBoundaries(stripped)
    const blocks = extractRunBlocks(stripped)
    const byJob = new Map<string, typeof blocks>()
    for (const b of blocks) {
      const key = jobNameOf(bounds, b.line)
      byJob.set(key, [...(byJob.get(key) ?? []), b])
    }
    for (const [job, jb] of byJob) {
      const credentialed = jb.some((b) =>
        vercelInvocations(b.body).some((v) => ['pull', 'build', 'deploy'].includes(v.verb))
      )
      if (!credentialed) continue
      jobs.add(`${file}/${job}`)
      const shimBlock = jb.find((b) => b.body.trim() === SHIM_RUN)
      const fail = (kind: string, line: number) => failures.push({ file, job, kind, line })
      const reported = new Set<number>()
      if (!shimBlock) fail('shim-step-missing', 0)
      else {
        const lines = stripped.split('\n')
        const nameOk = lines[shimBlock.line - 2]?.trim() === `- name: ${SHIM_STEP}`
        if (!nameOk) fail('shim-step-name', shimBlock.line)
      }
      for (const b of jb) {
        for (const v of vercelInvocations(b.body)) {
          invocations++
          if (v.word !== ABS) {
            fail('command-word', b.line)
            reported.add(b.line)
          }
          if (shimBlock && b.line < shimBlock.line) fail('before-shim-step', b.line)
        }
        for (const re of SHADOWING) {
          if (re.test(b.body) && !reported.has(b.line)) fail('shadowing', b.line)
        }
      }
    }
  }
  return { failures, jobs: [...jobs].sort(), invocations }
}

const realFiles = readdirSync(WF_DIR)
  .filter((f) => f.endsWith('.yml'))
  .map((file) => ({ file, source: readFileSync(join(WF_DIR, file), 'utf-8') }))

describe('SMI-6944 Test 3: every credentialed vercel call runs the lockfile binary', () => {
  it('matches exactly the 7 known jobs, with no failures', () => {
    const r = checkVercelJobs(realFiles)
    expect(r.jobs).toEqual(EXPECTED_JOBS)
    expect(r.invocations).toBe(EXPECTED_INVOCATIONS)
    expect(r.failures).toEqual([])
  })

  const staging = () => realFiles.find((f) => f.file === 'website-deploy-staging.yml')!
  const prodDeploy = `${ABS} deploy --prebuilt --prod`

  it('control: a production call rewritten to /usr/local/bin/vercel fails exactly once', () => {
    const src = staging().source
    expect(src).toContain(prodDeploy)
    const mutated = src.replace(prodDeploy, '/usr/local/bin/vercel deploy --prebuilt --prod')
    const r = checkVercelJobs([{ file: staging().file, source: mutated }])
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toMatchObject({ job: 'deploy-production', kind: 'command-word' })
  })

  it('control: a vercel() function defined in deploy-production fails exactly once', () => {
    const src = staging().source
    const anchor = '          set -eu\n          ' + `${ABS} pull --yes --environment=production`
    expect(src).toContain(anchor)
    const mutated = src.replace(
      anchor,
      '          set -eu\n          vercel() { command vercel "$@"; }\n          ' +
        `${ABS} pull --yes --environment=production`
    )
    const r = checkVercelJobs([{ file: staging().file, source: mutated }])
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toMatchObject({ job: 'deploy-production', kind: 'shadowing' })
  })

  it('control: a shim step moved below the first invocation fails the ordering check', () => {
    const src = realFiles.find((f) => f.file === 'device-login-roundtrip.yml')!.source
    const step = `      - name: ${SHIM_STEP}\n        run: ${SHIM_RUN}\n`
    expect(src).toContain(step)
    const pullAt = src.indexOf(`${ABS} pull`)
    const stepStart = src.lastIndexOf('      - name:', pullAt)
    const moved = src.replace(step, '')
    const at = moved.indexOf('      - name:', moved.indexOf(`${ABS} pull`))
    const mutated =
      moved.slice(0, at === -1 ? moved.length : at) +
      step +
      moved.slice(at === -1 ? moved.length : at)
    expect(stepStart).toBeGreaterThan(0)
    const r = checkVercelJobs([{ file: 'device-login-roundtrip.yml', source: mutated }])
    expect(r.failures.some((f) => f.kind === 'before-shim-step' && f.job === 'test')).toBe(true)
  })
})
