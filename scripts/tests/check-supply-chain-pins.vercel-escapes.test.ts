/**
 * SMI-6944 review round 1: escapes that survived the first Check 4 / Test 3.
 *
 * Every escape is a positive case (flagged by the full `scanWorkflowSource`
 * pipeline, the way Check 4 runs it) paired with a presence control (the
 * lockfile-correct spelling of the same shape is NOT flagged), so an absence
 * assertion never rests on a scanner that matched nothing.
 *
 * @see docs/internal/implementation/smi-6944-vercel-cli-from-lockfile.md
 */
import { describe, it, expect } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const mod = await import('../ci/check-supply-chain-pins.mjs')
const {
  scanWorkflowSource,
  auditWorkflowInstalls,
  loadDirectDependencyNames,
  loadLockfileVersions,
} = mod as {
  scanWorkflowSource: (
    src: string,
    file: string,
    deps: Set<string>,
    lock?: Map<string, string>
  ) => { findings: Array<{ rule: string; message: string }> }
  auditWorkflowInstalls: (root: string) => {
    findings: Array<{ file: string; rule: string; message: string }>
    scannedFiles: number
  }
  loadDirectDependencyNames: (root: string) => Set<string>
  loadLockfileVersions: (root: string) => Map<string, string>
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEPS = new Set(['vercel', 'tsx'])
const LOCK = new Map([['vercel', '52.2.0']])
const ROOT_DEP = 'workflow-global-root-dep-install'
const WORD = 'workflow-vercel-command-word'
const ABS = '"$GITHUB_WORKSPACE/node_modules/.bin/vercel"'

/** A one-job workflow whose second step runs `body`; `ci` puts an `npm ci` step before it. */
function wf(body: string, ci: boolean): string {
  const indented = body
    .split('\n')
    .map((l) => `          ${l}`)
    .join('\n')
  return [
    'jobs:',
    '  job:',
    '    steps:',
    ci ? '      - run: npm ci --ignore-scripts' : '      - run: echo start',
    '      - run: |',
    indented,
    '',
  ].join('\n')
}

const rulesFor = (body: string, ci: boolean) =>
  scanWorkflowSource(wf(body, ci), 'wf.yml', DEPS, LOCK).findings.map((f) => f.rule)

describe('SMI-6944 review round 1: Check 4 escapes', () => {
  describe('vercel / vc command word must be the exact absolute lockfile path', () => {
    const escapes = [
      'vc deploy --prebuilt --prod',
      'vercel deploy --prebuilt',
      'vercel@60.1.3 deploy',
      '/usr/local/bin/vc deploy',
      '/usr/local/bin/vercel --prod',
      'vc --prebuilt',
      'URL=$(vc deploy --prebuilt --yes)',
      'echo "$(vc deploy)"',
      'bash -c "vc deploy"',
      'sudo -E vercel pull',
      'node node_modules/vercel/dist/vc.js deploy',
    ]
    it.each(escapes)('flags: %s', (body) => {
      expect(rulesFor(body, true)).toContain(WORD)
    })

    it('presence control: the absolute lockfile path, and non-command mentions, are not flagged', () => {
      expect(rulesFor(`${ABS} deploy --prebuilt --prod`, true)).toEqual([])
      expect(rulesFor(`URL=$(${ABS} deploy --prebuilt)`, true)).toEqual([])
      expect(rulesFor('which vercel\ncommand -v vc\necho vercel deploy', true)).toEqual([])
      expect(rulesFor('bash scripts/ci/use-lockfile-vercel.sh --verify-only', true)).toEqual([])
    })
  })

  describe('installs and runs of a repo dependency outside the lockfile tree', () => {
    const escapes: Array<[string, string, boolean]> = [
      ['npx --yes vercel@60.1.3 after npm ci', 'npx --yes vercel@60.1.3 deploy', true],
      ['npx -y vercel@60.1.3 with no npm ci', 'npx -y vercel@60.1.3 deploy', false],
      ['npm exec', 'npm exec --yes vercel@60.1.3 -- deploy', true],
      ['npm x', 'npm x -y vercel@60.1.3 -- deploy', true],
      ['npx --package=', 'npx --package=vercel@60.1.3 vercel deploy', true],
      ['npx -p', 'npx -p vercel@60.1.3 vercel deploy', true],
      ['pnpm dlx', 'pnpm dlx vercel@60.1.3 deploy', true],
      ['yarn dlx', 'yarn dlx vercel@60.1.3 deploy', true],
      ['bunx', 'bunx vercel@60.1.3 deploy', true],
      ['bun x', 'bun x vercel@60.1.3 deploy', true],
      ['npm --global install', 'npm --global install vercel@52.2.0', true],
      ['npm -g install', 'npm -g install vercel@52.2.0', true],
      ['npm i -g with a variable spec', 'npm i -g "$PKG"', true],
      ['npm i -g braced variable spec', 'npm i -g ${PKG}', true],
      ['npm --location=global', 'npm install --location=global vercel@52.2.0', true],
      ['pnpm add -g', 'pnpm add -g vercel@52.2.0', true],
      ['pnpm i -g', 'pnpm i -g vercel@52.2.0', true],
      ['yarn global add', 'yarn global add vercel@52.2.0', true],
      ['bun add -g', 'bun add -g vercel@52.2.0', true],
      ['npm install -g after --', 'npm install -g -- vercel@52.2.0', true],
      ['npm i --no-save after npm ci', 'npm i --no-save vercel@60.1.3', true],
      ['npm install a different version after npm ci', 'npm install vercel@60.1.3', true],
    ]
    // Global-install cases use the LOCKFILE version, so the global flag is the only thing
    // that can explain the finding (a version mismatch alone would also trip the rule).
    it.each(escapes)('flags: %s', (_name, body, ci) => {
      expect(rulesFor(body, ci)).toContain(ROOT_DEP)
    })

    const clean: Array<[string, string, boolean]> = [
      ['npx of the lockfile version after npm ci', 'npx vercel@52.2.0 --version', true],
      ['npx with no version after npm ci (resolves the local bin)', 'npx vercel --version', true],
      [
        'npm exec of the lockfile version after npm ci',
        'npm exec vercel@52.2.0 -- --version',
        true,
      ],
      ['npm install of the lockfile version after npm ci', 'npm install vercel@52.2.0', true],
      ['a global install of a non-dependency', 'npm i -g npm@11.9.0', true],
      ['pnpm dlx of a non-dependency', 'pnpm dlx cowsay@1.6.0 hi', true],
      ['an npx of a non-dependency (pinned)', 'npx cowsay@1.6.0 hi', false],
      ['a plain npm ci', 'npm ci --ignore-scripts', false],
    ]
    it.each(clean)('presence control, not flagged: %s', (_name, body, ci) => {
      expect(rulesFor(body, ci)).not.toContain(ROOT_DEP)
    })
  })

  it('blast radius: the real tree still has no finding of either new rule', () => {
    const r = auditWorkflowInstalls(ROOT)
    // Presence first: the audit examined workflows and knows the dependency it guards.
    expect(r.scannedFiles).toBeGreaterThan(0)
    expect(loadDirectDependencyNames(ROOT).has('vercel')).toBe(true)
    expect(loadLockfileVersions(ROOT).get('vercel')).toMatch(/^\d+\.\d+\.\d+$/)
    expect(r.findings.filter((f) => f.rule === ROOT_DEP || f.rule === WORD)).toEqual([])
  })
})
