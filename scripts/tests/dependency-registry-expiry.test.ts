/**
 * SMI-6949 review round 1 (R1-L4): .github/workflows/dependency-registry-expiry.yml.
 * Static shape (schedule, permissions, command, pinned actions) plus an EXECUTED
 * run of the workflow's own script with stub `node` and `gh`, so the dedup and
 * close-when-clean behaviour is observed, not just spelled. The script uses GNU
 * sed escapes (ubuntu runner); tests run in the Linux container.
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WORKFLOW = join(REPO_ROOT, '.github/workflows/dependency-registry-expiry.yml')
const require = createRequire(import.meta.url)
interface Step {
  name?: string
  uses?: string
  run?: string
}
interface Doc {
  name: string
  on: { schedule?: Array<{ cron: string }>; workflow_dispatch?: unknown }
  permissions: Record<string, string>
  jobs: Record<string, { steps: Step[]; env?: Record<string, string> }>
}
const yaml = require('js-yaml') as { load: (t: string) => Doc }
const doc = (): Doc => yaml.load(readFileSync(WORKFLOW, 'utf8'))
const script = (): string => {
  const steps = Object.values(doc().jobs)[0].steps.filter((s) =>
    s.run?.includes('check-dependency-registry')
  )
  expect(steps).toHaveLength(1)
  return steps[0].run as string
}

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

  function exec(nodeOut: string, nodeRc: number, existing = '', ghFail = '') {
    const dir = mkdtempSync(join(tmpdir(), 'smi6949-expiry-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const nodeOutFile = join(dir, 'node.out')
    const ghLog = join(dir, 'gh.log')
    const ghBody = join(dir, 'gh.body')
    writeFileSync(nodeOutFile, nodeOut)
    writeFileSync(ghLog, '')
    writeFileSync(join(bin, 'node'), '#!/bin/bash\ncat "$STUB_NODE_OUT"\nexit "$STUB_NODE_RC"\n')
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/bash
echo "$*" >> "$GH_LOG"
if [ "$1 $2" = "$STUB_GH_FAIL" ]; then echo "stub gh: $1 $2 failed" >&2; exit 1; fi
prev=""
for a in "$@"; do
  if [ "$prev" = "--body-file" ]; then cp "$a" "$GH_BODY"; fi
  prev="$a"
done
case "$1 $2" in
  "issue list") printf '%s\\n' "$STUB_EXISTING" ;;
  "issue create") echo https://github.com/o/r/issues/99 ;;
esac
exit 0
`
    )
    chmodSync(join(bin, 'node'), 0o755)
    chmodSync(join(bin, 'gh'), 0o755)
    const r = spawnSync('bash', ['-c', script()], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: dir,
        ISSUE_LABEL: 'dependency-registry-expiry',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_RUN_ID: '123',
        STUB_NODE_OUT: nodeOutFile,
        STUB_NODE_RC: String(nodeRc),
        STUB_EXISTING: existing,
        STUB_GH_FAIL: ghFail,
        GH_LOG: ghLog,
        GH_BODY: ghBody,
      },
    })
    const calls = readFileSync(ghLog, 'utf8').split('\n').filter(Boolean)
    const body = existsSync(ghBody) ? readFileSync(ghBody, 'utf8') : ''
    return { status: r.status, calls, body, stderr: r.stderr, stdout: r.stdout }
  }
  const verbs = (calls: string[]) => calls.map((c) => c.split(' ').slice(0, 2).join(' '))

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
  // (measured: adding that import left the run green). Walk the import closure statically.
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
  it('exits 0 and prints the coherent line from a node_modules-free copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smi6949-bare-'))
    // The whole scripts/ tree (minus tests and any node_modules): the closure must resolve in it.
    cpSync(join(REPO_ROOT, 'scripts'), join(dir, 'scripts'), {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|tests)$/.test(src),
    })
    for (const rel of ['.github/dependency-registry.json', 'package.json', 'package-lock.json']) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), readFileSync(join(REPO_ROOT, rel)))
    }
    expect(existsSync(join(dir, 'node_modules'))).toBe(false)
    const r = spawnSync(process.execPath, ['scripts/check-dependency-registry.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(r.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Check 76: dependency registry coherent \(/)
  })
})
