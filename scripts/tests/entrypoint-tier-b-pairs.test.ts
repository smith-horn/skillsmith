/**
 * SMI-7201 Wave 2: container-boot Tier-B pair check
 * (scripts/lib/entrypoint-tier-b-pairs.sh) and its call site in
 * docker-entrypoint.sh.
 *
 * The library is sourced in real bash under `set -e` (the entrypoint's own
 * mode) and driven with fake checkers that print `[tier-b-pairs]` lines and
 * exit with a chosen status. Every absence assertion is paired with a presence
 * assertion from the same run, so a run that produced nothing cannot pass.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { extractTierBRestoreBlock } from './docker-entrypoint-tier-b-seed.helpers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const LIB = join(REPO_ROOT, 'scripts', 'lib', 'entrypoint-tier-b-pairs.sh')
const ENTRYPOINT = join(REPO_ROOT, 'docker-entrypoint.sh')

const WORKTREE_REMEDY =
  'docker compose --profile dev build dev && ./scripts/worktree-docker.sh stop && ./scripts/worktree-docker.sh start'
const MAIN_REMEDY = 'sh scripts/lib/print-deps-refresh-advice.sh'
const MAIN_REMEDY_NOTE = 'A rebuild alone does not change the named node_modules volume.'
const CLEAN_LINE =
  '[tier-b-pairs] CLEAN 3 packages expected (3 applicable, 0 skipped for another platform), 3 pairs checked'
const MISMATCH_LINE =
  '[tier-b-pairs] MISMATCH path=node_modules/@img/sharp-linux-arm64 installed=0.0.0 parent=node_modules/sharp spec=^9.9.9'
const NOT_EVAL_LINE =
  '[tier-b-pairs] NOT-EVALUATED path=node_modules/@img/sharp-linux-arm64 installed package.json unreadable (EACCES)'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'skillsmith-tier-b-pairs-boot-'))
  dirs.push(d)
  return d
}

/** A fake checker: records its argv to `<dir>/ran`, prints `lines` to stderr, exits `code`. */
function fakeChecker(dir: string, lines: string[], code: number): string {
  const path = join(dir, 'fake-checker.mjs')
  writeFileSync(
    path,
    [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(join(dir, 'ran'))}, process.argv.slice(2).join(' ') + '\\n')`,
      `for (const l of ${JSON.stringify(lines)}) process.stderr.write(l + '\\n')`,
      `process.exit(${code})`,
      '',
    ].join('\n')
  )
  return path
}

interface Run {
  status: number
  out: string
  stdout: string
}

/** Source the lib in bash under `set -e`, call the function, report its status. */
function runCheck(
  checker: string,
  flag: string,
  kind: string,
  env: Record<string, string> = {}
): Run {
  const script = [
    'set -e',
    `source '${LIB}'`,
    `check_tier_b_pairs '${checker}' '${flag}' '${kind}'`,
    'echo "FUNCTION_STATUS=$?"',
    '',
  ].join('\n')
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...env },
    timeout: 20_000,
  })
  const stdout = r.stdout ?? ''
  return { status: r.status ?? -1, out: stdout + (r.stderr ?? ''), stdout }
}

describe('check_tier_b_pairs (boot)', () => {
  it('CLEAN: one green line with the CLEAN summary, flag removed, status 0', () => {
    const d = tmp()
    const flag = join(d, 'run', 'tier-b-pairs.state')
    mkdirSync(dirname(flag), { recursive: true })
    writeFileSync(flag, 'state=mismatch\nsource=boot\nold\n')
    expect(existsSync(flag)).toBe(true) // precondition: there is a flag to remove
    const r = runCheck(fakeChecker(d, [CLEAN_LINE], 0), flag, 'worktree')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('FUNCTION_STATUS=0')
    expect(r.out).toContain(CLEAN_LINE)
    expect(r.out).not.toContain('MISMATCH')
    expect(existsSync(join(d, 'ran'))).toBe(true) // the check really ran
    expect(existsSync(flag)).toBe(false)
  })

  it('CLEAN in a worktree still shows the INFO line naming obsolete seed entries', () => {
    const d = tmp()
    const flag = join(d, 'state')
    const info =
      '[tier-b-pairs] INFO seed entries not in the live lockfile (not checked): node_modules/@img/old-linux-arm64'
    const r = runCheck(fakeChecker(d, [info, CLEAN_LINE], 0), flag, 'worktree')
    expect(r.stdout).toContain('FUNCTION_STATUS=0')
    expect(r.out).toContain(CLEAN_LINE)
    expect(r.out).toContain(info)
    expect(existsSync(flag)).toBe(false)
  })

  it('exit 0 without a CLEAN line is not reported as clean', () => {
    const d = tmp()
    const flag = join(d, 'state')
    const r = runCheck(fakeChecker(d, ['[tier-b-pairs] something else'], 0), flag, 'main')
    expect(r.stdout).toContain('FUNCTION_STATUS=0')
    expect(r.out).toContain('NOT EVALUATED')
    expect(r.out).toContain('without a CLEAN summary line')
    expect(readFileSync(flag, 'utf8').split('\n')[0]).toBe('state=not-evaluated')
  })

  it('MISMATCH in a worktree: red block, consequence, worktree remedy only, flag state=mismatch', () => {
    const d = tmp()
    const flag = join(d, 'run', 'tier-b-pairs.state')
    const lines = [MISMATCH_LINE, '[tier-b-pairs] MISMATCH: 3 packages expected; 1 mismatch(es)']
    const r = runCheck(fakeChecker(d, lines, 1), flag, 'worktree')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('FUNCTION_STATUS=0')
    expect(r.out).toContain(MISMATCH_LINE)
    expect(r.out).toContain('EmbeddingService silently serves mock embeddings')
    expect(r.out).toContain(WORKTREE_REMEDY)
    expect(r.out).not.toContain(MAIN_REMEDY)
    expect(readFileSync(join(d, 'ran'), 'utf8').trim()).toBe('--worktree')
    const flagLines = readFileSync(flag, 'utf8').split('\n')
    expect(flagLines[0]).toBe('state=mismatch')
    expect(flagLines[1]).toBe('source=boot')
    expect(flagLines).toContain(MISMATCH_LINE)
  })

  it('MISMATCH in the main checkout: main remedy with the volume note, no worktree remedy, no --worktree', () => {
    const d = tmp()
    const flag = join(d, 'tier-b-pairs.state')
    const r = runCheck(fakeChecker(d, [MISMATCH_LINE], 1), flag, 'main')
    expect(r.stdout).toContain('FUNCTION_STATUS=0')
    expect(r.out).toContain(MISMATCH_LINE)
    expect(r.out).toContain(MAIN_REMEDY)
    expect(r.out).toContain(MAIN_REMEDY_NOTE)
    expect(r.out).not.toContain(WORKTREE_REMEDY)
    expect(readFileSync(join(d, 'ran'), 'utf8').trim()).toBe('')
    expect(readFileSync(flag, 'utf8').split('\n').slice(0, 2)).toEqual([
      'state=mismatch',
      'source=boot',
    ])
  })

  it('NOT-EVALUATED: yellow block with the lines, never says clean, state=not-evaluated', () => {
    const d = tmp()
    const flag = join(d, 'tier-b-pairs.state')
    const r = runCheck(fakeChecker(d, [NOT_EVAL_LINE], 2), flag, 'worktree')
    expect(r.stdout).toContain('FUNCTION_STATUS=0')
    expect(r.out).toContain(NOT_EVAL_LINE)
    expect(r.out).toContain('NOT verified')
    expect(r.out.toLowerCase()).not.toContain('clean')
    const flagLines = readFileSync(flag, 'utf8').split('\n')
    expect(flagLines.slice(0, 2)).toEqual(['state=not-evaluated', 'source=boot'])
    expect(flagLines).toContain(NOT_EVAL_LINE)
  })

  it('any other status (a crash) is not evaluated and names the status', () => {
    const d = tmp()
    const flag = join(d, 'tier-b-pairs.state')
    const r = runCheck(fakeChecker(d, ['[tier-b-pairs] boom'], 7), flag, 'main')
    expect(r.stdout).toContain('FUNCTION_STATUS=0')
    expect(r.out).toContain('exited with status 7')
    expect(r.out.toLowerCase()).not.toContain('clean')
    const flagLines = readFileSync(flag, 'utf8').split('\n')
    expect(flagLines.slice(0, 2)).toEqual(['state=not-evaluated', 'source=boot'])
    expect(flagLines.join('\n')).toContain('status 7')
  })

  it('disabled: names the variable, the checker does not run, state=disabled', () => {
    const d = tmp()
    const flag = join(d, 'tier-b-pairs.state')
    const checker = fakeChecker(d, [MISMATCH_LINE], 1)
    const r = runCheck(checker, flag, 'worktree', { SKILLSMITH_TIER_B_PAIR_CHECK_DISABLE: '1' })
    expect(r.stdout).toContain('FUNCTION_STATUS=0')
    expect(r.out).toContain('SKILLSMITH_TIER_B_PAIR_CHECK_DISABLE=1')
    expect(r.out).not.toContain(MISMATCH_LINE)
    expect(existsSync(join(d, 'ran'))).toBe(false)
    expect(readFileSync(flag, 'utf8').split('\n').slice(0, 2)).toEqual([
      'state=disabled',
      'source=boot',
    ])
    // Control: the same checker without the variable does run.
    const control = runCheck(checker, join(d, 'flag2'), 'worktree')
    expect(control.out).toContain(MISMATCH_LINE)
    expect(existsSync(join(d, 'ran'))).toBe(true)
  })

  it('checker missing: UNAVAILABLE, never clean, state=unavailable', () => {
    const d = tmp()
    const flag = join(d, 'tier-b-pairs.state')
    const r = runCheck(join(d, 'no-such-checker.mjs'), flag, 'main')
    expect(r.stdout).toContain('FUNCTION_STATUS=0')
    expect(r.out).toContain('UNAVAILABLE')
    expect(r.out).toContain('NOT verified')
    expect(r.out.toLowerCase()).not.toContain('clean')
    expect(readFileSync(flag, 'utf8').split('\n').slice(0, 2)).toEqual([
      'state=unavailable',
      'source=boot',
    ])
  })

  it('an unwritable flag directory is reported, not skipped, and the function still returns 0', () => {
    const d = tmp()
    const blocker = join(d, 'a-file')
    writeFileSync(blocker, 'not a directory')
    const flag = join(blocker, 'sub', 'tier-b-pairs.state') // mkdir -p under a file fails for any uid
    const r = runCheck(fakeChecker(d, [MISMATCH_LINE], 1), flag, 'main')
    expect(r.stdout).toContain('FUNCTION_STATUS=0')
    expect(r.out).toContain(MISMATCH_LINE) // the block itself was printed
    expect(r.out).toContain('could not write the state flag')
    expect(r.out).toContain('state=mismatch')
    expect(existsSync(flag)).toBe(false)
  })

  it('writes the flag atomically: no temp file is left beside it', () => {
    const d = tmp()
    const flagDir = join(d, 'run')
    const flag = join(flagDir, 'tier-b-pairs.state')
    runCheck(fakeChecker(d, [MISMATCH_LINE], 1), flag, 'main')
    expect(existsSync(flag)).toBe(true)
    expect(readFileSync(flag, 'utf8')).toContain(MISMATCH_LINE)
    expect(readdirSync(flagDir)).toEqual(['tier-b-pairs.state'])
  })

  it('replaces the flag by rename, not in place: a hard link to the old flag keeps its content', () => {
    const d = tmp()
    const flagDir = join(d, 'run')
    mkdirSync(flagDir)
    const flag = join(flagDir, 'tier-b-pairs.state')
    writeFileSync(flag, 'state=disabled\nsource=boot\n')
    const other = join(d, 'old-link')
    linkSync(flag, other) // same inode: an in-place write would change both
    runCheck(fakeChecker(d, [MISMATCH_LINE], 1), flag, 'main')
    expect(readFileSync(flag, 'utf8').split('\n')[0]).toBe('state=mismatch')
    expect(readFileSync(other, 'utf8')).toBe('state=disabled\nsource=boot\n')
  })

  it('the flag is readable by any user (mode 644)', () => {
    const d = tmp()
    const flag = join(d, 'run', 'tier-b-pairs.state')
    runCheck(fakeChecker(d, [MISMATCH_LINE], 1), flag, 'main')
    expect(statSync(flag).mode & 0o777).toBe(0o644)
  })

  it('a checker that hangs is cut off by the timeout and reported as not evaluated', () => {
    const d = tmp()
    const flag = join(d, 'state')
    const hang = join(d, 'hang.mjs')
    writeFileSync(hang, 'setTimeout(() => {}, 60_000)\n')
    const started = Date.now()
    const r = runCheck(hang, flag, 'main', { SKILLSMITH_TIER_B_PAIR_CHECK_TIMEOUT_SECS: '1' })
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(r.stdout).toContain('FUNCTION_STATUS=0')
    expect(r.out).toContain('timed out after 1s')
    expect(readFileSync(flag, 'utf8').split('\n')[0]).toBe('state=not-evaluated')
  })

  it('exit 1 without a MISMATCH line (a crash) is not evaluated, shows the output, gives no rebuild remedy', () => {
    const d = tmp()
    const flag = join(d, 'state')
    const r = runCheck(fakeChecker(d, ['Error: boom'], 1), flag, 'worktree')
    expect(r.stdout).toContain('FUNCTION_STATUS=0')
    expect(r.out).toContain('without naming a mismatch')
    expect(r.out).toContain('Error: boom')
    expect(r.out).not.toContain('Remedy')
    expect(r.out).not.toContain('Tier-B pair check: MISMATCH')
    expect(readFileSync(flag, 'utf8').split('\n')[0]).toBe('state=not-evaluated')
  })
})

describe('docker-entrypoint.sh call site', () => {
  const src = readFileSync(ENTRYPOINT, 'utf8')
  const lines = src.split('\n')

  /**
   * The call-site `if ... fi` block, located by its comment line (which no mutation of the
   * call itself changes), from the `if` after it to its column-0 `fi`.
   */
  function callSite(): string {
    const marker = lines.findIndex((l) =>
      l.startsWith('# SMI-7201 pair check, run as its own process')
    )
    expect(marker).toBeGreaterThan(-1)
    const start = marker + 1
    expect(lines[start]).toMatch(/^tbp_rc=0; /)
    const end = lines.findIndex((l, i) => i > start && l === 'fi')
    expect(end).toBeGreaterThan(start)
    return lines.slice(start, end + 1).join('\n')
  }

  it('runs the lib after the restore block closes and before exec, outside it', () => {
    const block = extractTierBRestoreBlock(src)
    const blockEnd = src.indexOf(block) + block.length
    const callAt = src.indexOf(
      'bash /app/scripts/lib/entrypoint-tier-b-pairs.sh /app/scripts/lib/check-tier-b-pairs.mjs'
    )
    const execAt = src.lastIndexOf('exec "$@"')
    expect(src.indexOf(block)).toBeGreaterThan(-1)
    expect(callAt).toBeGreaterThan(-1)
    expect(block).not.toContain('entrypoint-tier-b-pairs.sh') // not inside the if/elif/fi
    expect(callAt).toBeGreaterThan(blockEnd)
    expect(callAt).toBeLessThan(execAt)
    // Between the restore block's closing `fi` and the call, no branch is opened: the call
    // runs unconditionally, outside the restore block's if/elif/fi.
    const between = src.slice(blockEnd, callAt)
    const openers = between.match(/^\s*(if|while|for)\b/gm) ?? []
    expect(openers).toHaveLength(0)
    expect(between).toMatch(/^tbp_rc=0; RED=/m)
    // Success needs the lib's completion status, not just a zero exit.
    expect(callSite()).toContain('if [ "$tbp_rc" != 42 ]; then')
    expect(between).not.toMatch(/^\s*(elif|else)\b/m)
    // Its own process, never sourced: a broken lib cannot stop the entrypoint.
    expect(callSite()).not.toContain('source ')
    expect(callSite()).toContain('bash /app/scripts/lib/entrypoint-tier-b-pairs.sh ')
    expect(callSite()).toContain('/run/skillsmith/tier-b-pairs.state')
  })

  it('renames the restore summary so it no longer implies the pair was verified', () => {
    expect(src).toContain('seed marker current')
    expect(src).not.toContain('already current')
  })

  it('stays within the 8-line budget over the 491-line original', () => {
    expect(lines.length - 1).toBeLessThanOrEqual(499) // trailing newline yields one empty element
  })

  /** Run the extracted call-site block with /app and /run redirected into a fixture. */
  function runCallSite(root: string): Run {
    const body = callSite()
      .split('/app/')
      .join(`${root}/app/`)
      .split('/run/skillsmith')
      .join(`${root}/run/skillsmith`)
    const r = spawnSync(
      'bash',
      [
        '-c',
        ['set -e', "RED=''", "GREEN=''", "YELLOW=''", "NC=''", body, 'echo "SITE_DONE"', ''].join(
          '\n'
        ),
      ],
      {
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
        timeout: 20_000,
      }
    )
    return {
      status: r.status ?? -1,
      out: (r.stdout ?? '') + (r.stderr ?? ''),
      stdout: r.stdout ?? '',
    }
  }

  function fixture(withLib: boolean, worktree: boolean): string {
    const root = tmp()
    mkdirSync(join(root, 'app', 'scripts', 'lib'), { recursive: true })
    if (worktree) writeFileSync(join(root, 'app', '.git'), 'gitdir: x\n')
    if (withLib) {
      writeFileSync(
        join(root, 'app', 'scripts', 'lib', 'entrypoint-tier-b-pairs.sh'),
        readFileSync(LIB)
      )
      fakeChecker(join(root, 'app', 'scripts', 'lib'), [MISMATCH_LINE], 1)
      writeFileSync(
        join(root, 'app', 'scripts', 'lib', 'check-tier-b-pairs.mjs'),
        readFileSync(join(root, 'app', 'scripts', 'lib', 'fake-checker.mjs'))
      )
    }
    return root
  }

  it('lib missing: prints UNAVAILABLE and writes state=unavailable, then boot continues', () => {
    const root = fixture(false, true)
    const r = runCallSite(root)
    expect(r.stdout).toContain('SITE_DONE')
    expect(r.out).toContain('UNAVAILABLE')
    expect(r.out).toContain('pairs NOT verified')
    expect(
      readFileSync(join(root, 'run', 'skillsmith', 'tier-b-pairs.state'), 'utf8')
        .split('\n')
        .slice(0, 2)
    ).toEqual(['state=unavailable', 'source=boot'])
  })

  it.each([
    ['a syntax error', 'check_tier_b_pairs() {\n  if then\n}\n'],
    ['a top-level exit', 'exit 3\n'],
    ['no content (0 bytes)', ''],
    ['its run guard cut off', 'check_tier_b_pairs() { :; }\n'],
  ])('a lib with %s: boot continues, prints UNAVAILABLE, writes state=unavailable', (_l, body) => {
    const root = fixture(false, true)
    writeFileSync(join(root, 'app', 'scripts', 'lib', 'entrypoint-tier-b-pairs.sh'), body)
    const r = runCallSite(root)
    expect(r.stdout).toContain('SITE_DONE')
    expect(r.out).toContain('UNAVAILABLE')
    const flag = join(root, 'run', 'skillsmith', 'tier-b-pairs.state')
    expect(readFileSync(flag, 'utf8').split('\n').slice(0, 2)).toEqual([
      'state=unavailable',
      'source=boot',
    ])
    expect(statSync(flag).mode & 0o777).toBe(0o644)
  })

  it('lib missing and the fallback flag write fails: the failure is printed, boot continues', () => {
    const root = fixture(false, true)
    mkdirSync(join(root, 'run'), { recursive: true })
    writeFileSync(join(root, 'run', 'skillsmith'), 'a file, so mkdir -p fails')
    const r = runCallSite(root)
    expect(r.stdout).toContain('SITE_DONE')
    expect(r.out).toContain('UNAVAILABLE')
    expect(r.out).toContain('could not write the state flag')
  })

  it('lib present: kind comes from /app/.git being a file (worktree) or not (main)', () => {
    const wt = fixture(true, true)
    const rWt = runCallSite(wt)
    expect(rWt.stdout).toContain('SITE_DONE')
    expect(rWt.out).toContain(MISMATCH_LINE)
    // The lib proved it completed (exit 42): no UNAVAILABLE fallback, and its own flag stands.
    expect(rWt.out).not.toContain('UNAVAILABLE')
    expect(
      readFileSync(join(wt, 'run', 'skillsmith', 'tier-b-pairs.state'), 'utf8').split('\n')[0]
    ).toBe('state=mismatch')
    expect(readFileSync(join(wt, 'app', 'scripts', 'lib', 'ran'), 'utf8').trim()).toBe('--worktree')

    const main = fixture(true, false)
    const rMain = runCallSite(main)
    expect(rMain.stdout).toContain('SITE_DONE')
    expect(rMain.out).toContain(MISMATCH_LINE)
    expect(readFileSync(join(main, 'app', 'scripts', 'lib', 'ran'), 'utf8').trim()).toBe('')
    expect(rMain.out).toContain(MAIN_REMEDY)
  })
})
