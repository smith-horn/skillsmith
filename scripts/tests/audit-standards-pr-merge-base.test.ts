/**
 * Check 78 (SMI-7164): a pull_request audit whose merge-base cannot resolve fails loudly.
 *
 * R4a drives runCheck78 with an injected git. R4b runs the real `--only pr-merge-base`
 * subprocess against five real clone shapes, because the verdict must follow merge-base
 * resolution, not shallowness and not "the base ref exists": shape B (deepened shallow) must
 * pass, shape C (full single-branch) must fail, and shape E (depth-1 plus a depth-1 fetch of
 * the base tip: the ref exists, merge-base exits 1 with no stderr) must fail. R4c pins which
 * env var names the base. The last block pins that the full audit runs the registered entry.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env'

type Reporter = (msg: string, fix?: string) => void
const mod = (await import('../lib/audit-pr-merge-base.mjs')) as {
  gitErrorLine: (stderr: unknown) => string
  runCheck78: (a: {
    baseRef?: string
    execFile: (args: string[]) => string
    pass: Reporter
    fail: Reporter
    warn: Reporter
  }) => void
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const AUDIT = join(__dirname, '..', 'audit-standards.mjs')

const drive = (baseRef: string | undefined, execFile: (args: string[]) => string) => {
  const c = {
    pass: [] as string[],
    fail: [] as string[],
    fix: [] as string[],
    warn: [] as string[],
  }
  mod.runCheck78({
    baseRef,
    execFile,
    pass: (m) => c.pass.push(m),
    fail: (m, f) => (c.fail.push(m), c.fix.push(f ?? '')),
    warn: (m) => c.warn.push(m),
  })
  return c
}
const gitExit = (status: number, stderr: string, message = 'Command failed: git merge-base') =>
  Object.assign(new Error(message), { status, stderr })

describe('Check 78: verdict logic (R4a)', () => {
  it('passes and names the merge-base when git resolves it', () => {
    const c = drive('main', (args) => {
      expect(args).toEqual(['merge-base', 'origin/main', 'HEAD'])
      return '0123456789abcdef0123\n'
    })
    expect(c.fail).toEqual([])
    expect(c.pass).toEqual(['Check 78: PR merge-base resolves (0123456789ab)'])
  })

  it('fails on a non-zero exit, quoting the first fatal line and the shallow flag', () => {
    const c = drive('main', (args) => {
      if (args[0] === 'rev-parse') return 'true\n'
      throw gitExit(128, 'warning: noise\nfatal: Not a valid object name origin/main\n')
    })
    expect(c.pass).toEqual([])
    expect(c.fail).toHaveLength(1)
    expect(c.fail[0]).toContain('fatal: Not a valid object name origin/main; shallow=true')
    expect(c.fail[0]).toContain('Checks 45, 50, 51, 54 and 77')
    expect(c.fix[0]).toContain('In CI: set fetch-depth: 0')
    expect(c.fix[0]).toContain('Locally: git fetch origin <base>')
  })

  it('falls back to the error message when stderr is empty (shape E exits 1 silently)', () => {
    const c = drive('main', (args) => {
      if (args[0] === 'rev-parse') return 'true\n'
      throw gitExit(1, '', 'Command failed: git merge-base origin/main HEAD')
    })
    expect(c.fail).toHaveLength(1)
    expect(c.fail[0]).toContain('(Command failed: git merge-base origin/main HEAD; shallow=true)')
    expect(c.fail[0]).not.toContain('()')
  })

  it('prints shallow=unknown when git cannot answer, without changing the verdict', () => {
    const c = drive('main', (args) => {
      if (args[0] === 'rev-parse') return '--is-shallow-repository\n'
      throw gitExit(128, 'fatal: bad\n')
    })
    expect(c.fail).toHaveLength(1)
    expect(c.fail[0]).toContain('shallow=unknown')
  })

  it('is not applicable when GITHUB_BASE_REF is empty, and never calls git', () => {
    for (const ref of [undefined, '']) {
      const c = drive(ref, () => {
        throw new Error('git must not run')
      })
      expect(c.pass).toEqual(['Check 78: not a PR run: not applicable'])
    }
  })

  it('warns, never passes, when git itself cannot be spawned', () => {
    const c = drive('main', () => {
      throw Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT', status: null })
    })
    expect(c.pass).toEqual([])
    expect(c.fail).toEqual([])
    expect(c.warn).toEqual(['Check 78: could not run git: spawnSync git ENOENT'])
  })

  it('picks the first fatal/error line, else the first non-empty line', () => {
    expect(mod.gitErrorLine('hint: x\nerror: y\nfatal: z')).toBe('error: y')
    expect(mod.gitErrorLine('\n  first  \nsecond')).toBe('first')
    expect(mod.gitErrorLine('')).toBe('')
    expect(mod.gitErrorLine(undefined)).toBe('')
  })
})

describe('Check 78: real clone shapes through --only pr-merge-base (R4b, R4c)', () => {
  let root = ''
  // CI test jobs run under pull_request with GITHUB_BASE_REF/GITHUB_HEAD_REF set; pin both
  // so every case sees only the env it names.
  const gitEnv = makeFixtureEnv({ GITHUB_BASE_REF: '', GITHUB_HEAD_REF: '' })
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: 'pipe' })
  const audit = (cwd: string, extra: Record<string, string> = {}) =>
    spawnSync('node', [AUDIT, '--only', 'pr-merge-base'], {
      cwd,
      env: { ...gitEnv, GITHUB_BASE_REF: 'main', ...extra },
      encoding: 'utf8',
    })

  beforeAll(() => {
    root = makeFixtureTempDir('smi7164-check78-')
    const src = join(root, 'src')
    git(root, 'init', '-q', '-b', 'main', src)
    for (let i = 1; i <= 30; i++) {
      writeFileSync(join(src, `f${i}`), String(i))
      git(src, 'add', `f${i}`)
      git(src, 'commit', '-q', '-m', `main ${i}`)
    }
    // The PR branch forks two commits behind main's tip, so a depth-1 base fetch misses the fork point.
    git(src, 'checkout', '-q', '-b', 'pr', 'HEAD~2')
    writeFileSync(join(src, 'p'), 'pr')
    git(src, 'add', 'p')
    git(src, 'commit', '-q', '-m', 'pr')
    git(src, 'checkout', '-q', 'main')
    const url = `file://${src}`
    const clone = (name: string, ...opts: string[]) => {
      git(root, 'clone', '-q', ...opts, '--branch', 'pr', url, name)
      return join(root, name)
    }
    clone('A', '--depth', '1')
    const b = clone('B', '--depth', '1')
    git(b, 'fetch', '-q', '--deepen=5', 'origin', 'pr')
    git(b, 'fetch', '-q', '--depth=5', 'origin', 'main:refs/remotes/origin/main')
    clone('C', '--single-branch')
    clone('D')
    const e = clone('E', '--depth', '1')
    git(e, 'fetch', '-q', '--depth=1', 'origin', 'main:refs/remotes/origin/main')
    const r = clone('R')
    git(r, 'update-ref', '-d', 'refs/remotes/origin/pr')
  })
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  const expectPass = (shape: string) => {
    const r = audit(join(root, shape))
    expect(r.stdout).toContain('Check 78: PR merge-base resolves (')
    expect(r.status).toBe(0)
  }
  const expectFail = (shape: string, shallow: string) => {
    const r = audit(join(root, shape))
    expect(r.stdout).toContain('Check 78: PR merge-base unresolvable')
    expect(r.stdout).toContain(`shallow=${shallow})`)
    expect(r.status).toBe(1)
  }

  it('A, depth-1 clone (the bug): fails', () => expectFail('A', 'true'))
  it('B, shallow clone deepened past the fork point: passes', () => expectPass('B'))
  it('C, full single-branch clone with no origin/main: fails', () => expectFail('C', 'false'))
  it('D, full clone: passes', () => expectPass('D'))
  it('E, depth-1 clone plus a depth-1 fetch of the base tip: fails', () => {
    // Precondition: the base ref exists here, so only a real merge-base test can fail this shape.
    expect(git(join(root, 'E'), 'rev-parse', '--verify', '-q', 'origin/main').trim()).toMatch(
      /^[0-9a-f]{40}$/
    )
    expectFail('E', 'true')
  })

  it('R4c: reads the base from GITHUB_BASE_REF, not GITHUB_HEAD_REF', () => {
    // origin/pr was deleted in clone R, so a head-ref read cannot resolve and would fail.
    const r = audit(join(root, 'R'), { GITHUB_HEAD_REF: 'pr' })
    expect(r.stdout).toContain('Check 78: PR merge-base resolves (')
    expect(r.status).toBe(0)
  })

  it('is not applicable without GITHUB_BASE_REF, even in a broken checkout', () => {
    const r = audit(join(root, 'A'), { GITHUB_BASE_REF: '' })
    expect(r.stdout).toContain('Check 78: not a PR run: not applicable')
    expect(r.status).toBe(0)
  })
})

describe('Check 78: the full audit runs the registered entry (X4)', () => {
  it("the Check 78 block is exactly a call to CHECK_REGISTRY.get('pr-merge-base')", () => {
    const src = readFileSync(AUDIT, 'utf8')
    const start = src.indexOf('${BOLD}Check 78:')
    const end = src.indexOf('// Summary', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = src.slice(src.indexOf('\n', start) + 1, end).trim()
    expect(body).toBe("await CHECK_REGISTRY.get('pr-merge-base')()")
    expect(src).toContain("['pr-merge-base', async () => runCheck78FromEnv({ pass, fail, warn })]")
  })
})
