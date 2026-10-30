/**
 * SMI-7201 Wave 2: pre-push Tier-B pair check
 * (scripts/lib/check-tier-b-pairs-prepush.sh) and its wiring in .husky/pre-push.
 *
 * Driven through the SKILLSMITH_TIER_B_PAIR_CHECK_TEST seam (status or host
 * route) and SKILLSMITH_TIER_B_PAIR_CHECK_TEST_KIND (checkout kind), plus a
 * copy of the script beside a fake hook-docker-detect.sh to exercise the real
 * (non-seam) route. Every absence assertion is paired with a presence
 * assertion from the same run.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'check-tier-b-pairs-prepush.sh')
const PRE_PUSH = join(REPO_ROOT, '.husky', 'pre-push')

const WORKTREE_REMEDY =
  'docker compose --profile dev build dev && ./scripts/worktree-docker.sh stop && ./scripts/worktree-docker.sh start'
const MAIN_REMEDY = 'sh scripts/lib/print-deps-refresh-advice.sh'
const MAIN_REMEDY_NOTE = 'A rebuild alone does not change the named node_modules volume.'
const DISABLE = 'SKILLSMITH_TIER_B_PAIR_CHECK_DISABLE'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'skillsmith-tier-b-pairs-push-'))
  dirs.push(d)
  return d
}

interface Run {
  status: number
  out: string
}

function run(env: Record<string, string>, script: string = SCRIPT, cwd: string = REPO_ROOT): Run {
  const r = spawnSync('sh', [script], {
    encoding: 'utf8',
    cwd,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...env },
    input: '', // stdin-silent: nothing to read
    timeout: 20_000,
  })
  return { status: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

const seam = (status: string, kind: string, extra: Record<string, string> = {}): Run =>
  run({
    SKILLSMITH_TIER_B_PAIR_CHECK_TEST: status,
    SKILLSMITH_TIER_B_PAIR_CHECK_TEST_KIND: kind,
    ...extra,
  })

describe('check-tier-b-pairs-prepush.sh via the seam', () => {
  it('CLEAN: exits 0 with at most one line and no remedy', () => {
    const r = seam('0', 'worktree')
    expect(r.status).toBe(0)
    expect(r.out).toContain('] CLEAN ')
    expect(r.out.trim().split('\n')).toHaveLength(1)
    expect(r.out).not.toContain('Remedy')
  })

  it.each([
    ['worktree', WORKTREE_REMEDY, MAIN_REMEDY],
    ['main', MAIN_REMEDY, WORKTREE_REMEDY],
  ])("MISMATCH in %s: blocks with the lines and only this kind's remedy", (kind, want, notWant) => {
    const r = seam('1', kind)
    expect(r.status).toBe(1)
    expect(r.out).toContain('] MISMATCH path=')
    expect(r.out).toContain('EmbeddingService silently serves mock embeddings')
    expect(r.out).toContain(want)
    expect(r.out).not.toContain(notWant)
    if (kind === 'main') expect(r.out).toContain(MAIN_REMEDY_NOTE)
  })

  it('NOT-EVALUATED (2) blocks, names the lines, says the input must be fixed, and never says clean', () => {
    const r = seam('2', 'main')
    expect(r.status).toBe(1)
    expect(r.out).toContain('] NOT-EVALUATED path=')
    expect(r.out).toContain("checker's input must be fixed")
    expect(r.out).toContain('a broken state cannot be excluded')
    expect(r.out).not.toContain('] CLEAN ')
    expect(r.out).not.toContain('Remedy')
  })

  it('any other status blocks and names the status', () => {
    const r = seam('9', 'worktree')
    expect(r.status).toBe(1)
    expect(r.out).toContain('exit status 9')
    expect(r.out).toContain("checker's input must be fixed")
    expect(r.out).not.toContain('] CLEAN ')
  })

  it.each(['1', '2', '9'])(
    '%s under the disable variable: still runs, warns naming it, exits 0',
    (status) => {
      const blocked = seam(status, 'main')
      expect(blocked.status).toBe(1) // control: without the variable it blocks
      const r = seam(status, 'main', { [DISABLE]: '1' })
      expect(r.status).toBe(0)
      expect(r.out).toContain(`${DISABLE}=1`)
      expect(r.out).toContain('does not block the push')
      expect(r.out).toContain('NOT verified')
      // The check ran: the result it produced is in the output.
      expect(r.out).toContain(
        status === '1'
          ? '] MISMATCH path='
          : status === '2'
            ? '] NOT-EVALUATED path='
            : 'exit status 9'
      )
    }
  )

  it('CLEAN under the disable variable carries no warning', () => {
    const r = seam('0', 'main', { [DISABLE]: '1' })
    expect(r.status).toBe(0)
    expect(r.out).toContain('] CLEAN ')
    expect(r.out).not.toContain('WARNING')
  })

  it('host route: one loud line that the check did not run, exit 0', () => {
    const r = seam('host', 'main')
    expect(r.status).toBe(0)
    expect(r.out).toContain('NOT RUN')
    expect(r.out).toContain('not using a container')
    expect(r.out).not.toContain('] CLEAN ')
    expect(r.out.trim().split('\n')).toHaveLength(1)
  })
})

describe('check-tier-b-pairs-prepush.sh real route (fake container helper)', () => {
  /** A copy of the script next to a fake hook-docker-detect.sh. */
  function stage(detect: string | null): { script: string; rec: string; dir: string } {
    const dir = tmp()
    const lib = join(dir, 'scripts', 'lib')
    mkdirSync(lib, { recursive: true })
    cpSync(SCRIPT, join(lib, 'check-tier-b-pairs-prepush.sh'))
    if (detect !== null) writeFileSync(join(lib, 'hook-docker-detect.sh'), detect)
    return { script: join(lib, 'check-tier-b-pairs-prepush.sh'), rec: join(dir, 'rec'), dir }
  }
  const fakeDetect = (rec: string, useDocker: string): string =>
    [
      `USE_DOCKER=${useDocker}`,
      'run_cmd() {',
      `  printf '%s\\n' "$*" >"${rec}"`,
      '  printf "%s\\n" "[tier-b-pairs] MISMATCH path=p installed=1.0.0 parent=q spec=^2.0.0" >&2',
      '  return "${FAKE_RC:-1}"',
      '}',
      '',
    ].join('\n')

  it('detect helper absent: says the check did not run, exits 0', () => {
    const s = stage(null)
    const r = run({}, s.script)
    expect(r.status).toBe(0)
    expect(r.out).toContain('NOT RUN')
    expect(r.out).toContain('hook-docker-detect.sh is missing')
  })

  it('USE_DOCKER=0: the host-route line, run_cmd never called', () => {
    const rec = join(tmp(), 'rec')
    const s = stage(fakeDetect(rec, '0'))
    const r = run({}, s.script)
    expect(r.status).toBe(0)
    expect(r.out).toContain('not using a container')
    expect(() => readFileSync(s.rec, 'utf8')).toThrow() // never invoked
  })

  it('USE_DOCKER=1: runs node on the checker through run_cmd and renders its MISMATCH', () => {
    const s = stage('')
    writeFileSync(join(dirname(s.script), 'hook-docker-detect.sh'), fakeDetect(s.rec, '1'))
    const r = run({ FAKE_RC: '1' }, s.script, s.dir) // s.dir is not a git repo: kind main
    expect(r.status).toBe(1)
    expect(readFileSync(s.rec, 'utf8').trim()).toBe('node scripts/lib/check-tier-b-pairs.mjs')
    expect(r.out).toContain('MISMATCH path=p installed=1.0.0')
    expect(r.out).toContain(MAIN_REMEDY)
    expect(r.out).not.toContain(WORKTREE_REMEDY)
  })

  it('USE_DOCKER=1 in a git worktree: passes --worktree and prints the worktree remedy', () => {
    const s = stage('')
    writeFileSync(join(dirname(s.script), 'hook-docker-detect.sh'), fakeDetect(s.rec, '1'))
    const repo = join(s.dir, 'repo')
    const wt = join(s.dir, 'wt')
    const git = (...a: string[]) =>
      spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], {
        cwd: repo,
        encoding: 'utf8',
      })
    mkdirSync(repo)
    expect(git('init', '-q').status).toBe(0)
    expect(git('commit', '-q', '--allow-empty', '-m', 'x').status).toBe(0)
    expect(git('worktree', 'add', '-q', wt, '-b', 'wt-branch').status).toBe(0)
    const r = run({ FAKE_RC: '1' }, s.script, wt)
    expect(r.status).toBe(1)
    expect(readFileSync(s.rec, 'utf8').trim()).toBe(
      'node scripts/lib/check-tier-b-pairs.mjs --worktree'
    )
    expect(r.out).toContain(WORKTREE_REMEDY)
    expect(r.out).not.toContain(MAIN_REMEDY)
  })

  it('USE_DOCKER=1, a clean status with no CLEAN line is not reported as clean', () => {
    const s = stage('')
    writeFileSync(join(dirname(s.script), 'hook-docker-detect.sh'), fakeDetect(s.rec, '1'))
    const r = run({ FAKE_RC: '0' }, s.script, s.dir)
    expect(r.status).toBe(1)
    expect(readFileSync(s.rec, 'utf8').trim()).toBe('node scripts/lib/check-tier-b-pairs.mjs')
    expect(r.out).toContain('without a CLEAN summary line')
  })
})

describe('.husky/pre-push wiring', () => {
  const src = readFileSync(PRE_PUSH, 'utf8')

  it('invokes the lib after the native-binding guard and exits 1 when it fails', () => {
    const nativeAt = src.indexOf('if ! sh "$NATIVE_LIB" </dev/null; then')
    const callAt = src.indexOf('if ! sh "$TIER_B_PAIRS_LIB" </dev/null; then')
    expect(nativeAt).toBeGreaterThan(-1)
    expect(callAt).toBeGreaterThan(nativeAt)
    expect(src).toContain('scripts/lib/check-tier-b-pairs-prepush.sh')
    const after = src.slice(callAt).split('\n')
    expect(after[1].trim()).toBe('exit 1')
    expect(after[2].trim()).toBe('fi')
    // Guarded by readability like its neighbours.
    expect(src.slice(0, callAt)).toMatch(/if \[ -r "\$TIER_B_PAIRS_LIB" \]; then\s*$/)
  })
})
