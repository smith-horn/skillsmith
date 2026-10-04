/**
 * SMI-6944 review round 2: Check 4 dispatch surfaces that are not a bare
 * `vercel` / `vc` command word -- package-runner wrappers, a third-party Vercel
 * action, and a variable holding the CLI -- in credentialed jobs.
 *
 * Every positive is flagged by the full `scanWorkflowSource` pipeline (the way
 * Check 4 runs it) and paired with a control of the same shape that is not, so
 * an absence never rests on a scanner that matched nothing. The real-tree
 * absence is paired with a presence count from the same pass and with injected
 * positives into the real production job.
 *
 * @see docs/internal/implementation/smi-6944-vercel-cli-from-lockfile.md
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const mod = await import('../ci/check-supply-chain-pins.mjs')
const dispatch = await import('../ci/check-supply-chain-pins.vercel-dispatch.mjs')
const { scanWorkflowSource, auditWorkflowInstalls, jobBoundaries } = mod as {
  scanWorkflowSource: (
    src: string,
    file: string,
    deps: Set<string>,
    lock?: Map<string, string>
  ) => { findings: Array<{ rule: string; job: string; message: string }> }
  auditWorkflowInstalls: (root: string) => {
    findings: Array<{ file: string; rule: string; message: string }>
    scannedFiles: number
  }
  jobBoundaries: (src: string) => Array<{ line: number; name: string }>
}
const { credentialedJobKeys } = dispatch as {
  credentialedJobKeys: (src: string, b: Array<{ line: number; name: string }>) => Set<number>
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WF = join(ROOT, '.github', 'workflows')
const DEPS = new Set(['vercel'])
const LOCK = new Map([['vercel', '52.2.0']])
const WORD = 'workflow-vercel-command-word'
const ACTION = 'workflow-vercel-action'
const INDIRECT = 'workflow-vercel-indirect-dispatch'
const NEW_RULES = [WORD, ACTION, INDIRECT]

const TOKEN_ENV = '    env:\n      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}'

/** A one-job workflow (after `npm ci`) whose second step runs `body`. */
function wf(body: string, credentialed = true): string {
  const indented = body
    .split('\n')
    .map((l) => `          ${l}`)
    .join('\n')
  return [
    'jobs:',
    '  job:',
    ...(credentialed ? [TOKEN_ENV] : []),
    '    steps:',
    '      - run: npm ci --ignore-scripts',
    '      - run: |',
    indented,
    '',
  ].join('\n')
}

/** A one-job workflow whose step is `uses: <ref>`. */
function wfUses(ref: string, env: 'job' | 'preamble' | 'prod' | 'none'): string {
  return [
    ...(env === 'preamble' ? ['env:', '  VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}'] : []),
    'jobs:',
    '  deploy:',
    ...(env === 'job' ? [TOKEN_ENV] : []),
    ...(env === 'prod'
      ? ['    env:', '      VERCEL_PROD_TOKEN: ${{ secrets.VERCEL_PROD_TOKEN }}']
      : []),
    '    steps:',
    `      - uses: ${ref}`,
    '',
  ].join('\n')
}

const rules = (src: string) =>
  scanWorkflowSource(src, 'wf.yml', DEPS, LOCK).findings.map((f) => f.rule)

describe('SMI-6944 round 2: package-runner wrappers are Vercel command words', () => {
  const flagged = [
    'npx vercel deploy --prod',
    'npx --yes vercel@52.2.0 deploy',
    'npx -p vercel vercel deploy',
    'npx --package=vc vc deploy',
    'npx -- vercel deploy',
    'bunx vercel deploy',
    'pnpx vercel deploy',
    'corepack yarn dlx vercel deploy',
    'corepack pnpm dlx vercel@52.2.0 deploy',
    'yarn dlx vc deploy',
    'yarn vercel deploy',
    'yarn run vercel deploy',
    'pnpm exec vercel deploy',
    'pnpm vercel deploy',
    'npm exec -- vercel deploy',
    'npm x vercel deploy',
    'bun x vercel deploy',
    'bun run vercel deploy',
    'URL=$(npx vercel deploy --prebuilt)',
  ]
  it.each(flagged)('flags: %s', (body) => {
    expect(rules(wf(body))).toContain(WORD)
  })

  const clean = [
    'npm install vercel@52.2.0',
    'npx prettier --check .',
    'yarn dlx cowsay vercel',
    'npm run vercel-build',
    'pnpm run build',
    'npx playwright test vercel',
    'corepack enable',
  ]
  it.each(clean)('control, not flagged as a Vercel command word: %s', (body) => {
    expect(rules(wf(body))).not.toContain(WORD)
  })
})

describe('SMI-6944 round 2: a third-party Vercel action in a credentialed job', () => {
  it.each([
    ['amondnet/vercel-action@v25', 'job'],
    ['BetaHuhn/deploy-to-Vercel-action@v1', 'job'],
    ['vercel/actions/deploy@0123456789012345678901234567890123456789', 'job'],
    ['docker://vercel/cli:latest', 'job'],
    ['amondnet/vercel-action@v25', 'preamble'],
    ['amondnet/vercel-action@v25', 'prod'],
  ] as const)('flags `uses: %s` (token at %s level)', (ref, env) => {
    expect(rules(wfUses(ref, env))).toContain(ACTION)
  })

  it.each([
    ['amondnet/vercel-action@v25', 'none'],
    ['actions/checkout@0123456789012345678901234567890123456789', 'job'],
    ['./.github/actions/vercel-setup', 'job'],
  ] as const)('control, not flagged: `uses: %s` (token: %s)', (ref, env) => {
    expect(rules(wfUses(ref, env))).not.toContain(ACTION)
  })
})

describe('SMI-6944 round 2: a variable holding the CLI in a credentialed job', () => {
  const flagged = [
    'CLI=vercel\n"$CLI" deploy --token "$VERCEL_TOKEN"',
    'export V="vc deploy --prod"\neval "$V"',
    'local x=/usr/local/bin/vercel',
    "CLI=$'vercel'",
    'readonly CLI=vercel@52.2.0',
    'declare -x CLI=vc',
    'CLI="$GITHUB_WORKSPACE/node_modules/.bin/vercel"',
    'if true; then CLI=vc; fi',
    'bash -c "CLI=vercel; \\"\\$CLI\\" deploy"',
  ]
  it.each(flagged)('flags: %s', (body) => {
    expect(rules(wf(body))).toContain(INDIRECT)
  })

  it.each([
    'URL=$("$GITHUB_WORKSPACE/node_modules/.bin/vercel" deploy --prebuilt)',
    'EVENT=vercel-prod-deployed',
    'gh api repos/o/r/dispatches -f event_type=vercel',
    'echo CLI=vercel',
  ])('control, not flagged: %s', (body) => {
    expect(rules(wf(body))).not.toContain(INDIRECT)
  })

  it('control: the same assignment in a job with no Vercel token is not flagged', () => {
    expect(rules(wf('CLI=vercel', false))).not.toContain(INDIRECT)
    expect(rules(wf('CLI=vercel', true))).toContain(INDIRECT)
  })
})

describe('SMI-6944 round 2: real tree', () => {
  const staging = readFileSync(join(WF, 'website-deploy-staging.yml'), 'utf-8')
  const deps = new Set(['vercel'])

  it('absence of all three rules, paired with a presence count of credentialed jobs from the same tree', () => {
    const r = auditWorkflowInstalls(ROOT)
    expect(r.scannedFiles).toBeGreaterThanOrEqual(66)
    expect(r.findings.filter((f) => NEW_RULES.includes(f.rule))).toEqual([])
    const b = jobBoundaries(staging)
    const keys = credentialedJobKeys(staging, b)
    const names = b.filter((x) => keys.has(x.line)).map((x) => x.name)
    expect(names).toEqual(expect.arrayContaining(['deploy-staging', 'deploy-production']))
  })

  const anchor = '      - name: Deploy prebuilt to Vercel (Production)\n'
  it('injected: a Vercel action step in deploy-production is flagged exactly once', () => {
    expect(staging).toContain(anchor)
    const mutated = staging.replace(
      anchor,
      '      - uses: amondnet/vercel-action@0123456789012345678901234567890123456789\n' + anchor
    )
    const hits = scanWorkflowSource(mutated, 'website-deploy-staging.yml', deps).findings.filter(
      (f) => f.rule === ACTION
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].job).toBe('deploy-production')
  })

  it('injected: `CLI=vercel` in the production deploy step is flagged exactly once', () => {
    const line =
      '          bash "$GITHUB_WORKSPACE/scripts/ci/use-lockfile-vercel.sh" --verify-only\n'
    const at = staging.lastIndexOf(line)
    expect(at).toBeGreaterThan(0)
    const mutated = staging.slice(0, at) + '          CLI=vercel\n' + staging.slice(at)
    const hits = scanWorkflowSource(mutated, 'website-deploy-staging.yml', deps).findings.filter(
      (f) => f.rule === INDIRECT
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].job).toBe('deploy-production')
  })
})
